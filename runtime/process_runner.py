"""
Process Isolation & Latency Budget Engine (DIFF 2 & DIFF 3).
Separates the safety-critical Reactive Loop from the Deliberative Perception/LLM Stack.
Enforces per-stage latency budgets with structured telemetry on breaches.
"""

import time
import queue
import logging
import threading
from typing import Optional, Dict, Any, List, Tuple
from config import settings
from schemas.models import (
    FrameOutput,
    HazardEvent,
    RiskAssessment,
    Justification,
    VehicleState,
    RawDetection,
    ScenarioConfig
)
from sensor_sim.sal import SensorSource, SimulatedSensorSource, ReplaySensorSource
from perception.pipeline import PerceptionStage
from perception.model import PerceptionClassifier
from perception.shadow_model import ShadowPerceptionEvaluator
from analysis.risk_scorer import RiskAnalyzer
from justification.engine import JustificationEngine
from storage.logger import StructuredRunLogger
from runtime.heartbeat import HeartbeatRegistry

logger = logging.getLogger("av01.runtime.process")


class ReactiveSafetyLoop:
    """
    Process A: Reactive Safety Loop.
    Budget: <= 10ms.
    Strictly isolated: No ML inference, no network I/O, zero allocation-heavy code.
    Evaluates raw proximity and issues immediate emergency braking/collision warnings.
    """
    def __init__(self, sensor_source: SensorSource, emergency_queue: queue.Queue, heartbeat_registry: HeartbeatRegistry):
        self.sensor = sensor_source
        self.emergency_queue = emergency_queue
        self.registry = heartbeat_registry
        self.is_running = False

    def evaluate_tick(self, timestamp: float) -> Optional[Dict[str, Any]]:
        t0 = time.perf_counter()
        detections = self.sensor.read(timestamp)
        self.registry.beat("reactive_loop")

        emergency_alert = None
        for det in detections:
            dist = det.features.get("distance", 999.0)
            raw_conf = det.features.get("sensor_confidence_raw", 0.0)
            
            # Ultra-fast critical proximity safety barrier (< 10m with non-zero return)
            if dist <= settings.CRITICAL_DISTANCE_METERS and raw_conf >= 0.20:
                emergency_alert = {
                    "alert_type": "EMERGENCY_PROXIMITY_BARRIER",
                    "distance_m": dist,
                    "timestamp": timestamp,
                    "triggered_at_perf": time.perf_counter()
                }
                break

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        
        # Check reactive latency budget (P0 if breached)
        if elapsed_ms > settings.LATENCY_BUDGET_REACTIVE_MS:
            logger.critical(
                f"LATENCY BUDGET BREACH [Reactive Loop]: actual={elapsed_ms:.2f}ms > budget={settings.LATENCY_BUDGET_REACTIVE_MS}ms"
            )

        if emergency_alert:
            try:
                self.emergency_queue.put_nowait(emergency_alert)
            except queue.Full:
                pass

        return emergency_alert


