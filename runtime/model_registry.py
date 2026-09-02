"""
Model Registry and Version Management for AV-01.
Tracks model metadata, versions, validation accuracy, and shadow model usage.
"""

import logging
from typing import Dict, Any, Optional
from dataclasses import dataclass, field
import hashlib

logger = logging.getLogger("av01.model_registry")


@dataclass
class ModelMetadata:
    """Production metadata for an ML model."""
    model_id: str
    version: str
    build_date: str
    training_data_version: str
    training_data_size: int
    validation_accuracy: float
    signature: str  # SHA256 hash of weights
    performance_stats: Dict[str, float] = field(default_factory=dict)


class ModelRegistry:
    """
    Manages active and shadow models in production.
    Ensures safe rollback and shadow testing.
    """
    
    def __init__(self):
        self._models: Dict[str, ModelMetadata] = {}
        self._active_model_id: Optional[str] = None
        self._shadow_model_id: Optional[str] = None
        
    def register(self, metadata: ModelMetadata):
        """Registers a new model version."""
        self._models[metadata.model_id] = metadata
        logger.info(f"Registered model {metadata.model_id} (v{metadata.version})")
        
    def set_active(self, model_id: str) -> bool:
        """Promotes a model to active production use."""
        if model_id not in self._models:
            logger.error(f"Cannot set active: model {model_id} not registered.")
            return False
            
        self._active_model_id = model_id
        logger.info(f"Model {model_id} is now ACTIVE.")
        return True
        
    def set_shadow(self, model_id: str) -> bool:
        """Sets a model to run in shadow mode alongside the active model."""
        if model_id not in self._models:
            logger.error(f"Cannot set shadow: model {model_id} not registered.")
            return False
            
        self._shadow_model_id = model_id
        logger.info(f"Model {model_id} is now running in SHADOW mode.")
        return True
        
    def get_active(self) -> Optional[ModelMetadata]:
        if not self._active_model_id:
            return None
        return self._models[self._active_model_id]
        
    def get_shadow(self) -> Optional[ModelMetadata]:
        if not self._shadow_model_id:
            return None
        return self._models[self._shadow_model_id]
        
    def rollback(self, target_model_id: str) -> bool:
        """Emergency rollback to a previous model."""
        if target_model_id not in self._models:
            logger.error(f"Rollback failed: {target_model_id} not found.")
            return False
            
        logger.warning(f"EMERGENCY ROLLBACK: Swapping {self._active_model_id} -> {target_model_id}")
        return self.set_active(target_model_id)
        
    def get_status(self) -> Dict[str, Any]:
        active = self.get_active()
        shadow = self.get_shadow()
        
        return {
            "total_registered": len(self._models),
            "active_model": active.model_id if active else "None",
            "active_version": active.version if active else "None",
            "shadow_model": shadow.model_id if shadow else "None",
            "shadow_version": shadow.version if shadow else "None"
        }

# Global singleton
registry = ModelRegistry()
