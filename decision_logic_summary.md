# AV-01 Decision-Logic Summary
**Hackatronics Project: Explainable Autonomous Arbitration**

## Overview
The AV-01 system uses a deterministic, rule-based guidance module to translate raw hazard detections into concrete driving actions. We explicitly chose a **scoring table and if/then heuristic** over black-box Machine Learning for the final decision layer. This ensures that every vehicle action is 100% explainable, traceable, and verifiable—a critical requirement for autonomous safety regulation.

## The Rule-Based Arbitration Engine

When a `HazardEvent` is received from the perception module (simulated sensors), it passes through our arbitration engine which calculates a **Risk Score (0.0 to 1.0)** based on three primary factors:

### 1. Distance & Proximity Weight (40%)
- **Critical Zone (< 15m):** Maximum penalty applied.
- **Caution Zone (15m - 40m):** Linear scaling penalty.
- **Safe Zone (> 40m):** Minimal impact.

### 2. Time-To-Collision (TTC) (40%)
We predict the future trajectory using a constant velocity model.
- **TTC < 2.0 seconds:** Triggers an immediate AEB (Autonomous Emergency Braking) override.
- **TTC < 4.0 seconds:** Triggers a Lane Change / Overtake recommendation if adjacent lanes are clear.

### 3. Actor Classification & Severity Weight (20%)
Different obstacles possess different behavioral unpredictability multipliers, heavily customized for Indian traffic scenarios:
- **Pedestrians/Cyclists:** Base risk × 1.5 (High vulnerability)
- **Motorcycles/Auto-Rickshaws:** Base risk × 1.3 (High erratic movement probability)
- **Cows/Animals:** Base risk × 1.6 (Extreme unpredictability)
- **Standard Vehicles:** Base risk × 1.0

## The Decision Matrix

Once the aggregate Risk Score is calculated, the system maps the score directly to an actionable state:

| Risk Score | Confidence | Recommended Action | Reasoning Output to Dashboard |
|------------|------------|--------------------|-------------------------------|
| **< 0.3**  | High       | **MAINTAIN SPEED** | "Nominal path. No driving intervention required." |
| **0.3 - 0.7** | High | **REDUCE SPEED** | "Obstacle detected in caution range. Slowing down to maintain safety buffer." |
| **0.7 - 0.9** | Medium | **LANE CHANGE** | "In-path obstacle closing rapidly. Adjacent lane is clear for evasive maneuver." |
| **> 0.9**  | Low/High | **EMERGENCY STOP** | "Critical proximity! AEB engaged to prevent imminent collision." |

## Edge Case Handling & Graceful Degradation
To satisfy robustness requirements, our `DegradationManager` intercepts edge cases *before* they reach the decision matrix:
- **Sensor Conflict (e.g., Radar vs Camera mismatch):** The system defaults to the most conservative (highest risk) reading and lowers the confidence score.
- **Data Gap (No detections for > 500ms):** The system enters "Degraded Mode," holding the last known safe action and recommending a controlled stop until sensor health is restored.

By adhering to this strict, mathematically transparent table, AV-01 guarantees that **no action is taken without a logged, human-readable justification.**
