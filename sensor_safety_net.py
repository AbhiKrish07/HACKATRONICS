"""
Full simulation: 6 distance sensors + 4 cameras, connected, tagged, and
visualized. No risk scoring, no safety-buffer math, no action decisions --
that's a separate module someone else owns. This script only proves the
connect -> process -> visualize path end to end.

Run:  python main.py

Everything here runs without any physical hardware. The camera sensors
load a real YOLOv8 model (ultralytics) and are fully wired for real
inference -- point `source` at a webcam index or video file later and
detection switches from simulated to real with no other code changes.
"""

from __future__ import annotations

import os
import platform
import time

import cv2
import numpy as np

from sensors.distance_sensor import SimulatedDistanceSensor
from sensors.event_bus import EventBus
from sensors.fusion_hub import SensorHub
from sensors.visualization import build_camera_grid, draw_camera_overlay, draw_distance_panel, stack_view
from sensors.yolo_camera_sensor import YoloCameraSensor

# Flip these to True to test the safety net below without real hardware --
# forces that subsystem to be treated as down regardless of what it reports.
SIMULATE_DISTANCE_OUTAGE = False
SIMULATE_CAMERA_OUTAGE = False

# --- 6 simulated distance sensors, positioned around the vehicle ---------
DISTANCE_SENSORS = [
    SimulatedDistanceSensor("distance_front_left",  mount_position=(-0.8, 2.0)),
    SimulatedDistanceSensor("distance_front_center", mount_position=(0.0, 2.2)),
    SimulatedDistanceSensor("distance_front_right", mount_position=(0.8, 2.0)),
    SimulatedDistanceSensor("distance_rear_left",   mount_position=(-0.8, -2.0)),
    SimulatedDistanceSensor("distance_rear_center", mount_position=(0.0, -2.2)),
    SimulatedDistanceSensor("distance_rear_right",  mount_position=(0.8, -2.0)),
]

# --- 4 cameras, one shared YOLOv8 model across all of them ---------------
CAMERA_IDS = ["camera_front", "camera_rear", "camera_left", "camera_right"]

_STATUS_MESSAGES = {
    "normal": "All systems nominal: cameras + distance sensors online.",
    "camera_only": "WARNING: distance sensors unavailable -- running on cameras only.",
    "sensor_only": "WARNING: cameras unavailable -- running on distance sensors only.",
    "offline": "SYSTEM NOT FUNCTIONAL: cameras and distance sensors are both unavailable.",
}
# BGR banner colors per status
_STATUS_COLORS = {
    "normal": (70, 150, 70),
    "camera_only": (0, 150, 230),
    "sensor_only": (0, 150, 230),
    "offline": (0, 0, 200),
}


def _load_yolo_model():
    """Loads YOLOv8n once, shared across all 4 camera sensors. Swap the
    weights path/name for a bigger variant (yolov8s.pt, yolov8m.pt, ...)
    if you want more accuracy and have the compute budget for it."""
    try:
        from ultralytics import YOLO
        return YOLO("yolov8n.pt")
    except Exception as exc:
        print(f"Could not load YOLOv8 model ({exc}); cameras will report no detections.")
        return None


def _display_available() -> bool:
    # On headless OpenCV builds (opencv-python-headless), calling GUI
    # functions like namedWindow() doesn't raise a catchable exception --
    # it segfaults the process. Check for a display instead of probing.
    if platform.system() == "Linux" and not os.environ.get("DISPLAY"):
        return False
    try:
        cv2.namedWindow("__probe__", cv2.WINDOW_NORMAL)
        cv2.destroyWindow("__probe__")
        return True
    except Exception:
        return False


