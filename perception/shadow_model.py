"""
Shadow-Mode Perception Evaluator (DIFF 5).
Runs candidate / challenger model versions in parallel without influencing primary driving advisories.
Logs predictions with `shadow: true` for silent A/B fleet validation.
"""

import logging
from typing import Dict, Any, List, Optional
from pathlib import Path
from schemas.models import RawDetection, HazardEvent
from perception.model import PerceptionClassifier
from config import settings

logger = logging.getLogger("av01.perception.shadow")


class ShadowPerceptionEvaluator:
    """
    Evaluates candidate models in shadow mode.
    """
    def __init__(self, shadow_model_path: Optional[Path] = None):
        self.shadow_model_path = shadow_model_path or settings.SHADOW_MODEL_PATH
        self.classifier = PerceptionClassifier(model_path=self.shadow_model_path)
        self.enabled = settings.SHADOW_MODE_ENABLED

    def evaluate_shadow(self, raw_detections: List[RawDetection]) -> List[Dict[str, Any]]:
        """
        Runs candidate model inference on raw detections and tags results as shadow predictions.
        """
        if not self.enabled:
            return []

        shadow_results = []
        for idx, det in enumerate(raw_detections):
            feats = det.features
            pred_class, conf, class_probs, is_degraded = self.classifier.classify(feats)
            
            shadow_results.append({
                "shadow": True,
                "detection_idx": idx,
                "sensor_id": det.sensor_id,
                "candidate_predicted_class": pred_class,
                "candidate_confidence": conf,
                "candidate_class_probabilities": class_probs,
                "model_loaded": self.classifier.is_loaded
            })

        return shadow_results
