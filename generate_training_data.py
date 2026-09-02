"""
Synthetic Dataset Generator for the AV-01 Hazard Perception Classifier.
Generates realistic labeled sensor feature distributions with distance-correlated noise.
"""

import argparse
import numpy as np
import pandas as pd
from pathlib import Path
from config import settings


def generate_synthetic_data(num_samples: int = 12000, seed: int = 42) -> pd.DataFrame:
    np.random.seed(seed)
    
    classes = ["pedestrian", "vehicle", "cyclist", "static_obstacle", "cow", "auto_rickshaw", "motorcycle", "unknown"]
    class_probs = [0.15, 0.30, 0.10, 0.10, 0.12, 0.10, 0.10, 0.03]
    
    assigned_classes = np.random.choice(classes, size=num_samples, p=class_probs)
    
    data = []
    
    for cls in assigned_classes:
        # Distance (5m to 100m)
        dist = np.random.uniform(5.0, 95.0)
        dist_factor = dist / 100.0  # 0.05 to 0.95
        rel_vx = 0.0
        scenario_label = "nominal_traffic"
        
        # Base characteristics per class
        if cls == "pedestrian":
            base_size = np.random.normal(0.25, 0.05)
            base_aspect = np.random.normal(0.35, 0.05)
            base_motion = np.random.normal(1.3, 0.4)
            base_conf = np.random.uniform(0.80, 0.98)
            rel_vx = np.random.normal(0.8, 0.3)
            scenario_label = "pedestrian_signal_violator"
        elif cls == "vehicle":
            base_size = np.random.normal(1.2, 0.2)
            base_aspect = np.random.normal(2.0, 0.3)
            base_motion = np.random.normal(12.0, 4.0)
            base_conf = np.random.uniform(0.85, 0.99)
            rel_vx = np.random.normal(0.0, 0.2)
            scenario_label = "nominal_traffic"
        elif cls == "motorcycle":
            base_size = np.random.normal(0.35, 0.06)
            base_aspect = np.random.normal(0.55, 0.08)
            base_motion = np.random.normal(10.0, 3.0)
            base_conf = np.random.uniform(0.82, 0.97)
            rel_vx = np.random.normal(1.6, 0.5) * np.random.choice([-1, 1])
            scenario_label = "motorcycle_weaving"
        elif cls == "auto_rickshaw":
            base_size = np.random.normal(0.65, 0.10)
            base_aspect = np.random.normal(1.1, 0.15)
            base_motion = np.random.normal(6.0, 2.0)
            base_conf = np.random.uniform(0.84, 0.96)
            rel_vx = np.random.normal(1.1, 0.4)
            scenario_label = "auto_sudden_turn"
        elif cls == "cow":
            base_size = np.random.normal(0.9, 0.15)
            base_aspect = np.random.normal(1.4, 0.20)
            base_motion = np.random.normal(0.1, 0.08)
            base_conf = np.random.uniform(0.85, 0.98)
            rel_vx = np.random.normal(0.0, 0.05)
            scenario_label = "cow_stationary"
        elif cls == "cyclist":
            base_size = np.random.normal(0.45, 0.08)
            base_aspect = np.random.normal(0.65, 0.08)
            base_motion = np.random.normal(5.5, 1.5)
            base_conf = np.random.uniform(0.78, 0.95)
            rel_vx = np.random.normal(0.3, 0.1)
        elif cls == "static_obstacle":
            base_size = np.random.normal(0.8, 0.25)
            base_aspect = np.random.normal(1.1, 0.3)
            base_motion = np.random.normal(0.05, 0.04)
            base_conf = np.random.uniform(0.82, 0.96)
        else:  # unknown
            base_size = np.random.uniform(0.1, 1.5)
            base_aspect = np.random.uniform(0.2, 2.5)
            base_motion = np.random.uniform(0.0, 15.0)
            base_conf = np.random.uniform(0.40, 0.75)
            
        # Apply distance-correlated degradation / noise
        # Farther objects suffer greater measurement variance and reduced raw confidence
        noise_std = settings.SENSOR_NOISE_DISTANCE_FACTOR * dist
        
        rel_size = max(0.05, base_size + np.random.normal(0, noise_std * 0.4))
        aspect_ratio = max(0.1, base_aspect + np.random.normal(0, noise_std * 0.5))
        motion_sig = max(0.0, base_motion + np.random.normal(0, noise_std * 1.5))
        sensor_conf_raw = np.clip(base_conf - (dist_factor * 0.35) + np.random.normal(0, 0.05), 0.15, 0.99)
        
        # Additional engineered sensor features
        reflectivity_signal = np.clip(
            (0.9 if cls == "vehicle" else 0.4 if cls == "pedestrian" else 0.6) - (dist_factor * 0.2) + np.random.normal(0, 0.1),
            0.05, 0.99
        )
        
        # Open-World & Waymo dataset alignment features
        traffic_signal = np.random.choice(["GREEN", "YELLOW", "RED"], p=[0.6, 0.15, 0.25])
        turn_maneuver = np.random.choice(["STRAIGHT", "LEFT", "RIGHT", "EXIT"], p=[0.55, 0.20, 0.15, 0.10])

        data.append({
            "relative_size": float(rel_size),
            "aspect_ratio": float(aspect_ratio),
            "motion_signature": float(motion_sig),
            "distance": float(dist),
            "sensor_confidence_raw": float(sensor_conf_raw),
            "reflectivity_signal": float(reflectivity_signal),
            "traffic_light_state": str(traffic_signal),
            "turn_maneuver": str(turn_maneuver),
            "waymo_schema_aligned": 1,
            "object_type": cls
        })
        
    df = pd.DataFrame(data)
    return df


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic training data for hazard perception classifier.")
    parser.add_argument("--samples", type=int, default=12000, help="Number of samples to generate")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--output", type=str, default=str(settings.DATA_DIR / "training_data.csv"), help="Output CSV path")
    args = parser.parse_args()
    
    print(f"Generating {args.samples} synthetic sensor detections with seed={args.seed}...")
    df = generate_synthetic_data(num_samples=args.samples, seed=args.seed)
    
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_path, index=False)
    print(f"Saved synthetic dataset with {len(df)} rows to {out_path}")
    print("\nClass distribution:")
    print(df["object_type"].value_counts())
    print("\nSample features:")
    print(df.head())


if __name__ == "__main__":
    main()
