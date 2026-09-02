"""
Model training script for AV-01 Hazard Perception System.
Trains a Scikit-Learn ensemble classifier on synthetic sensor data and exports the pipeline artifact.
"""

import argparse
import poplib
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score, f1_score
from config import settings
from generate_training_data import generate_synthetic_data


FEATURE_COLUMNS = [
    "relative_size",
    "aspect_ratio",
    "motion_signature",
    "distance",
    "sensor_confidence_raw",
    "reflectivity_signal",
]


def train_and_save_model(
    data_path: str = None,
    output_model_path: str = None,
    n_estimators: int = 150,
    max_depth: int = 14,
    seed: int = 42
):
    if data_path and Path(data_path).exists():
        print(f"Loading data from {data_path}...")
        df = pd.read_csv(data_path)
    else:
        print("Generating fresh synthetic dataset in-memory...")
        df = generate_synthetic_data(num_samples=12000, seed=seed)
        
    X = df[FEATURE_COLUMNS]
    y = df["object_type"]
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=seed, stratify=y
    )
    
    print(f"Training RandomForestClassifier on {len(X_train)} samples across classes {np.unique(y)}...")
    clf = RandomForestClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        min_samples_split=4,
        min_samples_leaf=2,
        class_weight="balanced",
        random_state=seed,
        n_jobs=-1
    )
    clf.fit(X_train, y_train)
    
    # Evaluate
    y_pred = clf.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    f1_macro = f1_score(y_test, y_pred, average="macro")
    
    print("\n" + "=" * 50)
    print(f"Model Test Accuracy: {acc * 100:.2f}% | Macro F1: {f1_macro:.4f}")
    print("=" * 50)
    print("\nClassification Report:\n", classification_report(y_test, y_pred))
    
    # Bundle artifact with metadata
    model_artifact = {
        "model": clf,
        "feature_columns": FEATURE_COLUMNS,
        "classes": list(clf.classes_),
        "version": settings.APP_VERSION,
        "metrics": {
            "test_accuracy": float(acc),
            "macro_f1": float(f1_macro)
        }
    }
    
    out_path = Path(output_model_path or settings.MODEL_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model_artifact, out_path)
    print(f"Saved trained model artifact to {out_path}")
    return model_artifact


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default=str(settings.DATA_DIR / "training_data.csv"))
    parser.add_argument("--out", type=str, default=str(settings.MODEL_PATH))
    args = parser.parse_args()
    
    train_and_save_model(data_path=args.data, output_model_path=args.out)
