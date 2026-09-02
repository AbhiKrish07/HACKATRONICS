"""
Production-Hardened FastAPI Service for AV-01.
Exposes REST telemetry, stage latency budgets, circuit breaker monitoring,
and 10Hz live WebSocket streaming.
"""

import asyncio
import logging
import time
from typing import Optional, Dict, Any
from pydantic import BaseModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from config import settings
from schemas.models import ScenarioConfig, FrameOutput, MetricsSummary
from data.traffic_adapter import traffic_adapter
from data.traffic_llm import traffic_director
from light_integration import (
    assess_traffic_risk,
    generate_traffic_scene,
    KaggleTrafficDensity,
    KaggleHazardSensorSource,
    integration_stats,
    LOCAL_ONLY,
    is_local_only,
    set_local_only,
)
from perception.model import PerceptionClassifier
from justification.engine import JustificationEngine
from api.pipeline import PipelineRunner
from runtime.heartbeat import HeartbeatRegistry
from runtime.watchdog import ProcessWatchdog
from runtime.driver_learner import driver_learner

# Configure structured application logger
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("av01.api")

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Production-hardened hazard perception, risk analysis, and Groq-grounded justification system."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global pipeline & runtime instances
classifier_instance = PerceptionClassifier()
justification_instance = JustificationEngine()
pipeline_runner = PipelineRunner(
    classifier=classifier_instance,
    justification_engine=justification_instance
)

# Watchdog supervisor (DIFF 4)
heartbeat_registry = HeartbeatRegistry()
watchdog = ProcessWatchdog(registry=heartbeat_registry)
watchdog.start()

start_time_service = time.time()


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """
    Health check endpoint reporting per-stage latency budgets, hardware SAL status,
    circuit breaker state, process isolation heartbeats, and degraded mode flags.
    """
    recent_metrics = pipeline_runner.logger.get_summary()
    uptime_sec = round(time.time() - start_time_service, 1)
    sensor_health = pipeline_runner.sensor_source.health()
    cb_status = justification_instance.circuit_breaker.get_status()

    # Record API process beat
    heartbeat_registry.beat("api_service")
    heartbeat_registry.beat("deliberative_pipeline")
    heartbeat_registry.beat("reactive_loop")

    return {
        "status": "healthy" if classifier_instance.is_loaded and cb_status["state"] != "OPEN" else "degraded",
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "uptime_seconds": uptime_sec,
        "latency_budgets_ms": {
            "reactive_loop": settings.LATENCY_BUDGET_REACTIVE_MS,
            "perception": settings.LATENCY_BUDGET_PERCEPTION_MS,
            "analysis": settings.LATENCY_BUDGET_ANALYSIS_MS,
            "justification": settings.LATENCY_BUDGET_JUSTIFICATION_MS,
            "deliberative_tick": settings.LATENCY_BUDGET_DELIBERATIVE_TICK_MS
        },
        "sensor_abstraction_layer": sensor_health.model_dump(),
        "circuit_breaker": cb_status,
        "process_watchdog": watchdog.get_status(),
        "stages": {
            "sensor_sal": {
                "status": "nominal" if sensor_health.liveness else "degraded",
                "active_scenario": pipeline_runner.scenario_type
            },
            "perception": {
                "status": "nominal" if classifier_instance.is_loaded else "degraded (occupancy_only)",
                "model_loaded": classifier_instance.is_loaded,
                "model_path": str(classifier_instance.model_path),
                "model_error": classifier_instance.load_error,
                "num_classes": len(classifier_instance.classes),
                "shadow_mode_active": settings.SHADOW_MODE_ENABLED
            },
            "analysis": {
                "status": "nominal",
                "weights": {
                    "distance": settings.WEIGHT_DISTANCE,
                    "velocity": settings.WEIGHT_VELOCITY,
                    "lane": settings.WEIGHT_LANE,
                    "severity": settings.WEIGHT_SEVERITY
                }
            },
            "justification": {
                "status": "nominal" if cb_status["state"] == "CLOSED" else "degraded (circuit_open_or_probing)",
                "llm_provider": settings.LLM_PROVIDER,
                "llm_model": settings.GROQ_MODEL if settings.LLM_PROVIDER == "groq" else settings.LLM_MODEL,
                "api_key_configured": bool(justification_instance.client.api_key),
                "circuit_state": cb_status["state"],
                "calls_count": justification_instance.llm_call_count,
                "error_count": justification_instance.llm_error_count,
                "error_rate": recent_metrics.llm_error_rate,
                "cap_reached": justification_instance.llm_cap_reached
            }
        },
        "current_trip": {
            "trip_id": pipeline_runner.trip_id,
            "scenario": pipeline_runner.scenario_type,
            "frames_processed": pipeline_runner.frame_id
        },
        "local_only_mode": {
            "enabled": is_local_only(),
            "initial_from_env": LOCAL_ONLY,
            "toggle_endpoint": "/settings/local_only",
        }
    }


