"""
Graceful Degradation Manager for AV-01.
Implements staged shutdown: Level 0 (Nominal) → Level 4 (Manual Override).
Automatically detects system failures and escalates/de-escalates degradation level.
"""

import time
import logging
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

logger = logging.getLogger("av01.degradation")


@dataclass
class DegradationState:
    level: int = 0
    level_name: str = "nominal"
    since: float = field(default_factory=time.time)
    reason: str = ""
    llm_enabled: bool = True
    low_confidence_dropped: bool = False
    new_detections_rejected: bool = False
    manual_override: bool = False


class DegradationManager:
    """
    Manages system health through 5 degradation levels.

    Level 0 — NOMINAL: All systems active (full analysis + LLM justification)
    Level 1 — SINGLE_FAULT: One subsystem down. Skip LLM, use templates.
    Level 2 — DEGRADED_PERCEPTION: Multiple failures. High-confidence detections only.
    Level 3 — MINIMAL: Stop accepting new detections, coast on last-known state.
    Level 4 — MANUAL_OVERRIDE: Hand off to human, log everything, escalate.
    """

    LEVEL_NAMES = {
        0: "nominal",
        1: "single_fault",
        2: "degraded_perception",
        3: "minimal_functionality",
        4: "manual_override"
    }

    def __init__(self):
        self.state = DegradationState()
        self.history: list = []
        self._consecutive_errors: int = 0
        self._error_window: list = []  # timestamps of recent errors

    def evaluate(
        self,
        perception_degraded: bool = False,
        model_unavailable: bool = False,
        llm_degraded: bool = False,
        sensor_gap_active: bool = False,
        pipeline_exception: bool = False,
        latency_breach: bool = False
    ) -> DegradationState:
        """
        Evaluates current system health and adjusts degradation level.
        Called once per pipeline tick.
        """
        now = time.time()

        # Track errors for windowed escalation
        if pipeline_exception:
            self._error_window.append(now)
            self._consecutive_errors += 1
        else:
            self._consecutive_errors = 0

        # Prune old errors (30-second window)
        self._error_window = [t for t in self._error_window if now - t < 30.0]

        # Determine target level
        fault_count = sum([
            perception_degraded,
            model_unavailable,
            llm_degraded,
            sensor_gap_active,
            pipeline_exception,
            latency_breach
        ])

        if self._consecutive_errors >= 10 or len(self._error_window) >= 20:
            target_level = 4
            reason = f"catastrophic: {self._consecutive_errors} consecutive errors"
        elif fault_count >= 3 or (sensor_gap_active and model_unavailable):
            target_level = 3
            reason = f"multiple_critical_faults ({fault_count} active)"
        elif fault_count >= 2 or model_unavailable:
            target_level = 2
            reason = f"degraded_perception (faults={fault_count})"
        elif fault_count >= 1:
            target_level = 1
            reason = f"single_fault: {'llm' if llm_degraded else 'perception' if perception_degraded else 'sensor' if sensor_gap_active else 'latency'}"
        else:
            target_level = 0
            reason = "all_systems_nominal"

        # Only escalate immediately; de-escalate after sustained recovery (5s)
        if target_level > self.state.level:
            self._transition(target_level, reason)
        elif target_level < self.state.level and (now - self.state.since > 5.0):
            self._transition(target_level, reason)

        return self.state

    def _transition(self, new_level: int, reason: str):
        old_level = self.state.level
        self.state = DegradationState(
            level=new_level,
            level_name=self.LEVEL_NAMES.get(new_level, "unknown"),
            since=time.time(),
            reason=reason,
            llm_enabled=(new_level < 1),
            low_confidence_dropped=(new_level >= 2),
            new_detections_rejected=(new_level >= 3),
            manual_override=(new_level >= 4)
        )
        self.history.append({
            "timestamp": time.time(),
            "from_level": old_level,
            "to_level": new_level,
            "reason": reason
        })
        logger.warning(
            f"Degradation: L{old_level} → L{new_level} ({self.LEVEL_NAMES[new_level]}): {reason}"
        )

    def get_status(self) -> Dict[str, Any]:
        return {
            "level": self.state.level,
            "level_name": self.state.level_name,
            "reason": self.state.reason,
            "llm_enabled": self.state.llm_enabled,
            "low_confidence_dropped": self.state.low_confidence_dropped,
            "new_detections_rejected": self.state.new_detections_rejected,
            "manual_override": self.state.manual_override,
            "transition_history_count": len(self.history)
        }

    def get_history(self, limit: int = 20) -> list:
        return self.history[-limit:]
