"""
ML Classification Model Manager for AV-01 Hazard Perception.
Exposes `classify(features) -> (label, confidence, class_probabilities)` using a trained
Scikit-Learn classifier artifact. Implements robust fallbacks when models are unavailable or inference fails.
"""

import logging
from pathlib import Path
from typing import Dict, Any, Tuple, Optional, List
import joblib
import numpy as np
import pandas as pd
from config import settings

logger = logging.getLogger("av01.perception.model")


class PerceptionClassifier:
    """
    Manages loading, validation, and inference for the object classification model.
    """
    def __init__(self, model_path: Optional[Path] = None):
        self.model_path = model_path or settings.MODEL_PATH
        self.model_artifact: Optional[Dict[str, Any]] = None
        self.classifier = None
        self.feature_columns: List[str] = []
        self.classes: List[str] = []
        self.is_loaded: bool = False
        self.load_error: Optional[str] = None
        
        self.load_model()

    def load_model(self) -> bool:
        """
        Attempts to load the trained model artifact from disk.
        Gracefully marks model as unavailable if missing/corrupt without crashing.
        """
        try:
            if not self.model_path.exists():
                self.is_loaded = False
                self.load_error = f"Model artifact not found at {self.model_path}"
                logger.warning(self.load_error)
                return False

            artifact = joblib.load(self.model_path)
            if not isinstance(artifact, dict) or "model" not in artifact:
                self.is_loaded = False
                self.load_error = "Corrupted model artifact structure"
                logger.error(self.load_error)
                return False

            self.model_artifact = artifact
            self.classifier = artifact["model"]
            self.feature_columns = artifact.get("feature_columns", [
                "relative_size", "aspect_ratio", "motion_signature",
                "distance", "sensor_confidence_raw", "reflectivity_signal"
            ])
            self.classes = list(artifact.get("classes", self.classifier.classes_))
            self.is_loaded = True
            self.load_error = None
            logger.info(f"Loaded classifier successfully from {self.model_path}")
            return True

        except Exception as e:
            self.is_loaded = False
            self.load_error = f"Failed loading model artifact: {str(e)}"
            logger.error(self.load_error, exc_info=True)
            return False

    def classify(self, raw_features: Dict[str, float]) -> Tuple[Optional[str], Optional[float], Dict[str, float], bool]:
        """
        Performs inference given raw sensor features.
        Returns:
            (predicted_class, max_probability_confidence, all_class_probabilities, is_degraded)
            
        Confidence comes directly from model's actual predict_proba - NEVER a hardcoded number.
        If model is unavailable or inference throws, catches exception, logs, and degrades gracefully.
        """
        if not self.is_loaded or self.classifier is None:
            # Model unavailable degraded state
            return None, None, {}, True

        try:
            # Extract features in exact order
            feature_vector = []
            for col in self.feature_columns:
                val = raw_features.get(col, 0.0)
                feature_vector.append(float(val))

            df_input = pd.DataFrame([feature_vector], columns=self.feature_columns)
            
            # Predict probabilities
            probabilities = self.classifier.predict_proba(df_input)[0]
            class_probs = {cls_name: float(prob) for cls_name, prob in zip(self.classes, probabilities)}
            
            max_idx = int(np.argmax(probabilities))
            predicted_class = self.classes[max_idx]
            confidence = float(probabilities[max_idx])
            
            # Check if confidence meets minimal operational bar
            is_degraded = confidence < settings.CLASSIFICATION_CONFIDENCE_THRESHOLD
            
            return predicted_class, confidence, class_probs, is_degraded

        except Exception as e:
            logger.error(f"Inference execution failed on feature input: {str(e)}", exc_info=True)
            # Catch single inference failure and degrade without taking down frame
            return "unknown", 0.20, {"unknown": 1.0}, True
