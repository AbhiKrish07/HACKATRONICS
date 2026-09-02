import os
import json
import asyncio
import logging
import httpx
from typing import List, Dict, Any
from config import settings

logger = logging.getLogger("av01.traffic_llm")

TRAFFIC_LLM_SYSTEM_PROMPT = """
You are TrafficLLM, an adversarial traffic director for an autonomous driving simulator specialized in INDIAN TRAFFIC.
Your job is to generate challenging, realistic chaotic scenarios to test the ego vehicle's safety systems.
Indian traffic is characterized by lack of lane discipline, aggressive weaving, sudden braking, animals on the road, and honking as communication.

Given the current simulation state (Ego Speed, Weather, Traffic Volume), generate 1 to 4 dynamic objects to spawn.
If Traffic Volume is high (> 30), spawn a "congestion" mode scenario with slow, dense traffic.

Return ONLY a JSON array of objects to spawn. Do not include markdown formatting or explanations.
Each object must have exactly these keys:
- "type": "vehicle", "pedestrian", "cyclist", "motorcycle", "auto_rickshaw", "cow", or "dog".
- "lane_x": Float. -6.0 to 6.0 (-6 is left lane, 0 is center, 6 is right lane. +/- 5.5 are sidewalks).
- "distance_m": Float. Spawn distance ahead (30 to 150).
- "speed_mph": Float. Speed of the object (0 to 60). Animals should be 0-5. Autos 10-30.
- "lateral_vx": Float. Lateral movement speed. High for weaving motorcycles (+/- 2.0). 
- "honking_detected": Boolean. True if the object is honking to signal aggression/presence.
- "honk_duration_ms": Integer. 0 if not honking. 100 for warning, 500 for aggressive forcing.
"""

class TrafficLLMDirector:
    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY") or settings.GROQ_API_KEY
        self.model = settings.GROQ_MODEL
        self.endpoint = settings.GROQ_ENDPOINT

    async def generate_scene(self, ego_speed: float, weather: str, traffic_volume: int) -> List[Dict[str, Any]]:
        """
        Calls Groq API to get an adversarial traffic layout.
        Returns a fallback random scene if the LLM fails or is unavailable.
        """
        fallback_scene = [
            {"type": "auto_rickshaw", "lane_x": 0.0, "distance_m": 60.0, "speed_mph": 25.0, "lateral_vx": 0.0, "honking_detected": False, "honk_duration_ms": 0},
            {"type": "motorcycle", "lane_x": 2.0, "distance_m": 70.0, "speed_mph": 35.0, "lateral_vx": -1.5, "honking_detected": True, "honk_duration_ms": 100}
        ]

        if not self.api_key:
            return fallback_scene

        prompt = (
            f"Current State:\n"
            f"- Ego Speed: {ego_speed} mph\n"
            f"- Weather: {weather}\n"
            f"- Traffic Volume Dataset: {traffic_volume} vehicles/hr\n\n"
            f"Generate a challenging scenario."
        )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": TRAFFIC_LLM_SYSTEM_PROMPT},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.7,
            "max_tokens": 300
        }

        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.post(self.endpoint, headers=headers, json=payload)
                if response.status_code == 200:
                    data = response.json()
                    content = data["choices"][0]["message"]["content"].strip()
                    
                    # Clean markdown if present
                    if content.startswith("```json"):
                        content = content[7:-3]
                    elif content.startswith("```"):
                        content = content[3:-3]
                        
                    parsed = json.loads(content)
                    if isinstance(parsed, list):
                        return parsed
        except Exception as e:
            logger.warning(f"TrafficLLM failed to generate scene: {e}")
            
        return fallback_scene

# Singleton instance
traffic_director = TrafficLLMDirector()
