"""
Grounding and Hallucination Tripwire Validation for LLM Justifications.
Ensures that justification prompts contain only structured evidence and that LLM outputs
are strictly grounded in provided facts without inventing objects or numbers.
"""

import re
from typing import List, Dict, Any, Tuple
from schemas.models import RiskAssessment


SYSTEM_PROMPT = (
    "You are a justification-writing layer. You will be given structured risk-assessment facts. "
    "Write one or two sentences of plain-language reasoning that only restates and connects the facts given. "
    "Do not introduce any object, number, or cause not present in the input. "
    "If information is insufficient, say so explicitly rather than inferring. "
    "Respond ONLY with a valid JSON object matching: {\"reasoning\": \"<your explanation>\"}"
)


def extract_evidence_facts(assessment: RiskAssessment) -> List[str]:
    """
    Extracts deterministic bulleted evidence strings from structured RiskAssessment data.
    """
    facts = []
    snap = assessment.hazard_snapshot or {}
    
    obj_type = snap.get("type", "unknown")
    dist = snap.get("distance_m", "unknown")
    closing_v = snap.get("closing_velocity_mps", "unknown")
    lane = snap.get("lane_relevance", "unknown")
    conf = snap.get("confidence")

    facts.append(f"Risk Level: {assessment.risk_level.upper()} (score: {assessment.risk_score})")
    facts.append(f"Detected Object: {obj_type}")
    facts.append(f"Distance: {dist} meters")
    facts.append(f"Closing Velocity: {closing_v} m/s")
    facts.append(f"Lane Relevance: {lane}")
    if conf is not None:
        facts.append(f"Classification Confidence: {conf}")
    if assessment.degraded:
        facts.append("Status: Degraded sensor/perception confidence")

    for factor_name, factor_val in assessment.contributing_factors.items():
        facts.append(f"Contributing Weight ({factor_name}): {factor_val}")

    return facts


def build_llm_prompt(assessment: RiskAssessment, evidence: List[str]) -> str:
    """
    Constructs a strict facts-only user prompt for the LLM.
    """
    evidence_text = "\n".join([f"- {item}" for item in evidence])
    return (
        f"Input Structured Facts:\n{evidence_text}\n\n"
        "Generate a concise 1-2 sentence justification in JSON format {\"reasoning\": \"...\"}."
    )


# Permitted object lexicon
KNOWN_ENTITIES = {"pedestrian", "vehicle", "cyclist", "static_obstacle", "obstacle", "car", "unknown"}


def validate_grounding(reasoning_text: str, assessment: RiskAssessment, evidence: List[str]) -> Tuple[bool, str]:
    """
    Hallucination tripwire:
    Verifies that the reasoning text does not introduce hallucinated entities or unsupported numerical claims.
    Returns (is_valid, validation_reason).
    """
    if not reasoning_text or len(reasoning_text.strip()) < 5:
        return False, "Empty or trivial reasoning text"

    lower_text = reasoning_text.lower()
    snap = assessment.hazard_snapshot or {}
    allowed_type = str(snap.get("type", "unknown")).lower()

    # 1. Entity tripwire: check if reasoning mentions other specific object categories not in input
    all_types = ["pedestrian", "cyclist", "vehicle", "static_obstacle"]
    for t in all_types:
        if t in lower_text and t not in allowed_type and allowed_type != "unknown":
            # If the text mentions "cyclist" when the object was a "pedestrian", flag hallucination
            return False, f"Hallucinated entity '{t}' detected (expected '{allowed_type}')"

    # 2. Number tripwire: extract all numbers in reasoning text and ensure they correspond to input facts
    # Matches integers and floats like 15, 15.5, 0.75
    found_numbers = re.findall(r"\b\d+(?:\.\d+)?\b", reasoning_text)
    
    # Collect all valid input numbers
    valid_numbers = set()
    valid_numbers.add(round(float(assessment.risk_score), 2))
    valid_numbers.add(round(float(assessment.risk_score), 4))
    if "distance_m" in snap and isinstance(snap["distance_m"], (int, float)):
        d = float(snap["distance_m"])
        valid_numbers.update([round(d, 0), round(d, 1), int(d)])
    if "closing_velocity_mps" in snap and isinstance(snap["closing_velocity_mps"], (int, float)):
        v = float(snap["closing_velocity_mps"])
        valid_numbers.update([round(v, 0), round(v, 1), abs(round(v, 1)), int(abs(v))])
    if "confidence" in snap and snap["confidence"] is not None:
        c = float(snap["confidence"])
        valid_numbers.update([round(c, 2), round(c, 1)])

    # Also allow standard small integers like 1, 2 (for "1 or 2 seconds")
    allowed_generic_numbers = {1, 2, 100}

    for num_str in found_numbers:
        val = float(num_str)
        # Check if number matches any valid input number with small rounding tolerance
        matched = any(abs(val - vn) <= 0.5 for vn in valid_numbers) or (int(val) in allowed_generic_numbers)
        if not matched:
            # Stricter check for significant foreign numbers (e.g. hallucinating "95 meters" when input was "18 meters")
            return False, f"Hallucinated numerical value '{num_str}' not found in structured evidence facts"

    return True, "Passed grounding validation"
