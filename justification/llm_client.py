"""
Async Anthropic LLM Client with strict timeouts, retries, and API-key safety.
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

logger = logging.getLogger("av01.justification.client")


class AnthropicJustificationClient:
    """
    Manages robust async API calls to the Anthropic Claude API.
    """
    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None
    ):
        self.api_key = api_key or os.getenv("ANTHROPIC_API_KEY") or settings.ANTHROPIC_API_KEY
        self.model = model or settings.LLM_MODEL
        self.timeout = timeout if timeout is not None else settings.LLM_TIMEOUT_SECONDS
        self.max_retries = max_retries if max_retries is not None else settings.LLM_MAX_RETRIES
        self.endpoint = "https://api.anthropic.com/v1/messages"

    def _sanitize_error(self, error_msg: str) -> str:
        """
        Strips any potential API key substrings from error messages to prevent leakage.
        """
        if self.api_key and len(self.api_key) > 6:
            return error_msg.replace(self.api_key, "[REDACTED_API_KEY]")
        return error_msg

    async def generate_justification_text(self, prompt: str) -> Optional[str]:
        """
        Calls Anthropic API with strict timeout, single retry on transient errors,
        and JSON output parsing.
        """
        if not self.api_key:
            logger.debug("No Anthropic API key configured - using fallback path.")
            return None

        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }

        payload = {
            "model": self.model,
            "max_tokens": 150,
            "temperature": 0.0,  # Zero temperature for deterministic grounding
            "system": SYSTEM_PROMPT,
            "messages": [
                {"role": "user", "content": prompt}
            ]
        }

        attempts = 0
        while attempts <= self.max_retries:
            attempts += 1
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(self.endpoint, headers=headers, json=payload)
                    
                    if response.status_code == 200:
                        data = response.json()
                        content_list = data.get("content", [])
                        if content_list and "text" in content_list[0]:
                            raw_text = content_list[0]["text"].strip()
                            # Parse JSON
                            try:
                                parsed = json.loads(raw_text)
                                return parsed.get("reasoning")
                            except json.JSONDecodeError:
                                # Try extracting {"reasoning": "..."} substring
                                import re
                                match = re.search(r'\{.*"reasoning"\s*:\s*"([^"]+)".*\}', raw_text, re.DOTALL)
                                if match:
                                    return match.group(1)
                                return raw_text
                    
                    elif 400 <= response.status_code < 500:
                        # 4xx client errors (bad request, auth) -> DO NOT retry
                        sanitized_body = self._sanitize_error(response.text[:200])
                        logger.warning(f"Anthropic API client error {response.status_code}: {sanitized_body}")
                        return None
                    
                    else:
                        # 5xx server error -> retry if attempts remaining
                        sanitized_body = self._sanitize_error(response.text[:200])
                        logger.warning(f"Anthropic API server error {response.status_code}: {sanitized_body} (attempt {attempts})")

            except (httpx.TimeoutException, httpx.NetworkError, asyncio.TimeoutError) as e:
                sanitized_err = self._sanitize_error(str(e))
                logger.warning(f"Anthropic API transient timeout/network exception: {sanitized_err} (attempt {attempts})")
            
            except Exception as e:
                sanitized_err = self._sanitize_error(str(e))
                logger.error(f"Unexpected exception calling Anthropic API: {sanitized_err}")
                return None

            if attempts <= self.max_retries:
                await asyncio.sleep(settings.LLM_RETRY_BACKOFF_SECONDS)

        return None