@app.post("/scenario/start")
async def start_scenario(config: ScenarioConfig) -> Dict[str, Any]:
    trip_id = pipeline_runner.start_scenario(config)
    return {
        "message": f"Scenario '{config.scenario_type}' started successfully",
        "trip_id": trip_id,
        "scenario_type": config.scenario_type,
        "hz": settings.SIMULATION_HZ
    }


@app.post("/scenario/reset")
async def reset_scenario() -> Dict[str, Any]:
    trip_id = pipeline_runner.start_scenario(ScenarioConfig(scenario_type="normal"))
    return {
        "message": "Scenario reset to default",
        "trip_id": trip_id
    }


class EdgeCaseRequest(BaseModel):
    type: str

@app.post("/scenario/edge_case")
async def trigger_edge_case(req: EdgeCaseRequest) -> Dict[str, Any]:
    if req.type == "sensor_gap":
        pipeline_runner.consecutive_empty_ticks = settings.SENSOR_GAP_N_TICKS + 1
        pipeline_runner.start_scenario(ScenarioConfig(scenario_type="sensor_gap"))
    elif req.type in ("conflict", "conflicting_detections"):
        pipeline_runner.start_scenario(ScenarioConfig(scenario_type="conflicting_detections"))
    else:
        pipeline_runner.start_scenario(ScenarioConfig(scenario_type=req.type))
    return {"message": f"Triggered {req.type}", "trip_id": pipeline_runner.trip_id}


class EgoLiveRequest(BaseModel):
    ego_x: float = 0.0
    speed_mph: float = 49.0
    psi: float = 0.0
    obstacles: list = []


class InterventionRequest(BaseModel):
    speed_mph: float
    following_distance_m: Optional[float] = None
    steer: float = 0.0
    throttle_intent: str = "steer"


@app.post("/autopilot/state")
async def post_autopilot_state(req: EgoLiveRequest) -> Dict[str, Any]:
    """Live pose from the 3D sim so MPC Autopilot tracks the same vehicle."""
    pipeline_runner.update_ego_live(req.model_dump())
    return {"ok": True, "guidance": pipeline_runner._last_guidance}


@app.get("/autopilot/profile")
async def get_driver_profile() -> Dict[str, Any]:
    return driver_learner.snapshot()


@app.get("/metrics", response_model=MetricsSummary)
@app.get("/logs/summary", response_model=MetricsSummary)
async def get_metrics() -> MetricsSummary:
    return pipeline_runner.logger.get_summary()


@app.get("/logs/scrollback")
async def get_scrollback(limit: int = 50) -> Dict[str, Any]:
    frames = pipeline_runner.logger.get_scrollback(limit=limit)
    return {
        "trip_id": pipeline_runner.trip_id,
        "count": len(frames),
        "frames": frames
    }


# Kaggle Dataset Streaming Endpoint
_kaggle_rows_cache = None

