"""
Deterministic Fallback Template Engine for Justifications.
Produces robust, human-readable explanations directly from structured evidence without network calls.
"""

from typing import Optional
from schemas.models import RiskAssessment


def format_template_justification(assessment: RiskAssessment) -> str:
    """
    Generates a deterministic, grammatically clean explanation from a RiskAssessment.
    Used when the LLM is unreachable, times out, rate-limited, or fails validation.
    """
    snap = assessment.hazard_snapshot or {}
    obj_type = snap.get("type", "object")
    dist = snap.get("distance_m", 0.0)
    closing_v = snap.get("closing_velocity_mps", 0.0)
    lane = snap.get("lane_relevance", "in_lane").replace("_", " ")
    
    score = assessment.risk_score
    level = assessment.risk_level.upper()

    closing_desc = f"closing at {abs(closing_v):.1f} m/s" if closing_v > 0.5 else "maintaining distance"
    if closing_v < -0.5:
        closing_desc = f"pulling away at {abs(closing_v):.1f} m/s"

    degraded_notice = " [degraded sensor confidence]" if assessment.degraded else ""
    rule_note = ""
    if assessment.dominant_rule:
        if "predicted_collision" in assessment.dominant_rule:
            rule_note = f" (Rule: Predicted collision in {assessment.predicted_ttc:.1f}s)" if assessment.predicted_ttc else " (Rule: Predicted trajectory collision)"
        elif "lane_change_blind_spot" in assessment.dominant_rule:
            rule_note = f" (Rule: Blind-spot hazard in {snap.get('sensor_zone', 'side')} zone)"

    return (
        f"{level} risk (score: {score:.2f}): {obj_type} detected at {dist:.1f}m ({lane}), "
        f"{closing_desc}.{rule_note}{degraded_notice}"
    )


def format_sensor_gap_justification(consecutive_ticks: int) -> str:
    """
    Deterministic justification for the sensor gap edge case.
    """
    return (
        f"Sensor coverage degraded for {consecutive_ticks} consecutive ticks. "
        "Conservative default posture active: maintaining safety buffer due to sensor gap."
    )


def format_conflict_justification(
    primary: RiskAssessment,
    secondary: RiskAssessment,
    tie_break_reason: str = "higher vulnerability and closer proximity"
) -> str:
    """
    Deterministic justification explaining conflict resolution between two competing hazards.
    """
    snap_p = primary.hazard_snapshot or {}
    snap_s = secondary.hazard_snapshot or {}

    p_type = snap_p.get("type", "primary hazard")
    p_dist = snap_p.get("distance_m", 0.0)
    p_score = primary.risk_score

    s_type = snap_s.get("type", "secondary hazard")
    s_dist = snap_s.get("distance_m", 0.0)
    s_score = secondary.risk_score

    return (
        f"Conflicting high-risk hazards detected. Priority given to {p_type} at {p_dist:.1f}m (score: {p_score:.2f}) "
        f"over {s_type} at {s_dist:.1f}m (score: {s_score:.2f}) based on {tie_break_reason}."
    )
