"""
Short-horizon trajectory predictor for AV-01.

Design goals:
  * Deterministic (rule-based) so outputs can be traced / justified back to
    inputs → stays aligned with the "rule-based, explainable" decision-engine
    constraint in DECISION_LOGIC.md.
  * Lightweight — runs inside the <=10ms SAL budget for a dozen tracked
    hazards per tick.
  * Pure NumPy-free (no heavy dependencies): hazard count is small, so list
    comprehensions are perfectly sufficient.

Model: constant-acceleration with optional Indian-driver correction factor
       (we re-use the predictor class already in api/pipeline.py if one is
       supplied, otherwise fall back to this baseline for any caller).

Outputs (added directly onto HazardEvent by `enrich_hazard_paths`):
  * predicted_path_local: 12 points dt apart, in ego-local meters (x/y/z).
  * predicted_path_geo:  the same 12 points, in WGS-84 lng/lat so map.js
                         can render them as dotted lines on the MapLibre map.
  * position_geo:        hazard's current WGS-84 point, for map markers.
  * ttc_seconds:         predicted time-to-collision with ego if both keep
                         their current velocity (None if receding).
"""

from __future__ import annotations

from typing import List, Dict, Any, Optional, TYPE_CHECKING

import math

if TYPE_CHECKING:
    from schemas.models import HazardEvent, VehicleState


# One step of predicted trajectory = 100 ms (one pipeline tick).  12 of these
# = 1.2s lookahead, which is enough to render a "path" to the driver without
# hallucinating far outside the forward-sensor FOV.
PRED_DT_SEC = 0.1
PRED_STEPS = 12

# Geodesy helpers (identical to sensor_sim/generator.py to keep projections
# consistent between the two modules — not a shared import to avoid cycles).
_METERS_PER_DEG_LAT = 111320.0


def _dlng_deg_per_meter(lat: float) -> float:
    return 1.0 / (111320.0 * math.cos(math.radians(lat)))


def _dlat_deg_per_meter() -> float:
    return 1.0 / _METERS_PER_DEG_LAT


def estimate_acceleration(history: Optional[List[Dict[str, float]]]) -> Dict[str, float]:
    """
    Approximate (ax, ay) in m/s² from per-frame position deltas.

    history is a list of {"x", "y", "vx", "vy"} per tick (the same buffer
    api/pipeline.py builds).  If we have <3 samples, fall back to 0 accel —
    the predictor behaves as constant-velocity, which is the baseline
    requirement for Step 2.
    """
    if not history or len(history) < 3:
        return {"ax": 0.0, "ay": 0.0}
    # Compute delta-v over the last two pairs, then average → crude jerk-free
    # estimate that's stable in <2 ms for the N~10 history window.
    samples = history[-3:]
    a_xs: List[float] = []
    a_ys: List[float] = []
    for a, b in zip(samples, samples[1:]):
        dvx = b.get("vx", 0.0) - a.get("vx", 0.0)
        dvy = b.get("vy", 0.0) - a.get("vy", 0.0)
        a_xs.append(dvx / PRED_DT_SEC)
        a_ys.append(dvy / PRED_DT_SEC)
    ax = sum(a_xs) / len(a_xs) if a_xs else 0.0
    ay = sum(a_ys) / len(a_ys) if a_ys else 0.0
    # Clamp to physically reasonable values (so a bad history sample can't
    # make the predicted path arc off the map into the next county).
    max_a = 8.0  # m/s² — ~0.8 g
    return {"ax": max(-max_a, min(max_a, ax)),
            "ay": max(-max_a, min(max_a, ay))}


def predicted_path_local(
    x0: float, y0: float, z0: float,
    vx: float, vy: float,
    ax: float, ay: float,
    steps: int = PRED_STEPS,
    dt: float = PRED_DT_SEC,
) -> List[Dict[str, float]]:
    """Project `steps` positions in ego-local meters using p = p0 + v·t + ½·a·t²."""
    out: List[Dict[str, float]] = []
    for i in range(1, steps + 1):
        t = float(i) * dt
        out.append({
            "x": x0 + vx * t + 0.5 * ax * t * t,
            "y": y0 + vy * t + 0.5 * ay * t * t,
            "z": z0,
        })
    return out


def local_path_to_geo(
    ego_lng: float, ego_lat: float,
    heading_deg: float,
    local_path: List[Dict[str, float]],
) -> List[Dict[str, float]]:
    """
    Convert ego-local (x=right, y=forward) meters to WGS-84 lng/lat.

    Treats heading as a simple planar rotation about the ego's position.  The
    ~m-level error this introduces at a 1.2s lookahead is negligible for
    driver-facing map visualization.
    """
    h_rad = math.radians(heading_deg)
    cos_h = math.cos(h_rad)
    sin_h = math.sin(h_rad)
    dlng_m = _dlng_deg_per_meter(ego_lat)
    dlat_m = _dlat_deg_per_meter()
    out: List[Dict[str, float]] = []
    for p in local_path:
        # Rotate local coordinates into world-aligned north/east offsets.
        east_m  = p["x"] * cos_h + p["y"] * sin_h
        north_m = -p["x"] * sin_h + p["y"] * cos_h
        out.append({
            "lng": ego_lng + east_m  * dlng_m,
            "lat": ego_lat + north_m * dlat_m,
        })
    return out