@app.get("/kaggle/rows")
async def get_kaggle_rows() -> Dict[str, Any]:
    """Returns all Kaggle dataset rows pre-processed with derived object types for 3D sim."""
    global _kaggle_rows_cache
    if _kaggle_rows_cache is not None:
        return _kaggle_rows_cache

    try:
        from data.kaggle_adapter import load_kaggle_dataset, derive_object_type
        df = load_kaggle_dataset()
        rows = []
        for idx, row in df.iterrows():
            obj_type = derive_object_type(row)
            speed_kmph = float(row.get("Speed_kmph", 50))
            dist = float(row.get("Distance_to_Obstacle_m", 50))
            lane_pos = float(row.get("Lane_Position", 1.5))
            weather = str(row.get("Weather_Condition", "Sunny"))
            road_type = str(row.get("Road_Type", "Urban"))
            traffic_light = str(row.get("Traffic_Light_State", "Green"))
            ped_presence = int(row.get("Pedestrian_Presence", 0))
            sign_detected = int(row.get("Traffic_Sign_Detected", 0))
            steering = float(row.get("Steering_Angle_deg", 0))
            cam_sim = float(row.get("Camera_Input_Similarity", 0.5))
            lidar_sim = float(row.get("Lidar_Point_Cloud_Similarity", 0.5))
            dist_intersection = float(row.get("Distance_to_Intersection_m", 100))

            # Map object type to realistic 3D entity speed (mph)
            if obj_type == "pedestrian":
                entity_speed_mph = 3.0
            elif obj_type == "cyclist":
                entity_speed_mph = 14.0
            elif obj_type == "vehicle":
                entity_speed_mph = max(15.0, min(68.0, speed_kmph * 0.621))
            else:
                entity_speed_mph = 0.0  # static obstacle or unknown

            # Map lane position to 3D X coordinate (-6 to +6 across 5 lanes)
            lane_x = (lane_pos - 1.75) * 3.2  # center around 0

            rows.append({
                "idx": int(idx),
                "object_type": obj_type,
                "speed_kmph": round(speed_kmph, 1),
                "entity_speed_mph": round(entity_speed_mph, 1),
                "distance_m": round(dist, 1),
                "lane_position": round(lane_pos, 2),
                "lane_x": round(lane_x, 2),
                "weather": weather,
                "road_type": road_type,
                "traffic_light": traffic_light,
                "pedestrian_presence": ped_presence,
                "sign_detected": sign_detected,
                "steering_angle": round(steering, 1),
                "camera_similarity": round(cam_sim, 3),
                "lidar_similarity": round(lidar_sim, 3),
                "dist_intersection": round(dist_intersection, 1),
                "lateral_vx": round(-0.6 if obj_type == "pedestrian" else 0.0, 2)
            })

        _kaggle_rows_cache = {"total": len(rows), "rows": rows}
        return _kaggle_rows_cache
    except Exception as e:
        logger.error(f"Failed to load Kaggle rows: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Kaggle dataset error: {str(e)}")

@app.get("/traffic/llm/scene")
async def get_llm_traffic_scene(
    speed: float = 45.0,
    weather: str = "Sunny",
    force_groq: bool = False,
) -> Dict[str, Any]:
    """
    Credit-efficient traffic scene generator.

    Same response shape as before (dashboard-agnostic), but:
      • Low/medium traffic volumes → pure rule generator (0 Groq tokens)
      • High volume / force_groq → fingerprint cache first, Groq only on miss
      • Set AV01_LOCAL_ONLY=1 to force 0 Groq calls entirely
    """
    density_info = KaggleTrafficDensity.instance().current()
    scene_objects, meta = generate_traffic_scene(
        ego_speed_mph=float(speed),
        weather=str(weather),
        traffic_volume_vehicles=int(density_info.vehicles_per_hour),
        force_groq=bool(force_groq) and not is_local_only(),
    )
    return {
        "dataset_datetime": density_info.datetime_str,
        "traffic_volume": density_info.vehicles_per_hour,
        "traffic_density_source": density_info.source,
        "objects": scene_objects,
        "meta": {
            **meta,
            "local_only": is_local_only(),
            "cache_stats": integration_stats(),
        },
    }


@app.get("/traffic/density")
async def traffic_density() -> Dict[str, Any]:
    """Real-time traffic density, driven by Kaggle historical data (or fallback)."""
    info = KaggleTrafficDensity.instance().current()
    return {
        "vehicles_per_hour": info.vehicles_per_hour,
        "hour_of_day": info.hour_of_day,
        "datetime_str": info.datetime_str,
        "source": info.source,
        "status": info.status,
    }


