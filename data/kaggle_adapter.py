"""
Kaggle Dataset Adapter for AV-01 Hazard Perception System.
Maps the 'autonomous-navigation-driving-data' Kaggle dataset into our
RawDetection feature space and derives hazard object type labels.

Source: https://www.kaggle.com/datasets/zara2099/autonomous-navigation-driving-data
"""

import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, List
from config import settings
from schemas.models import RawDetection

# Default Kaggle cache path
KAGGLE_DATASET_PATH = Path.home() / ".cache/kagglehub/datasets/zara2099/autonomous-navigation-driving-data/versions/1/autonomous_navigation_dataset.csv"


def load_kaggle_dataset(path: Optional[Path] = None) -> pd.DataFrame:
    """Load the raw Kaggle autonomous navigation dataset."""
    csv_path = path or KAGGLE_DATASET_PATH
    if not csv_path.exists():
        raise FileNotFoundError(f"Kaggle dataset not found at {csv_path}. Run kagglehub.dataset_download() first.")
    return pd.read_csv(csv_path)


def derive_object_type(row: pd.Series) -> str:
    """
    Derive hazard object type from Kaggle row context.
    
    Mapping logic:
    - Pedestrian_Presence == 1 AND close obstacle → 'pedestrian'
    - Pedestrian_Presence == 0 AND close obstacle AND highway → 'vehicle'
    - Pedestrian_Presence == 0 AND Traffic_Sign_Detected == 1 AND very close → 'static_obstacle'
    - Pedestrian_Presence == 0 AND urban + moderate distance → 'cyclist'
    - Otherwise → 'unknown'
    """
    ped = row.get("Pedestrian_Presence", 0)
    dist = row.get("Distance_to_Obstacle_m", 100.0)
    road = row.get("Road_Type", "Urban")
    sign = row.get("Traffic_Sign_Detected", 0)
    speed = row.get("Speed_kmph", 50)

    if ped == 1 and dist < 50.0:
        return "pedestrian"
    elif ped == 0 and dist < 40.0 and road == "Highway":
        return "vehicle"
    elif ped == 0 and sign == 1 and dist < 20.0:
        return "static_obstacle"
    elif ped == 0 and road == "Urban" and 15.0 < dist < 45.0 and speed < 60:
        return "cyclist"
    elif ped == 1 and dist >= 50.0:
        return "pedestrian"  # far pedestrian
    elif dist < 30.0:
        return "vehicle"
    else:
        return "unknown"


def map_kaggle_to_features(df: pd.DataFrame, seed: int = 42) -> pd.DataFrame:
    """
    Transform Kaggle columns into our ML classifier feature space.
    
    Mapping:
    - relative_size:         Derived from Distance_to_Obstacle_m (closer = larger apparent size)
    - aspect_ratio:          Derived from object type heuristic + lane position
    - motion_signature:      Speed_kmph converted to m/s relative motion
    - distance:              Distance_to_Obstacle_m directly
    - sensor_confidence_raw: Blend of Camera_Input_Similarity and Lidar_Point_Cloud_Similarity
    - reflectivity_signal:   Lidar_Point_Cloud_Similarity with weather degradation
    """
    rng = np.random.RandomState(seed)
    n = len(df)
    
    # Derive object types first
    object_types = df.apply(derive_object_type, axis=1)
    
    # Feature: distance (direct mapping, clamp to realistic sensor range)
    distance = df["Distance_to_Obstacle_m"].clip(lower=5.0, upper=settings.SENSOR_MAX_RANGE_METERS)
    
    # Feature: relative_size (inverse relationship with distance + type-based base)
    type_size_base = object_types.map({
        "pedestrian": 0.25, "vehicle": 1.2, "cyclist": 0.45,
        "static_obstacle": 0.8, "unknown": 0.5
    })
    relative_size = type_size_base * (1.0 + 20.0 / distance.clip(lower=10.0)) + rng.normal(0, 0.05, n)
    relative_size = relative_size.clip(lower=0.05)
    
    # Feature: aspect_ratio (type-dependent base + lane position influence)
    type_aspect_base = object_types.map({
        "pedestrian": 0.35, "vehicle": 2.0, "cyclist": 0.65,
        "static_obstacle": 1.1, "unknown": 1.0
    })
    lane_offset = df["Lane_Position"].abs().clip(upper=2.0) * 0.1
    aspect_ratio = type_aspect_base + lane_offset + rng.normal(0, 0.08, n)
    aspect_ratio = aspect_ratio.clip(lower=0.1)
    
    # Feature: motion_signature (speed in m/s with steering influence)
    speed_mps = df["Speed_kmph"] / 3.6
    steering_factor = df["Steering_Angle_deg"].abs() / 45.0  # normalized
    motion_signature = speed_mps * (1.0 - 0.3 * steering_factor) + rng.normal(0, 0.5, n)
    motion_signature = motion_signature.clip(lower=0.0)
    
    # Bayesian Sensor Fusion: Dynamic confidence weighting based on weather
    # Camera is severely degraded by adverse weather; LiDAR is more robust but still slightly degraded
    weather_conds = df["Weather_Condition"].fillna("Sunny")
    
    # Define dynamic priors (Camera Weight, LiDAR Weight, Global Penalty)
    bayesian_priors = {
        "Sunny": (0.60, 0.40, 0.00),
        "Rainy": (0.30, 0.70, 0.08),
        "Foggy": (0.10, 0.90, 0.12),
        "Snowy": (0.15, 0.85, 0.15)
    }
    
    cam_weights = weather_conds.map(lambda w: bayesian_priors.get(w, (0.4, 0.6, 0.05))[0])
    lidar_weights = weather_conds.map(lambda w: bayesian_priors.get(w, (0.4, 0.6, 0.05))[1])
    weather_penalty = weather_conds.map(lambda w: bayesian_priors.get(w, (0.4, 0.6, 0.05))[2])
    
    cam_sim = df["Camera_Input_Similarity"].clip(lower=0.1, upper=0.99)
    lidar_sim = df["Lidar_Point_Cloud_Similarity"].clip(lower=0.1, upper=0.99)
    
    # Bayesian evidence blend
    sensor_conf = (cam_weights * cam_sim + lidar_weights * lidar_sim) - weather_penalty + rng.normal(0, 0.03, n)
    sensor_conf = sensor_conf.clip(lower=0.1, upper=0.99)
    
    # Feature: reflectivity_signal (lidar-based with weather + distance degradation)
    dist_factor = (distance / settings.SENSOR_MAX_RANGE_METERS).clip(upper=1.0)
    reflectivity = lidar_sim * (1.0 - 0.2 * dist_factor) - weather_penalty * 0.5 + rng.normal(0, 0.05, n)
    reflectivity = reflectivity.clip(lower=0.05, upper=0.99)
    
    result = pd.DataFrame({
        "relative_size": relative_size.values,
        "aspect_ratio": aspect_ratio.values,
        "motion_signature": motion_signature.values,
        "distance": distance.values,
        "sensor_confidence_raw": sensor_conf.values,
        "reflectivity_signal": reflectivity.values,
        "object_type": object_types.values,
        # Preserve original Kaggle columns as metadata for replay
        "_kaggle_speed_kmph": df["Speed_kmph"].values,
        "_kaggle_weather": df["Weather_Condition"].values,
        "_kaggle_road_type": df["Road_Type"].values,
        "_kaggle_traffic_light": df["Traffic_Light_State"].values,
        "_kaggle_pedestrian_presence": df["Pedestrian_Presence"].values,
        "_kaggle_lane_position": df["Lane_Position"].values,
    })
    
    return result


