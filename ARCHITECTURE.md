# AV-01 Decision Logic Summary: Explainable Rule-Based Navigation

## Overview
Our **AV-01 Intelligent Navigation and Decision-Support System** utilizes a multi-tiered, rule-based inference engine rather than a black-box end-to-end neural network. This ensures **100% explainability** in our trajectory planning and safety overrides, which is critical for regulatory compliance and trust in autonomous vehicles.

The system is fundamentally divided into three core subsystems:
1. **The 360° Environmental Awareness Module (Perception)**
2. **The Risk Assessor & Guidance Module (Decision)**
3. **The Evasive Trajectory Planner (Action)**

---

## 1. Environmental Awareness Module
The AV fuses data from four simulated cameras and a 360° radar array. Rather than just tracking distance, the perception engine places all objects into **Relative Sector Coordinates** (`isFront`, `isRear`, `lateralOffset`).

Each tracked object is assigned a **Time-To-Collision (TTC)** and a localized Risk Profile:
- **Green Zone (> 40m):** Normal tracking.
- **Amber Zone (15m - 40m):** High-alert tracking; AEB primed.
- **Red Zone (< 15m):** Critical immediate danger.

---

## 2. Guidance & Decision Logic
The Guidance Module (MPC) evaluates the `activeHazards` array and generates an explicit string recommendation. 

We utilize a **3-Tier Escalation Protocol**:

### Tier 1: Nominal Cruise (ACC)
If the path is clear, the system maintains the target cruise velocity. If a lead vehicle is detected in the Green Zone, the system enters **Adaptive Cruise Control (ACC)**, smoothly adjusting the Ego speed to match the target vehicle and maintain a safe following distance.

### Tier 2: Evasive Maneuvering (Active Safety)
If an obstacle enters the Amber Zone at high relative speed (e.g., a stalled vehicle or dense traffic), the system first attempts an **Evasive Lane Change**. 
- It scans the adjacent lanes for a 40m clearance gap.
- If clear, it engages a high-aggression lateral shift (swerving) to avoid the collision while maintaining momentum.

### Tier 3: Critical AEB Override
If an obstacle breaches the 15m Red Zone, OR if any object from any 360° sector comes within 6.0m of the vehicle (including side-swipes or rear-ends), the system triggers an unconditional **Autonomous Emergency Braking (AEB)** override. 
- Steering is locked.
- Momentum is forcefully dissipated.

---

## 3. Unique Selling Proposition: Optimization for Indian Traffic
Standard Western AV algorithms fail in chaotic Indian traffic because they are too conservative. Our logic engine introduces specific cultural heuristics:
- **Lateral Overtaking Bias:** The evasive planner will intentionally hug the lane boundaries rather than hard-braking when passing slow-moving `autorickshaws` or `motorcycles`, reflecting the organic flow of Indian highways.
- **Motorcycle Swarm Tolerance:** The radar system allows a smaller lateral buffer for motorcycles than for heavy trucks, recognizing that lane-splitting is standard behavior.

## 4. Edge Case Handling (Sensor Gap)
Our Guidance Module uses multi-modal validation. In our **Sensor Fail / Conflict** scenario, if the Camera detects a high-confidence obstacle, but the Lidar/Radar returns empty (a sensor gap), the Decision logic defaults to the **most conservative action**. It raises a `CONFLICT` status flag, alerts the remote operator, and executes a controlled deceleration to prevent phantom braking while ensuring safety.