# ---------------------------------------------------------------------------
# Waymo Dataset, Traffic Signals & Data Generation Endpoints
# ---------------------------------------------------------------------------

class TrafficSignalRequest(BaseModel):
    state: str  # GREEN | YELLOW | RED
    distance_m: Optional[float] = None


@app.get("/waymo/feed")
async def get_waymo_feed(frame_index: int = 0) -> Dict[str, Any]:
    """Provides Waymo Open Dataset frames converted to AV-01 sensor detections."""
    from data.waymo_adapter import waymo_adapter
    detections = waymo_adapter.get_av01_detections_for_frame(frame_index)
    return {
        "source": "Waymo Open Dataset",
        "frame_index": frame_index,
        "total_frames": len(waymo_adapter.frames),
        "detections_count": len(detections),
        "detections": [d.model_dump() for d in detections]
    }


@app.post("/traffic/signal")
async def set_traffic_signal(req: TrafficSignalRequest) -> Dict[str, Any]:
    """Manually override or trigger traffic light state for live simulation."""
    if req.state.upper() not in ("GREEN", "YELLOW", "RED"):
        raise HTTPException(status_code=400, detail="State must be GREEN, YELLOW, or RED")

    state = req.state.upper()
    pipeline_runner.sensor_source.vehicle_state.traffic_light_state = state
    if req.distance_m is not None:
        pipeline_runner.sensor_source.vehicle_state.traffic_light_dist = float(req.distance_m)

    return {
        "ok": True,
        "traffic_light_state": state,
        "traffic_light_dist": pipeline_runner.sensor_source.vehicle_state.traffic_light_dist
    }


@app.post("/data/generate")
async def generate_data_endpoint(num_samples: int = 5000) -> Dict[str, Any]:
    """Triggers synthetic open-world dataset generation on demand."""
    from generate_training_data import generate_synthetic_data
    df = generate_synthetic_data(num_samples=num_samples)
    output_path = f"data/synthetic_openworld_{int(time.time())}.csv"
    df.to_csv(output_path, index=False)
    return {
        "ok": True,
        "samples_generated": len(df),
        "file_path": output_path
    }


@app.get("/integration/summary")
async def integration_summary() -> Dict[str, Any]:
    """
    Credit / data usage summary for the judges:
    • Groq cache hits/misses
    • Local-only mode flag
    • Kaggle data source used (CSV cache, kagglehub DF, or hardcoded fallback)
    """
    info = KaggleTrafficDensity.instance().current()
    return {
        "local_only_mode": is_local_only(),
        "groq_disabled_note": (
            "All Groq calls skipped; heuristic + table fallback in use."
            if is_local_only()
            else "Groq calls permitted only on ambiguous/high-risk ticks (cache-first)."
        ),
        "cache_stats": integration_stats(),
        "kaggle_traffic_source": info.source,
        "kaggle_hazard_note": (
            "scenario_type='kaggle' streams zara2099 rows via KaggleHazardSensorSource."
        ),
        "traffic_density_current": {
            "vehicles_per_hour": info.vehicles_per_hour,
            "hour_of_day": info.hour_of_day,
            "datetime_str": info.datetime_str,
        },
    }


@app.post("/scenario/use_kaggle_hazard_stream")
async def use_kaggle_hazard_stream(seed: Optional[int] = 42) -> Dict[str, Any]:
    """
    Hot-swap the current sensor source to KaggleHazardSensorSource so every
    tick replays a real zara2099/autonomous-navigation-driving-data row.

    Returns the trip_id so the dashboard can reset its view.
    """
    stream = KaggleHazardSensorSource(seed=int(seed or 42))
    pipeline_runner.sensor_source = stream
    pipeline_runner.trip_id = f"trip_kaggle_{int(time.time())}_{seed or 0}"
    return {
        "ok": True,
        "trip_id": pipeline_runner.trip_id,
        "sensor_id": stream.health().sensor_id,
        "rows_available": len(stream.stream.rows),
        "note": "All MPC/autopilot/perception now consumes real Kaggle hazard rows.",
    }


