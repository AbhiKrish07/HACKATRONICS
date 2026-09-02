"""
Data Validation & Schema Enforcement Layer for AV-01.
Validates every incoming sensor payload and outgoing frame against strict schemas.
Bad data is logged but never crashes the pipeline.
"""

import time
import logging
import hashlib
from typing import Tuple, Optional, List, Dict, Any
from schemas.models import RawDetection, FrameOutput

logger = logging.getLogger("av01.data_validator")


class DataValidator:
    """
    Production-grade data validation for the AV-01 sensor pipeline.
    Every incoming sensor message is validated against strict mathematical bounds.
    """

    MAX_DETECTIONS_PER_FRAME = 50
    MAX_DISTANCE_METERS = 200.0
    MIN_CONFIDENCE = 0.0
    MAX_CONFIDENCE = 1.0
    VALID_SENSOR_IDS = {
        # Hardware sensor IDs (production)
        "lidar_0", "radar_0", "camera_0", "camera_1", "fused",
        # Simulated sensor IDs
        "sim_fusion_01",
        # NHTSA replay sensor IDs
        "nhtsa_radar_01",
        # Kaggle dataset sensor IDs
        "kaggle_fusion_01",
        # Adversarial test injections
        "phantom_adversary_01",
    }

    VALID_OBJECT_TYPES = {
        "pedestrian", "cyclist", "vehicle", "motorcycle",
        "auto_rickshaw", "cow", "dog", "buffalo",
        "static_obstacle", "unknown"
    }

    def __init__(self):
        self.last_valid_timestamp: float = 0.0
        self.total_validated: int = 0
        self.total_rejected: int = 0
        self.rejection_reasons: Dict[str, int] = {}

    def validate_sensor_payload(self, raw: RawDetection) -> Tuple[bool, str]:
        """
        Validates a single raw detection against schema constraints.
        Returns (is_valid, reason_if_invalid).
        """
        # Timestamp ordering check
        if raw.timestamp < self.last_valid_timestamp - 0.5:
            return self._reject("timestamp_out_of_order",
                f"ts={raw.timestamp} < last_valid={self.last_valid_timestamp}")

        # Sensor ID whitelist
        if raw.sensor_id not in self.VALID_SENSOR_IDS:
            return self._reject("invalid_sensor_id", f"sensor_id={raw.sensor_id}")

        # Occupancy confidence range
        if not (self.MIN_CONFIDENCE <= raw.occupancy_confidence <= self.MAX_CONFIDENCE):
            return self._reject("occupancy_out_of_range",
                f"occupancy={raw.occupancy_confidence}")

        # Features validation
        features = raw.features
        if not isinstance(features, dict):
            return self._reject("features_not_dict", "features must be a dict")

        # Distance bounds check
        distance = features.get("distance_m")
        if distance is not None and (distance < 0 or distance > self.MAX_DISTANCE_METERS):
            return self._reject("distance_out_of_range", f"distance={distance}")

        # Velocity bounds check (sanity: no object going faster than 100 m/s)
        for vel_key in ["vx", "vy"]:
            vel = features.get(vel_key)
            if vel is not None and abs(vel) > 100.0:
                return self._reject("velocity_out_of_range", f"{vel_key}={vel}")

        # Accept
        self.total_validated += 1
        self.last_valid_timestamp = raw.timestamp
        return True, "valid"

    def validate_batch(self, detections: List[RawDetection]) -> Tuple[List[RawDetection], List[str]]:
        """
        Validates a batch of detections. Returns (valid_detections, rejection_log).
        """
        if len(detections) > self.MAX_DETECTIONS_PER_FRAME:
            logger.warning(f"Detection overflow: {len(detections)} > {self.MAX_DETECTIONS_PER_FRAME}")

        valid = []
        rejections = []
        for det in detections:
            is_valid, reason = self.validate_sensor_payload(det)
            if is_valid:
                valid.append(det)
            else:
                rejections.append(f"[{det.sensor_id}@{det.timestamp}] {reason}")
                logger.debug(f"Rejected detection: {reason}")

        return valid, rejections

    def validate_frame_output(self, frame: FrameOutput) -> Tuple[bool, List[str]]:
        """
        Post-pipeline validation: ensures output frame integrity.
        """
        issues = []

        if frame.frame_id < 0:
            issues.append("negative_frame_id")

        if frame.timestamp < 0:
            issues.append("negative_timestamp")

        # Ensure risk assessments reference existing hazards
        hazard_ids = {h.id for h in frame.hazards}
        for ra in frame.risk_assessments:
            if ra.hazard_event_id not in hazard_ids and ra.hazard_event_id != "pipeline_recovery":
                issues.append(f"orphaned_risk_assessment: {ra.hazard_event_id}")

        # Check risk score bounds
        for ra in frame.risk_assessments:
            if not (0.0 <= ra.risk_score <= 1.0):
                issues.append(f"risk_score_out_of_bounds: {ra.risk_score}")

        return len(issues) == 0, issues

    def get_stats(self) -> Dict[str, Any]:
        """Returns validation statistics."""
        total = self.total_validated + self.total_rejected
        return {
            "total_processed": total,
            "total_validated": self.total_validated,
            "total_rejected": self.total_rejected,
            "rejection_rate": round(self.total_rejected / max(1, total), 4),
            "top_rejection_reasons": dict(
                sorted(self.rejection_reasons.items(), key=lambda x: -x[1])[:5]
            )
        }

    def _reject(self, reason_key: str, detail: str) -> Tuple[bool, str]:
        self.total_rejected += 1
        self.rejection_reasons[reason_key] = self.rejection_reasons.get(reason_key, 0) + 1
        return False, detail
