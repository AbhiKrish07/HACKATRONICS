import json
import os
import logging
from typing import Any, Dict, List

import groq

from config import settings

logger = logging.getLogger("av01.traffic_llm_groq")

try:
    _api_key = os.environ.get("GROQ_API_KEY") or settings.GROQ_API_KEY
    client = groq.Groq(api_key=_api_key) if _api_key else None
except Exception as e:
    client = None
    logger.warning(f"Failed to init Groq client: {e}")


def analyze_trajectory_indian_traffic(frame_data: dict, current_speed_mph: float, obstacles: list) -> dict:
    """
    Groq LLM trajectory / risk assessment specialized for Indian traffic.
    """
    if not client:
        return {"risk": "UNKNOWN", "reasoning": "Groq client not initialized. Set GROQ_API_KEY."}

    system_prompt = (
        "You are AV-01, an autonomous vehicle perception system. Hardware is FRONT-SENSOR ONLY "
        "(forward camera/radar cone). Sides and rear are unknown. Never assume 360 coverage. "
        "Indian traffic is chaotic: weak lane discipline, weaving two-wheelers, animals. "
        "Output ONLY valid JSON with keys: 'risk' (LOW, MEDIUM, HIGH, CRITICAL) and "
        "'reasoning' (1-2 short sentences stating what you know, what you cannot see, and why)."
    )

    scenario = f"Ego Vehicle Speed: {current_speed_mph:.1f} mph. Sensor coverage: FRONT CONE ONLY.\n"
    if frame_data:
        scenario += f"Telemetry: Road={frame_data.get('Road Type', 'Urban')}, "
        scenario += f"Weather={frame_data.get('Weather', 'Clear')}, "
        scenario += f"Pedestrian={frame_data.get('Pedestrian Presence', 'False')}"
        if frame_data.get("Traffic Light"):
            scenario += f", Traffic Light={frame_data.get('Traffic Light')}"
        if frame_data.get("Object Type"):
            scenario += f", Object Type={frame_data.get('Object Type')}"
        scenario += ".\n"

    if obstacles:
        scenario += f"Forward-cone obstacles: {len(obstacles)}.\n"
        for i, obs in enumerate(obstacles[:3]):
            scenario += (
                f" - Obstacle {i+1}: Distance {obs.get('distance', 0):.1f}m, "
                f"Speed {obs.get('speedMph', 0):.1f}mph, Type: {obs.get('type', 'Vehicle')}\n"
            )
    else:
        scenario += "Forward path is clear. Side and rear remain unknown.\n"

    try:
        response = client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": scenario},
            ],
            model=settings.GROQ_MODEL,
            temperature=0.1,
            response_format={"type": "json_object"},
            timeout=2.0,
        )
        result_str = response.choices[0].message.content
        parsed: Dict[str, Any] = json.loads(result_str)
        return parsed
    except Exception as e:
        logger.warning(f"Groq API Error: {e}")
        return {"risk": "ERROR", "reasoning": "Groq temporarily unavailable — using deterministic Autopilot."}


if __name__ == "__main__":
    test_frame = {"Road Type": "Urban", "Weather": "Rainy", "Pedestrian Presence": "True"}
    test_obstacles = [{"distance": 8.0, "speedMph": 2.5, "type": "Pedestrian"}]
    print("Test Result:", analyze_trajectory_indian_traffic(test_frame, 35.0, test_obstacles))
