"""Shared Anthropic client helper."""
from __future__ import annotations
import os


def call_claude(user_message: str, system_prompt: str, max_tokens: int = 1024) -> str:
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )
    return message.content[0].text
