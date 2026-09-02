"""
Learns a Tesla-style Autopilot profile from driver takeovers.
Manual steering, throttle, and following-gap choices update cruise speed,
time-gap, comfort, and overtake preference. Groq summarizes the style.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import settings
from justification.groq_client import GroqJustificationClient

logger = logging.getLogger("av01.driver_learner")


DEFAULT_PROFILE: Dict[str, Any] = {
    "ref_speed_mph": 55.0,
    "following_gap_s": 1.8,
    "comfort": 0.65,
    "overtake_bias": 0.25,
    "brake_aggression": 0.45,
    "interventions": 0,
    "last_summary": "Default Autopilot profile: 55 mph cruise, 1.8s following gap, lane-keep only.",
    "updated_at": 0.0,
}


class DriverLearner:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or (settings.DATA_DIR / "driver_profile.json")
        self.profile = dict(DEFAULT_PROFILE)
        self._recent: List[Dict[str, Any]] = []
        self._load()
        self._groq = GroqJustificationClient()

    def _load(self) -> None:
        try:
            if self.path.exists():
                loaded = json.loads(self.path.read_text())
                self.profile.update(loaded)
        except Exception as e:
            logger.warning(f"Could not load driver profile: {e}")

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.profile, indent=2))
        except Exception as e:
            logger.warning(f"Could not save driver profile: {e}")

    def observe_intervention(
        self,
        speed_mph: float,
        following_distance_m: Optional[float],
        steer: float,
        throttle_intent: str,
    ) -> Dict[str, Any]:
        """Exponentially blend driver takeover into the Autopilot profile."""
        alpha = 0.18
        speed_mph = float(max(20.0, min(80.0, speed_mph)))
        self.profile["ref_speed_mph"] = (1 - alpha) * float(self.profile["ref_speed_mph"]) + alpha * speed_mph

        if following_distance_m and speed_mph > 5:
            speed_mps = speed_mph * 0.44704
            gap_s = max(0.8, min(3.2, following_distance_m / max(speed_mps, 1.0)))
            self.profile["following_gap_s"] = (1 - alpha) * float(self.profile["following_gap_s"]) + alpha * gap_s

        if abs(steer) > 0.12:
            self.profile["overtake_bias"] = min(0.9, float(self.profile["overtake_bias"]) + 0.06)

        if throttle_intent == "brake":
            self.profile["brake_aggression"] = min(0.95, float(self.profile["brake_aggression"]) + 0.05)
            self.profile["comfort"] = max(0.2, float(self.profile["comfort"]) - 0.04)
        elif throttle_intent == "accel":
            self.profile["comfort"] = min(0.9, float(self.profile["comfort"]) + 0.03)

        self.profile["interventions"] = int(self.profile.get("interventions", 0)) + 1
        self.profile["updated_at"] = time.time()

        event = {
            "speed_mph": round(speed_mph, 1),
            "following_distance_m": following_distance_m,
            "steer": round(steer, 3),
            "throttle_intent": throttle_intent,
            "t": time.time(),
        }
        self._recent.append(event)
        self._recent = self._recent[-24:]
        self._save()
        return dict(self.profile)

    async def groq_refresh_summary(self) -> str:
        if not self._recent:
            return str(self.profile.get("last_summary") or DEFAULT_PROFILE["last_summary"])

        parsed = await self._groq.complete_json(
            system_prompt=(
                "You summarize a human driver's Autopilot takeover style for a Tesla-like "
                "front-radar vehicle. Output JSON with keys summary (one sentence) and "
                "recommended_gap_s (number)."
            ),
            user_prompt=json.dumps({
                "profile": {k: self.profile[k] for k in (
                    "ref_speed_mph", "following_gap_s", "comfort", "overtake_bias", "brake_aggression", "interventions"
                )},
                "recent_takeovers": self._recent[-8:],
            }),
            temperature=0.2,
            max_tokens=180,
        )
        if parsed and parsed.get("summary"):
            self.profile["last_summary"] = str(parsed["summary"])[:280]
            if parsed.get("recommended_gap_s"):
                try:
                    gap = float(parsed["recommended_gap_s"])
                    self.profile["following_gap_s"] = max(0.8, min(3.2, gap))
                except (TypeError, ValueError):
                    pass
            self._save()
        return str(self.profile.get("last_summary"))

    def snapshot(self) -> Dict[str, Any]:
        return dict(self.profile)


driver_learner = DriverLearner()
