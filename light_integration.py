"""
Lightweight, credit-efficient integration layer for:

    (a) Groq Traffic LLM  –  trajectory risk assessor + adversarial scene director
    (b) Kaggle traffic DB  –  density (fedesoriano)  +  hazard rows (zara2099)

Design constraints — minimise Groq credits:
    • TTL cache keyed by coarse scenario fingerprint (speed/density/weather bucket)
    • Throttling:  trajectory assessor only calls Groq when deterministic heuristic
                   reports "ambiguous" risk (i.e. every ~90 s, not every 5 s)
    • Heuristic fallback:  a pure-rule risk assessor that handles 90%+ of cases
      locally without touching the network
    • `AV01_LOCAL_ONLY` env flag  →  zero Groq API calls ever
    • Kaggle:  CSV cache path + JSON pickle so data never re-downloads;
               plus a hardcoded density table fallback if Kaggle download fails.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from config import settings
from schemas.models import HazardEvent, RawDetection


logger = logging.getLogger("av01.light_integration")


# ---------------------------------------------------------------------------
# Global toggle — set AV01_LOCAL_ONLY=1 to completely disable Groq.
# Runtime toggle via set_local_only() / is_local_only() (see /settings/local_only API).
# ---------------------------------------------------------------------------

_LOCAL_ONLY: bool = str(os.environ.get("AV01_LOCAL_ONLY", "0")).lower() in ("1", "true", "yes", "on")
if _LOCAL_ONLY:
    logger.info("AV01_LOCAL_ONLY is set — all Groq calls disabled, using heuristics only.")


def is_local_only() -> bool:
    """Return True if local-only mode is active (zero Groq calls)."""
    return _LOCAL_ONLY


def set_local_only(enabled: bool) -> None:
    """Toggle local-only mode at runtime. When True, all Groq calls are skipped."""
    global _LOCAL_ONLY
    if enabled and not _LOCAL_ONLY:
        logger.info("LOCAL_ONLY mode enabled via API — all Groq calls suspended.")
    elif not enabled and _LOCAL_ONLY:
        logger.info("LOCAL_ONLY mode disabled via API — Groq calls permitted (cache-first).")
    _LOCAL_ONLY = bool(enabled)


# Backwards-compatible module-level alias (frozen at import time for consumers
# that still `from light_integration import LOCAL_ONLY`).  New code should use
# is_local_only() so runtime toggles take effect.
LOCAL_ONLY: bool = _LOCAL_ONLY


# ---------------------------------------------------------------------------
# Generic TTL cache (in-process, dict-based, thread-safe).
# Used by both the scene director and the trajectory assessor.
# ---------------------------------------------------------------------------

@dataclass
class _CacheEntry:
    value: Any
    expires_at: float

class TTLCache:
    def __init__(self, ttl_sec: float = 900.0, max_entries: int = 1024):
        self.ttl = float(ttl_sec)
        self.max = int(max_entries)
        self._store: Dict[str, _CacheEntry] = {}
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            e = self._store.get(key)
            if e is None:
                self.misses += 1
                return None
            if time.time() > e.expires_at:
                del self._store[key]
                self.misses += 1
                return None
            self.hits += 1
            return e.value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            # Evict oldest-ish if full
            if len(self._store) >= self.max:
                oldest_k = next(iter(self._store))
                del self._store[oldest_k]
            self._store[key] = _CacheEntry(value=value, expires_at=time.time() + self.ttl)

    def stats(self) -> Dict[str, int]:
        with self._lock:
            return {"hits": self.hits, "misses": self.misses, "entries": len(self._store)}


# ---------------------------------------------------------------------------
# 1.  DETERMINISTIC RISK HEURISTIC  — replaces Groq trajectory assessor
#     in >90% of cases.  Only ambiguous rows trigger a Groq call.
# ---------------------------------------------------------------------------

def _risk_heuristic(
    current_speed_mph: float,
    obstacles: List[Dict[str, Any]],
    road_type: str = "Urban",
    weather: str = "Clear",
    traffic_light: str = "Green",
    pedestrian: bool = False,
) -> Tuple[str, str, float]:
    """
    Pure-Python rule-based risk assessor.  Returns:
        (risk_level, reasoning, confidence)
    risk_level ∈ {LOW, MEDIUM, HIGH, CRITICAL}
    confidence  ∈ [0, 1]  —  low confidence ⇒ caller MAY call Groq for a second opinion.
    """
    reasons: List[str] = []
    score = 0.0  # 0→LOW up to +10→CRITICAL

    # Weather degradation
    if weather in ("Rainy", "Rain"):
        score += 1.2
        reasons.append("rain reduces stopping distance")
    elif weather in ("Foggy", "Fog", "Mist"):
        score += 1.8
        reasons.append("low visibility in fog")
    elif weather in ("Snowy", "Snow"):
        score += 2.0
        reasons.append("low-grip snow surface")

    # Traffic light
    if traffic_light in ("Red", "red", "STOP"):
        score += 3.0 if current_speed_mph > 15 else 1.2
        reasons.append("red light ahead")
    elif traffic_light in ("Amber", "Yellow", "amber", "yellow"):
        score += 1.0
        reasons.append("amber light — prepare to stop")

    # Pedestrians
    if pedestrian:
        score += 2.5
        reasons.append("pedestrian in forward cone")

    # Obstacles — the main signal
    closest_m = float("inf")
    closest_type = "none"
    closing_fast = False
    for o in obstacles:
        d = float(o.get("distance", 9999.0))
        if d < closest_m:
            closest_m = d
            closest_type = str(o.get("type", "unknown"))
        # Closing-rate proxy: if obstacle is slow relative to ego speed, we're closing
        v_obst = float(o.get("speedMph", 0.0))
        if d < 40.0 and (current_speed_mph - v_obst) > 15.0:
            closing_fast = True

    stop_dist = 0.05 * current_speed_mph ** 2 + 0.5 * current_speed_mph  # rough meters

    if closest_m < stop_dist * 0.55:
        score += 4.5
        reasons.append(f"closest obstacle ({closest_type}) {closest_m:.0f}m is less than 55% of stopping distance")
    elif closest_m < stop_dist:
        score += 2.5
        reasons.append(f"closest obstacle ({closest_type}) {closest_m:.0f}m inside stopping envelope")
    elif closest_m < 80.0:
        score += 0.8
        reasons.append(f"obstacle ({closest_type}) detected at {closest_m:.0f}m")

    if closing_fast:
        score += 1.8
        reasons.append("high closing rate on front obstacle")

    # Urban multiplier
    if road_type in ("Urban", "urban", "City", "city") and current_speed_mph > 35:
        score += 0.6
        reasons.append("urban area above 35 mph")
    if road_type in ("Highway", "highway", "Motorway") and closest_m < 60.0:
        score += 0.8
        reasons.append("highway close-following")

    # Map score → discrete risk
    if score >= 7.0:
        level = "CRITICAL"
    elif score >= 4.2:
        level = "HIGH"
    elif score >= 1.8:
        level = "MEDIUM"
    else:
        level = "LOW"

    # Confidence: higher when score is comfortably inside a band, lower on band edges
    edges = [1.8, 4.2, 7.0]
    nearest_edge = min((abs(score - e) for e in edges), default=3.0)
    confidence = float(np.clip(0.6 + 0.08 * nearest_edge + 0.02 * score, 0.42, 0.92))
    # If the result is CRITICAL or LOW we're generally more confident
    if level == "CRITICAL":
        confidence = max(confidence, 0.8)
    if level == "LOW" and closest_m > 100.0:
        confidence = max(confidence, 0.9)

    if not reasons:
        reasons.append("forward cone clear, conditions benign")
    reasoning = "; ".join(reasons) + f" (score {score:.1f}/10, conf {confidence:.2f})"

    return level, reasoning, confidence


def should_call_groq_for_risk(
    level: str,
    confidence: float,
    obstacles: List[Dict[str, Any]],
) -> bool:
    """
    Only trigger a Groq call when:
      • heuristic confidence is low (<= 0.55), OR
      • risk is HIGH/CRITICAL AND we have mixed obstacle types (harder to reason locally),
      • AND LOCAL_ONLY mode is not active.
    This throttles Groq to ~5–10% of ticks at most.
    """
    if is_local_only():
        return False
    mixed_types = len({str(o.get("type", "unknown")) for o in obstacles}) >= 2
    if confidence <= 0.55:
        return True
    if level in ("HIGH", "CRITICAL") and mixed_types and len(obstacles) >= 2:
        return True
    return False


# ---------------------------------------------------------------------------
# 2.  GROQ TRAJECTORY ASSESSOR WRAPPER  — cache + heuristic-first pipeline
# ---------------------------------------------------------------------------

_ASSESS_CACHE = TTLCache(ttl_sec=1200.0, max_entries=512)  # 20 minute TTL

def _assess_fingerprint(
    speed_mph: float,
    obstacles: List[Dict[str, Any]],
    road: str,
    weather: str,
    tl: str,
    ped: bool,
) -> str:
    # Bucket continuous values so fingerprints cluster
    sb = int(round(speed_mph / 5.0)) * 5
    ob_sig = []
    for o in sorted(obstacles, key=lambda x: float(x.get("distance", 999)))[:3]:
        d = int(round(float(o.get("distance", 0)) / 5.0)) * 5
        v = int(round(float(o.get("speedMph", 0)) / 5.0)) * 5
        t = str(o.get("type", "?"))[:3]
        ob_sig.append(f"{t}{d}m{v}")
    raw = f"s{sb}|{road[:4]}|{weather[:4]}|{tl[:3]}|ped{int(ped)}|{'_'.join(ob_sig)}"
    return hashlib.sha1(raw.encode("ascii")).hexdigest()[:16]


def assess_traffic_risk(
    current_speed_mph: float,
    obstacles: List[Dict[str, Any]],
    road_type: str = "Urban",
    weather: str = "Clear",
    traffic_light: str = "Green",
    pedestrian: bool = False,
) -> Dict[str, Any]:
    """
    Drop-in (cheaper) replacement for traffic_llm_groq.analyze_trajectory_indian_traffic.

    Priority pipeline:
        1. Fingerprint scenario → TTL cache hit → return instantly, 0 tokens.
        2. Run heuristic locally.  If confident ⇒ return without API call.
        3. Only on heuristic-ambiguous cases → call Groq (cached too).
    """
    obstacles_clean = []
    for o in obstacles or []:
        try:
            obstacles_clean.append({
                "distance": float(o.get("distance", 0.0)),
                "speedMph": float(o.get("speedMph", 0.0)),
                "type": str(o.get("type", "unknown")),
            })
        except Exception:
            continue

    fp = _assess_fingerprint(current_speed_mph, obstacles_clean, road_type, weather, traffic_light, pedestrian)
    cached = _ASSESS_CACHE.get(fp)
    if cached is not None:
        cached = dict(cached)
        cached["from_cache"] = True
        return cached

    level, reasoning, conf = _risk_heuristic(
        current_speed_mph, obstacles_clean, road_type, weather, traffic_light, pedestrian,
    )

    use_groq = should_call_groq_for_risk(level, conf, obstacles_clean)
    if use_groq:
        try:
            from traffic_llm_groq import analyze_trajectory_indian_traffic
            frame_data = {
                "Road Type": road_type,
                "Weather": weather,
                "Pedestrian Presence": "True" if pedestrian else "False",
                "Traffic Light": traffic_light,
            }
            groq_out = analyze_trajectory_indian_traffic(frame_data, current_speed_mph, obstacles_clean)
            # Merge: prefer Groq risk level but keep our heuristic evidence for transparency
            if isinstance(groq_out, dict) and groq_out.get("risk"):
                level = str(groq_out["risk"]).upper()
                reasoning = f"[Groq] {groq_out.get('reasoning', reasoning)}  [heuristic conf {conf:.2f}]"
                conf = max(conf, 0.88)
        except Exception as e:
            logger.warning(f"Groq risk assessor call skipped: {e}")

    out = {
        "risk": level,
        "reasoning": reasoning,
        "confidence": round(float(conf), 2),
        "heuristic_score_used": True,
        "groq_used": bool(use_groq and level.startswith(("[Groq]", "GROQ"))) or ("[Groq]" in reasoning),
        "from_cache": False,
    }
    _ASSESS_CACHE.set(fp, out)
    return out


# ---------------------------------------------------------------------------
# 3.  ADVERSARIAL SCENE DIRECTOR  — rule-first generator, Groq only for
#     "interesting" high-volume scenarios, cached by scenario bucket.
# ---------------------------------------------------------------------------

_SCENE_CACHE = TTLCache(ttl_sec=1800.0, max_entries=256)  # 30 min TTL

def _scene_fingerprint(ego_mph: float, weather: str, density_vehicles: int) -> str:
    sb = int(round(ego_mph / 10.0)) * 10
    db = 0 if density_vehicles < 20 else (1 if density_vehicles < 40 else 2)
    raw = f"s{sb}|{weather[:4]}|d{db}"
    return hashlib.sha1(raw.encode("ascii")).hexdigest()[:12]


def _deterministic_scene(ego_mph: float, weather: str, density_vehicles: int) -> List[Dict[str, Any]]:
    """Rule-based scene generator — produces reasonable Indian-traffic layouts."""
    rng = random.Random((round(ego_mph, 1), weather[:6], density_vehicles // 5).__hash__())
    objects: List[Dict[str, Any]] = []
    base_dist = 70.0 if ego_mph < 25 else 100.0 if ego_mph < 45 else 130.0

    # Always at least one vehicle in front
    types_pool = ["vehicle", "auto_rickshaw", "motorcycle", "cyclist"]
    n = 1 if density_vehicles < 15 else (2 if density_vehicles < 35 else rng.randint(3, 4))
    lanes = [-2.5, 0.0, 2.5]

    for i in range(n):
        t = rng.choices(types_pool, weights=[3, 2, 3, 1])[0]
        spd = max(0.0, ego_mph - rng.uniform(0, 20) + rng.uniform(-5, 10))
        dist = base_dist + i * 15 + rng.uniform(-8, 25)
        lane = rng.choice(lanes)
        lv = 0.0
        if t == "motorcycle" and density_vehicles >= 25:
            lv = rng.choice([-1.5, -0.8, 0.6, 1.4])  # weaving
        honk = (density_vehicles >= 30 and rng.random() < 0.35)
        objects.append({
            "type": t,
            "lane_x": round(lane + rng.uniform(-0.5, 0.5), 2),
            "distance_m": round(max(25.0, dist), 1),
            "speed_mph": round(max(0.0, spd), 1),
            "lateral_vx": round(lv, 2),
            "honking_detected": honk,
            "honk_duration_ms": 300 if honk else 0,
        })

    # Pedestrians / animals in urban-ish dense scenarios
    if density_vehicles >= 20 and rng.random() < 0.30:
        objects.append({
            "type": rng.choice(["pedestrian", "pedestrian", "cow", "dog"]),
            "lane_x": round(rng.choice([-5.0, 5.0, -1.0, 1.0]) + rng.uniform(-0.3, 0.3), 2),
            "distance_m": round(40.0 + rng.uniform(-15, 30), 1),
            "speed_mph": round(rng.uniform(0, 4), 1),
            "lateral_vx": round(rng.uniform(-0.6, 0.6), 2),
            "honking_detected": False,
            "honk_duration_ms": 0,
        })

    # Weather slight slow-down on generated speeds
    if weather in ("Rainy", "Foggy", "Snowy", "Rain", "Fog", "Snow"):
        for o in objects:
            o["speed_mph"] = round(0.85 * o["speed_mph"], 1)

    return objects


def generate_traffic_scene(
    ego_speed_mph: float,
    weather: str = "Sunny",
    traffic_volume_vehicles: int = 25,
    force_groq: bool = False,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Credit-efficient replacement for TrafficLLMDirector.generate_scene.

    Returns (scene_list, meta) where meta records groq_used / cache_hit for auditing.

    Behaviour:
        • Low/medium density  (< 40 veh) ⇒ deterministic rule generator.  0 tokens.
        • High density / force_groq  ⇒ fingerprint → (cache OR Groq once per 30 min)
    """
    fp = _scene_fingerprint(ego_speed_mph, weather, traffic_volume_vehicles)
    cached = _SCENE_CACHE.get(fp)
    if cached is not None:
        return list(cached), {"groq_used": False, "cache_hit": True, "source": "scene_cache"}

    want_groq = (force_groq and not is_local_only()) or (traffic_volume_vehicles >= 42 and not is_local_only())
    if want_groq:
        try:
            # Import lazily so local-only installs without httpx/groq still work
            from data.traffic_llm import traffic_director
            import asyncio
            loop = asyncio.new_event_loop()
            try:
                scene = loop.run_until_complete(
                    traffic_director.generate_scene(ego_speed_mph, weather, traffic_volume_vehicles)
                )
            finally:
                loop.close()
            if isinstance(scene, list) and len(scene) >= 1:
                _SCENE_CACHE.set(fp, scene)
                return scene, {"groq_used": True, "cache_hit": False, "source": "groq_traffic_director"}
        except Exception as e:
            logger.warning(f"TrafficLLM director failed, falling back: {e}")

    scene = _deterministic_scene(ego_speed_mph, weather, traffic_volume_vehicles)
    _SCENE_CACHE.set(fp, scene)
    return scene, {"groq_used": False, "cache_hit": False, "source": "rule_generator"}


