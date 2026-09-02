"""
Model Predictive Control for Tesla-style Autopilot.

Hardware truth: only a forward radar/camera cone exists. The controller
performs Autosteer (lane keep) + Traffic-Aware Cruise. It will not command
a lane change into unsensed side or rear space.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.optimize import minimize

from config import settings


def in_front_fov(x: float, z: float) -> bool:
    """True if a point (lateral x, forward z) is inside the forward sensor cone."""
    if z <= 0.4:
        return False
    dist = math.hypot(x, z)
    if dist > settings.FRONT_SENSOR_RANGE_M:
        return False
    angle = abs(math.atan2(x, z))
    return angle <= math.radians(settings.FRONT_FOV_HALF_ANGLE_DEG)


class MPCController:
    def __init__(self):
        self.dt = 0.1
        self.N = 8
        self.Lf = 2.67
        self.w_cte = 1800.0
        self.w_epsi = 1600.0
        self.w_v = 1.2
        self.w_delta = 8.0
        self.w_a = 6.0
        self.w_delta_d = 160.0
        self.w_a_d = 12.0
        self.w_obs = 900.0
        self._last_u = np.zeros(2 * (self.N - 1))
        self._last_steer = 0.0
        self._last_a = 0.0

    def _lead_in_lane(
        self,
        obstacles: Sequence[Dict[str, Any]],
        lane_half_m: float = 1.9,
    ) -> Optional[Dict[str, Any]]:
        lead = None
        best = 1e9
        for obs in obstacles:
            if not obs.get("in_fov", True):
                continue
            x = float(obs.get("x", 0.0))
            z = float(obs.get("z", obs.get("distance", 0.0)))
            if not in_front_fov(x, z):
                continue
            if abs(x) > lane_half_m or z <= 1.0:
                continue
            if z < best:
                best = z
                lead = obs
        return lead

    def _target_speed_mps(
        self,
        v: float,
        ref_v_mps: float,
        lead: Optional[Dict[str, Any]],
        following_gap_s: float,
        sensor_gap: bool,
    ) -> float:
        if sensor_gap:
            return min(ref_v_mps, 8.9)  # ~20 mph conservative
        if not lead:
            return ref_v_mps
        z = float(lead.get("z", lead.get("distance", 40.0)))
        lead_v = float(lead.get("speed_mps", v * 0.7))
        desired_gap = max(8.0, following_gap_s * max(v, 4.0))
        gap_err = z - desired_gap
        # If too close, drop below lead speed; if gap is healthy, match lead then resume ref.
        if gap_err < 0:
            return max(0.0, min(lead_v - 1.5, ref_v_mps))
        return min(ref_v_mps, max(lead_v, lead_v + 0.25 * gap_err))

    def _obstacle_cost(self, x: float, y: float, obstacles: Sequence[Dict[str, Any]]) -> float:
        cost = 0.0
        for obs in obstacles:
            if not obs.get("in_fov", True):
                continue
            ox = float(obs.get("x", 0.0))
            oz = float(obs.get("z", 0.0))
            dx = y - ox
            dz = x - oz  # ego x is along-track in vehicle frame
            d2 = dx * dx + dz * dz
            if d2 < 1.0:
                d2 = 1.0
            if d2 < 400.0:
                cost += 1.0 / d2
        return cost

    def solve(
        self,
        state: Sequence[float],
        coeffs: np.ndarray,
        obstacles: Optional[Sequence[Dict[str, Any]]] = None,
        ref_v: Optional[float] = None,
        following_gap_s: float = 1.8,
        comfort: float = 0.65,
        sensor_gap: bool = False,
    ) -> Tuple[float, float, List[Dict[str, float]], Dict[str, Any]]:
        """
        state: [x, y, psi, v, cte, epsi] in vehicle frame (x forward, y left).
        returns: steer (rad), accel [-1,1], predicted path, guidance dict
        """
        obstacles = list(obstacles or [])
        x0, y0, psi0, v, cte, epsi = [float(s) for s in state]
        lead = self._lead_in_lane(obstacles)
        ref_v_mps = float(ref_v if ref_v is not None else settings.MPC_REF_SPEED_MPH * 0.44704)
        target_v = self._target_speed_mps(v, ref_v_mps, lead, following_gap_s, sensor_gap)

        comfort = max(0.2, min(0.95, comfort))
        w_a = self.w_a * (0.6 + comfort)
        w_delta = self.w_delta * (0.7 + comfort)

        n_u = 2 * (self.N - 1)
        u0 = self._last_u if self._last_u.size == n_u else np.zeros(n_u)
        bounds = [(-0.35, 0.35)] * (self.N - 1) + [(-1.0, 1.0)] * (self.N - 1)

        def cost_func(u):
            delta = u[: self.N - 1]
            a = u[self.N - 1 :]
            cost = 0.0
            x, y, psi, vv, cte_i, epsi_i = x0, y0, psi0, v, cte, epsi
            for t in range(self.N - 1):
                f0 = np.polyval(coeffs[::-1], x)
                if len(coeffs) > 1:
                    psides0 = math.atan(np.polyder(coeffs[::-1])(x))
                else:
                    psides0 = 0.0
                x_n = x + vv * math.cos(psi) * self.dt
                y_n = y + vv * math.sin(psi) * self.dt
                psi_n = psi - (vv / self.Lf) * delta[t] * self.dt
                v_n = vv + a[t] * 4.0 * self.dt
                cte_n = (f0 - y) + (vv * math.sin(epsi_i) * self.dt)
                epsi_n = (psi - psides0) - (vv / self.Lf) * delta[t] * self.dt
                cost += self.w_cte * cte_n ** 2
                cost += self.w_epsi * epsi_n ** 2
                cost += self.w_v * (v_n - target_v) ** 2
                cost += w_delta * delta[t] ** 2
                cost += w_a * a[t] ** 2
                cost += self.w_obs * self._obstacle_cost(x_n, y_n, obstacles)
                if t < self.N - 2:
                    cost += self.w_delta_d * (delta[t + 1] - delta[t]) ** 2
                    cost += self.w_a_d * (a[t + 1] - a[t]) ** 2
                x, y, psi, vv, cte_i, epsi_i = x_n, y_n, psi_n, v_n, cte_n, epsi_n
            return cost

        res = minimize(
            cost_func,
            u0,
            bounds=bounds,
            method="SLSQP",
            options={"maxiter": 18, "ftol": 1e-3, "disp": False},
        )

        if res.success:
            steer = float(np.clip(res.x[0], -0.35, 0.35))
            accel = float(np.clip(res.x[self.N - 1], -1.0, 1.0))
            self._last_u = res.x
        else:
            # Warm-start PD fallback so Autopilot never freezes.
            steer = float(np.clip(-0.35 * cte - 0.8 * epsi, -0.35, 0.35))
            accel = float(np.clip((target_v - v) * 0.12, -1.0, 1.0))

        self._last_steer = steer
        self._last_a = accel
        path = self._rollout_path(state, steer, accel, coeffs)

        if sensor_gap:
            action, why, conf = "SLOW", "Front sensor gap — Autopilot holding a conservative cruise.", 0.55
        elif lead:
            z = float(lead.get("z", lead.get("distance", 0)))
            if z < 12:
                action, why, conf = "FOLLOW", f"Lead in forward cone at {z:.0f}m — matching speed, holding lane.", 0.82
            else:
                action, why, conf = "FOLLOW", f"Traffic-aware cruise on lead at {z:.0f}m. Side/rear unsensed — no auto lane change.", 0.78
        else:
            action, why, conf = "HOLD_LANE", "Forward cone clear. Autosteer centering lane; side and rear marked unknown.", 0.88

        guidance = {
            "action": action,
            "confidence": round(conf, 2),
            "why": why,
            "sensor_coverage": "front_only",
            "lead_distance_m": round(float(lead.get("z", lead.get("distance", 0))), 1) if lead else None,
            "target_speed_mph": round(target_v * 2.23694, 1),
            "auto_lane_change": False,
        }
        return steer, accel, path, guidance

    def _rollout_path(
        self,
        state: Sequence[float],
        steer: float,
        accel: float,
        coeffs: np.ndarray,
    ) -> List[Dict[str, float]]:
        x, y, psi, v, _, _ = [float(s) for s in state]
        pts = []
        for _ in range(self.N):
            x = x + v * math.cos(psi) * self.dt
            y = y + v * math.sin(psi) * self.dt
            psi = psi - (v / self.Lf) * steer * self.dt
            v = max(0.0, v + accel * 4.0 * self.dt)
            pts.append({"x": round(y, 2), "z": round(x, 2)})
        return pts