# ---------------------------------------------------------------------------
# LOCAL-ONLY MODE RUNTIME TOGGLE
# Controls: traffic LLM (Groq), driver-style summary, justification LLM
# When enabled, all external API calls are blocked and local heuristics are used.
# ---------------------------------------------------------------------------

class LocalOnlyToggleRequest(BaseModel):
    enabled: bool
    reason: Optional[str] = None


@app.get("/settings/local_only")
async def get_local_only_status() -> Dict[str, Any]:
    """
    Return the current local-only mode status.
    When True, every Groq/LLM call is blocked — all decisions come from
    local heuristics (risk assessor, scene generator, justification templates).
    """
    return {
        "enabled": is_local_only(),
        "initial_from_env": LOCAL_ONLY,
        "env_var": "AV01_LOCAL_ONLY",
        "impact": {
            "traffic_llm": "disabled (heuristic scene generator only)" if is_local_only() else "enabled (cache-first, high-risk only)",
            "groq_justification": "disabled (template fallback)" if is_local_only() else "enabled (circuit-breaker guarded)",
            "kaggle_density": "always on (CSV cache / hardcoded table, never requires network)",
            "kaggle_hazard_rows": "always on (zara2099 replay, fully local once cached)",
            "driver_learner_summary": "skipped (local profile still recorded)" if is_local_only() else "enabled",
        },
        "cache_stats": integration_stats(),
    }


@app.post("/settings/local_only")
async def set_local_only_toggle(req: LocalOnlyToggleRequest) -> Dict[str, Any]:
    """
    Enable or disable local-only mode at runtime.

    Body: `{ "enabled": true, "reason": "low credit" }`

    Safe to call mid-simulation: the change takes effect on the next tick
    (every Groq-guard gate re-reads the flag via is_local_only()).
    """
    prev = is_local_only()
    set_local_only(req.enabled)
    now = is_local_only()
    logger.info(f"Local-only toggled: {prev} -> {now}" + (f" (reason: {req.reason})" if req.reason else ""))
    return {
        "ok": True,
        "previous_enabled": prev,
        "enabled": now,
        "changed": prev != now,
        "reason": req.reason,
        "note": (
            "External Groq/LLM calls BLOCKED — using pure local heuristics."
            if now
            else "Groq/LLM calls permitted (heuristic-first, TTL-cached, throttled)."
        ),
    }


@app.post("/autopilot/intervention")
async def post_driver_intervention(req: InterventionRequest) -> Dict[str, Any]:
    """Driver takeover — Autopilot learns cruise, gap, and overtake style."""
    profile = driver_learner.observe_intervention(
        speed_mph=req.speed_mph,
        following_distance_m=req.following_distance_m,
        steer=req.steer,
        throttle_intent=req.throttle_intent,
    )
    if not is_local_only():
        try:
            summary = await driver_learner.groq_refresh_summary()
            profile["last_summary"] = summary
        except Exception as e:
            logger.warning(f"Groq driver-style summary skipped: {e}")
    else:
        profile["last_summary"] = (
            "Groq summary disabled (local-only mode) — driving profile recorded locally."
        )
    return {"ok": True, "profile": profile}

@app.websocket("/ws")
@app.websocket("/ws/telemetry")
async def websocket_stream(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected to live WebSocket stream")

    try:
        while True:
            heartbeat_registry.beat("deliberative_pipeline")
            frame: FrameOutput = await pipeline_runner.step()
            await websocket.send_text(frame.model_dump_json())
            await asyncio.sleep(settings.TICK_INTERVAL_SEC)
    except WebSocketDisconnect:
        logger.info("Client disconnected from WebSocket stream")
    except Exception as e:
        logger.error(f"WebSocket session error: {str(e)}", exc_info=True)


from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
import os

# Mount the static directory for assets if needed
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def dashboard_ui():
    """
    Serves the Hackatronics Project AV-01 Autonomous Perception & High-Fidelity Simulator.
    """
    with open("static/index.html", "r") as f:
        content = f.read()
    return Response(
        content=content, 
        media_type="text/html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )
