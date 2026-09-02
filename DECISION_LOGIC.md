# AV-01 AI Decision & Arbitration Logic

This document explains the core decision-making and arbitration architecture powering the **AV-01 Autonomous Vehicle Simulation**. 

Our system uses a **multi-stage AI pipeline** that blends deterministic fallback rules with a state-of-the-art Large Language Model (Groq LPU / TrafficLLM) for evidence-grounded justification.

---

## 1. The Arbitration Hierarchy

AV-01 evaluates hazards and makes driving decisions 60 times per second using a **3-stage arbitration system**:

### Stage 1: Deterministic Physics & Sensor Bounds (The "Circuit Breaker")
Before any AI model is consulted, the physical parameters of the environment are checked against strict mathematical bounds.
- **TTC (Time to Collision):** Calculated using `(Distance to Object) / (Relative Speed)`.
- **In-Path Analysis:** Uses a ±1.8m lateral bounding box.
- **Action:** If TTC < 2.0s, the system hard-engages the **Automatic Emergency Braking (AEB)** system with maximum deceleration (100 mph/s). *This stage cannot be overridden by higher-level AI.*

### Stage 2: Tactical Driving & BLIS (Blind Spot Information System)
When the vehicle is not in an emergency state, it enters tactical planning.
- **Adaptive Cruise:** Dynamically matches speed with the lead vehicle to maintain a safe following distance.
- **BLIS Intervention:** The side sensors (visualized as orange lateral cones) track objects in the adjacent lanes (-15m to +10m). If the driver or the auto-pilot attempts a lane change while a vehicle is detected, the **BLIS Active Intervention** takes over, applying haptic feedback (screen shake) and forcing the vehicle back into its original lane.

### Stage 3: LLM-Grounded Justification (TrafficLLM)
For edge cases and complex scenes, the system packages the sensor telemetry (weather, road type, radar pings, camera confidence) and sends it to our high-speed Groq LPU endpoint. 
- The LLM parses the entire scene and provides a human-readable **Grounded Justification**.
- This acts as an "Explainable AI" layer, outputting the reasoning for the vehicle's behavior on the HUD (e.g., "Slowing down due to foggy conditions and high-speed cyclist in adjacent lane").

---

## 2. Handling Edge Cases

To demonstrate the robustness of this pipeline, we have engineered two specific chaos-testing edge cases:

### A. The "Sensor Gap" (Sensor Failure)
**Scenario:** Extreme weather (dense fog or blizzard) suddenly drops LiDAR and Camera confidence to < 0.2, blinding the primary sensors.
**Arbitration Response:** The system immediately detects the confidence drop. It falls back to the deterministic Radar and drastically reduces the target cruise speed to maintain safety margins until confidence is restored. The LLM is bypassed for latency reasons during this critical failure.

### B. Conflicting Sensor Detections
**Scenario:** The Camera detects a pedestrian (confidence: 0.9) but the LiDAR detects empty space (confidence: 0.1). This is a classic "phantom braking" scenario.
**Arbitration Response:** The system uses **Pessimistic Arbitration**. If *any* sensor detects a highly-confident hazard in the critical path, the system assumes the hazard is real and engages the AEB. It is better to phantom-brake than to cause a collision.

---

## 3. Performance Metrics

All interventions (AEB, BLIS) are logged in real-time to the **Trip Performance Log**. This JSON log can be exported at the end of the simulation run for post-trip analysis, ensuring full traceability and compliance with safety audits.
