"""
Observability & Monitoring Layer for AV-01.
Tracks per-stage latency percentiles, detection metrics, and resource usage.
"""

import time
import logging
import statistics
from typing import Dict, Any, List, Optional
from collections import defaultdict, deque
from dataclasses import dataclass, field

logger = logging.getLogger("av01.observability")


class LatencyTracker:
    """
    Records and computes p50/p95/p99 latency percentiles per pipeline stage.
    Uses a sliding window of the last 1000 measurements.
    """

    def __init__(self, window_size: int = 1000):
        self.window_size = window_size
        self._measurements: Dict[str, deque] = defaultdict(lambda: deque(maxlen=window_size))
        self._budget_violations: Dict[str, int] = defaultdict(int)

    def record(self, stage: str, latency_ms: float, budget_ms: Optional[float] = None):
        """Record a latency measurement for a stage."""
        self._measurements[stage].append(latency_ms)
        if budget_ms is not None and latency_ms > budget_ms:
            self._budget_violations[stage] += 1

    def get_percentiles(self, stage: str) -> Dict[str, float]:
        """Returns p50, p95, p99, max for a given stage."""
        data = list(self._measurements[stage])
        if not data:
            return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0, "count": 0}

        data_sorted = sorted(data)
        n = len(data_sorted)
        return {
            "p50": round(data_sorted[int(n * 0.50)], 2),
            "p95": round(data_sorted[min(int(n * 0.95), n - 1)], 2),
            "p99": round(data_sorted[min(int(n * 0.99), n - 1)], 2),
            "max": round(data_sorted[-1], 2),
            "count": n,
            "budget_violations": self._budget_violations.get(stage, 0)
        }

    def get_all_percentiles(self) -> Dict[str, Dict[str, float]]:
        """Returns percentiles for all tracked stages."""
        return {stage: self.get_percentiles(stage) for stage in self._measurements}


class DetectionMetrics:
    """
    Tracks per-class detection statistics: count, avg confidence, trends.
    """

    def __init__(self, window_size: int = 500):
        self.window_size = window_size
        self._counts: Dict[str, int] = defaultdict(int)
        self._confidences: Dict[str, deque] = defaultdict(lambda: deque(maxlen=window_size))
        self._total_frames: int = 0
        self._start_time: float = time.time()

    def record_detection(self, object_type: str, confidence: float):
        """Record a single detection."""
        self._counts[object_type] += 1
        self._confidences[object_type].append(confidence)

    def record_frame(self):
        """Called once per frame to track detection rate."""
        self._total_frames += 1

    def get_class_metrics(self, object_type: str) -> Dict[str, Any]:
        """Returns metrics for a specific object class."""
        count = self._counts.get(object_type, 0)
        confs = list(self._confidences.get(object_type, []))
        elapsed = max(1.0, time.time() - self._start_time)

        return {
            "total_detections": count,
            "detections_per_minute": round(count / (elapsed / 60.0), 2),
            "avg_confidence": round(statistics.mean(confs), 3) if confs else 0.0,
            "confidence_std": round(statistics.stdev(confs), 3) if len(confs) > 1 else 0.0,
            "min_confidence": round(min(confs), 3) if confs else 0.0,
            "max_confidence": round(max(confs), 3) if confs else 0.0,
        }

    def get_all_metrics(self) -> Dict[str, Any]:
        """Returns metrics for all detected classes."""
        elapsed = max(1.0, time.time() - self._start_time)
        return {
            "total_frames": self._total_frames,
            "uptime_seconds": round(elapsed, 1),
            "classes": {
                cls: self.get_class_metrics(cls) for cls in self._counts
            }
        }


@dataclass
class ResourceSnapshot:
    """Snapshot of system resource usage at a point in time."""
    timestamp: float = field(default_factory=time.time)
    stage: str = ""
    cpu_percent: float = 0.0
    memory_mb: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "stage": self.stage,
            "cpu_percent": self.cpu_percent,
            "memory_mb": self.memory_mb,
        }


class ResourceMonitor:
    """Lightweight resource tracking (no psutil dependency for portability)."""

    def __init__(self):
        self._snapshots: deque = deque(maxlen=100)

    def snapshot(self, stage: str = "pipeline") -> ResourceSnapshot:
        """Takes a resource snapshot. Uses basic Python memory tracking."""
        import sys
        snap = ResourceSnapshot(
            stage=stage,
            memory_mb=round(sys.getsizeof(0) * 0.000001, 2),  # placeholder
        )
        self._snapshots.append(snap)
        return snap

    def get_recent(self, limit: int = 20) -> List[Dict]:
        return [s.to_dict() for s in list(self._snapshots)[-limit:]]


class JustificationHealth:
    """Tracks LLM justification layer health metrics."""

    def __init__(self):
        self.total_calls: int = 0
        self.successful_calls: int = 0
        self.timeout_failures: int = 0
        self.validation_rejections: int = 0
        self._latencies: deque = deque(maxlen=200)

    def record_success(self, latency_ms: float):
        self.total_calls += 1
        self.successful_calls += 1
        self._latencies.append(latency_ms)

    def record_failure(self, failure_type: str = "timeout"):
        self.total_calls += 1
        if failure_type == "timeout":
            self.timeout_failures += 1
        elif failure_type == "validation":
            self.validation_rejections += 1

    def get_health(self) -> Dict[str, Any]:
        lats = list(self._latencies)
        return {
            "total_calls": self.total_calls,
            "successful_calls": self.successful_calls,
            "timeout_failures": self.timeout_failures,
            "validation_rejections": self.validation_rejections,
            "success_rate": round(self.successful_calls / max(1, self.total_calls), 4),
            "avg_latency_ms": round(statistics.mean(lats), 2) if lats else 0.0,
            "fallback_rate": round(1.0 - (self.successful_calls / max(1, self.total_calls)), 4)
        }