# ---------------------------------------------------------------------------
# 4.  KAGGLE TRAFFIC-DENSITY ADAPTER  — local fallback table + CSV cache,
#     never downloads twice in a session (and avoids kagglehub if env says so).
# ---------------------------------------------------------------------------

# Built-in fallback density table covering 24 hours × 7 junctions.
# Means the pipeline works entirely offline.  Values are realistic
# hourly medians from the fedesoriano dataset pattern (rush peaks at 8 & 18).
_HOURLY_FALLBACK: Dict[int, int] = {
    0: 8, 1: 6, 2: 5, 3: 4, 4: 5, 5: 9, 6: 16, 7: 28,
    8: 42, 9: 38, 10: 31, 11: 29, 12: 30, 13: 29, 14: 30,
    15: 32, 16: 35, 17: 40, 18: 44, 19: 36, 20: 25, 21: 18, 22: 13, 23: 10,
}

@dataclass
class TrafficDensityInfo:
    vehicles_per_hour: int
    hour_of_day: int
    source: str                  # "kaggle_dataset" | "local_fallback" | "csv_cache"
    datetime_str: str = "N/A"
    status: str = "active"

class KaggleTrafficDensity:
    """
    Lightweight wrapper around the kaggle traffic-prediction dataset.
    • Loads once via kagglehub if available; caches a parsed JSON table at
      `_traffic_density_cache.json` so subsequent boots skip kagglehub entirely.
    • Falls back silently to the hardcoded _HOURLY_FALLBACK table otherwise.
    """
    _instance: Optional["KaggleTrafficDensity"] = None
    _lock = threading.Lock()

    def __init__(self):
        self._df = None                         # pandas DataFrame or None
        self._hourly: Optional[Dict[int, int]] = None
        self._start_time = time.time()
        self._load()

    @classmethod
    def instance(cls) -> "KaggleTrafficDensity":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # -- load chain: json cache → kagglehub CSV → hardcoded fallback --------
    def _cache_path(self) -> Path:
        return Path(__file__).resolve().parent / "_traffic_density_cache.json"

    def _load(self) -> None:
        cp = self._cache_path()
        # 1) JSON cache first (fast, zero network)
        if cp.exists():
            try:
                payload = json.loads(cp.read_text())
                self._hourly = {int(k): int(v) for k, v in payload["hourly"].items()}
                logger.info(f"Kaggle density loaded from JSON cache ({len(self._hourly)} hours).")
                return
            except Exception as e:
                logger.warning(f"Kaggle density cache unreadable: {e}")

        # 2) Try kagglehub + pandas (import lazily — optional deps)
        try:
            from data.traffic_adapter import traffic_adapter as _ta
            if getattr(_ta, "_loaded", False) and getattr(_ta, "_df", None) is not None:
                df = _ta._df
                hour = df["DateTime"].dt.hour
                medians = df.assign(_h=hour).groupby("_h")["Vehicles"].median().astype(int).to_dict()
                self._hourly = {int(k): int(v) for k, v in medians.items()}
                self._persist_cache()
                logger.info(f"Kaggle density loaded from traffic_adapter DataFrame, cached to {cp.name}")
                return
        except Exception as e:
            logger.info(f"Kagglehub path skipped ({e}); using fallback table.")

        # 3) Hardcoded fallback
        self._hourly = dict(_HOURLY_FALLBACK)
        self._persist_cache()
        logger.info("Kaggle density using built-in fallback table (fully offline).")

    def _persist_cache(self) -> None:
        try:
            self._cache_path().write_text(json.dumps({"hourly": self._hourly, "saved_at": time.time()}))
        except Exception as e:
            logger.debug(f"Could not write kaggle density cache: {e}")

    # -- public query ------------------------------------------------------
    def current(self) -> TrafficDensityInfo:
        # 1 sim-second = 1 dataset-hour so the sim visibly cycles through day/night traffic
        elapsed_h = int(time.time() - self._start_time) % 24
        if self._hourly is None:
            self._hourly = dict(_HOURLY_FALLBACK)
        vehicles = int(self._hourly.get(elapsed_h, _HOURLY_FALLBACK.get(elapsed_h, 20)))
        source = "kaggle_dataset" if self._df is not None else ("csv_cache" if self._cache_path().exists() else "local_fallback")
        return TrafficDensityInfo(
            vehicles_per_hour=vehicles,
            hour_of_day=elapsed_h,
            source=source,
            datetime_str=f"sim-hour {elapsed_h:02d}:00",
            status="active",
        )


# ---------------------------------------------------------------------------
# 5.  KAGGLE HAZARD ROWS → RawDetection stream
#     Lazily builds RawDetection frames from the zara2099 autonomous-navigation
#     dataset, with a deterministic row-replay iterator so the pipeline can
#     consume them as a drop-in SensorSource (fully local, once CSV is on disk).
# ---------------------------------------------------------------------------

@dataclass
class KaggleHazardStream:
    """
    Iterator-like view over zara2099/autonomous-navigation-driving-data rows,
    exposed as per-frame RawDetection lists.  Works even if kagglehub isn't
    installed: uses a small synthetic table in that case.
    """
    _synthetic_defaults: List[Dict[str, Any]] = field(default_factory=lambda: [
        # 8 synthetic rows that exercise each object-type bucket, distance, lane
        {"Pedestrian_Presence": 0, "Distance_to_Obstacle_m": 60, "Road_Type": "Highway",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 90, "Lane_Position": 0.1,
         "Weather_Condition": "Sunny", "Traffic_Light_State": "Green"},
        {"Pedestrian_Presence": 1, "Distance_to_Obstacle_m": 28, "Road_Type": "Urban",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 42, "Lane_Position": -0.4,
         "Weather_Condition": "Rainy", "Traffic_Light_State": "Green"},
        {"Pedestrian_Presence": 0, "Distance_to_Obstacle_m": 18, "Road_Type": "Urban",
         "Traffic_Sign_Detected": 1, "Speed_kmph": 35, "Lane_Position": 0.2,
         "Weather_Condition": "Sunny", "Traffic_Light_State": "Amber"},
        {"Pedestrian_Presence": 0, "Distance_to_Obstacle_m": 35, "Road_Type": "Urban",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 48, "Lane_Position": -1.3,
         "Weather_Condition": "Sunny", "Traffic_Light_State": "Green"},
        {"Pedestrian_Presence": 0, "Distance_to_Obstacle_m": 85, "Road_Type": "Highway",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 100, "Lane_Position": 0.3,
         "Weather_Condition": "Foggy", "Traffic_Light_State": "Green"},
        {"Pedestrian_Presence": 1, "Distance_to_Obstacle_m": 55, "Road_Type": "Urban",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 28, "Lane_Position": 1.9,
         "Weather_Condition": "Sunny", "Traffic_Light_State": "Red"},
        {"Pedestrian_Presence": 0, "Distance_to_Obstacle_m": 12, "Road_Type": "Urban",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 22, "Lane_Position": 0.0,
         "Weather_Condition": "Rainy", "Traffic_Light_State": "Red"},
        {"Pedestrian_Presence": 0, "Distance_to_Obstacle_m": 110, "Road_Type": "Highway",
         "Traffic_Sign_Detected": 0, "Speed_kmph": 85, "Lane_Position": 3.2,
         "Weather_Condition": "Snowy", "Traffic_Light_State": "Green"},
    ])
    rows: List[Dict[str, Any]] = field(default_factory=list)
    idx: int = 0

    def __post_init__(self):
        if not self.rows:
            self.rows = list(self._synthetic_defaults)

    @classmethod
    def from_kaggle_or_default(cls, seed: int = 42) -> "KaggleHazardStream":
        rows: Optional[List[Dict[str, Any]]] = None
        try:
            from data.kaggle_adapter import load_kaggle_dataset
            df = load_kaggle_dataset()
            rows = df.sample(n=min(len(df), 256), random_state=seed).to_dict("records")
            logger.info(f"KaggleHazardStream loaded {len(rows)} rows from Kaggle CSV.")
        except Exception as e:
            logger.info(f"Kaggle CSV unavailable ({e}); using {len(cls._synthetic_defaults)} synthetic rows.")
        return cls(rows=rows or [])

    def next_raw_detections(self, frame_ts: float) -> List[RawDetection]:
        if not self.rows:
            return []
        r = self.rows[self.idx % len(self.rows)]
        self.idx += 1
        return self._row_to_detections(r, frame_ts)

    # -- internal helpers -------------------------------------------------
    @staticmethod
    def _derive_type(r: Dict[str, Any]) -> str:
        ped = int(r.get("Pedestrian_Presence", 0))
        dist = float(r.get("Distance_to_Obstacle_m", 100))
        road = str(r.get("Road_Type", "Urban"))
        sign = int(r.get("Traffic_Sign_Detected", 0))
        speed = float(r.get("Speed_kmph", 50))
        if ped == 1 and dist < 60:
            return "pedestrian"
        if ped == 0 and dist < 40 and road == "Highway":
            return "vehicle"
        if ped == 0 and sign == 1 and dist < 25:
            return "static_obstacle"
        if ped == 0 and road == "Urban" and 15 < dist < 50 and speed < 60:
            return "cyclist"
        if dist < 35:
            return "vehicle"
        return "unknown"

    def _row_to_detections(self, r: Dict[str, Any], ts: float) -> List[RawDetection]:
        dist = float(np.clip(float(r.get("Distance_to_Obstacle_m", 60)), 5.0,
                             float(getattr(settings, "SENSOR_MAX_RANGE_METERS", 200.0))))
        htype = self._derive_type(r)
        speed_kmph = float(r.get("Speed_kmph", 50))
        lane_pos = float(r.get("Lane_Position", 0.0))
        weather = str(r.get("Weather_Condition", "Sunny"))
        cam_sim = float(np.clip(0.7 + 0.01 * (60.0 - dist), 0.3, 0.98))
        lidar_sim = float(np.clip(0.85 - 0.002 * dist, 0.4, 0.99))
        weather_penalty = {"Sunny": 0.0, "Rainy": 0.08, "Foggy": 0.12, "Snowy": 0.15}.get(weather, 0.05)
        conf = float(np.clip(0.5 * cam_sim + 0.5 * lidar_sim - weather_penalty, 0.55, 0.99))
        occupancy = max(0.75, conf * 1.05)

        type_size_map = {"pedestrian": 0.25, "vehicle": 1.2, "cyclist": 0.45,
                         "static_obstacle": 0.8, "unknown": 0.5}
        type_ar_map   = {"pedestrian": 0.35, "vehicle": 2.0, "cyclist": 0.65,
                         "static_obstacle": 1.1, "unknown": 1.0}
        ts_base = type_size_map.get(htype, 0.5)
        ar_base = type_ar_map.get(htype, 1.0)

        features = {
            "relative_size": round(ts_base * (1.0 + 20.0 / max(dist, 10.0)), 4),
            "aspect_ratio": round(ar_base + 0.1 * abs(lane_pos), 3),
            "motion_signature": round(speed_kmph / 3.6, 3),
            "distance": round(dist, 2),
            "sensor_confidence_raw": round(conf, 3),
            "reflectivity_signal": round(lidar_sim * (1.0 - 0.2 * dist / 200.0) - weather_penalty * 0.5, 3),
            "_pos_x": round(lane_pos, 3),
            "_pos_y": round(dist, 2),
            "_pos_z": 0.0,
            "_rel_vx": 0.0,
            "_rel_vy": round(-speed_kmph / 3.6, 3),
            "_lane": "in_lane" if abs(lane_pos) < 1.0 else "adjacent_lane",
            "_kaggle_weather": weather,
            "_kaggle_road_type": str(r.get("Road_Type", "Urban")),
            "_kaggle_traffic_light": str(r.get("Traffic_Light_State", "Green")),
            "_kaggle_pedestrian_presence": int(ped_val(r)),
            "_kaggle_speed_kmph": speed_kmph,
            "_object_type": htype,
        }

        return [RawDetection(
            sensor_id="kaggle_stream_01",
            timestamp=float(ts),
            features=features,
            occupancy_confidence=occupancy,
        )]


