"""
Sensor Abstraction Layer (SAL) for AV-01.
Hardware-ready sensor interface protocol allowing simulated, replayed NHTSA logs,
and real sensor drivers to be swapped without changing downstream perception pipelines.
"""

import json
import time
import random
from pathlib import Path
from typing import List, Optional, Protocol, runtime_checkable
from pydantic import BaseModel
from schemas.models import RawDetection, VehicleState
from sensor_sim.generator import ScenarioGenerator
from config import settings


class SensorHealth(BaseModel):
    """Liveness and health telemetry for a sensor source."""
    liveness: bool = True
    last_frame_age_ms: float = 0.0
    error_state: Optional[str] = None
    sensor_id: str = "sal_primary"
    frames_delivered: int = 0


@runtime_checkable
class SensorSource(Protocol):
    """
    Hardware Abstraction Protocol for Sensor Inputs.
    Any sensor driver (LIDAR, RADAR, Camera Fusion, Sim, Replay) implements this.
    """
    def read(self, timestamp: float) -> List[RawDetection]:
        """Reads raw detections for the specified timestamp."""
        ...

    def health(self) -> SensorHealth:
        """Returns liveness, last-frame age, and hardware error status."""
        ...

    def get_vehicle_state(self) -> VehicleState:
        """Returns current ego vehicle kinematics."""
        ...


class SimulatedSensorSource(SensorSource):
    """
    Simulated Sensor Source generating scripted and stochastic scenarios.
    """
    def __init__(self, scenario_type: str = "normal", seed: Optional[int] = 42):
        self.generator = ScenarioGenerator(scenario_type=scenario_type, seed=seed)
        self.last_read_time = time.time()
        self.total_frames = 0
        self._error_state: Optional[str] = None

    def set_scenario(self, scenario_type: str, seed: Optional[int] = None):
        self.generator.reset(scenario_type=scenario_type, seed=seed)
        self._error_state = None

    def read(self, timestamp: float) -> List[RawDetection]:
        try:
            detections, _ = self.generator.step()
            self.last_read_time = time.time()
            self.total_frames += 1
            self._error_state = None
            return detections
        except Exception as e:
            self._error_state = f"Simulation generator error: {str(e)}"
            return []

    def health(self) -> SensorHealth:
        age_ms = (time.time() - self.last_read_time) * 1000.0
        return SensorHealth(
            liveness=self._error_state is None and age_ms < 2000.0,
            last_frame_age_ms=round(age_ms, 2),
            error_state=self._error_state,
            sensor_id="sim_fusion_01",
            frames_delivered=self.total_frames
        )

    def get_vehicle_state(self) -> VehicleState:
        return self.generator.vehicle_state


