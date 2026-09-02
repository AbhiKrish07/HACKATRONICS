"""
Perception Stage Pipeline.
Consumes RawDetections and produces structured HazardEvents.
Decouples occupancy presence detection from ML classification.
"""

import uuid
import logging
import math
import time
from typing import List, Optional, Dict, Any
from config import settings
from schemas.models import RawDetection, HazardEvent
from perception.occupancy import OccupancyDetector
from perception.model import PerceptionClassifier

logger = logging.getLogger("av01.perception")

class TemporalTracker:
    """
    1D Spatial Association and Exponentially Weighted Moving Average (EWMA) Tracker.
    Associates raw detections with persistent tracks to smooth out sensor noise.
    """
    def __init__(self, alpha: float = 0.4, distance_threshold: float = 8.0, timeout: float = 1.0):
        self.tracks: Dict[str, Dict[str, Any]] = {}
        self.alpha = alpha
        self.distance_threshold = distance_threshold
        self.timeout = timeout

    def update(self, detections: List[dict], current_time: float) -> List[dict]:
        # Expire old tracks
        expired = [k for k, v in self.tracks.items() if current_time - v["last_seen"] > self.timeout]
        for k in expired:
            del self.tracks[k]

        smoothed_detections = []
        for det in detections:
            x, y = det["pos_x"], det["pos_y"]
            vx, vy = det["rel_vx"], det["rel_vy"]
            
            # Find closest track
            best_track_id = None
            min_dist = float('inf')
            for track_id, track in self.tracks.items():
                # Euclidean distance
                dist = math.hypot(track["pos_x"] - x, track["pos_y"] - y)
                if dist < self.distance_threshold and dist < min_dist:
                    min_dist = dist
                    best_track_id = track_id
            
            if best_track_id:
                # Update existing track with EWMA
                t = self.tracks[best_track_id]
                t["pos_x"] = self.alpha * x + (1 - self.alpha) * t["pos_x"]
                t["pos_y"] = self.alpha * y + (1 - self.alpha) * t["pos_y"]
                t["rel_vx"] = self.alpha * vx + (1 - self.alpha) * t["rel_vx"]
                t["rel_vy"] = self.alpha * vy + (1 - self.alpha) * t["rel_vy"]
                t["last_seen"] = current_time
                
                det["pos_x"] = t["pos_x"]
                det["pos_y"] = t["pos_y"]
                det["rel_vx"] = t["rel_vx"]
                det["rel_vy"] = t["rel_vy"]
                det["track_id"] = best_track_id
            else:
                # Create new track
                new_id = uuid.uuid4().hex[:6]
                self.tracks[new_id] = {
                    "pos_x": x, "pos_y": y, "rel_vx": vx, "rel_vy": vy, "last_seen": current_time
                }
                det["track_id"] = new_id
            
            smoothed_detections.append(det)
            
        return smoothed_detections


class PerceptionStage:
    """
    Stage 2: Perception
    Process: List[RawDetection] -> List[HazardEvent]
    """
    def __init__(self, classifier: Optional[PerceptionClassifier] = None):
        self.classifier = classifier or PerceptionClassifier()
        self.occupancy_detector = OccupancyDetector()
        self.tracker = TemporalTracker(alpha=0.4)

    def process(self, raw_detections: List[RawDetection]) -> List[HazardEvent]:
        hazard_events: List[HazardEvent] = []
        valid_detections = []

        for idx, detection in enumerate(raw_detections):
            feats = detection.features
            
            # Step 1: High-recall physical presence detection
            occupied = self.occupancy_detector.is_occupied(feats, detection.occupancy_confidence)
            if not occupied:
                # Discard noise that does not meet occupancy presence
                continue

            # Step 2: ML classification
            pred_class, conf, class_probs, is_degraded = self.classifier.classify(feats)
            
            # Extract raw spatial/kinematic parameters
            raw_x = float(feats.get("_pos_x", 0.0))
            raw_y = float(feats.get("_pos_y", float(feats.get("distance", 50.0))))
            raw_z = float(feats.get("_pos_z", 0.0))
            raw_vx = float(feats.get("_rel_vx", 0.0))
            raw_vy = float(feats.get("_rel_vy", 0.0))
            
            # Prepare for tracker
            det_dict = {
                "pos_x": raw_x, "pos_y": raw_y, "rel_vx": raw_vx, "rel_vy": raw_vy,
                "pos_z": raw_z, "lane": str(feats.get("_lane", "in_lane")),
                "type": pred_class, "conf": conf, "idx": idx
            }
            valid_detections.append((detection, det_dict))
            
        # Run Temporal Tracker (EWMA smoothing)
        current_time = time.time()
        tracked_data = [d[1] for d in valid_detections]
        smoothed_data = self.tracker.update(tracked_data, current_time)
        
        for (detection, orig), smoothed in zip(valid_detections, smoothed_data):
            # Use tracked/smoothed values
            pos_x = smoothed["pos_x"]
            pos_y = smoothed["pos_y"]
            pos_z = smoothed["pos_z"]
            rel_vx = smoothed["rel_vx"]
            rel_vy = smoothed["rel_vy"]
            lane = smoothed["lane"]
            dist = pos_y  # Since Y is longitudinal distance in our coordinate system
            
            event_id = f"hazard_trk_{smoothed['track_id']}_{orig['idx']}"
            
            model_unavail = not self.classifier.is_loaded

            hazard = HazardEvent(
                id=event_id,
                type=orig["type"] if not model_unavail else None,
                classification_confidence=orig["conf"] if not model_unavail else None,
                model_unavailable=model_unavail,
                occupancy_confidence=float(detection.occupancy_confidence),
                position={"x": pos_x, "y": pos_y, "z": pos_z},
                distance=dist,
                relative_velocity={"vx": rel_vx, "vy": rel_vy},
                lane_relevance=lane,
                timestamp=detection.timestamp,
                raw_features=dict(detection.features)  # Preserve original features for Groq context
            )
            hazard_events.append(hazard)


        return hazard_events
