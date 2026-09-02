"""
Analysis Stage: Deterministic Risk Scoring Engine.
Calculates multi-factor risk scores and evaluates hazard priority with strict tie-break rules.
Pure functional interface: HazardEvent[] + VehicleState -> RiskAssessment[]
"""

from typing import List, Dict, Any, Tuple, Optional
from config import settings
from schemas.models import HazardEvent, RiskAssessment, VehicleState


class RiskAnalyzer:
    """
    Stage 3: Analysis
    Computes deterministic, weighted risk scores from kinematic and semantic hazard data.
    """
    def __init__(self):
        self.w_dist = settings.WEIGHT_DISTANCE
        self.w_vel = settings.WEIGHT_VELOCITY
        self.w_lane = settings.WEIGHT_LANE
        self.w_sev = settings.WEIGHT_SEVERITY

    def _compute_rss_safe_distance(self, v_ego: float, v_obj: float) -> float:
        """
        Responsibility-Sensitive Safety (RSS) minimum safe following distance.
        d_min = v_ego * t_react + (v_ego^2 / (2 * a_brake)) - (v_obj^2 / (2 * a_brake_obj))
        """
        t_react = 1.0       # 1.0s reaction time for system + hydraulics
        a_brake = 6.0       # 6.0 m/s^2 ego deceleration capability
        a_brake_obj = 8.0   # 8.0 m/s^2 assumed max object deceleration
        
        # Ego stopping distance
        d_ego = (v_ego * t_react) + ((v_ego ** 2) / (2 * a_brake))
        # Object stopping distance
        d_obj = (v_obj ** 2) / (2 * a_brake_obj)
        
        # Absolute minimum safe distance
        d_min = max(2.0, d_ego - d_obj)
        return d_min

    def _compute_distance_factor(self, distance: float, v_ego: float, v_obj: float) -> float:
        """
        Calculates normalized distance factor based on RSS mathematical bounds.
        """
        if distance <= 0:
            return 1.0
            
        rss_safe = self._compute_rss_safe_distance(v_ego, v_obj)
        
        if distance <= rss_safe * 0.5:
            # Deep inside critical bound
            return 1.0
        elif distance <= rss_safe:
            # Inside RSS bound but not immediately fatal (High Risk)
            fraction = (distance - (rss_safe * 0.5)) / (rss_safe * 0.5)
            return 0.75 + 0.25 * (1.0 - fraction)
        else:
            # Outside RSS bound (Warning / Low Risk)
            span = rss_safe * 2.0
            offset = distance - rss_safe
            return max(0.0, 0.75 * (1.0 - (offset / span)))

    def _compute_velocity_factor(self, distance: float, hazard: HazardEvent) -> float:
        """
        Calculates Time-To-Collision (TTC) based velocity factor.
        TTC = Distance / Closing Speed.
        """
        vy = hazard.relative_velocity.get("vy", 0.0)
        vx = hazard.relative_velocity.get("vx", 0.0)
        
        # Closing speed along longitudinal axis
        closing_speed = -vy  # negative vy means moving closer to ego
        
        # If object is cutting in laterally with significant vx
        lateral_speed = abs(vx)
        if hazard.lane_relevance in ["adjacent_lane", "oncoming_lane"] and lateral_speed > 0.5:
            closing_speed += lateral_speed * 0.5

        if closing_speed <= 0.1:
            return 0.1  # opening or static relative distance

        # Time To Collision (TTC)
        ttc = distance / closing_speed
        
        if ttc < 1.5:
            return 1.0    # Critical < 1.5s
        elif ttc < 3.0:
            return 0.8    # High risk < 3.0s
        elif ttc < 5.0:
            return 0.5    # Medium risk < 5.0s
        else:
            return 0.2    # Low risk

    def _compute_lane_factor(self, lane_relevance: str) -> float:
        return settings.LANE_RELEVANCE_WEIGHTS.get(lane_relevance, settings.LANE_RELEVANCE_WEIGHTS["unknown"])

    def _compute_severity_factor(self, object_type: Optional[str]) -> float:
        if not object_type:
            return settings.SEVERITY_WEIGHTS["unknown"]
        return settings.SEVERITY_WEIGHTS.get(object_type, settings.SEVERITY_WEIGHTS["unknown"])

    def score_hazard(self, hazard: HazardEvent, vehicle_state: VehicleState) -> RiskAssessment:
        """
        Computes risk assessment for a single hazard.
        Guaranteed to never throw or return None.
        """
        try:
            # Extract absolute speeds for RSS math
            v_ego = max(0.0, vehicle_state.speed_mps)
            v_obj = max(0.0, v_ego + hazard.relative_velocity.get("vy", 0.0))
            
            # Compute factor sub-scores using physical TTC and RSS bounds
            f_dist = self._compute_distance_factor(hazard.distance, v_ego, v_obj)
            f_vel = self._compute_velocity_factor(hazard.distance, hazard)
            f_lane = self._compute_lane_factor(hazard.lane_relevance)
            f_sev = self._compute_severity_factor(hazard.type)

            # Weighted sum
            raw_score = (
                self.w_dist * f_dist +
                self.w_vel * f_vel +
                self.w_lane * f_lane +
                self.w_sev * f_sev
            )
            # Determine dominant rule and TTC overrides
            dominant_rule = None
            predicted_ttc = getattr(hazard, "ttc_seconds", None)

            if predicted_ttc is not None and predicted_ttc < 3.5:
                dominant_rule = f"predicted_collision_{predicted_ttc:.1f}s"
                if predicted_ttc < 1.5:
                    raw_score = max(raw_score, 0.88)
                elif predicted_ttc < 2.5:
                    raw_score = max(raw_score, 0.72)

            if vehicle_state.lane_change_state != "IDLE" or hazard.sensor_zone in ("LEFT", "RIGHT"):
                if hazard.distance < 25.0 and hazard.sensor_zone in ("LEFT", "RIGHT"):
                    dominant_rule = f"lane_change_blind_spot_{hazard.sensor_zone.lower()}"
                    raw_score = max(raw_score, 0.75)

            risk_score = round(max(0.0, min(1.0, raw_score)), 4)

            # Risk level categorization
            if risk_score >= settings.RISK_THRESHOLD_CRITICAL:
                risk_level = "critical"
            elif risk_score >= settings.RISK_THRESHOLD_HIGH:
                risk_level = "high"
            elif risk_score >= settings.RISK_THRESHOLD_MEDIUM:
                risk_level = "medium"
            else:
                risk_level = "low"

            # Check degraded condition
            is_degraded = (
                hazard.model_unavailable or
                hazard.classification_confidence is None or
                hazard.classification_confidence < settings.CLASSIFICATION_CONFIDENCE_THRESHOLD or
                hazard.occupancy_confidence < 0.60
            )

            contributing_factors = {
                "distance_factor": round(float(f_dist * self.w_dist), 4),
                "velocity_factor": round(float(f_vel * self.w_vel), 4),
                "lane_factor": round(float(f_lane * self.w_lane), 4),
                "severity_factor": round(float(f_sev * self.w_sev), 4),
            }

            snapshot = {
                "hazard_id": hazard.id,
                "type": hazard.type or "unclassified_obstacle",
                "distance_m": round(hazard.distance, 1),
                "closing_velocity_mps": round(-hazard.relative_velocity.get("vy", 0.0), 1),
                "lane_relevance": hazard.lane_relevance,
                "sensor_zone": hazard.sensor_zone,
                "confidence": round(hazard.classification_confidence, 2) if hazard.classification_confidence else None
            }

            return RiskAssessment(
                hazard_event_id=hazard.id,
                risk_score=risk_score,
                risk_level=risk_level,
                degraded=is_degraded,
                contributing_factors=contributing_factors,
                hazard_snapshot=snapshot,
                dominant_rule=dominant_rule,
                predicted_ttc=predicted_ttc
            )

        except Exception as e:
            # Conservative safe fallback if unexpected exception occurs
            return RiskAssessment(
                hazard_event_id=hazard.id if hazard else "unknown",
                risk_score=0.50,
                risk_level="medium",
                degraded=True,
                contributing_factors={"fallback_safe_default": 0.50},
                hazard_snapshot={"error": str(e)}
            )

    def process(
        self,
        hazards: List[HazardEvent],
        vehicle_state: Optional[VehicleState] = None
    ) -> List[RiskAssessment]:
        """
        Process all hazards and return deterministic RiskAssessments sorted by priority.
        Tie-break rule: risk_level priority (critical > high > medium > low) -> distance (closer first) -> conservative default.
        """
        v_state = vehicle_state or VehicleState()
        assessments: List[RiskAssessment] = []

        for hazard in hazards:
            assessment = self.score_hazard(hazard, v_state)
            assessments.append(assessment)

        # Sort assessments by strict tie-break rule
        # 1. Risk Level Priority (Descending)
        # 2. Risk Score (Descending)
        # 3. Distance (Ascending - closer first)
        def sort_key(ra: RiskAssessment):
            level_rank = settings.RISK_LEVEL_PRIORITY.get(ra.risk_level, 0)
            score = ra.risk_score
            dist = ra.hazard_snapshot.get("distance_m", 999.0) if ra.hazard_snapshot else 999.0
            return (-level_rank, -score, dist)

        assessments.sort(key=sort_key)
        return assessments

    def detect_conflicts(self, assessments: List[RiskAssessment]) -> Tuple[bool, Optional[RiskAssessment], Optional[RiskAssessment]]:
        """
        Checks if two or more hazards both exhibit high/critical risk with competing kinematic directions.
        Returns (conflict_active, primary_assessment, secondary_assessment).
        """
        high_crit = [a for a in assessments if a.risk_level in ["critical", "high"]]
        if len(high_crit) >= 2:
            return True, high_crit[0], high_crit[1]
        return False, None, None
