import math
from typing import List, Dict, Any, Optional

class TrajectoryPredictor:
    """
    Kinematic Heuristic Model (Hackathon Stand-in for LSTM).
    Input: past frames of (x, y, vx, vy) for one tracked object
    Output: predicted positions for next N frames (e.g., 0.5s to 3s ahead)
    """
    def __init__(self, fps: int = 10):
        self.fps = fps

    def predict(self, history: List[Dict[str, float]], horizon_seconds: float = 2.0) -> Dict[str, Any]:
        """
        history: list of dicts with 'x', 'y', 'vx', 'vy'
        """
        if not history:
            return {"predicted_trajectory": [], "confidence": 0.0, "scenario_type": "unknown"}
            
        last_state = history[-1]
        x, y = last_state['x'], last_state['y']
        vx, vy = last_state['vx'], last_state['vy']
        
        num_frames = int(horizon_seconds * self.fps)
        trajectory = []
        
        # Linear kinematic extrapolation for base prediction
        for i in range(1, num_frames + 1):
            dt = i / self.fps
            trajectory.append({
                "x": x + (vx * dt),
                "y": y + (vy * dt),
                "frame_offset": i
            })
            
        # Base confidence decays over time
        confidence = max(0.2, 1.0 - (0.15 * horizon_seconds))
        
        return {
            "predicted_trajectory": trajectory,
            "confidence": confidence,
            "scenario_type": "nominal_linear"
        }

class CongestionModePredictor:
    """Prediction changes based on traffic density"""
    
    def identify_mode(self, entity_count: int, road_capacity: int = 20) -> str:
        vehicle_density = entity_count / road_capacity
        
        if vehicle_density < 0.1:
            return "open_road"  # Western-style prediction works
        elif vehicle_density < 0.5:
            return "normal_traffic"  # some unpredictability
        else:
            return "congestion"  # chaos mode
    
    def adapt_prediction_horizon(self, mode: str) -> float:
        """Predict less far ahead in chaos"""
        return {
            'open_road': 3.0,          # predict 3 seconds
            'normal_traffic': 1.5,     # predict 1.5 seconds
            'congestion': 0.5,         # predict only 0.5 seconds (too chaotic)
        }[mode]

class HonkingInterpreter:
    def interpret(self, detector_output: Dict[str, Any]) -> str:
        if detector_output.get('honking_detected'):
            honk_duration = detector_output.get('honk_duration_ms', 0)
            
            if honk_duration < 100:
                return "warning_presence"
            elif honk_duration < 500:
                return "aggressive_intent"
            else:
                return "forcing_passage"
        return "none"

class IndianTrafficPredictor(TrajectoryPredictor):
    """Specialization for chaotic Indian traffic patterns"""
    
    SCENARIO_CLASSIFIERS = {
        'pedestrian_signal_violator': {
            'features': ['approaching_road', 'ignoring_signal'],
            'prediction_horizon': 2.0,  
            'confidence_decay': 0.95,   
        },
        'motorcycle_weaving': {
            'features': ['high_lateral_velocity', 'erratic_path'],
            'prediction_horizon': 1.0,  
            'confidence_decay': 0.90,   
        },
        'auto_sudden_turn': {
            'features': ['slowdown_without_braking', 'in_congestion'],
            'prediction_horizon': 1.5,
            'confidence_decay': 0.93,
        },
        'cow_stationary': {
            'features': ['stationary', 'in_traffic'],
            'prediction_horizon': 3.0,  
            'confidence_decay': 0.98,   
        },
    }
    
    def identify_indian_scenario(self, history: List[Dict[str, float]], object_type: str) -> str:
        if not history:
            return "unknown"
            
        last_state = history[-1]
        vx, vy = last_state['vx'], last_state['vy']
        speed = math.hypot(vx, vy)
        
        if object_type == "cow" or object_type == "dog":
            return "cow_stationary"
        elif object_type == "motorcycle" and abs(vx) > 1.0: # high lateral velocity
            return "motorcycle_weaving"
        elif object_type == "auto_rickshaw" and speed < 3.0 and speed > 0.5:
            return "auto_sudden_turn"
        elif object_type == "pedestrian" and abs(vx) > 0.5:
            return "pedestrian_signal_violator"
            
        return "nominal_traffic"
    
    def predict_with_indian_adaptation(self, history: List[Dict[str, float]], object_type: str) -> Dict[str, Any]:
        scenario = self.identify_indian_scenario(history, object_type)
        
        # Adjust horizon based on chaos
        horizon = 2.0
        if scenario in self.SCENARIO_CLASSIFIERS:
            horizon = self.SCENARIO_CLASSIFIERS[scenario]['prediction_horizon']
            
        base_prediction = self.predict(history, horizon_seconds=horizon)
        base_prediction['scenario_type'] = scenario
        
        # Apply scenario-specific confidence decay
        scenario_meta = self.SCENARIO_CLASSIFIERS.get(scenario)
        if scenario_meta:
            base_prediction['confidence'] *= scenario_meta['confidence_decay']
            
        # Animal specific logic
        if object_type in ["cow", "dog"]:
            # Highly unpredictable, assume worst case (they stay in road or wander erratically)
            base_prediction['predicted_trajectory'] = [history[-1]] * int(horizon * self.fps)
            base_prediction['confidence'] = 0.4 if object_type == "cow" else 0.3
            base_prediction['recommendation'] = 'BRAKE'
            
        return base_prediction

def euclidean(pos1, pos2):
    return math.hypot(pos1['x'] - pos2['x'], pos1['y'] - pos2['y'])

def estimate_future_collision_risk(vehicle_position: dict, object_trajectory: List[dict], collision_threshold: float = 2.5) -> float:
    """
    Will this object be in a collision trajectory with us?
    Returns time to collision (seconds) or None if safe.
    """
    fps = 10.0 # Standard simulation tick rate
    
    for idx, future_pos in enumerate(object_trajectory):
        distance = euclidean(vehicle_position, future_pos)
        if distance < collision_threshold:
            return (idx + 1) / fps  # TTC in seconds
            
    return None

def score_risk_with_prediction(current_distance: float, prediction: dict, vehicle_pos: dict) -> dict:
    predicted_collision = prediction['predicted_trajectory']
    time_to_collision = estimate_future_collision_risk(vehicle_pos, predicted_collision)
    
    if time_to_collision is not None:
        if time_to_collision < 1.0:
            return {"risk_level": "critical", "reason": f"collision_in_{time_to_collision:.1f}s"}
        elif time_to_collision < 2.0:
            return {"risk_level": "high", "reason": f"collision_in_{time_to_collision:.1f}s"}
        else:
            return {"risk_level": "medium", "reason": f"collision_in_{time_to_collision:.1f}s"}
    else:
        # No collision predicted, fall back to current risk
        risk = "low"
        if current_distance < 10.0:
            risk = "high"
        elif current_distance < 25.0:
            risk = "medium"
            
        return {
            "risk_level": risk,
            "reason": f"no_collision_predicted_dist_{current_distance:.1f}m"
        }
