"""Smoke test for the credit-light integration module + API imports."""
import os, sys, json, random
os.environ.setdefault("AV01_LOCAL_ONLY", "1")  # 0 Groq tokens, 0 credits

from light_integration import (
    assess_traffic_risk, generate_traffic_scene, KaggleTrafficDensity,
    KaggleHazardStream, KaggleHazardSensorSource, integration_stats,
    LOCAL_ONLY, _risk_heuristic, should_call_groq_for_risk,
    _ASSESS_CACHE, _SCENE_CACHE,
)
from schemas.models import RawDetection


def check(label, cond):
    if not cond:
        print(f"  FAIL: {label}")
        sys.exit(1)
    print(f"  OK: {label}")


print("T1: LOCAL_ONLY flag honoured")
check("LOCAL_ONLY is True", LOCAL_ONLY is True)

print("\nT2: Risk heuristic correctness + decision thresholds")
scenes = [
    ("LOW-open-road", dict(current_speed_mph=55, obstacles=[], road_type="Highway", weather="Clear", traffic_light="Green", pedestrian=False), "LOW"),
    ("MEDIUM-rain-red", dict(current_speed_mph=40, obstacles=[], road_type="Urban", weather="Rainy", traffic_light="Red", pedestrian=False), None),
    ("HIGH-ped-near", dict(current_speed_mph=30, obstacles=[dict(distance=20, speedMph=2, type="pedestrian")], road_type="Urban", weather="Clear", traffic_light="Green", pedestrian=True), None),
    ("CRITICAL-closing-fast", dict(current_speed_mph=70, obstacles=[dict(distance=40, speedMph=30, type="vehicle")], road_type="Highway", weather="Clear", traffic_light="Green", pedestrian=False), None),
    ("MIXED-fog-multi", dict(current_speed_mph=35, obstacles=[dict(distance=25, speedMph=5, type="auto_rickshaw"), dict(distance=30, speedMph=35, type="motorcycle")], road_type="Urban", weather="Foggy", traffic_light="Green", pedestrian=False), None),
]
for name, kw, expect in scenes:
    lvl, reason, conf = _risk_heuristic(**kw)
    assert lvl in {"LOW","MEDIUM","HIGH","CRITICAL"} and 0.4 <= conf <= 1.0, f"{name}: bad lvl/conf"
    if expect:
        check(f"scene {name} level={lvl} (expect {expect})", lvl == expect)
    else:
        print(f"   scene {name:22s} -> {lvl:8s} conf={conf:.2f} groq?={should_call_groq_for_risk(lvl, conf, kw['obstacles'])}")
check("should_call_groq_for_risk returns False in LOCAL_ONLY", should_call_groq_for_risk("HIGH", 0.45, [{},{}]) is False)

print("\nT3: assess_traffic_risk wrapper (heuristic-only, 0 tokens)")
out = assess_traffic_risk(30, [dict(distance=22, speedMph=0, type="pedestrian")], "Urban", "Rainy", "Green", True)
for k in ("risk","reasoning","confidence","heuristic_score_used","groq_used"):
    check(f"assess output key {k}", k in out)
check("groq_used is False (LOCAL_ONLY)", out["groq_used"] is False)
check("confidence numeric in range", isinstance(out["confidence"], float) and 0.0 <= out["confidence"] <= 1.0)
print("   reasoning:", out["reasoning"][:90])

print("\nT4: fingerprint caching on assess")
_ASSESS_CACHE.hits = _ASSESS_CACHE.misses = 0
out1 = assess_traffic_risk(65, [], "Highway", "Clear", "Green", False)
out2 = assess_traffic_risk(65, [], "Highway", "Clear", "Green", False)
check("second call comes from cache", bool(out2.get("from_cache")) is True)

