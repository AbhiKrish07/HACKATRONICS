"""
Configuration management for the AV-01 Hazard Perception System.
Centralizes all weights, thresholds, simulation parameters, latency budgets,
Groq LLM settings, and circuit breaker tunables.
"""

from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    # System & Paths
    APP_NAME: str = "AV-01 Production-Hardened Hazard Perception System"
    APP_VERSION: str = "2.0.0"
    BASE_DIR: Path = Path(__file__).resolve().parent
    DATA_DIR: Path = BASE_DIR / "data"
    MODELS_DIR: Path = BASE_DIR / "models"
    LOGS_DIR: Path = BASE_DIR / "logs"
    MODEL_PATH: Path = BASE_DIR / "models" / "classifier.joblib"
    SHADOW_MODEL_PATH: Path = BASE_DIR / "models" / "shadow_classifier.joblib"
    REPLAY_DATA_PATH: Path = BASE_DIR / "data" / "nhtsa_incident_replay.jsonl"

    # Simulation & Stream Rates
    SIMULATION_HZ: float = 10.0  # 10 frames per second deliberative tick
    TICK_INTERVAL_SEC: float = 0.1
    REACTIVE_LOOP_HZ: float = 50.0  # 50Hz ultra-fast reactive safety loop
    RING_BUFFER_SIZE: int = 1000

    # Sensor Degradation & Detection Parameters
    OCCUPANCY_CONFIDENCE_THRESHOLD: float = 0.40
    CLASSIFICATION_CONFIDENCE_THRESHOLD: float = 0.50
    SENSOR_GAP_N_TICKS: int = 3  # N consecutive ticks with zero / below floor detections triggers sensor_gap_active
    SENSOR_MAX_RANGE_METERS: float = 120.0
    SENSOR_NOISE_DISTANCE_FACTOR: float = 0.015  # Noise scaling with distance

    # Real-Time Latency Budgets (per stage, in milliseconds)
    LATENCY_BUDGET_REACTIVE_MS: float = 10.0         # Reactive loop (raw proximity check)
    LATENCY_BUDGET_PERCEPTION_MS: float = 50.0       # Perception (ML inference)
    LATENCY_BUDGET_ANALYSIS_MS: float = 10.0         # Analysis (risk scoring)
    LATENCY_BUDGET_JUSTIFICATION_MS: float = 2000.0  # Justification (LLM call)
    LATENCY_BUDGET_DELIBERATIVE_TICK_MS: float = 200.0 # End-to-end deliberative tick

    # Analysis & Risk Scoring Weights (sum to 1.0)
    WEIGHT_DISTANCE: float = 0.35
    WEIGHT_VELOCITY: float = 0.25
    WEIGHT_LANE: float = 0.25
    WEIGHT_SEVERITY: float = 0.15

    # Critical thresholds for collision avoidance
    CRITICAL_DISTANCE_METERS: float = 15.0
    WARNING_DISTANCE_METERS: float = 40.0
    SAFE_DISTANCE_METERS: float = 80.0

    # Closing velocity scoring normalization (m/s)
    MAX_CLOSING_VELOCITY_MPS: float = 25.0

    # Risk Level Thresholds [0.0 - 1.0]
    RISK_THRESHOLD_CRITICAL: float = 0.75
    RISK_THRESHOLD_HIGH: float = 0.55
    RISK_THRESHOLD_MEDIUM: float = 0.30

    # Severity weights per object type
    SEVERITY_WEIGHTS: dict[str, float] = {
        "pedestrian": 1.0,
        "cyclist": 0.85,
        "vehicle": 0.70,
        "motorcycle": 0.90,       # High vulnerability + erratic
        "auto_rickshaw": 0.80,    # Erratic but larger than bike
        "cow": 0.95,              # Highly unpredictable, severe damage
        "dog": 0.80,              # Very erratic, low damage but hard to see
        "static_obstacle": 0.50,
        "unknown": 0.60
    }

    # Lane Relevance weights
    LANE_RELEVANCE_WEIGHTS: dict[str, float] = {
        "in_lane": 1.0,
        "adjacent_lane": 0.60,
        "oncoming_lane": 0.40,
        "off_road": 0.15,
        "unknown": 0.50
    }

    # Groq is the ONLY AI provider in this application - no alternatives
    GROQ_API_KEY: str = Field(default="", alias="GROQ_API_KEY")
    LLM_PROVIDER: str = "groq"
    GROQ_MODEL: str = Field(default="llama-3.3-70b-versatile", description="Groq Model to use - highest quality for AV reasoning")

    # Front-only sensing (no side or rear hardware) - Tesla-style single forward sensor suite
    FRONT_FOV_HALF_ANGLE_DEG: float = 40.0
    FRONT_SENSOR_RANGE_M: float = 150.0
    SIDE_SENSOR_AVAILABLE: bool = False
    REAR_SENSOR_AVAILABLE: bool = False
    MPC_REF_SPEED_MPH: float = 60.0

    # Longitudinal MPC user-adjustable parameters (NOT learned online)
    # following_distance_preference: seconds of time-headway (0.8 .. 3.2)
    # driving_style: "cautious" | "normal" | "aggressive" — weight profile
    FOLLOWING_DISTANCE_PREFERENCE_S: float = 1.8
    DRIVING_STYLE: str = "normal"


    GROQ_ENDPOINT: str = "https://api.groq.com/openai/v1/chat/completions"
    LLM_TIMEOUT_SECONDS: float = 2.0
    LLM_MAX_RETRIES: int = 1
    LLM_RETRY_BACKOFF_SECONDS: float = 0.2
    LLM_MAX_CALLS_PER_RUN: int = 150
    LLM_CACHE_TTL_SECONDS: float = 3.0
    LLM_ENABLED: bool = True

    # Circuit Breaker Parameters (DIFF 6)
    CB_FAILURE_THRESHOLD: int = 3          # 3 consecutive failures trips breaker
    CB_WINDOW_SECONDS: float = 30.0        # Failures within 30-second window
    CB_BASE_COOLDOWN_SECONDS: float = 60.0 # 60-second cooldown in OPEN state
    CB_MAX_COOLDOWN_SECONDS: float = 300.0 # Capped at 5 minutes

    # Watchdog & Process Isolation
    WATCHDOG_HEARTBEAT_TIMEOUT_SEC: float = 2.0
    SHADOW_MODE_ENABLED: bool = True       # Shadow-mode logging
    AUDIT_TRAIL_ENABLED: bool = True       # NHTSA-style JSONL logging

    # Tie-break priority mapping
    RISK_LEVEL_PRIORITY: dict[str, int] = {
        "critical": 4,
        "high": 3,
        "medium": 2,
        "low": 1
    }


# Global singleton settings
settings = Settings()

# Ensure directories exist
settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
settings.MODELS_DIR.mkdir(parents=True, exist_ok=True)
settings.LOGS_DIR.mkdir(parents=True, exist_ok=True)
