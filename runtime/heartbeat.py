"""
Process Heartbeat Registry for Watchdog Monitoring (DIFF 4).
Tracks per-process liveness timestamps across isolated OS processes.
"""

import time
from typing import Dict, Any


class HeartbeatRegistry:
    """
    Tracks heartbeat timestamps for isolated worker processes.
    """
    def __init__(self, shared_dict: Dict[str, float] = None):
        self._heartbeats: Dict[str, float] = shared_dict if shared_dict is not None else {}

    def beat(self, process_name: str):
        self._heartbeats[process_name] = time.time()

    def get_last_beat(self, process_name: str) -> float:
        return self._heartbeats.get(process_name, 0.0)

    def check_health(self, timeout_sec: float = 2.0) -> Dict[str, Any]:
        now = time.time()
        status = {}
        for name, ts in self._heartbeats.items():
            age_sec = now - ts
            status[name] = {
                "alive": age_sec <= timeout_sec,
                "last_beat_age_sec": round(age_sec, 2),
                "status": "nominal" if age_sec <= timeout_sec else "unresponsive"
            }
        return status
