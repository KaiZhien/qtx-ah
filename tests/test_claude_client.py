"""Tests for the shared Anthropic client helper (services/claude_client.py)."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


# ── Model ID resolution ───────────────────────────────────────────────────────

def test_default_model_is_sonnet_4_6(monkeypatch):
    monkeypatch.delenv("QTX_CLAUDE_MODEL", raising=False)
    from services.claude_client import resolve_model
    assert resolve_model() == "claude-sonnet-4-6"


def test_model_env_override(monkeypatch):
    monkeypatch.setenv("QTX_CLAUDE_MODEL", "claude-test-override")
    from services.claude_client import resolve_model
    assert resolve_model() == "claude-test-override"


def test_module_constant_matches_default():
    """CLAUDE_MODEL (import-time constant) defaults to claude-sonnet-4-6."""
    from services import claude_client
    assert claude_client.CLAUDE_MODEL == "claude-sonnet-4-6"


def test_insight_and_anomaly_use_central_model():
    """InsightService.MODEL and AnomalyDetector.MODEL come from the shared constant."""
    from services import claude_client
    from services.insight import InsightService
    from services.anomaly import AnomalyDetector
    assert InsightService.MODEL == claude_client.CLAUDE_MODEL
    assert AnomalyDetector.MODEL == claude_client.CLAUDE_MODEL


# ── call_claude behaviour (stubbed anthropic SDK) ─────────────────────────────

class _Block:
    def __init__(self, type_: str, text: str = ""):
        self.type = type_
        self.text = text


class _Usage:
    input_tokens = 100
    output_tokens = 10
    cache_read_input_tokens = 0
    cache_creation_input_tokens = 0


class _Message:
    def __init__(self, content):
        self.content = content
        self.usage = _Usage()


class _FakeMessages:
    def __init__(self, recorder, content):
        self._recorder = recorder
        self._content = content

    def create(self, **kwargs):
        self._recorder["create_kwargs"] = kwargs
        return _Message(self._content)


class _FakeAnthropicFactory:
    """Builds a stub `anthropic` module capturing constructor + create() kwargs."""

    def __init__(self, content=None):
        self.recorder: dict = {"constructions": []}
        content = content if content is not None else [_Block("text", "hello")]
        recorder = self.recorder

        class _FakeClient:
            def __init__(self, **kwargs):
                recorder["constructions"].append(kwargs)
                self.messages = _FakeMessages(recorder, content)

        mod = types.ModuleType("anthropic")
        mod.Anthropic = _FakeClient
        self.module = mod


@pytest.fixture
def fresh_client(monkeypatch):
    """Reset the module-level cached client between tests."""
    from services import claude_client
    monkeypatch.setattr(claude_client, "_client", None)
    monkeypatch.setattr(claude_client, "_client_api_key", None)
    return claude_client


def test_call_claude_passes_timeout_and_model(fresh_client, monkeypatch):
    fake = _FakeAnthropicFactory()
    monkeypatch.setitem(sys.modules, "anthropic", fake.module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-123")

    result = fresh_client.call_claude("user msg", "system prompt", max_tokens=99)

    assert result == "hello"
    ctor = fake.recorder["constructions"][0]
    assert ctor["timeout"] == 60.0
    assert ctor["api_key"] == "k-123"
    kwargs = fake.recorder["create_kwargs"]
    assert kwargs["model"] == fresh_client.CLAUDE_MODEL
    assert kwargs["max_tokens"] == 99
    assert kwargs["messages"] == [{"role": "user", "content": "user msg"}]


def test_call_claude_system_prompt_has_cache_control(fresh_client, monkeypatch):
    """System prompt is sent as a content-block list with ephemeral cache_control."""
    fake = _FakeAnthropicFactory()
    monkeypatch.setitem(sys.modules, "anthropic", fake.module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-123")

    fresh_client.call_claude("msg", "the system prompt")

    system = fake.recorder["create_kwargs"]["system"]
    assert isinstance(system, list)
    assert system[-1]["type"] == "text"
    assert system[-1]["text"] == "the system prompt"
    assert system[-1]["cache_control"] == {"type": "ephemeral"}


def test_call_claude_extracts_first_text_block(fresh_client, monkeypatch):
    """Non-text leading blocks are skipped — text extraction does not assume block 0."""
    fake = _FakeAnthropicFactory(
        content=[_Block("thinking"), _Block("text", "actual answer"), _Block("text", "tail")]
    )
    monkeypatch.setitem(sys.modules, "anthropic", fake.module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-123")

    assert fresh_client.call_claude("msg", "sys") == "actual answer"


def test_call_claude_returns_empty_string_when_no_text_block(fresh_client, monkeypatch):
    fake = _FakeAnthropicFactory(content=[_Block("thinking")])
    monkeypatch.setitem(sys.modules, "anthropic", fake.module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-123")

    assert fresh_client.call_claude("msg", "sys") == ""


def test_client_is_reused_across_calls(fresh_client, monkeypatch):
    """The Anthropic client is constructed once and shared across calls."""
    fake = _FakeAnthropicFactory()
    monkeypatch.setitem(sys.modules, "anthropic", fake.module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-123")

    fresh_client.call_claude("m1", "s")
    fresh_client.call_claude("m2", "s")

    assert len(fake.recorder["constructions"]) == 1


def test_client_rebuilt_when_api_key_changes(fresh_client, monkeypatch):
    fake = _FakeAnthropicFactory()
    monkeypatch.setitem(sys.modules, "anthropic", fake.module)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-1")
    fresh_client.call_claude("m1", "s")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-2")
    fresh_client.call_claude("m2", "s")

    assert len(fake.recorder["constructions"]) == 2
    assert fake.recorder["constructions"][1]["api_key"] == "k-2"