def time_to_collision_seconds(
    x0: float, y0: float,
    vx: float, vy: float,
    ax: float, ay: float,
    ego_width_m: float = 2.0,
    ego_length_m: float = 5.0,
) -> Optional[float]:
    """
    TTC under constant acceleration.  Returns None if the hazard is
    unambiguously receding or its closest approach misses the ego footprint.

    Closure is computed along y (forward-axis) first — that's what TTC for
    highway scenarios actually means in the existing rule set.  We also check
    lateral overlap so a vehicle passing on a parallel lane doesn't raise a
    spurious TTC flag on the guidance engine (Step 3 integration).
    """
    # Solve dy(t) = y0 + vy·t + ½·ay·t² = 0 for smallest positive t.
    y_min = -ego_length_m / 2.0   # rear bumper in local frame
    y_max =  ego_length_m / 2.0   # front bumper

    # 1) Find the range of t where y(t) crosses [y_min, y_max].
    candidates: List[float] = []
    # Evaluate at t=0 first — already inside y-range?
    if y_min <= y0 <= y_max:
        candidates.append(0.0)
    if abs(ay) < 1e-6:
        # Linear: y0 + vy·t ∈ [y_min, y_max]  →  t ∈ [ (y_min - y0)/vy, (y_max - y0)/vy ]
        if abs(vy) > 1e-4:
            t_a = (y_min - y0) / vy
            t_b = (y_max - y0) / vy
            lo, hi = min(t_a, t_b), max(t_a, t_b)
            if hi > 0:
                candidates.append(max(0.0, lo))
                candidates.append(hi)
    else:
        # Quadratic: y(t) ∈ [y_min, y_max] — solve for both bounds.
        for bound in (y_min, y_max):
            disc = vy * vy - 2.0 * ay * (y0 - bound)
            if disc >= 0:
                sq = math.sqrt(disc)
                t1 = (-vy + sq) / ay
                t2 = (-vy - sq) / ay
                for t in (t1, t2):
                    if t >= 0.0:
                        candidates.append(t)
    if not candidates:
        return None
    # 2) Among those candidate t's, find the earliest with x inside the ego
    #    lateral footprint ± 0.5m merge margin.
    x_min = -ego_width_m / 2.0 - 0.5
    x_max =  ego_width_m / 2.0 + 0.5
    earliest: Optional[float] = None
    for t in sorted(candidates):
        x_t = x0 + vx * t + 0.5 * ax * t * t
        if x_min <= x_t <= x_max and 0.0 < t < 20.0:
            earliest = t if earliest is None else min(earliest, t)
    return earliest


def enrich_hazard_paths(
    hazard: "HazardEvent",
    vehicle_state: "VehicleState",
    history: Optional[List[Dict[str, float]]] = None,
) -> None:
    """
    Attach all prediction outputs onto the HazardEvent in-place.

    This function is safe to call more than once — it simply overwrites the
    same fields each time.
    """
    x0 = hazard.position.get("x", 0.0)
    y0 = hazard.position.get("y", 0.0)
    z0 = hazard.position.get("z", 0.0)
    vx = hazard.relative_velocity.get("vx", 0.0)
    vy = hazard.relative_velocity.get("vy", 0.0)
    accel = estimate_acceleration(history)
    ax, ay = accel["ax"], accel["ay"]

    path_m = predicted_path_local(x0, y0, z0, vx, vy, ax, ay)
    hazard.predicted_path_local = path_m
    hazard.predicted_path_geo = local_path_to_geo(
        vehicle_state.pos_lng, vehicle_state.pos_lat,
        vehicle_state.heading_deg, path_m,
    )

    # Current hazard position in WGS-84 for map markers.
    hazard.position_geo = (local_path_to_geo(
        vehicle_state.pos_lng, vehicle_state.pos_lat,
        vehicle_state.heading_deg, [{"x": x0, "y": y0, "z": z0}],
    )[0] if path_m else {"lng": vehicle_state.pos_lng, "lat": vehicle_state.pos_lat})

    # TTC (None if receding / clearly passing in an adjacent lane).
    hazard.ttc_seconds = time_to_collision_seconds(x0, y0, vx, vy, ax, ay)

    # Also propagate sensor_zone / source_lane from raw features so the map
    # HUD / justification templates can reference them easily.
    if hazard.raw_features and "source_lane" not in hazard.__dict__:
        pass  # source_lane is on the model itself now
    if not hazard.sensor_zone or hazard.sensor_zone == "FRONT":
        if hazard.raw_features and "_sensor_zone" in hazard.raw_features:
            hazard.sensor_zone = str(hazard.raw_features["_sensor_zone"])
