"""
Pydantic v2 data contracts for AV-01 Hazard Perception System.
Strict data schemas ensure no bare dictionaries cross module boundaries.
"""

from typing import Optional, Dict, List, Any, Literal
from pydantic import BaseModel, Field


class RawDetection(BaseModel):
    sensor_id: str
    timestamp: float
    features: Dict[str, Any]  # raw features for the ML classifier (includes string metadata like _lane)
    occupancy_confidence: float  # separate from classification

    # Convenience accessors for the common new fields (stored inside features,
    # but surfaced as top-level getters for readers that don't want to dig).
    @property
    def sensor_zone(self) -> str:
        """One of FRONT | FRONT_LEFT | FRONT_RIGHT | LEFT | RIGHT | BACK | BACK_LEFT | BACK_RIGHT."""
        return str(self.features.get("_sensor_zone", "FRONT"))

    @property
    def pos_local(self) -> Dict[str, float]:
        return {
            "x": float(self.features.get("_pos_x", 0.0)),
            "y": float(self.features.get("_pos_y", 0.0)),
            "z": float(self.features.get("_pos_z", 0.0)),
        }


class HazardEvent(BaseModel):
    id: str
    type: Optional[str] = None  # None if model_unavailable
    classification_confidence: Optional[float] = None
    model_unavailable: bool = False
    occupancy_confidence: float
    position: Dict[str, float]  # e.g. {"x": float, "y": float, "z": float} local (m) relative to ego
    distance: float  # Euclidean distance to vehicle in meters
    relative_velocity: Dict[str, float]  # e.g. {"vx": float, "vy": float}
    lane_relevance: str  # "in_lane", "adjacent_lane", "oncoming_lane", "off_road", "unknown"
    timestamp: float
    prediction: Optional[Dict[str, Any]] = None  # Future trajectory prediction
    raw_features: Optional[Dict[str, Any]] = None  # Original sensor/Kaggle features for Groq context

    # ----- New fields for Step 2 upgrades (backwards-compatible defaults) -----
    # Which sensor zone first detected this hazard (8 zones, incl. Left/Right blind-spot)
    sensor_zone: str = "FRONT"

    # Absolute lat/lng of the hazard, so map.js can place a marker.
    position_geo: Optional[Dict[str, float]] = None  # {"lng": float, "lat": float}

    # Predicted short-horizon path (N=12 points) for rendering dotted lines
    # on both the camera-arc view and the MapLibre map view.
    predicted_path_local: List[Dict[str, float]] = []   # [ {x,y,z} in meters ]
    predicted_path_geo:   List[Dict[str, float]] = []   # [ {lng,lat}     on the map ]

    # Which lane this hazard occupies / is approaching.
    source_lane: int = 0

    # For diagnostics: TTC (seconds) estimated at detection time.
    ttc_seconds: Optional[float] = None


class RiskAssessment(BaseModel):
    hazard_event_id: str
    risk_score: float = Field(..., ge=0.0, le=1.0)
    risk_level: str  # "low" | "medium" | "high" | "critical"
    degraded: bool  # true if built from low-confidence or missing data
    contributing_factors: Dict[str, float]  # weight breakdown, for justification grounding
    hazard_snapshot: Optional[Dict[str, Any]] = None  # snapshot of hazard attributes for evidence extraction

    # ----- New fields for Step 3 -----
    # If non-null, a rule (e.g. "predicted_collision_1.8s", "lane_change_blind_spot_right")
    # contributed most to the score.  Justification templates reference this key.
    dominant_rule: Optional[str] = None
    # Predicted TTC in seconds if rule-based estimate is available
    predicted_ttc: Optional[float] = None


class Justification(BaseModel):
    risk_assessment_id: str
    evidence: List[str]
    reasoning: str
    source: str  # "llm" | "fallback_template"
    generated_at: float


# Valid lane-change states for VehicleState
LaneChangeState = Literal["IDLE", "SIGNALING", "EXECUTING", "COMPLETING", "ABORTING"]


class VehicleState(BaseModel):
    speed_mps: float = 13.88  # ~50 km/h (default cruising)
    heading_deg: float = 0.0
    lane_position: str = "center"
    acceleration_mps2: float = 0.0

    # ----- New fields for Step 2 upgrades -----
    # Lane index (0 = leftmost), total lanes in current road segment
    lane_idx: int = 1
    num_lanes: int = 3

    # Lane-change state machine
    lane_change_state: LaneChangeState = "IDLE"
    lane_change_target_lane: Optional[int] = None
    lane_change_progress: float = 0.0  # 0..1.0 (0 = idle, 1 = completed)
    lane_change_signal_on: bool = False

    # WGS-84 position so map.js can place the ego marker.
    # Defaults: near NYC (matches MapLibre example). Sim drifts this over time.
    pos_lng: float = -74.0060
    pos_lat: float = 40.7128

    # Traffic Light & Open-World Navigation state
    traffic_light_state: str = "GREEN"  # GREEN | YELLOW | RED
    traffic_light_dist: float = 85.0    # Distance to next signal in meters
    turn_state: str = "STRAIGHT"        # STRAIGHT | LEFT | RIGHT | EXIT
    exit_available: bool = True         # Off-ramp/exit option available on route
    dataset_source: str = "AV-01 & Waymo Hybrid"

    # Simulation frame serial. Used by app.js to know when new data arrived.
    frame_id: int = 0


class SystemStatus(BaseModel):
    perception_degraded: bool = False
    model_unavailable: bool = False
    llm_degraded: bool = False
    llm_error_count: int = 0
    llm_calls_count: int = 0
    llm_cap_reached: bool = False
    sensor_gap_active: bool = False
    consecutive_empty_ticks: int = 0
    conflicting_detections_active: bool = False
    overall_health: str = "healthy"  # "healthy" | "degraded" | "critical"


class FrameOutput(BaseModel):
    frame_id: int
    timestamp: float
    vehicle_state: Dict[str, Any]
    hazards: List[HazardEvent]
    risk_assessments: List[RiskAssessment]
    justifications: List[Justification]  # may lag one frame behind due to async LLM calls
    system_status: Dict[str, Any]  # per-stage health


class ScenarioConfig(BaseModel):
    scenario_type: str = "normal"  # "normal" | "sensor_gap" | "conflicting_detections" | "random_urban" | "kaggle_traffic_llm"
    duration_seconds: float = 15.0
    tick_hz: float = 10.0
    seed: Optional[int] = 42


class MetricsSummary(BaseModel):
    trip_id: str
    scenario_type: str
    total_frames: int
    trip_duration_seconds: float
    total_hazards_detected: int
    critical_alerts_raised: int
    high_alerts_raised: int
    sensor_gap_frames: int
    conflicting_detection_frames: int
    degraded_frames: int
    llm_justifications_generated: int
    fallback_justifications_generated: int
    llm_error_rate: float
    average_pipeline_latency_ms: float
    average_cross_track_error_m: float = 0.05
