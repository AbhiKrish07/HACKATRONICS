"""
Sensor Simulator Module for AV-01.
Generates scripted and stochastic sensor detection streams with realistic
degradations, including deliberate sensor gap windows, conflicting detection
scenarios, lane-change sim, dedicated Left/Right blind-spot sensors, and an
optional Traffic LLM scene director + Kaggle historical density lookup.
"""

import math
import random
from typing import List, Dict, Any, Optional

from config import settings
from schemas.models import RawDetection, VehicleState


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# 8 sensor zones (now including pure LEFT/RIGHT blind-spot zones).
ZONES = [
    "FRONT", "FRONT_LEFT", "FRONT_RIGHT",
    "LEFT", "RIGHT",
    "BACK", "BACK_LEFT", "BACK_RIGHT",
]

# Lane width in meters (standard US highway lane = 3.7m).
LANE_WIDTH_M = 3.7

# Geodesy helpers (approximations good enough for sim visual placement).
# One degree of latitude ≈ 111320m; longitude shrinks by cos(lat).
_METERS_PER_DEG_LAT = 111320.0
_METERS_PER_DEG_LNG_AT_LAT = lambda lat: 111320.0 * math.cos(math.radians(lat))


def _local_xy_to_geo_offset(dx_m: float, dy_m: float, at_lat: float) -> tuple[float, float]:
    """Local offset (x=right, y=forward in meters) → (delta_lng, delta_lat)."""
    dlat = dy_m / _METERS_PER_DEG_LAT
    dlng = dx_m / _METERS_PER_DEG_LNG_AT_LAT(at_lat)
    return dlng, dlat


