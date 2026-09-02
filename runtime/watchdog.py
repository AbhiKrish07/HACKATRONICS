"""
Watchdog Daemon for Fault Detection and Process Recovery (DIFF 4).
Monitors heartbeat liveness across reactive and deliberative loops.
Automatically restarts unresponsive deliberative workers while safety-critical reactive path runs continuously.
"""

import time
import logging
import threading
from typing import Callable, Optional, Dict, Any
from config import settings
from runtime.heartbeat import HeartbeatRegistry

logger = logging.getLogger("av01.runtime.watchdog")


class ProcessWatchdog:
    """
    Supervises process health and initiates recovery on stalls.
    """
    def __init__(
        self,
        registry: HeartbeatRegistry,
        check_interval_sec: float = 0.5,
        timeout_sec: float = None,
        restart_callback: Optional[Callable[[str], None]] = None
    ):
        self.registry = registry
        self.check_interval_sec = check_interval_sec
        self.timeout_sec = timeout_sec or settings.WATCHDOG_HEARTBEAT_TIMEOUT_SEC
        self.restart_callback = restart_callback
        self.is_running = False
        self._thread: Optional[threading.Thread] = None
        self.restart_counts: Dict[str, int] = {}

    def start(self):
        self.is_running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="AV01-Watchdog")
        self._thread.start()
        logger.info("Watchdog supervisor thread started.")

    def stop(self):
        self.is_running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)

    def _run_loop(self):
        while self.is_running:
            try:
                health = self.registry.check_health(timeout_sec=self.timeout_sec)
                for proc_name, info in health.items():
                    if not info["alive"]:
                        logger.critical(f"WATCHDOG ALERT: Process '{proc_name}' is UNRESPONSIVE (age: {info['last_beat_age_sec']}s)")
                        self.restart_counts[proc_name] = self.restart_counts.get(proc_name, 0) + 1
                        
                        if proc_name == "deliberative_pipeline" and self.restart_callback:
                            logger.warning(f"Watchdog triggering automated restart for '{proc_name}'...")
                            self.restart_callback(proc_name)
                            # Reset beat timestamp to give grace period
                            self.registry.beat(proc_name)

                time.sleep(self.check_interval_sec)
            except Exception as e:
                logger.error(f"Watchdog exception in monitor loop: {str(e)}")

    def get_status(self) -> Dict[str, Any]:
        return {
            "watchdog_active": self.is_running,
            "timeout_sec": self.timeout_sec,
            "process_health": self.registry.check_health(timeout_sec=self.timeout_sec),
            "restart_counts": self.restart_counts
        }