class DeliberativePipelineProcess:
    """
    Process B: Deliberative Pipeline.
    Runs Perception (ML) -> Analysis -> Justification (Groq/Fallback) -> Shadow Evaluation.
    Budget: <= 200ms per deliberative frame.
    """
    def __init__(
        self,
        sensor_source: SensorSource,
        output_queue: queue.Queue,
        heartbeat_registry: HeartbeatRegistry,
        classifier: Optional[PerceptionClassifier] = None,
        justification_engine: Optional[JustificationEngine] = None
    ):
        self.sensor = sensor_source
        self.output_queue = output_queue
        self.registry = heartbeat_registry
        self.classifier = classifier or PerceptionClassifier()
        self.perception = PerceptionStage(classifier=self.classifier)
        self.shadow_evaluator = ShadowPerceptionEvaluator()
        self.analyzer = RiskAnalyzer()
        self.justification = justification_engine or JustificationEngine()
        
        self.frame_id = 0
        self.consecutive_empty_ticks = 0
        self.budget_breaches: List[Dict[str, Any]] = []

    async def step(self) -> FrameOutput:
        self.frame_id += 1
        t_frame_start = time.perf_counter()
        self.registry.beat("deliberative_pipeline")
        timings: Dict[str, float] = {}
        breaches: List[str] = []

        try:
            # 1. Sensor Read via SAL
            t0 = time.perf_counter()
            current_time = self.frame_id * settings.TICK_INTERVAL_SEC
            raw_detections = self.sensor.read(current_time)
            vehicle_state = self.sensor.get_vehicle_state()
            timings["sensor_sal_ms"] = round((time.perf_counter() - t0) * 1000, 2)

            # Sensor gap tracking
            valid_occupancy = [d for d in raw_detections if d.occupancy_confidence >= settings.OCCUPANCY_CONFIDENCE_THRESHOLD]
            if len(valid_occupancy) == 0:
                self.consecutive_empty_ticks += 1
            else:
                self.consecutive_empty_ticks = 0
            sensor_gap_active = self.consecutive_empty_ticks >= settings.SENSOR_GAP_N_TICKS

            # 2. Perception Stage (ML + Occupancy)
            t1 = time.perf_counter()
            hazards = self.perception.process(raw_detections)
            perception_ms = (time.perf_counter() - t1) * 1000
            timings["perception_ms"] = round(perception_ms, 2)

            if perception_ms > settings.LATENCY_BUDGET_PERCEPTION_MS:
                breaches.append(f"perception_breach ({perception_ms:.1f}ms > {settings.LATENCY_BUDGET_PERCEPTION_MS}ms)")
                logger.warning(f"LATENCY BUDGET BREACH [Perception]: actual={perception_ms:.2f}ms > budget={settings.LATENCY_BUDGET_PERCEPTION_MS}ms")

            # 3. Shadow-Mode Evaluation (DIFF 5)
            t_shadow = time.perf_counter()
            shadow_predictions = self.shadow_evaluator.evaluate_shadow(raw_detections)
            timings["shadow_eval_ms"] = round((time.perf_counter() - t_shadow) * 1000, 2)

            perception_degraded = (
                not self.classifier.is_loaded or
                any(h.classification_confidence is None or h.classification_confidence < settings.CLASSIFICATION_CONFIDENCE_THRESHOLD for h in hazards)
            )

            # 4. Analysis Stage (Deterministic Risk Scoring)
            t2 = time.perf_counter()
            risk_assessments = self.analyzer.process(hazards, vehicle_state)
            is_conflict, primary_h, secondary_h = self.analyzer.detect_conflicts(risk_assessments)
            conflict_pair = (primary_h, secondary_h) if (is_conflict and primary_h and secondary_h) else None
            analysis_ms = (time.perf_counter() - t2) * 1000
            timings["analysis_ms"] = round(analysis_ms, 2)

            if analysis_ms > settings.LATENCY_BUDGET_ANALYSIS_MS:
                breaches.append(f"analysis_breach ({analysis_ms:.1f}ms > {settings.LATENCY_BUDGET_ANALYSIS_MS}ms)")
                logger.error(f"LATENCY BUDGET BREACH [Analysis]: actual={analysis_ms:.2f}ms > budget={settings.LATENCY_BUDGET_ANALYSIS_MS}ms")

            # 5. Justification Stage (Groq / Template Fallback)
            t3 = time.perf_counter()
            justifications = await self.justification.process(
                assessments=risk_assessments,
                sensor_gap_ticks=self.consecutive_empty_ticks,
                conflict_pair=conflict_pair
            )
            justification_ms = (time.perf_counter() - t3) * 1000
            timings["justification_ms"] = round(justification_ms, 2)

            total_tick_ms = (time.perf_counter() - t_frame_start) * 1000
            timings["total_pipeline_ms"] = round(total_tick_ms, 2)

            if total_tick_ms > settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS:
                breaches.append(f"deliberative_tick_breach ({total_tick_ms:.1f}ms > {settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS}ms)")
                logger.warning(f"LATENCY BUDGET BREACH [Deliberative Tick]: actual={total_tick_ms:.2f}ms > budget={settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS}ms")

            # System status compilation
            overall_health = "healthy"
            if sensor_gap_active or not self.classifier.is_loaded:
                overall_health = "critical"
            elif perception_degraded or is_conflict or len(breaches) > 0:
                overall_health = "degraded"

            status = {
                "perception_degraded": perception_degraded,
                "model_unavailable": not self.classifier.is_loaded,
                "llm_degraded": self.justification.llm_error_count > 0,
                "circuit_breaker": self.justification.circuit_breaker.get_status(),
                "sensor_gap_active": sensor_gap_active,
                "consecutive_empty_ticks": self.consecutive_empty_ticks,
                "conflicting_detections_active": is_conflict,
                "latency_breaches": breaches,
                "shadow_eval_active": settings.SHADOW_MODE_ENABLED,
                "overall_health": overall_health
            }

            frame = FrameOutput(
                frame_id=self.frame_id,
                timestamp=round(current_time, 3),
                vehicle_state=vehicle_state.model_dump(),
                hazards=hazards,
                risk_assessments=risk_assessments,
                justifications=justifications,
                system_status=status
            )

            try:
                self.output_queue.put_nowait(frame)
            except queue.Full:
                pass

            return frame

        except Exception as e:
            logger.error(f"Deliberative pipeline exception on tick {self.frame_id}: {str(e)}", exc_info=True)
            fallback_frame = FrameOutput(
                frame_id=self.frame_id,
                timestamp=round(self.frame_id * settings.TICK_INTERVAL_SEC, 3),
                vehicle_state=VehicleState().model_dump(),
                hazards=[],
                risk_assessments=[],
                justifications=[
                    Justification(
                        risk_assessment_id="process_recovery",
                        evidence=["Internal pipeline exception caught"],
                        reasoning="Deliberative pipeline degraded temporarily — process isolation active.",
                        source="fallback_template",
                        generated_at=time.time()
                    )
                ],
                system_status={
                    "perception_degraded": True,
                    "model_unavailable": not self.classifier.is_loaded,
                    "overall_health": "degraded",
                    "exception": str(e)
                }
            )
            return fallback_frame