print("\nT5: rule-based scene generator")
random.seed(0)
scene, meta = generate_traffic_scene(ego_speed_mph=45, weather="Sunny", traffic_volume_vehicles=20)
check("scene non-empty list", isinstance(scene, list) and 1 <= len(scene) <= 5)
req_keys = {"type","lane_x","distance_m","speed_mph","lateral_vx","honking_detected","honk_duration_ms"}
for o in scene:
    missing = req_keys - set(o.keys())
    check(f"object type={o.get('type')} has all required keys", len(missing) == 0)
check("meta records rule source", meta.get("source") == "rule_generator" or meta.get("cache_hit") is True)
scene2, meta2 = generate_traffic_scene(ego_speed_mph=45, weather="Sunny", traffic_volume_vehicles=20)
check("second call scene cache hit", meta2.get("cache_hit") is True)

print("\nT6: Kaggle traffic density (100% local fallback)")
info = KaggleTrafficDensity.instance().current()
check(f"source in valid set (got {info.source})", info.source in {"local_fallback","csv_cache","kaggle_dataset"})
check(f"vehicles_per_hour in range (got {info.vehicles_per_hour})", 4 <= info.vehicles_per_hour <= 60)
check("hour_of_day loops 0..23", 0 <= info.hour_of_day < 24)

print("\nT7: KaggleHazardStream synthetic rows -> RawDetection features")
stream = KaggleHazardStream.from_kaggle_or_default(seed=42)
check(f"rows >= 8 (got {len(stream.rows)})", len(stream.rows) >= 8)
frame0 = stream.next_raw_detections(0.0)
check("first frame has exactly 1 RawDetection", len(frame0) == 1 and isinstance(frame0[0], RawDetection))
feat = frame0[0].features
for fk in ("relative_size","aspect_ratio","motion_signature","distance","sensor_confidence_raw",
           "reflectivity_signal","_lane","_object_type","_kaggle_weather","_kaggle_road_type",
           "_kaggle_traffic_light","_kaggle_pedestrian_presence","_kaggle_speed_kmph","_rel_vy"):
    check(f"RawDetection has feature '{fk}'", fk in feat)
check(f"occupancy_confidence >= 0.75 ({frame0[0].occupancy_confidence})", frame0[0].occupancy_confidence >= 0.75)
print(f"   sample row: dist={feat['distance']:.0f}m  type={feat['_object_type']}  lane={feat['_lane']}  weather={feat['_kaggle_weather']}")

print("\nT8: KaggleHazardSensorSource SAL protocol")
sensor = KaggleHazardSensorSource(seed=7)
health0 = sensor.health()
check("health.sensor_id present", bool(health0.sensor_id))
frame = sensor.read(0.1)
health1 = sensor.health()
check("read increments frames_delivered", health1.frames_delivered == health0.frames_delivered + len(frame))
check("get_vehicle_state present", sensor.get_vehicle_state() is not None)

print("\nT9: integration_stats exposes cache usage")
s = integration_stats()
for k in ("local_only_mode","risk_cache","scene_cache","traffic_density_source"):
    check(f"stats key '{k}' present", k in s)
print("   stats:", json.dumps(s))

print("\nT10: Pipeline + API modules import cleanly after edits")
from api import pipeline as _pl, main as _m
check("PipelineRunner class present", hasattr(_pl, "PipelineRunner"))
check("FastAPI app present", hasattr(_m, "app"))
# Verify the light integration endpoints exist on the app router
paths = {route.path for route in _m.app.routes if hasattr(route, "path")}
for p in ("/traffic/llm/scene", "/traffic/density", "/integration/summary", "/scenario/use_kaggle_hazard_stream"):
    check(f"endpoint registered: {p}", p in paths)
# Verify pipeline.step no longer uses analyze_trajectory_indian_traffic directly
src = open(_pl.__file__).read()
check("pipeline no longer imports analyze_trajectory_indian_traffic directly",
      "from traffic_llm_groq import analyze_trajectory_indian_traffic" not in src)

print("\n✅ ALL INTEGRATION TESTS PASSED — 0 Groq credits used")