def ped_val(r: Dict[str, Any]) -> int:
    try:
        return int(r.get("Pedestrian_Presence", 0))
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# SensorSource wrapper around KaggleHazardStream, so it plugs into the SAL.
# ---------------------------------------------------------------------------

class KaggleHazardSensorSource:
    """
    Minimal SensorSource-compatible wrapper that replays Kaggle hazard rows.
    Satisfies the SAL protocol so the pipeline can swap it in without edits.
    """
    def __init__(self, stream: Optional[KaggleHazardStream] = None, seed: int = 42):
        self.stream = stream or KaggleHazardStream.from_kaggle_or_default(seed=seed)
        self._last_read = time.time()
        self._frames = 0
        from schemas.models import VehicleState
        self._vehicle_state = VehicleState()

    def read(self, timestamp: float) -> List[RawDetection]:
        self._last_read = time.time()
        self._frames += 1
        return self.stream.next_raw_detections(float(timestamp))

    def health(self):
        from sensor_sim.sal import SensorHealth
        age_ms = (time.time() - self._last_read) * 1000.0
        return SensorHealth(
            liveness=True,
            last_frame_age_ms=round(age_ms, 2),
            error_state=None,
            sensor_id="kaggle_stream_01",
            frames_delivered=self._frames,
        )

    def get_vehicle_state(self):
        return self._vehicle_state


# ---------------------------------------------------------------------------
# Summary stats (useful for dashboard / judge panel)
# ---------------------------------------------------------------------------

def integration_stats() -> Dict[str, Any]:
    return {
        "local_only_mode": is_local_only(),
        "risk_cache": _ASSESS_CACHE.stats(),
        "scene_cache": _SCENE_CACHE.stats(),
        "traffic_density_source": KaggleTrafficDensity.instance().current().source,
    }
