"""Shared Anthropic client helper.

Centralizes:
  - the Claude model ID (env-overridable via QTX_CLAUDE_MODEL),
  - a single module-level client with a request timeout (the SDK retries
    429/overloaded/5xx twice by default — no hand-rolled retry loop needed),
  - prompt caching: the system prompt is sent as a content-block list with
    an ephemeral cache_control marker on the last block. Note the minimum
    cacheable prefix on this model is 2048 tokens; shorter system prompts
    silently skip caching (harmless). Volatile per-request content (timeline
    JSON, questions) must stay in the user message, never in `system`.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "claude-sonnet-4-6"


def resolve_model() -> str:
    """Return the Claude model ID, honouring the QTX_CLAUDE_MODEL env var."""
    return os.environ.get("QTX_CLAUDE_MODEL", _DEFAULT_MODEL)


# Import-time constant — set QTX_CLAUDE_MODEL before process start to override.
CLAUDE_MODEL: str = resolve_model()

_client = None
_client_api_key: str | None = None


def _get_client():
    """Return the shared Anthropic client, rebuilding only if the key changed."""
    global _client, _client_api_key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if _client is None or api_key != _client_api_key:
        import anthropic
        _client = anthropic.Anthropic(api_key=api_key, timeout=60.0)
        _client_api_key = api_key
    return _client


def call_claude(user_message: str, system_prompt: str, max_tokens: int = 1024) -> str:
    """Call Claude and return the text of the first text content block."""
    client = _get_client()
    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=max_tokens,
        system=[
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )
    usage = getattr(message, "usage", None)
    if usage is not None:
        logger.debug(
            "claude usage: input=%s output=%s cache_read=%s cache_creation=%s",
            getattr(usage, "input_tokens", None),
            getattr(usage, "output_tokens", None),
            getattr(usage, "cache_read_input_tokens", None),
            getattr(usage, "cache_creation_input_tokens", None),
        )
    return next((b.text for b in message.content if b.type == "text"), "")