class ReplaySensorSource(SensorSource):
    """
    Replay Sensor Source: Reads recorded NHTSA-style incident logs frame-by-frame.
    Enables deterministic regression testing against fixed real-world incident recordings.
    """
    def __init__(self, log_path: Optional[Path] = None):
        self.log_path = log_path or settings.REPLAY_DATA_PATH
        self.frames: List[dict] = []
        self.current_idx = 0
        self.last_read_time = time.time()
        self.total_frames = 0
        self._error_state: Optional[str] = None
        self._load_log()

    def _load_log(self):
        if not self.log_path.exists():
            # Generate a default synthetic NHTSA-style incident log if missing
            self._generate_default_incident_log()
            
        try:
            with open(self.log_path, "r", encoding="utf-8") as f:
                self.frames = [json.loads(line) for line in f if line.strip()]
            self.current_idx = 0
        except Exception as e:
            self._error_state = f"Failed to load replay log: {str(e)}"

    def _generate_default_incident_log(self):
        """Creates a benchmark NHTSA-style cut-in incident recording."""
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        records = []
        for i in range(50):
            t = i * 0.1
            dist = max(8.0, 45.0 - i * 0.8)
            records.append({
                "frame_id": i,
                "timestamp": round(t, 2),
                "ego_speed_mps": 13.88,
                "detections": [
                    {
                        "sensor_id": "nhtsa_radar_01",
                        "timestamp": round(t, 2),
                        "occupancy_confidence": 0.95,
                        "features": {
                            "relative_size": 1.2,
                            "aspect_ratio": 2.0,
                            "motion_signature": 14.0,
                            "distance": dist,
                            "sensor_confidence_raw": 0.92,
                            "reflectivity_signal": 0.88,
                            "_pos_x": -2.5 if i < 20 else 0.0,
                            "_pos_y": dist,
                            "_pos_z": 0.0,
                            "_rel_vx": 1.2 if i < 20 else 0.0,
                            "_rel_vy": -8.0,
                            "_lane": "adjacent_lane" if i < 20 else "in_lane"
                        }
                    }
                ]
            })
        with open(self.log_path, "w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(rec) + "\n")

    def read(self, timestamp: float) -> List[RawDetection]:
        if not self.frames:
            return []
        
        frame_data = self.frames[self.current_idx]
        self.current_idx = (self.current_idx + 1) % len(self.frames)
        self.last_read_time = time.time()
        self.total_frames += 1

        detections = []
        for d in frame_data.get("detections", []):
            detections.append(RawDetection(**d))
        return detections

    def health(self) -> SensorHealth:
        age_ms = (time.time() - self.last_read_time) * 1000.0
        return SensorHealth(
            liveness=self._error_state is None,
            last_frame_age_ms=round(age_ms, 2),
            error_state=self._error_state,
            sensor_id="nhtsa_replay_reader",
            frames_delivered=self.total_frames
        )

    def get_vehicle_state(self) -> VehicleState:
        return VehicleState(speed_mps=13.88)


class KaggleReplaySensorSource(SensorSource):
    """
    Kaggle Replay Sensor Source: Reads and replays real-world Kaggle autonomous navigation dataset.
    """
    def __init__(self, path: Optional[Path] = None, seed: int = 42):
        self.path = path
        self.seed = seed
        self.frames: List[List[RawDetection]] = []
        self.current_idx = 0
        self.last_read_time = time.time()
        self.total_frames = 0
        self._error_state: Optional[str] = None
        self._load_kaggle()

    def _load_kaggle(self):
        try:
            from data.kaggle_adapter import kaggle_to_replay_detections
            self.frames = kaggle_to_replay_detections(path=self.path, seed=self.seed)
            self.current_idx = 0
        except Exception as e:
            self._error_state = f"Failed to load Kaggle dataset: {str(e)}"

    def read(self, timestamp: float) -> List[RawDetection]:
        if not self.frames:
            return []
        
        # Adversarial Sensor Dropout (5% chance to drop frame entirely)
        if random.random() < 0.05:
            self.last_read_time = time.time()
            return []
        
        detections = self.frames[self.current_idx]
        self.current_idx = (self.current_idx + 1) % len(self.frames)
        self.last_read_time = time.time()
        self.total_frames += 1
        
        # Adversarial Phantom Object Injection (2% chance to hallucinate a ghost object)
        if random.random() < 0.02 and detections:
            import uuid
            ghost = RawDetection(
                sensor_id="phantom_adversary_01",
                timestamp=timestamp,
                occupancy_confidence=0.99,  # High occupancy to force it through physical filter
                features={
                    "sensor_confidence_raw": 0.95,
                    "reflectivity_signal": 0.05,  # Inconsistent LiDAR reflectivity -> LLM should catch this
                    "distance": 15.0,
                    "_pos_x": 0.0,
                    "_pos_y": 15.0,
                    "_pos_z": 0.0,
                    "_rel_vx": 0.0,
                    "_rel_vy": -20.0,  # Incoming at 20 m/s
                    "_lane": "in_lane"
                }
            )
            # Make a copy so we don't mutate the fixed dataset permanently
            detections = detections.copy()
            detections.append(ghost)
            
        return detections

    def health(self) -> SensorHealth:
        age_ms = (time.time() - self.last_read_time) * 1000.0
        return SensorHealth(
            liveness=self._error_state is None and len(self.frames) > 0,
            last_frame_age_ms=round(age_ms, 2),
            error_state=self._error_state,
            sensor_id="kaggle_replay_fusion_01",
            frames_delivered=self.total_frames
        )

    def get_vehicle_state(self) -> VehicleState:
        return VehicleState(speed_mps=13.88)

