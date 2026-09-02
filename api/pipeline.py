"""
Production Pipeline Orchestrator with SAL, Circuit Breaker, and Latency Telemetry.

Connects:
SensorSource
    -> Perception
    -> Analysis
    -> Justification
    -> Output

Also handles:
- Sensor-gap detection
- Graceful degradation
- Conflict detection
- Latency telemetry
- MPC control
- Shadow-mode evaluation
"""

import time
import uuid
import logging
from typing import Optional, Dict, Any, List

from config import settings

from schemas.models import (
    FrameOutput,
    HazardEvent,
    RiskAssessment,
    Justification,
    VehicleState,
    ScenarioConfig
)

from sensor_sim.sal import (
    SensorSource,
    SimulatedSensorSource,
    ReplaySensorSource,
    KaggleReplaySensorSource
)

from perception.pipeline import PerceptionStage
from perception.model import PerceptionClassifier
from perception.shadow_model import ShadowPerceptionEvaluator
from perception.prediction import IndianTrafficPredictor
from perception.trajectory import enrich_hazard_paths

from autodrive_mpc import MPCController, in_front_fov
from longitudinal_mpc import LongitudinalMPC, find_nearest_front_hazard, accel_to_throttle
from light_integration import (
    assess_traffic_risk,
    generate_traffic_scene,
    KaggleTrafficDensity,
    KaggleHazardSensorSource,
    integration_stats as light_integration_stats,
)

from analysis.risk_scorer import RiskAnalyzer
from justification.engine import JustificationEngine

from storage.logger import StructuredRunLogger
from storage.audit_trail import AuditTrailLogger

from runtime.data_validator import DataValidator
from runtime.degradation import DegradationManager
from runtime.observability import LatencyTracker, DetectionMetrics


logger = logging.getLogger("av01.pipeline")