def get_kaggle_training_data(path: Optional[Path] = None, seed: int = 42) -> pd.DataFrame:
    """
    Load Kaggle dataset and return it in our ML training format.
    Returns DataFrame with FEATURE_COLUMNS + 'object_type'.
    """
    raw = load_kaggle_dataset(path)
    mapped = map_kaggle_to_features(raw, seed=seed)
    
    # Return only the columns needed for training
    feature_cols = [
        "relative_size", "aspect_ratio", "motion_signature",
        "distance", "sensor_confidence_raw", "reflectivity_signal",
        "object_type"
    ]
    return mapped[feature_cols]


def kaggle_to_replay_detections(path: Optional[Path] = None, seed: int = 42) -> List[List[RawDetection]]:
    """
    Convert Kaggle dataset rows into frame-by-frame RawDetection lists
    for use with ReplaySensorSource.
    """
    raw = load_kaggle_dataset(path)
    mapped = map_kaggle_to_features(raw, seed=seed)
    
    frames = []
    for idx, row in mapped.iterrows():
        # Ensure occupancy_confidence always clears the 0.40 pipeline threshold
        # so every Kaggle row produces a real HazardEvent that flows through
        # perception -> risk scoring -> Groq justification.
        occupancy = max(0.75, float(row["sensor_confidence_raw"]) * 1.05)
        
        det = RawDetection(
            sensor_id="kaggle_fusion_01",
            timestamp=float(idx) * 0.1,
            features={
                "relative_size": float(row["relative_size"]),
                "aspect_ratio": float(row["aspect_ratio"]),
                "motion_signature": float(row["motion_signature"]),
                "distance": float(row["distance"]),
                "sensor_confidence_raw": float(row["sensor_confidence_raw"]),
                "reflectivity_signal": float(row["reflectivity_signal"]),
                "_pos_x": float(row.get("_kaggle_lane_position", 0.0)),
                "_pos_y": float(row["distance"]),
                "_pos_z": 0.0,
                "_rel_vx": 0.0,
                "_rel_vy": -float(row.get("_kaggle_speed_kmph", 50)) / 3.6,
                "_lane": "in_lane" if abs(row.get("_kaggle_lane_position", 0.0)) < 1.0 else "adjacent_lane",
                # Rich Kaggle metadata preserved for Groq LLM context
                "_kaggle_weather": str(row.get("_kaggle_weather", "Sunny")),
                "_kaggle_road_type": str(row.get("_kaggle_road_type", "Urban")),
                "_kaggle_traffic_light": str(row.get("_kaggle_traffic_light", "Green")),
                "_kaggle_pedestrian_presence": int(row.get("_kaggle_pedestrian_presence", 0)),
                "_kaggle_speed_kmph": float(row.get("_kaggle_speed_kmph", 50)),
                "_object_type": str(row.get("object_type", "unknown")),
            },
            occupancy_confidence=occupancy
        )
        frames.append([det])
    
    return frames