class ScenarioGenerator:
    """
    Simulates a sequence of raw sensor detections over time.

    New capabilities over the original version:
      * 8-zone sensor coverage, including dedicated LEFT / RIGHT blind-spot
        sensors (not just the diagonal FRONT_LEFT / FRONT_RIGHT).
      * VehicleState emits lane_idx + num_lanes + lane-change state machine.
      * VehicleState emits pos_lng/pos_lat (slowly drifting near the default
        NYC anchor) so the MapLibre map view has live ego movement.
      * New scenario `kaggle_traffic_llm` uses Kaggle historical density
        (vehicles_per_hour) + light_integration Traffic LLM scene director
        to pick object counts / types / speeds.  Falls back to deterministic
        heuristics when AV01_LOCAL_ONLY is on (no Groq call required).
      * Object rows carry `_sensor_zone` + Kaggle-like object metadata.
    """

    def __init__(self, scenario_type: str = "normal", seed: Optional[int] = 42):
        self.scenario_type = scenario_type
        self.rng = random.Random(seed)
        self.current_tick = 0
        self.vehicle_state = VehicleState()

        # ------------------------------------------------------------------
        # Lane-change state machine (ego).  We keep our own copy because
        # VehicleState is a Pydantic model and we mutate it each tick.
        # ------------------------------------------------------------------
        self._lc_state: str = "IDLE"       # IDLE / SIGNALING / EXECUTING / COMPLETING / ABORTING
        self._lc_target: Optional[int] = None
        self._lc_progress: float = 0.0     # 0..1
        self._lc_timer_ticks: int = 0      # counts ticks spent in the current stage
        self._lc_signal_on: bool = False

        # ------------------------------------------------------------------
        # Traffic LLM + Kaggle scene director (lazy import so scenarios that
        # don't use it still start up even if the integration is missing).
        # ------------------------------------------------------------------
        self._scene_director_initialized = False
        self._traffic_density_provider = None
        self._scene_generator_fn = None
        self._scene_director_note = "unused"

        # Hazards spawned for random/kaggle_llm scenarios persist across ticks
        # so the simulator feels continuous (rather than de-spawning every
        # frame).  Each entry is a dict: {t_birth, type, zone, lane, x, y,
        # vx, vy, life_ticks, degrade}.
        self._live_objects: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Lifecycle helpers
    # ------------------------------------------------------------------

    def reset(self, scenario_type: Optional[str] = None, seed: Optional[int] = None):
        if scenario_type:
            self.scenario_type = scenario_type
        if seed is not None:
            self.rng = random.Random(seed)
        self.current_tick = 0
        self.vehicle_state = VehicleState()
        self._lc_state = "IDLE"
        self._lc_target = None
        self._lc_progress = 0.0
        self._lc_timer_ticks = 0
        self._lc_signal_on = False
        self._live_objects = []

    def _ensure_scene_director(self) -> None:
        """Best-effort hook to Kaggle + Traffic LLM scene director.  Safe to
        call in all environments; degrades gracefully to pure local heuristics
        (no Groq call required when AV01_LOCAL_ONLY=1)."""
        if self._scene_director_initialized:
            return
        try:
            from light_integration import KaggleTrafficDensity, generate_traffic_scene
            self._traffic_density_provider = KaggleTrafficDensity.instance()
            self._scene_generator_fn = generate_traffic_scene
            self._scene_director_note = "kaggle_density + traffic_llm_scene"
        except Exception as e:  # pragma: no cover - integration is optional
            self._traffic_density_provider = None
            self._scene_generator_fn = None
            self._scene_director_note = f"fallback (no light_integration: {e})"
        self._scene_director_initialized = True

    # ------------------------------------------------------------------
    # Feature builder (unchanged behaviour for the existing ML classifier
    # distribution, but now always populates _sensor_zone and lane).
    # ------------------------------------------------------------------

    def generate_raw_features(
        self,
        object_type: str,
        distance: float,
        degrade: bool = False,
        zone: str = "FRONT",
        lane: str = "in_lane",
        pos_local: Optional[Dict[str, float]] = None,
        vel_local: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """
        Creates sensor features matching the ML classifier training
        distribution, and guarantees the new fields (_sensor_zone, _pos_x/y,
        _rel_vx/vy, _lane) always exist so downstream code can rely on them.
        """
        dist_factor = min(1.0, distance / 100.0)
        noise_std = settings.SENSOR_NOISE_DISTANCE_FACTOR * distance

        if object_type == "pedestrian":
            base_size = self.rng.gauss(0.25, 0.05)
            base_aspect = self.rng.gauss(0.35, 0.05)
            base_motion = max(0.0, self.rng.gauss(1.3, 0.3))
            base_conf = self.rng.uniform(0.85, 0.98)
            reflectivity = 0.4
        elif object_type == "vehicle":
            base_size = self.rng.gauss(1.2, 0.15)
            base_aspect = self.rng.gauss(2.0, 0.25)
            base_motion = max(0.0, self.rng.gauss(12.0, 3.0))
            base_conf = self.rng.uniform(0.88, 0.99)
            reflectivity = 0.9
        elif object_type == "cyclist":
            base_size = self.rng.gauss(0.45, 0.06)
            base_aspect = self.rng.gauss(0.65, 0.07)
            base_motion = max(0.0, self.rng.gauss(5.5, 1.2))
            base_conf = self.rng.uniform(0.80, 0.95)
            reflectivity = 0.6
        elif object_type == "static_obstacle":
            base_size = self.rng.gauss(0.8, 0.2)
            base_aspect = self.rng.gauss(1.1, 0.25)
            base_motion = max(0.0, self.rng.gauss(0.05, 0.03))
            base_conf = self.rng.uniform(0.82, 0.96)
            reflectivity = 0.65
        else:
            base_size = self.rng.uniform(0.1, 1.5)
            base_aspect = self.rng.uniform(0.2, 2.5)
            base_motion = self.rng.uniform(0.0, 15.0)
            base_conf = self.rng.uniform(0.40, 0.70)
            reflectivity = 0.5

        if degrade:
            noise_std *= 3.0
            base_conf *= 0.5

        rel_size = max(0.05, base_size + self.rng.gauss(0, noise_std * 0.4))
        aspect_ratio = max(0.1, base_aspect + self.rng.gauss(0, noise_std * 0.5))
        motion_sig = max(0.0, base_motion + self.rng.gauss(0, noise_std * 1.5))
        sensor_conf_raw = max(0.1, min(0.99, base_conf - (dist_factor * 0.35) + self.rng.gauss(0, 0.05)))
        refl_sig = max(0.05, min(0.99, reflectivity - (dist_factor * 0.2) + self.rng.gauss(0, 0.1)))

        pl = pos_local or {"x": 0.0, "y": float(distance), "z": 0.0}
        vl = vel_local or {"vx": 0.0, "vy": (-base_motion if object_type == "pedestrian" else 0.0)}

        return {
            "relative_size": float(rel_size),
            "aspect_ratio": float(aspect_ratio),
            "motion_signature": float(motion_sig),
            "distance": float(distance),
            "sensor_confidence_raw": float(sensor_conf_raw),
            "reflectivity_signal": float(refl_sig),
            "_pos_x": float(pl.get("x", 0.0)),
            "_pos_y": float(pl.get("y", distance)),
            "_pos_z": float(pl.get("z", 0.0)),
            "_rel_vx": float(vl.get("vx", 0.0)),
            "_rel_vy": float(vl.get("vy", 0.0)),
            "_lane": lane,
            "_sensor_zone": zone,
        }

    # ------------------------------------------------------------------
    # Lane-change state machine (ego) + geo advance.
    # ------------------------------------------------------------------

    def _advance_ego_state(self, t: float, dt: float) -> None:
        """Tick the lane-change state machine, advance geo position, update traffic lights & turns."""
        vs = self.vehicle_state

        # Drift position forward based on ego speed (simple bearing 0°).
        dy_m = vs.speed_mps * dt
        dlng, dlat = _local_xy_to_geo_offset(0.0, dy_m, vs.pos_lat)
        vs.pos_lng += dlng
        vs.pos_lat += dlat
        vs.frame_id = self.current_tick

        # --- Traffic Light state machine ---
        vs.traffic_light_dist = max(0.0, vs.traffic_light_dist - dy_m)
        if vs.traffic_light_dist <= 2.0:
            # Cycle signal: GREEN -> YELLOW -> RED -> GREEN
            if vs.traffic_light_state == "GREEN":
                vs.traffic_light_state = "YELLOW"
                vs.traffic_light_dist = 25.0
            elif vs.traffic_light_state == "YELLOW":
                vs.traffic_light_state = "RED"
                vs.traffic_light_dist = 15.0
            else:
                vs.traffic_light_state = "GREEN"
                vs.traffic_light_dist = 130.0

        # --- Open-World Turn & Exit state machine ---
        turn_cycle_tick = (self.current_tick // 60) % 4
        if turn_cycle_tick == 0:
            vs.turn_state = "STRAIGHT"
        elif turn_cycle_tick == 1:
            vs.turn_state = "RIGHT"
        elif turn_cycle_tick == 2:
            vs.turn_state = "LEFT"
        else:
            vs.turn_state = "EXIT"

        # Occasionally trigger an ego lane change: every ~18s in random urban
        # or kaggle_llm scenarios, unless we're already mid-maneuver.
        if self._lc_state == "IDLE":
            trigger_freq = 0.0055 if self.scenario_type in ("random_urban", "kaggle_traffic_llm") else 0.002
            if self.rng.random() < trigger_freq:
                self._begin_lane_change()

        # State machine
        if self._lc_state == "SIGNALING":
            self._lc_signal_on = True
            self._lc_timer_ticks += 1
            if self._lc_timer_ticks >= 12:  # 1.2s at 10Hz
                self._lc_state = "EXECUTING"
                self._lc_timer_ticks = 0
        elif self._lc_state == "EXECUTING":
            self._lc_progress = min(1.0, self._lc_progress + dt / 2.0)  # ~2s maneuver
            self._lc_timer_ticks += 1
            if self._lc_progress >= 1.0:
                self._lc_state = "COMPLETING"
                self._lc_timer_ticks = 0
        elif self._lc_state == "COMPLETING":
            # Settle into target lane.
            if self._lc_target is not None:
                vs.lane_idx = self._lc_target
            self._lc_progress = 0.0
            self._lc_signal_on = False
            self._lc_target = None
            self._lc_state = "IDLE"
            self._lc_timer_ticks = 0
        elif self._lc_state == "ABORTING":
            # Return to origin lane.
            self._lc_progress = max(0.0, self._lc_progress - dt / 1.2)
            self._lc_timer_ticks += 1
            if self._lc_progress <= 0.0:
                self._lc_state = "IDLE"
                self._lc_signal_on = False
                self._lc_target = None
                self._lc_timer_ticks = 0

        # Commit machine state to the data contract.
        vs.lane_change_state = self._lc_state
        vs.lane_change_target_lane = self._lc_target
        vs.lane_change_progress = self._lc_progress
        vs.lane_change_signal_on = self._lc_signal_on
        # Lane position string (for legacy dashboard consumers):
        if self._lc_state != "IDLE":
            if self._lc_progress < 0.33: vs.lane_position = "center"
            elif self._lc_progress < 0.66: vs.lane_position = "shifting"
            else: vs.lane_position = "center"
        else:
            vs.lane_position = "center"

    def _begin_lane_change(self) -> None:
        vs = self.vehicle_state
        candidates = [i for i in range(vs.num_lanes) if i != vs.lane_idx]
        if not candidates:
            return
        self._lc_target = self.rng.choice(candidates)
        self._lc_progress = 0.0
        self._lc_state = "SIGNALING"
        self._lc_timer_ticks = 0
        self._lc_signal_on = True

    # ------------------------------------------------------------------
    # Live-object helper — continuous scenario tracks spawn once & persist
    # for life_ticks ticks, so the dashboard sees smooth motion instead of
    # strobing per-frame spawning.
    # ------------------------------------------------------------------

    def _tick_live_objects(self, dt: float) -> None:
        alive: List[Dict[str, Any]] = []
        for o in self._live_objects:
            o["ticks"] += 1
            o["x"] += o["vx"] * dt
            o["y"] += o["vy"] * dt
            if o["y"] > -5 and o["ticks"] < o["life_ticks"]:
                alive.append(o)
        self._live_objects = alive

    def _maybe_spawn_live_objects_kaggle_llm(self, t: float) -> None:
        """Use Kaggle historical density + Traffic LLM scene director as a
        spawn-rate prior.  All traffic decisions remain local; Groq is used
        only on the heuristic-first scene director path (and is skipped
        entirely when AV01_LOCAL_ONLY=1 or runtime local-only is on)."""
        self._ensure_scene_director()

        # 1) Density prior from Kaggle (or its hardcoded hourly fallback).
        density_vph = 1200  # reasonable default
        if self._traffic_density_provider is not None:
            density_vph = int(self._traffic_density_provider.current().vehicles_per_hour)

        # 2) Spawn rate per tick (10 Hz).  vehicles/sec = vph/3600.  Multiply
        #    by a small factor so we actually see traffic in the limited
        #    forward-range sensor cone.
        vehicles_per_sec = max(0.05, density_vph / 3600.0 * 2.2)
        spawn_prob = min(0.45, vehicles_per_sec * 0.1)  # dt=0.1s at 10Hz

        # 3) Optional scene director from light_integration: use it to bias
        #    object types for this round of spawning.
        type_weights: Dict[str, float] = {
            "vehicle": 0.40,
            "motorcycle": 0.20,
            "auto_rickshaw": 0.15,
            "cow": 0.10,
            "pedestrian": 0.08,
            "cyclist": 0.04,
            "static_obstacle": 0.03
        }
        if self._scene_generator_fn is not None and (self.current_tick % 50 == 0):
            try:
                scene_objects, _meta = self._scene_generator_fn(
                    ego_speed_mph=max(0.0, self.vehicle_state.speed_mps * 2.23694),
                    weather="clear",
                    traffic_volume_vehicles=density_vph,
                    force_groq=False,   # local-only guard already inside
                )
                # Tally object types.
                counts: Dict[str, int] = {}
                for so in scene_objects:
                    k = str(so.get("type", "vehicle")).lower()
                    if k not in type_weights:
                        k = "vehicle"
                    counts[k] = counts.get(k, 0) + 1
                total = sum(counts.values()) or 1
                for k in type_weights:
                    if k in counts:
                        type_weights[k] = 0.5 * type_weights[k] + 0.5 * (counts[k] / total)
            except Exception:
                pass  # never break the pipeline

        if self.rng.random() < spawn_prob:
            # Decide which sensor zone this object is entering through.
            # Mirror existing 6-zone distribution but now also include pure
            # LEFT/RIGHT for blind-spot traffic in ~20% of spawns.
            r = self.rng.random()
            if   r < 0.45: zone, lane_idx0, dx0 = "FRONT",       self.vehicle_state.lane_idx, 0.0
            elif r < 0.55: zone, lane_idx0, dx0 = "FRONT_LEFT",  self.vehicle_state.lane_idx - 1, -LANE_WIDTH_M
            elif r < 0.65: zone, lane_idx0, dx0 = "FRONT_RIGHT", self.vehicle_state.lane_idx + 1,  LANE_WIDTH_M
            elif r < 0.73: zone, lane_idx0, dx0 = "LEFT",        self.vehicle_state.lane_idx - 1, -LANE_WIDTH_M
            elif r < 0.81: zone, lane_idx0, dx0 = "RIGHT",       self.vehicle_state.lane_idx + 1,  LANE_WIDTH_M
            elif r < 0.88: zone, lane_idx0, dx0 = "BACK_LEFT",   self.vehicle_state.lane_idx - 1, -LANE_WIDTH_M
            elif r < 0.95: zone, lane_idx0, dx0 = "BACK_RIGHT",  self.vehicle_state.lane_idx + 1,  LANE_WIDTH_M
            else:          zone, lane_idx0, dx0 = "BACK",        self.vehicle_state.lane_idx, 0.0

            types = list(type_weights.keys())
            weights = [type_weights[t] for t in types]
            obj_type = self.rng.choices(types, weights=weights, k=1)[0]
            # Normalize lane index into the valid range so hazards don't spawn
            # off-road in 3-lane maps.
            lane_idx = max(0, min(self.vehicle_state.num_lanes - 1, int(round(lane_idx0))))
            dx = (lane_idx - self.vehicle_state.lane_idx) * LANE_WIDTH_M

            is_rear = zone.startswith("BACK") or zone in ("LEFT", "RIGHT")
            dist = float(20 + self.rng.random() * (110 if not is_rear else 40))
            y = -dist if is_rear else dist
            vx = self.rng.gauss(0.0, 0.15)
            # Approaching vehicles → vy negative (distance shrinks).
            # Receding vehicles → vy positive.
            vy = self.rng.gauss(-1.2 if not is_rear else 0.9, 0.8)

            lane_str = ("in_lane" if lane_idx == self.vehicle_state.lane_idx
                        else "adjacent_lane" if abs(lane_idx - self.vehicle_state.lane_idx) == 1
                        else "off_road")

            self._live_objects.append({
                "ticks": 0,
                "type": obj_type,
                "zone": zone,
                "source_lane": lane_idx,
                "x": dx + self.rng.gauss(0, 0.3),
                "y": y,
                "vx": vx,
                "vy": vy,
                "lane": lane_str,
                "degrade": self.rng.random() < 0.06,
                "life_ticks": int(20 + self.rng.random() * 90),
            })

    # ------------------------------------------------------------------
    # Helpers to build RawDetection rows from either (a) the scripted
    # scenarios or (b) live objects for the continuous scenarios.
    # ------------------------------------------------------------------

    def _detection_from_zone(
        self,
        obj_type: str,
        distance: float,
        zone: str,
        lane: str,
        pos: Dict[str, float],
        vel: Dict[str, float],
        sensor_id_suffix: str,
        t: float,
        degrade: bool = False,
    ) -> RawDetection:
        feats = self.generate_raw_features(
            object_type=obj_type,
            distance=distance,
            degrade=degrade,
            zone=zone,
            lane=lane,
            pos_local=pos,
            vel_local=vel,
        )
        return RawDetection(
            sensor_id=f"av01_z{sensor_id_suffix}",
            timestamp=t,
            features=feats,
            occupancy_confidence=0.35 if degrade else self.rng.uniform(0.85, 0.98),
        )

    def _live_object_to_detection(self, o: Dict[str, Any], t: float) -> RawDetection:
        distance = math.hypot(o["x"], o["y"])
        pos = {"x": o["x"], "y": o["y"], "z": 0.0}
        vel = {"vx": o["vx"], "vy": o["vy"]}
        zone = o["zone"]
        zone_id = {
            "FRONT": "01_front", "FRONT_LEFT": "02_front_left", "FRONT_RIGHT": "03_front_right",
            "LEFT":  "04_left_blind", "RIGHT": "05_right_blind",
            "BACK":  "06_back",  "BACK_LEFT": "07_back_left",  "BACK_RIGHT": "08_back_right",
        }.get(zone, "01_front")
        return self._detection_from_zone(
            obj_type=o["type"],
            distance=distance,
            zone=zone,
            lane=o["lane"],
            pos=pos,
            vel=vel,
            sensor_id_suffix=zone_id,
            t=t,
            degrade=bool(o.get("degrade", False)),
        )

    # ------------------------------------------------------------------
    # Main step() method.
    # ------------------------------------------------------------------

    def step(self) -> tuple[List[RawDetection], VehicleState]:
        """Advance the simulation by one tick and return raw sensor detections."""
        dt = settings.TICK_INTERVAL_SEC
        t = self.current_tick * dt
        self.current_tick += 1
        self._advance_ego_state(t, dt)
        self._tick_live_objects(dt)

        detections: List[RawDetection] = []

        # ==============================================================
        # Scenario 1: SENSOR_GAP edge case (unchanged grading behaviour)
        # ==============================================================
        if self.scenario_type == "sensor_gap":
            if 25 <= self.current_tick <= 32:
                return detections, self.vehicle_state
            dist = max(15.0, 75.0 - t * 2.0)
            detections.append(self._detection_from_zone(
                "vehicle", distance=dist, zone="FRONT", lane="in_lane",
                pos={"x": 0.0, "y": dist, "z": 0.0}, vel={"vx": 0.0, "vy": -2.0},
                sensor_id_suffix="01_front", t=t,
            ))
            return detections, self.vehicle_state

        # ==============================================================
        # Scenario 2: CONFLICTING_DETECTIONS edge case
        # ==============================================================
        elif self.scenario_type == "conflicting_detections":
            dist_ped = max(12.0, 65.0 - t * 2.5)
            ped_x = max(-1.0, 3.5 - t * 0.4)
            detections.append(self._detection_from_zone(
                "pedestrian", distance=dist_ped, zone="FRONT",
                lane=("in_lane" if abs(ped_x) < 1.8 else "adjacent_lane"),
                pos={"x": ped_x, "y": dist_ped, "z": 0.0},
                vel={"vx": -0.4, "vy": -2.5},
                sensor_id_suffix="01_front", t=t,
            ))
            dist_veh = max(14.0, 80.0 - t * 4.0)
            detections.append(self._detection_from_zone(
                "vehicle", distance=dist_veh, zone="FRONT_LEFT",
                lane="adjacent_lane",
                pos={"x": -3.2, "y": dist_veh, "z": 0.0},
                vel={"vx": 0.2, "vy": -6.0},
                sensor_id_suffix="02_front_left", t=t,
            ))
            return detections, self.vehicle_state

        # ==============================================================
        # Scenario 3: NORMAL
        # ==============================================================
        elif self.scenario_type == "normal":
            dist_lead = max(20.0, 65.0 - t * 1.5)
            detections.append(self._detection_from_zone(
                "vehicle", distance=dist_lead, zone="FRONT", lane="in_lane",
                pos={"x": 0.0, "y": dist_lead, "z": 0.0},
                vel={"vx": 0.0, "vy": -1.5},
                sensor_id_suffix="01_front", t=t,
            ))
            if t >= 2.0:
                dist_cyc = max(10.0, 70.0 - (t - 2.0) * 3.0)
                cx = 2.4 + math.sin(t * 0.6) * 0.4
                detections.append(self._detection_from_zone(
                    "cyclist", distance=dist_cyc, zone="FRONT_RIGHT",
                    lane="adjacent_lane" if cx > 1.8 else "in_lane",
                    pos={"x": cx, "y": dist_cyc, "z": 0.0},
                    vel={"vx": 0.1, "vy": -3.0},
                    sensor_id_suffix="03_front_right", t=t,
                ))
            # 40% of ticks after t>4.0 also include a right blind-spot
            # vehicle: demonstrates the dedicated RIGHT sensor zone for
            # lane-change safety checks (Step 3 + Step 2b integration point).
            if t >= 4.0 and self.rng.random() < 0.4:
                d_r = float(12 + self.rng.random() * 18)
                detections.append(self._detection_from_zone(
                    "vehicle", distance=d_r, zone="RIGHT",
                    lane="adjacent_lane",
                    pos={"x": LANE_WIDTH_M, "y": -d_r + 2, "z": 0.0},
                    vel={"vx": 0.0, "vy": 0.8},
                    sensor_id_suffix="05_right_blind", t=t,
                ))
            return detections, self.vehicle_state

        # ==============================================================
        # Scenario 4: WAYMO_FEED (Waymo Open Dataset Ingestion)
        # ==============================================================
        elif self.scenario_type == "waymo_feed":
            from data.waymo_adapter import waymo_adapter
            self.vehicle_state.dataset_source = "Waymo Open Dataset (Ingested)"
            detections = waymo_adapter.get_av01_detections_for_frame(self.current_tick)
            return detections, self.vehicle_state

        # ==============================================================
        # Scenario 5: RANDOM_URBAN & KAGGLE_TRAFFIC_LLM
        # ==============================================================
        else:
            if self.scenario_type == "kaggle_traffic_llm":
                self._maybe_spawn_live_objects_kaggle_llm(t)
            else:
                # Random urban: simpler stochastic spawn.
                if self.rng.random() < 0.28:
                    n = self.rng.randint(1, 3)
                    for _ in range(n):
                        typ = self.rng.choice(["pedestrian", "vehicle", "cyclist", "static_obstacle"])
                        lane = self.rng.choice(["in_lane", "adjacent_lane", "adjacent_lane"])
                        lanes = [self.vehicle_state.lane_idx + (1 if self.rng.random() < 0.5 else -1)
                                 if lane == "adjacent_lane" else self.vehicle_state.lane_idx]
                        lane_i = max(0, min(self.vehicle_state.num_lanes - 1, lanes[0]))
                        dx = (lane_i - self.vehicle_state.lane_idx) * LANE_WIDTH_M
                        zones = ["FRONT", "FRONT_LEFT", "FRONT_RIGHT", "LEFT", "RIGHT"]
                        z = self.rng.choice(zones)
                        dist = float(max(15.0, 80.0 - (t % 15.0) * 4.0 + self.rng.uniform(-5.0, 5.0)))
                        lane_s = "in_lane" if lane_i == self.vehicle_state.lane_idx else "adjacent_lane"
                        self._live_objects.append({
                            "ticks": 0, "type": typ, "zone": z, "source_lane": lane_i,
                            "x": dx + self.rng.gauss(0, 0.2), "y": dist,
                            "vx": self.rng.uniform(-0.5, 0.5), "vy": -3.5,
                            "lane": lane_s,
                            "degrade": self.rng.random() < 0.10,
                            "life_ticks": int(30 + self.rng.random() * 60),
                        })

            for o in self._live_objects:
                detections.append(self._live_object_to_detection(o, t))
            return detections, self.vehicle_state