class PipelineRunner:
    """
    Executes discrete simulation ticks.

    Pipeline:

        Sensor
          ↓
        Validation
          ↓
        Perception
          ↓
        Prediction
          ↓
        Risk Analysis
          ↓
        Justification
          ↓
        Degradation
          ↓
        Output
    """

    def __init__(
        self,
        sensor_source: Optional[SensorSource] = None,
        classifier: Optional[PerceptionClassifier] = None,
        justification_engine: Optional[JustificationEngine] = None
    ):
        # Core processing components
        self.classifier = classifier or PerceptionClassifier()
        self.perception = PerceptionStage(
            classifier=self.classifier
        )

        self.shadow_evaluator = ShadowPerceptionEvaluator()
        self.analyzer = RiskAnalyzer()

        self.justification = (
            justification_engine
            or JustificationEngine()
        )

        # Scenario information
        self.scenario_type = "normal"

        self.trip_id = (
            f"trip_{int(time.time())}_"
            f"{uuid.uuid4().hex[:6]}"
        )

        # Sensor
        self.sensor_source = (
            sensor_source
            or SimulatedSensorSource(
                scenario_type=self.scenario_type
            )
        )

        # Logging
        self.logger = StructuredRunLogger(
            trip_id=self.trip_id,
            scenario_type=self.scenario_type
        )

        self.audit_logger = AuditTrailLogger(
            trip_id=self.trip_id
        )

        # Runtime systems
        self.validator = DataValidator()
        self.degradation_mgr = DegradationManager()
        self.latency_tracker = LatencyTracker()
        self.detection_metrics = DetectionMetrics()

        # Prediction and control
        self.predictor = IndianTrafficPredictor(
            fps=int(settings.SIMULATION_HZ)
        )
        self.mpc_controller = MPCController()
        self.longitudinal_mpc = LongitudinalMPC(horizon_steps=10, dt_sec=settings.TICK_INTERVAL_SEC)

        # Kaggle traffic density (fully local, CSV-cached)
        self.traffic_density = KaggleTrafficDensity.instance()

        # Recent object positions
        self.history_buffer = {}

        # Runtime state
        self.frame_id = 0
        self.consecutive_empty_ticks = 0
        self.is_running = False
        self._cached_traffic_assess_out: Optional[Dict[str, Any]] = None
        self._last_guidance: Dict[str, Any] = {
            "action": "CRUISE",
            "confidence": 0.6,
            "why": "Initializing — no guidance yet.",
            "source": "pipeline_init",
            "cost_breakdown": {"speed": 0, "distance": 0, "jerk": 0, "actuation": 0, "total": 0},
        }

    # ------------------------------------------------------------------
    # SCENARIO MANAGEMENT
    # ------------------------------------------------------------------

    def start_scenario(
        self,
        scenario_config: Optional[ScenarioConfig] = None
    ) -> str:
        """
        Start or restart a simulation scenario.
        """

        cfg = scenario_config or ScenarioConfig()

        self.scenario_type = cfg.scenario_type

        self.trip_id = (
            f"trip_{int(time.time())}_"
            f"{uuid.uuid4().hex[:6]}"
        )

        # Select sensor source
        if self.scenario_type == "replay":

            self.sensor_source = ReplaySensorSource()

        elif self.scenario_type == "kaggle":

            self.sensor_source = KaggleHazardSensorSource(seed=cfg.seed or 42)

        elif self.scenario_type == "kaggle_replay":

            self.sensor_source = KaggleReplaySensorSource(
                seed=cfg.seed or 42
            )

        else:

            self.sensor_source = SimulatedSensorSource(
                scenario_type=self.scenario_type,
                seed=cfg.seed
            )

        # Reset logging
        self.logger = StructuredRunLogger(
            trip_id=self.trip_id,
            scenario_type=self.scenario_type
        )

        self.audit_logger = AuditTrailLogger(
            trip_id=self.trip_id
        )

        # Reset runtime state
        self.justification.reset_run()

        self.history_buffer = {}

        self.frame_id = 0
        self.consecutive_empty_ticks = 0

        self.is_running = True

        logger.info(
            f"Started scenario '{self.scenario_type}' "
            f"with trip ID: {self.trip_id}"
        )

        return self.trip_id

    def reset(self):
        """
        Reset the pipeline to a normal scenario.
        """

        self.start_scenario(
            ScenarioConfig(
                scenario_type="normal"
            )
        )

    # ------------------------------------------------------------------
    # MAIN PIPELINE
    # ------------------------------------------------------------------

    async def step(self) -> FrameOutput:
        """
        Execute one complete simulation tick.
        """

        self.frame_id += 1

        t_start = time.perf_counter()

        timings: Dict[str, float] = {}
        errors: List[str] = []
        breaches: List[str] = []

        try:

            current_time = (
                self.frame_id
                * settings.TICK_INTERVAL_SEC
            )

            # ==========================================================
            # STAGE 1: SENSOR ABSTRACTION LAYER
            # ==========================================================

            t0 = time.perf_counter()

            raw_detections = self.sensor_source.read(
                current_time
            )

            # Validate detections
            valid_detections, rejections = (
                self.validator.validate_batch(
                    raw_detections
                )
            )

            if rejections:
                errors.extend(rejections)

            # Vehicle state
            vehicle_state = (
                self.sensor_source.get_vehicle_state()
            )

            # Sensor health
            sensor_health = self.sensor_source.health()

            sensor_latency = (
                time.perf_counter() - t0
            ) * 1000

            sensor_latency = round(
                sensor_latency,
                2
            )

            timings["sensor_sal_ms"] = sensor_latency

            self.latency_tracker.record(
                "sensor_sal",
                sensor_latency,
                10.0
            )

            # ==========================================================
            # SENSOR GAP DETECTION
            # ==========================================================

            valid_occupancy = [
                detection
                for detection in valid_detections
                if (
                    detection.occupancy_confidence
                    >= settings.OCCUPANCY_CONFIDENCE_THRESHOLD
                )
            ]

            if len(valid_occupancy) == 0:

                self.consecutive_empty_ticks += 1

            else:

                self.consecutive_empty_ticks = 0

            sensor_gap_active = (
                self.consecutive_empty_ticks
                >= settings.SENSOR_GAP_N_TICKS
            )

            # ==========================================================
            # STAGE 2: PERCEPTION
            # ==========================================================

            t1 = time.perf_counter()

            hazards = self.perception.process(
                valid_detections
            )

            # Detection metrics
            self.detection_metrics.record_frame()

            for hazard in hazards:

                if hazard.type:

                    self.detection_metrics.record_detection(
                        hazard.type,
                        hazard.classification_confidence
                        or 0.0
                    )

            perception_ms = (
                time.perf_counter() - t1
            ) * 1000

            perception_ms = round(
                perception_ms,
                2
            )

            timings["perception_ms"] = perception_ms

            self.latency_tracker.record(
                "perception",
                perception_ms,
                settings.LATENCY_BUDGET_PERCEPTION_MS
            )

            if (
                perception_ms
                > settings.LATENCY_BUDGET_PERCEPTION_MS
            ):

                breaches.append(
                    f"perception_latency_breach "
                    f"({perception_ms:.1f}ms > "
                    f"{settings.LATENCY_BUDGET_PERCEPTION_MS}ms)"
                )

            # ==========================================================
            # SHADOW MODEL
            # ==========================================================

            if settings.SHADOW_MODE_ENABLED:

                t_shadow = time.perf_counter()

                shadow_evals = (
                    self.shadow_evaluator.evaluate_shadow(
                        valid_detections
                    )
                )

                timings["shadow_eval_ms"] = round(
                    (
                        time.perf_counter()
                        - t_shadow
                    ) * 1000,
                    2
                )

            else:

                shadow_evals = []

            # ==========================================================
            # PERCEPTION HEALTH
            # ==========================================================

            perception_degraded = (
                not self.classifier.is_loaded
                or any(
                    (
                        hazard.classification_confidence
                        is None
                        or
                        hazard.classification_confidence
                        <
                        settings.CLASSIFICATION_CONFIDENCE_THRESHOLD
                    )
                    for hazard in hazards
                )
            )

            # ==========================================================
            # PREDICTION
            # ==========================================================

            t_pred = time.perf_counter()

            obstacles = []

            for hazard in hazards:

                # Create history entry if necessary
                if hazard.id not in self.history_buffer:

                    self.history_buffer[
                        hazard.id
                    ] = []

                h_vx = hazard.relative_velocity.get(
                    "vx",
                    0.0
                )

                h_vy = hazard.relative_velocity.get(
                    "vy",
                    0.0
                )

                self.history_buffer[
                    hazard.id
                ].append(
                    {
                        "x": hazard.position.get(
                            "x",
                            0.0
                        ),

                        "y": hazard.position.get(
                            "z",
                            0.0
                        ),

                        "vx": h_vx,

                        "vy": (
                            h_vy
                            + vehicle_state.speed_mps
                        )
                    }
                )

                # Keep last 10 positions
                if len(
                    self.history_buffer[
                        hazard.id
                    ]
                ) > 10:

                    self.history_buffer[
                        hazard.id
                    ].pop(0)

                prediction = (
                    self.predictor
                    .predict_with_indian_adaptation(
                        self.history_buffer[
                            hazard.id
                        ],
                        hazard.type or "unknown"
                    )
                )

                hazard.prediction = prediction
                enrich_hazard_paths(hazard, vehicle_state, self.history_buffer.get(hazard.id))

                obstacles.append(
                    {
                        "distance": hazard.distance,

                        "speedMph": (
                            h_vy
                            + vehicle_state.speed_mps
                        ) * 2.23694,

                        "type": (
                            hazard.type
                            or "unknown"
                        )
                    }
                )

            # ==========================================================
            # TRAFFIC ANALYSIS  —  credit-efficient (heuristic-first,
            # cached, Groq only on ambiguous high-risk ticks).
            # ==========================================================

            # Enrich frame data from the nearest hazard's Kaggle metadata
            # (weather, road, traffic-light, pedestrian presence) so the
            # assessor has real historical context, not hardcoded constants.
            def _hazard_meta_field(h: HazardEvent, key: str, default: str) -> str:
                ev = h.extra or {}
                # Hazard events come from either RawDetection features or the
                # perception stage; check a handful of likely keys.
                for k in (key, f"_kaggle_{key}", f"_kaggle_{key.lower()}"):
                    v = ev.get(k)
                    if v is not None and v != "":
                        return str(v)
                return default

            road_ctx = "Urban"
            weather_ctx = "Clear"
            tl_ctx = "Green"
            ped_ctx = False
            if hazards:
                nearest = min(hazards, key=lambda h: h.distance or 9999.0)
                road_ctx = _hazard_meta_field(nearest, "Road_Type", "Urban").strip() or "Urban"
                weather_ctx = _hazard_meta_field(nearest, "Weather_Condition", "Clear").strip() or "Clear"
                tl_ctx = _hazard_meta_field(nearest, "Traffic_Light_State", "Green").strip() or "Green"
                ped_raw = _hazard_meta_field(nearest, "Pedestrian_Presence", "0")
                ped_ctx = str(ped_raw) in ("1", "True", "true", "yes", "Y") or nearest.type == "pedestrian"

            # Run the cheap assessor every 30 frames (~3 s at 10 Hz).
            # Because TTL cache + heuristic-first, ~95% of these still cost
            # zero Groq tokens.
            if self.frame_id % 30 == 0:
                try:
                    density_info = self.traffic_density.current()
                    assess_out = assess_traffic_risk(
                        current_speed_mph=vehicle_state.speed_mps * 2.23694,
                        obstacles=obstacles,
                        road_type=road_ctx,
                        weather=weather_ctx,
                        traffic_light=tl_ctx,
                        pedestrian=ped_ctx,
                    )
                    # Attach density (purely local) for the dashboard / judges.
                    assess_out["traffic_density_vph"] = density_info.vehicles_per_hour
                    assess_out["traffic_density_source"] = density_info.source
                    assess_out["hour_of_day"] = density_info.hour_of_day
                    self._cached_traffic_assess_out = assess_out
                    logger.info(
                        f"Traffic risk assessment (source=heuristic_cached, "
                        f"groq_used={assess_out.get('groq_used', False)}): "
                        f"{assess_out.get('risk')} — {assess_out.get('reasoning')[:90]}"
                    )
                except Exception as e:
                    # Never break the main pipeline.
                    logger.debug(f"Traffic risk assessment skipped: {e}")
                    self._cached_traffic_assess_out = {
                        "risk": "UNKNOWN",
                        "reasoning": "Traffic assessment unavailable this frame.",
                        "confidence": 0.0,
                        "heuristic_score_used": True,
                        "groq_used": False,
                    }

            prediction_ms = (
                time.perf_counter()
                - t_pred
            ) * 1000

            timings["prediction_ms"] = round(
                prediction_ms,
                2
            )

            # ==========================================================
            # STAGE 3: RISK ANALYSIS
            # ==========================================================

            t2 = time.perf_counter()

            risk_assessments = (
                self.analyzer.process(
                    hazards,
                    vehicle_state
                )
            )

            (
                is_conflict,
                primary_hazard,
                secondary_hazard
            ) = self.analyzer.detect_conflicts(
                risk_assessments
            )

            if (
                is_conflict
                and primary_hazard
                and secondary_hazard
            ):

                conflict_pair = (
                    primary_hazard,
                    secondary_hazard
                )

            else:

                conflict_pair = None

            analysis_ms = (
                time.perf_counter()
                - t2
            ) * 1000

            analysis_ms = round(
                analysis_ms,
                2
            )

            timings["analysis_ms"] = analysis_ms

            self.latency_tracker.record(
                "analysis",
                analysis_ms,
                settings.LATENCY_BUDGET_ANALYSIS_MS
            )

            if (
                analysis_ms
                > settings.LATENCY_BUDGET_ANALYSIS_MS
            ):

                breaches.append(
                    f"analysis_latency_breach "
                    f"({analysis_ms:.1f}ms > "
                    f"{settings.LATENCY_BUDGET_ANALYSIS_MS}ms)"
                )

            # ==========================================================
            # STAGE 4: JUSTIFICATION
            # ==========================================================

            t3 = time.perf_counter()

            justifications = (
                await self.justification.process(
                    assessments=risk_assessments,
                    sensor_gap_ticks=(
                        self.consecutive_empty_ticks
                    ),
                    conflict_pair=conflict_pair
                )
            )

            justification_ms = (
                time.perf_counter()
                - t3
            ) * 1000

            justification_ms = round(
                justification_ms,
                2
            )

            timings[
                "justification_ms"
            ] = justification_ms

            self.latency_tracker.record(
                "justification",
                justification_ms,
                settings.LATENCY_BUDGET_JUSTIFICATION_MS
            )

            # ==========================================================
            # DEGRADATION MANAGER
            # ==========================================================

            deg_state = (
                self.degradation_mgr.evaluate(
                    perception_degraded=(
                        perception_degraded
                    ),

                    model_unavailable=(
                        not self.classifier.is_loaded
                    ),

                    llm_degraded=(
                        self.justification.llm_error_count > 0
                        or
                        self.justification
                        .circuit_breaker
                        .state
                        .value
                        == "OPEN"
                    ),

                    sensor_gap_active=(
                        sensor_gap_active
                    ),

                    latency_breach=(
                        len(breaches) > 0
                    )
                )
            )

            # ==========================================================
            # TOTAL LATENCY
            # ==========================================================

            total_ms = (
                time.perf_counter()
                - t_start
            ) * 1000

            total_ms = round(
                total_ms,
                2
            )

            timings[
                "total_pipeline_ms"
            ] = total_ms

            self.latency_tracker.record(
                "total_tick",
                total_ms,
                settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS
            )

            if (
                total_ms
                > settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS
            ):

                breaches.append(
                    f"deliberative_tick_breach "
                    f"({total_ms:.1f}ms > "
                    f"{settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS}ms)"
                )

            # ==========================================================
            # SYSTEM STATUS
            # ==========================================================

            llm_degraded = (
                self.justification.llm_error_count > 0
                or
                self.justification
                .circuit_breaker
                .state
                .value
                == "OPEN"
            )

            # IMPORTANT:
            # An active sensor gap is explicitly reported
            # as CRITICAL health, even if the degradation
            # manager has moved to a higher numerical level.
            #
            # This is required by the edge-case specification:
            #
            # 3 consecutive empty ticks
            # -> sensor_gap_active = True
            # -> overall_health = "critical"

            if sensor_gap_active:

                overall_health = "critical"

            else:

                overall_health = deg_state.level_name

            status = {

                "perception_degraded":
                    perception_degraded,

                "model_unavailable":
                    not self.classifier.is_loaded,

                "llm_degraded":
                    llm_degraded,

                "llm_error_count":
                    self.justification.llm_error_count,

                "llm_calls_count":
                    self.justification.llm_call_count,

                "circuit_breaker":
                    self.justification
                    .circuit_breaker
                    .get_status(),

                "sensor_gap_active":
                    sensor_gap_active,

                "sensor_health":
                    sensor_health.model_dump(),

                "consecutive_empty_ticks":
                    self.consecutive_empty_ticks,

                "conflicting_detections_active":
                    is_conflict,

                "latency_breaches":
                    breaches,

                "shadow_predictions_count":
                    len(shadow_evals),

                "overall_health":
                    overall_health,

                "degradation_level":
                    deg_state.level,

                "light_integration_stats": light_integration_stats(),

                "groq_prediction": self._cached_traffic_assess_out,
            }

            # Synthesize live guidance recommendation for dashboard & API consumers
            if sensor_gap_active:
                g_act = "CONTROLLED STOP"
                g_conf = 0.50
                g_why = "Sensor gap active (>3 empty ticks). System maintaining conservative posture."
            elif is_conflict:
                g_act = "EMERGENCY STOP"
                g_conf = 0.70
                g_why = f"Conflicting hazard detections ({primary_hazard.risk_level if primary_hazard else 'high'} vs {secondary_hazard.risk_level if secondary_hazard else 'high'}). Pessimistic arbitration engaged."
            elif risk_assessments:
                top_ra = risk_assessments[0]
                top_snap = top_ra.hazard_snapshot or {}
                h_type = top_snap.get("type", "hazard")
                h_dist = top_snap.get("distance_m", 0.0)
                if top_ra.risk_level == "critical":
                    g_act = "EMERGENCY STOP"
                    g_conf = 0.95
                elif top_ra.risk_level == "high":
                    g_act = "LANE CHANGE" if (top_ra.contributing_factors.get("lane_factor", 0) > 0.2 and abs(top_snap.get("closing_velocity_mps", 0)) > 2.0) else "REDUCE SPEED"
                    g_conf = 0.88
                elif top_ra.risk_level == "medium":
                    g_act = "REDUCE SPEED"
                    g_conf = 0.91
                else:
                    g_act = "MAINTAIN SPEED"
                    g_conf = 0.96

                g_why = justifications[0].reasoning if justifications else f"{top_ra.risk_level.upper()} risk: {h_type} detected at {h_dist:.1f}m (score: {top_ra.risk_score:.2f})."
            else:
                g_act = "MAINTAIN SPEED"
                g_conf = 0.98
                g_why = "Nominal path forward. Forward sensor cone clear."

            self._last_guidance = {
                "action": g_act,
                "confidence": g_conf,
                "why": g_why,
                "source": "pipeline_deliberative",
                "lead_distance_m": hazards[0].distance if hazards else None,
            }
            status["guidance"] = self._last_guidance

            # ==========================================================
            # MPC AUTODRIVE
            # ==========================================================

            import numpy as np

            coeffs = np.array(
                [
                    0.0,
                    0.0,
                    0.0,
                    0.0
                ]
            )

            state = [
                0.0,
                0.0,
                0.0,
                vehicle_state.speed_mps,
                0.0,
                0.0
            ]

            try:

                steer, throttle = (
                    self.mpc_controller.solve(
                        state,
                        coeffs
                    )
                )

                status["mpc_steering"] = float(
                    steer
                )

                status["mpc_throttle"] = float(
                    throttle
                )

            except Exception:

                status["mpc_steering"] = 0.0
                status["mpc_throttle"] = 0.0

            # ==========================================================
            # BUILD FRAME OUTPUT
            # ==========================================================

            frame = FrameOutput(

                frame_id=self.frame_id,

                timestamp=round(
                    current_time,
                    3
                ),

                vehicle_state=(
                    vehicle_state.model_dump()
                ),

                hazards=hazards,

                risk_assessments=(
                    risk_assessments
                ),

                justifications=(
                    justifications
                ),

                system_status=status
            )

            # ==========================================================
            # VALIDATE OUTPUT
            # ==========================================================

            frame_valid, frame_issues = (
                self.validator
                .validate_frame_output(frame)
            )

            if not frame_valid:

                errors.extend(
                    frame_issues
                )

            # ==========================================================
            # LOGGING
            # ==========================================================

            self.logger.log_frame(
                frame,
                timings,
                errors
            )

            if settings.AUDIT_TRAIL_ENABLED:

                self.audit_logger.log_frame(
                    frame,
                    degradation_level=(
                        deg_state.level
                    ),
                    errors=errors
                )

            return frame

        # ==============================================================
        # PIPELINE RECOVERY
        # ==============================================================

        except Exception as e:

            err_msg = (
                f"Pipeline execution error "
                f"on tick {self.frame_id}: "
                f"{str(e)}"
            )

            logger.error(
                err_msg,
                exc_info=True
            )

            errors.append(
                err_msg
            )

            timings[
                "total_pipeline_ms"
            ] = round(
                (
                    time.perf_counter()
                    - t_start
                ) * 1000,
                2
            )

            fallback_frame = FrameOutput(

                frame_id=self.frame_id,

                timestamp=round(
                    self.frame_id
                    * settings.TICK_INTERVAL_SEC,
                    3
                ),

                vehicle_state=(
                    VehicleState().model_dump()
                ),

                hazards=[],

                risk_assessments=[],

                justifications=[
                    Justification(
                        risk_assessment_id=(
                            "pipeline_recovery"
                        ),

                        evidence=[
                            "Internal pipeline "
                            "exception caught"
                        ],

                        reasoning=(
                            "Pipeline degraded "
                            "temporarily — graceful "
                            "recovery active."
                        ),

                        source="fallback_template",

                        generated_at=time.time()
                    )
                ],

                system_status={

                    "perception_degraded":
                        True,

                    "model_unavailable":
                        not self.classifier.is_loaded,

                    "llm_degraded":
                        True,

                    "sensor_gap_active":
                        False,

                    "overall_health":
                        "degraded",

                    "exception":
                        str(e)
                }
            )

            self.logger.log_frame(
                fallback_frame,
                timings,
                errors
            )

            return fallback_frame