def _get_status(distance_sensors, cameras) -> str:
    """Decides which subsystems are actually up this tick. 'Working' means
    at least one sensor/camera in that group produced a reading -- a single
    dropped unit still counts as the subsystem being up (that's the normal
    per-sensor 'gap' case already shown in the panel)."""
    distance_ok = (not SIMULATE_DISTANCE_OUTAGE) and any(s.is_available() for s in distance_sensors)
    camera_ok = (not SIMULATE_CAMERA_OUTAGE) and any(c.is_available() for c in cameras)

    if not distance_ok and not camera_ok:
        return "offline"
    if not distance_ok:
        return "camera_only"
    if not camera_ok:
        return "sensor_only"
    return "normal"


def _announce_status(status: str, last_status: str | None) -> None:
    if status != last_status:
        print(f"[status] {_STATUS_MESSAGES[status]}")


def _draw_banner(frame, status: str):
    """Adds a status strip across the top of a frame, telling the user
    what mode the system is currently running in."""
    banner = np.full((30, frame.shape[1], 3), _STATUS_COLORS[status], dtype=np.uint8)
    cv2.putText(banner, _STATUS_MESSAGES[status], (10, 21),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return np.vstack([banner, frame])


def _render_offline_frame(width: int, height: int):
    """Blank frame shown when neither cameras nor distance sensors are working."""
    frame = np.full((height, width, 3), (25, 25, 25), dtype=np.uint8)
    lines = ["SYSTEM NOT FUNCTIONAL", "Cameras: unavailable", "Distance sensors: unavailable"]
    y = height // 2 - len(lines) * 18
    for line in lines:
        (tw, _), _ = cv2.getTextSize(line, cv2.FONT_HERSHEY_SIMPLEX, 0.65, 1)
        x = max(10, (width - tw) // 2)
        cv2.putText(frame, line, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 255), 1, cv2.LINE_AA)
        y += 32
    return frame


def _build_combined_view(status: str, tick, cameras):
    """Renders whatever the current status allows: both feeds, camera only,
    distance-sensor only, or an offline notice -- always tagged with a
    banner telling the user which mode they're looking at."""
    annotated_frames = [
        draw_camera_overlay(cam.last_frame, tick.readings_by_sensor.get(cam.name, []))
        if cam.last_frame is not None else None
        for cam in cameras
    ]
    grid = build_camera_grid(annotated_frames, CAMERA_IDS, cols=2)
    distance_readings = {s.name: tick.readings_by_sensor.get(s.name, []) for s in DISTANCE_SENSORS}

    if status == "normal":
        panel = draw_distance_panel(grid.shape[1], 220, distance_readings)
        return _draw_banner(stack_view(grid, panel), status)

    if status == "camera_only":
        return _draw_banner(grid, status)

    if status == "sensor_only":
        panel = draw_distance_panel(grid.shape[1], grid.shape[0], distance_readings)
        return _draw_banner(panel, status)

    # offline
    return _draw_banner(_render_offline_frame(grid.shape[1], grid.shape[0]), status)


def main():
    bus = EventBus()
    model = _load_yolo_model()

    # No real camera hardware in this environment -- each camera tries its
    # own device index and fails safely, falling back to synthetic frames.
    # (Use source=-1 to mean "any camera" only on setups without ultralytics/
    # torch loaded -- combined with torch, index -1 enumerates every video
    # device and can crash the process instead of failing cleanly.)
    cameras = [
        YoloCameraSensor(cam_id, source=i, model=model)
        for i, cam_id in enumerate(CAMERA_IDS)
    ]

    hub = SensorHub(bus, DISTANCE_SENSORS, cameras)
    headless = not _display_available()
    if headless:
        print("No display detected -- writing frames to /tmp/av_sim_view.jpg instead of a live window.")

    last_status = None

    try:
        while True:
            tick = hub.tick()

            status = _get_status(DISTANCE_SENSORS, cameras)
            _announce_status(status, last_status)
            last_status = status

            combined = _build_combined_view(status, tick, cameras)

            if headless:
                cv2.imwrite("/tmp/av_sim_view.jpg", combined)
                time.sleep(0.2)
            else:
                cv2.imshow("AV simulation: cameras + distance sensors", combined)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        if not headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
