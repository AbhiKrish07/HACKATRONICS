# AV-01 Intelligent Hazard Perception, Risk Analysis & Justification System

Production-grade Python backend and ML-integration service that ingests simulated sensor telemetry, detects and classifies hazards with machine learning, performs deterministic multi-factor risk analysis, and produces evidence-grounded natural language justifications.

---

## 1. System Architecture

The pipeline is partitioned into **five separable, decoupled modules**:

```
sensor_sim/  →  perception/  →  analysis/  →  justification/  →  api/
```

| Module | Responsibility | Pure Interface | Offline Testable |
| :--- | :--- | :--- | :--- |
| **`sensor_sim/`** | Generates synthetic sensor frames with distance-correlated noise, degradation, and scripted edge cases (sensor gaps, conflicting hazards). | `ScenarioGenerator.step() -> (List[RawDetection], VehicleState)` | Yes |
| **`perception/`** | Decoupled occupancy gatekeeper (presence) + trained Scikit-Learn `RandomForestClassifier` (`predict_proba`). Graceful fallback if model is unavailable or inference throws. | `PerceptionStage.process(List[RawDetection]) -> List[HazardEvent]` | Yes |
| **`analysis/`** | Deterministic multi-factor weighted risk scoring (distance, closing velocity, lane relevance, object severity) + tie-break arbitration for conflicting hazards. | `RiskAnalyzer.process(List[HazardEvent], VehicleState) -> List[RiskAssessment]` | Yes |
| **`justification/`**| Evidence-grounded natural language generation. Strict facts-only prompt to Claude API (`claude-sonnet-4-6`), post-generation hallucination tripwire, TTL caching, rate guards, and template fallbacks. | `JustificationEngine.process(...) -> List[Justification]` | Yes (offline fallback) |
| **`api/`** | Async FastAPI backend with REST endpoints, per-run JSONL persistence, ring buffer scrollback, and 10Hz live WebSocket streaming to the visual dashboard. | `FastAPI + WebSocket /ws` | Yes |

---

## 2. Decision Logic Summary (For Judges & Evaluators)

1. **Occupancy vs Classification Separation**: Physical presence detection operates independently with high recall so low classification confidence never silently drops physical obstacles.
2. **Deterministic Risk Scoring Formula**:
   $$\text{RiskScore} = w_{\text{dist}} \cdot f(\text{dist}) + w_{\text{vel}} \cdot f(v_{\text{closing}}) + w_{\text{lane}} \cdot f(\text{lane}) + w_{\text{sev}} \cdot f(\text{type})$$
   - Critical radius ($\le 15\text{m}$) sharply elevates risk scores.
   - All weights ($0.35, 0.25, 0.25, 0.15$) and thresholds are centralized in `config.py`.
3. **First-Class Edge Cases**:
   - **Sensor Gap Window**: If 0 detections or sub-floor occupancy occurs for $\ge N$ consecutive ticks ($N=3$), `sensor_gap_active=True`, triggering an immediate conservative default posture and deterministic justification.
   - **Conflicting Detections**: When two hazards simultaneously register high/critical risk, the system executes deterministic tie-break arbitration ($\text{Risk Level} \to \text{Distance} \to \text{Vulnerability}$) and issues a dual-hazard explanation justifying the selected priority.

---

## 3. LLM Justification Layer Grounding & Robustness

The justification layer is engineered with defensive guardrails to eliminate hallucinations and network fragility:

- **Strict Evidence Grounding**: The LLM prompt receives **only** pre-computed deterministic facts (distances, speeds, hazard types, contributing factors) — never unstructured or open-ended prompts.
- **Hallucination Tripwire (`grounding.py`)**: Validates every generated explanation against ground-truth facts. Any unmentioned entities (e.g., claiming a "cyclist" when only a "pedestrian" was detected) or unsupported numbers (e.g., claiming "95m" when true distance is "12m") cause immediate rejection and switch to the deterministic template fallback.
- **Timeout & Retries**: 2.0s strict timeout. Exactly 1 retry on transient 5xx/network errors; immediate fallback on 4xx client errors.
- **Deduplication Cache**: Hash-based TTL cache reuses explanations for identical static hazard profiles.
- **API Key Sanitization**: Strict regex sanitization prevents credentials from ever being printed to logs, console, or WebSocket payloads.

---

## 4. Quick Start & Execution Guide

### Prerequisites
- Python 3.11+ (or Python 3.9+ virtual environment)

### 1. Install Dependencies
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Generate Synthetic Dataset & Train Classifier
```bash
# Generate 12,000 synthetic sensor detection samples with distance-correlated noise
python generate_training_data.py

# Train Random Forest Classifier and save artifact to models/classifier.joblib
python train_model.py
```

### 3. Run the Pytest Test Suite
```bash
pytest -v
```

### 4. Start the Service & Visual Dashboard
```bash
uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

Open your browser to:
- **Interactive Visual Dashboard**: `http://localhost:8000`
- **Health Check & Stage Status**: `http://localhost:8000/health`
- **Metrics Summary**: `http://localhost:8000/metrics`
- **Interactive OpenAPI Documentation**: `http://localhost:8000/docs`
