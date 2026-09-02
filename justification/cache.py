"""
In-memory LRU/TTL Cache for Justifications.
Reuses generated justifications for identical/steady-state hazard profiles to eliminate redundant API calls.
"""

import time
from typing import Optional, Dict, Tuple
from config import settings
from schemas.models import RiskAssessment


class JustificationCache:
    """
    Time-to-Live (TTL) cache keyed by quantized hazard signature.
    """
    def __init__(self, ttl_seconds: Optional[float] = None):
        self.ttl = ttl_seconds if ttl_seconds is not None else settings.LLM_CACHE_TTL_SECONDS
        self._cache: Dict[str, Tuple[str, float]] = {}  # key -> (reasoning, timestamp)

    def _make_key(self, assessment: RiskAssessment) -> str:
        snap = assessment.hazard_snapshot or {}
        obj_type = str(snap.get("type", "unknown"))
        dist = float(snap.get("distance_m", 0.0))
        # Quantize distance to 2-meter buckets to absorb minor sensor jitter
        quantized_dist = round(dist / 2.0) * 2
        closing_v = round(float(snap.get("closing_velocity_mps", 0.0)), 0)
        lane = str(snap.get("lane_relevance", "in_lane"))
        level = assessment.risk_level

        return f"{obj_type}:{level}:{quantized_dist}:{closing_v}:{lane}"

    def get(self, assessment: RiskAssessment) -> Optional[str]:
        key = self._make_key(assessment)
        if key in self._cache:
            reasoning, cached_time = self._cache[key]
            if time.time() - cached_time < self.ttl:
                return reasoning
            else:
                del self._cache[key]
        return None

    def set(self, assessment: RiskAssessment, reasoning: str) -> None:
        key = self._make_key(assessment)
        self._cache[key] = (reasoning, time.time())

    def clear(self) -> None:
        self._cache.clear()
