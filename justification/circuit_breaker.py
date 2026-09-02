"""
Circuit Breaker State Machine for Justification Layer (DIFF 6).
Guarantees real-time latency budgets by isolating transient LLM failures.
States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED/OPEN
"""

import time
import logging
from enum import Enum
from typing import Dict, Any, List, Optional
from config import settings

logger = logging.getLogger("av01.justification.circuit_breaker")


class CircuitState(str, Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreaker:
    """
    Finite State Machine protecting real-time loop from remote LLM degradation.
    """
    def __init__(
        self,
        failure_threshold: int = None,
        window_seconds: float = None,
        base_cooldown_seconds: float = None,
        max_cooldown_seconds: float = None
    ):
        self.failure_threshold = failure_threshold or settings.CB_FAILURE_THRESHOLD
        self.window_seconds = window_seconds or settings.CB_WINDOW_SECONDS
        self.base_cooldown_seconds = base_cooldown_seconds or settings.CB_BASE_COOLDOWN_SECONDS
        self.max_cooldown_seconds = max_cooldown_seconds or settings.CB_MAX_COOLDOWN_SECONDS

        self.state: CircuitState = CircuitState.CLOSED
        self.current_cooldown_seconds: float = self.base_cooldown_seconds
        self.failure_timestamps: List[float] = []
        self.last_state_change: float = time.time()
        self.opened_timestamp: Optional[float] = None
        self.half_open_probe_in_flight: bool = False
        self.transition_history: List[Dict[str, Any]] = []

    def _log_transition(self, old_state: CircuitState, new_state: CircuitState, reason: str):
        now = time.time()
        event = {
            "timestamp": now,
            "old_state": old_state.value,
            "new_state": new_state.value,
            "reason": reason,
            "current_cooldown_seconds": self.current_cooldown_seconds
        }
        self.transition_history.append(event)
        logger.warning(f"Circuit Breaker Transition: {old_state.value} -> {new_state.value} | Reason: {reason}")

    def should_attempt_call(self) -> bool:
        """
        Determines if an LLM request is allowed under current circuit state.
        """
        now = time.time()

        if self.state == CircuitState.CLOSED:
            return True

        elif self.state == CircuitState.OPEN:
            # Check if cooldown has elapsed
            if self.opened_timestamp and (now - self.opened_timestamp >= self.current_cooldown_seconds):
                old_state = self.state
                self.state = CircuitState.HALF_OPEN
                self.half_open_probe_in_flight = True
                self.last_state_change = now
                self._log_transition(old_state, CircuitState.HALF_OPEN, f"Cooldown {self.current_cooldown_seconds}s elapsed; probing with single request")
                return True
            # Still in cooldown -> immediately reject
            return False

        elif self.state == CircuitState.HALF_OPEN:
            # Only 1 probe allowed at a time in HALF_OPEN
            if not self.half_open_probe_in_flight:
                self.half_open_probe_in_flight = True
                return True
            return False

        return False

    def record_success(self):
        """
        Records a successful LLM call.
        """
        now = time.time()
        if self.state == CircuitState.HALF_OPEN:
            old_state = self.state
            self.state = CircuitState.CLOSED
            self.current_cooldown_seconds = self.base_cooldown_seconds
            self.failure_timestamps.clear()
            self.half_open_probe_in_flight = False
            self.last_state_change = now
            self._log_transition(old_state, CircuitState.CLOSED, "Probe request succeeded; circuit restored to CLOSED")
        elif self.state == CircuitState.CLOSED:
            # Clear old failures outside sliding window
            self.failure_timestamps = [t for t in self.failure_timestamps if now - t <= self.window_seconds]

    def record_failure(self, error_type: str = "transient_error"):
        """
        Records an LLM call failure (timeout, 5xx).
        """
        now = time.time()
        self.failure_timestamps.append(now)

        if self.state == CircuitState.HALF_OPEN:
            # Probe failed -> reopen and double cooldown
            old_state = self.state
            self.state = CircuitState.OPEN
            self.opened_timestamp = now
            self.half_open_probe_in_flight = False
            self.current_cooldown_seconds = min(self.max_cooldown_seconds, self.current_cooldown_seconds * 2.0)
            self.last_state_change = now
            self._log_transition(old_state, CircuitState.OPEN, f"Probe request failed ({error_type}); reopening circuit with backoff cooldown {self.current_cooldown_seconds}s")

        elif self.state == CircuitState.CLOSED:
            # Prune failures outside the sliding window
            self.failure_timestamps = [t for t in self.failure_timestamps if now - t <= self.window_seconds]
            if len(self.failure_timestamps) >= self.failure_threshold:
                old_state = self.state
                self.state = CircuitState.OPEN
                self.opened_timestamp = now
                self.last_state_change = now
                self._log_transition(old_state, CircuitState.OPEN, f"Trip threshold ({self.failure_threshold} failures in {self.window_seconds}s) reached ({error_type})")

    def get_status(self) -> Dict[str, Any]:
        """Telemetry snapshot for /health endpoint."""
        return {
            "state": self.state.value,
            "failure_count_in_window": len(self.failure_timestamps),
            "current_cooldown_seconds": self.current_cooldown_seconds,
            "last_state_change": self.last_state_change,
            "transition_count": len(self.transition_history)
        }
