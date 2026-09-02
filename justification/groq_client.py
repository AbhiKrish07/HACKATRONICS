"""
Async Groq LLM Client for Ultra-Fast Evidence-Grounded Justifications.
Leverages Groq's high-speed LPU inference (~200ms latency) with OpenAI-compatible JSON format.
Never leaks or logs API keys.
"""

import os
import json
import asyncio
import logging
from typing import Optional, Dict, Any
import httpx
from config import settings
from justification.grounding import SYSTEM_PROMPT

logger = logging.getLogger("av01.justification.groq")


class GroqJustificationClient:
    """
    High-throughput, low-latency async client for Groq API.
    """
    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None
    ):
        self.api_key = api_key or os.getenv("GROQ_API_KEY") or settings.GROQ_API_KEY
        self.model = model or settings.GROQ_MODEL
        self.timeout = timeout if timeout is not None else settings.LLM_TIMEOUT_SECONDS
        self.max_retries = max_retries if max_retries is not None else settings.LLM_MAX_RETRIES
        self.endpoint = settings.GROQ_ENDPOINT

    def _sanitize_error(self, error_msg: str) -> str:
        """
        Strips API keys from error messages to prevent credential leakage.
        """
        if self.api_key and len(self.api_key) > 6:
            return error_msg.replace(self.api_key, "[REDACTED_GROQ_KEY]")
        return error_msg

    async def generate_justification_text(self, prompt: str) -> Optional[str]:
        """
        Executes an evidence-grounded inference call against Groq LPU endpoint.
        """
        if not self.api_key:
            logger.debug("No Groq API key configured - using fallback path.")
            return None

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.0,
            "max_tokens": 150
        }

        attempts = 0
        while attempts <= self.max_retries:
            attempts += 1
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(self.endpoint, headers=headers, json=payload)

                    if response.status_code == 200:
                        data = response.json()
                        choices = data.get("choices", [])
                        if choices and "message" in choices[0]:
                            content = choices[0]["message"].get("content", "").strip()
                            try:
                                parsed = json.loads(content)
                                return parsed.get("reasoning")
                            except json.JSONDecodeError:
                                return content

                    elif 400 <= response.status_code < 500:
                        sanitized_body = self._sanitize_error(response.text[:200])
                        logger.warning(f"Groq API client error {response.status_code}: {sanitized_body}")
                        return None

                    else:
                        sanitized_body = self._sanitize_error(response.text[:200])
                        logger.warning(f"Groq API server error {response.status_code}: {sanitized_body} (attempt {attempts})")

            except (httpx.TimeoutException, httpx.NetworkError, asyncio.TimeoutError) as e:
                sanitized_err = self._sanitize_error(str(e))
                logger.warning(f"Groq API transient timeout/network exception: {sanitized_err} (attempt {attempts})")

            except Exception as e:
                sanitized_err = self._sanitize_error(str(e))
                logger.error(f"Unexpected exception calling Groq API: {sanitized_err}")
                return None

            if attempts <= self.max_retries:
                await asyncio.sleep(settings.LLM_RETRY_BACKOFF_SECONDS)

        return None

    async def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.1,
        max_tokens: int = 250
    ) -> Optional[Dict[str, Any]]:
        """Generic Groq JSON completion used by every AI surface in the app."""
        if not self.api_key:
            return None

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "response_format": {"type": "json_object"},
            "temperature": temperature,
            "max_tokens": max_tokens
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(self.endpoint, headers=headers, json=payload)
                if response.status_code != 200:
                    logger.warning(f"Groq JSON complete failed: {response.status_code}")
                    return None
                data = response.json()
                content = data["choices"][0]["message"]["content"].strip()
                return json.loads(content)
        except Exception as e:
            logger.warning(f"Groq JSON complete exception: {self._sanitize_error(str(e))}")
            return None

