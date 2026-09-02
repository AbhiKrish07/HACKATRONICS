"""
Occupancy Detection Module.
High-recall physical presence detector that operates independently of ML classification.
Ensures low-confidence or failed classifications never silently drop physical obstacles.
"""

from typing import Dict, Any
from config import settings


class OccupancyDetector:
    """
    Lightweight, high-recall presence gatekeeper.
    """
    def __init__(self, threshold: float = None):
        self.threshold = threshold if threshold is not None else settings.OCCUPANCY_CONFIDENCE_THRESHOLD

    def is_occupied(self, raw_features: Dict[str, Any], occupancy_confidence: float) -> bool:
        """
        Determines whether physical matter is present based on multi-signal verification:
        1. Occupancy confidence >= threshold
        2. Proximity check (very close objects < 10m are treated with ultra-high sensitivity)
        """
        if occupancy_confidence >= self.threshold:
            return True
        
        # Proximity failsafe: distance under critical safety margin with non-zero sensor return
        distance = raw_features.get("distance", 999.0)
        raw_conf = raw_features.get("sensor_confidence_raw", 0.0)
        if distance < settings.CRITICAL_DISTANCE_METERS and raw_conf >= 0.20:
            return True

        return False
