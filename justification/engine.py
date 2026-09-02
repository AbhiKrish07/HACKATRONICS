"""
Justification Engine with Circuit Breaker - GROQ ONLY Provider.
Stage 4: Coordinates structured evidence extraction, circuit breaker state tracking,
caching, LLM generation via Groq LPU, grounding validation, fallback execution, and call-budget guards.
All AI justification flows exclusively through Groq's ultra-fast inference endpoints.
"""

import time
import asyncio
import logging
from typing import List, Optional, Tuple, Union
from config import settings
from schemas.models import RiskAssessment, Justification
from justification.grounding import extract_evidence_facts, build_llm_prompt, validate_grounding
from justification.fallback import (
    format_template_justification,
    format_sensor_gap_justification,
    format_conflict_justification
)
from justification.cache import JustificationCache
from justification.circuit_breaker import CircuitBreaker, CircuitState
from justification.groq_client import GroqJustificationClient

logger = logging.getLogger("av01.justification")


def _is_local_only_runtime() -> bool:
    """Runtime local-only flag from light_integration (imported lazily to avoid cycles)."""
    try:
        from light_integration import is_local_only
        return is_local_only()
    except Exception:
        return False


class JustificationEngine:
    """
    Stage 4: Justification
    Converts RiskAssessment[] into evidence-grounded Justifications with Circuit Breaker protection.
    """
    def __init__(
        self,
        llm_client: Optional[GroqJustificationClient] = None,
        circuit_breaker: Optional[CircuitBreaker] = None
    ):
        if llm_client:
            self.client = llm_client
        else:
            self.client = GroqJustificationClient()

        self.circuit_breaker = circuit_breaker or CircuitBreaker()
        self.cache = JustificationCache()
        self.llm_call_count = 0
        self.llm_error_count = 0
        self.llm_cap_reached = False

    def reset_run(self):
        """Resets per-run counters."""
        self.llm_call_count = 0
        self.llm_error_count = 0
        self.llm_cap_reached = False
        self.cache.clear()

    async def generate_single_justification(self, assessment: RiskAssessment) -> Justification:
        """
        Produces an evidence-grounded Justification for a single RiskAssessment.
        """
        evidence = extract_evidence_facts(assessment)
        now = time.time()

        # Step 1: Check cache
        cached_reasoning = self.cache.get(assessment)
        if cached_reasoning:
            return Justification(
                risk_assessment_id=assessment.hazard_event_id,
                evidence=evidence,
                reasoning=cached_reasoning,
                source="llm" if not cached_reasoning.startswith("LOW") and not cached_reasoning.startswith("CRITICAL") else "fallback_template",
                generated_at=now
            )

        # Step 2: Rate / Cost Guard check
        if self.llm_call_count >= settings.LLM_MAX_CALLS_PER_RUN:
            if not self.llm_cap_reached:
                logger.info(f"LLM run call cap ({settings.LLM_MAX_CALLS_PER_RUN}) reached. Using fallback templates.")
                self.llm_cap_reached = True
            template_text = format_template_justification(assessment)
            return Justification(
                risk_assessment_id=assessment.hazard_event_id,
                evidence=evidence,
                reasoning=template_text,
                source="fallback_template",
                generated_at=now
            )

        # Step 3: Check Circuit Breaker state (DIFF 6)
        if not self.circuit_breaker.should_attempt_call():
            # Circuit is OPEN -> skip LLM call instantly to conserve latency budget
            template_text = format_template_justification(assessment)
            return Justification(
                risk_assessment_id=assessment.hazard_event_id,
                evidence=evidence,
                reasoning=template_text,
                source="fallback_template",
                generated_at=now
            )

        # Step 4: LLM generation if enabled, key present, and local-only OFF
        if settings.LLM_ENABLED and self.client.api_key and not _is_local_only_runtime():
            self.llm_call_count += 1
            prompt = build_llm_prompt(assessment, evidence)
            try:
                timeout = getattr(self.client, 'timeout', settings.LLM_TIMEOUT_SECONDS)
                llm_text = await asyncio.wait_for(
                    self.client.generate_justification_text(prompt),
                    timeout=timeout
                )
            except (asyncio.TimeoutError, Exception) as e:
                logger.warning(f"LLM call failed or timed out: {e}")
                self.llm_error_count += 1
                self.circuit_breaker.record_failure(error_type="timeout_or_exception")
                llm_text = None

            if llm_text:
                # Step 5: Hallucination Tripwire Grounding Validation
                is_valid, val_reason = validate_grounding(llm_text, assessment, evidence)
                if is_valid:
                    self.circuit_breaker.record_success()
                    self.cache.set(assessment, llm_text)
                    return Justification(
                        risk_assessment_id=assessment.hazard_event_id,
                        evidence=evidence,
                        reasoning=llm_text,
                        source="llm",
                        generated_at=now
                    )
                else:
                    logger.warning(f"LLM justification rejected by grounding tripwire: {val_reason}. Text: '{llm_text}'")
                    self.llm_error_count += 1
                    self.circuit_breaker.record_failure(error_type="hallucination_tripwire_rejection")
            else:
                self.llm_error_count += 1
                self.circuit_breaker.record_failure(error_type="api_error_or_timeout")

        # Step 6: Deterministic Fallback Template
        template_text = format_template_justification(assessment)
        self.cache.set(assessment, template_text)
        return Justification(
            risk_assessment_id=assessment.hazard_event_id,
            evidence=evidence,
            reasoning=template_text,
            source="fallback_template",
            generated_at=now
        )

    async def process(
        self,
        assessments: List[RiskAssessment],
        sensor_gap_ticks: int = 0,
        conflict_pair: Optional[Tuple[RiskAssessment, RiskAssessment]] = None
    ) -> List[Justification]:
        """
        Main interface: RiskAssessment[] -> Justification[]
        """
        now = time.time()
        justifications: List[Justification] = []

        # Handle sensor gap edge case explicitly
        if sensor_gap_ticks >= settings.SENSOR_GAP_N_TICKS:
            gap_reasoning = format_sensor_gap_justification(sensor_gap_ticks)
            gap_just = Justification(
                risk_assessment_id="sensor_gap_alert",
                evidence=[
                    f"Sensor gap duration: {sensor_gap_ticks} ticks",
                    f"Threshold: {settings.SENSOR_GAP_N_TICKS} ticks",
                    "Status: Active sensor degradation"
                ],
                reasoning=gap_reasoning,
                source="fallback_template",
                generated_at=now
            )
            justifications.append(gap_just)
            return justifications

        # Handle conflicting detections edge case explicitly
        if conflict_pair:
            primary, secondary = conflict_pair
            tie_break_reason = "higher vulnerability rating and closer braking threshold"
            conflict_reasoning = format_conflict_justification(primary, secondary, tie_break_reason)

            evidence = [
                f"Conflicting hazard 1: {primary.hazard_snapshot.get('type')} at {primary.hazard_snapshot.get('distance_m')}m (risk: {primary.risk_level})",
                f"Conflicting hazard 2: {secondary.hazard_snapshot.get('type')} at {secondary.hazard_snapshot.get('distance_m')}m (risk: {secondary.risk_level})",
                f"Arbitration rule: Level ({primary.risk_level}) -> Distance ({primary.hazard_snapshot.get('distance_m')}m) -> Vulnerability"
            ]
            conflict_just = Justification(
                risk_assessment_id=f"conflict_{primary.hazard_event_id}_{secondary.hazard_event_id}",
                evidence=evidence,
                reasoning=conflict_reasoning,
                source="fallback_template",
                generated_at=now
            )
            justifications.append(conflict_just)

        # Standard assessment justifications
        for assessment in assessments:
            just = await self.generate_single_justification(assessment)
            justifications.append(just)

        return justifications
