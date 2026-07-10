"""Tests for GET /health (no-auth health probe) and deps logging."""
from __future__ import annotations

import logging
import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# Stub weasyprint before importing main (report router)
if "weasyprint" not in sys.modules:
    _wp = types.ModuleType("weasyprint")

    class _HTML:
        def __init__(self, s):
            pass

        def write_pdf(self):
            return b"%PDF"

    _wp.HTML = _HTML
    sys.modules["weasyprint"] = _wp

os.environ.setdefault("QTX_API_KEY", "health-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "s")

import deps as _deps  # noqa: E402

_orig_load_all = _deps.load_all
_deps.load_all = lambda: None
from main import app as _app  # noqa: E402
_deps.load_all = _orig_load_all


def _client():
    _deps.load_all = lambda: None
    return TestClient(_app, raise_server_exceptions=False)


def test_health_bypasses_api_key_middleware():
    """GET /health with no X-Api-Key header is NOT rejected with 401."""
    with _client() as c:
        resp = c.get("/health")
    assert resp.status_code != 401
    _deps.load_all = _orig_load_all


def test_health_reports_shape():
    with _client() as c:
        resp = c.get("/health")
    _deps.load_all = _orig_load_all
    data = resp.json()
    for key in ("status", "db", "models_loaded", "version"):
        assert key in data, f"missing key {key}"
    assert isinstance(data["db"], bool)
    assert isinstance(data["models_loaded"], bool)


def test_health_503_when_models_not_loaded():
    """deps.models is empty in tests → degraded → 503."""
    with patch.dict(_deps.models, {}, clear=True):
        with _client() as c:
            resp = c.get("/health")
    _deps.load_all = _orig_load_all
    assert resp.status_code == 503
    data = resp.json()
    assert data["status"] == "degraded"
    assert data["models_loaded"] is False


def test_health_200_when_db_and_models_ok():
    """With models present and the (sqlite) DB reachable → 200 ok."""
    with patch.dict(_deps.models, {"classifier": object()}, clear=True):
        with _client() as c:
            resp = c.get("/health")
    _deps.load_all = _orig_load_all
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["db"] is True
    assert data["models_loaded"] is True


def test_health_503_when_db_unreachable():
    import db as db_module

    def _boom():
        raise RuntimeError("db down")

    with patch.dict(_deps.models, {"classifier": object()}, clear=True):
        with patch.object(db_module, "_get_engine", _boom):
            with _client() as c:
                resp = c.get("/health")
    _deps.load_all = _orig_load_all
    assert resp.status_code == 503
    assert resp.json()["db"] is False


# ── deps logging ──────────────────────────────────────────────────────────────

def test_deps_uses_logger_not_print(caplog, capsys):
    """load_all logs through the module logger instead of print()."""
    prev_ready = _deps._db_ready
    try:
        with caplog.at_level(logging.INFO, logger="deps"):
            # No model files and (likely) no reachable clinical DB — load_all
            # must report through the logger, never stdout print().
            with patch.object(_deps, "_get_model_files", return_value={}):
                _orig_load_all()
    finally:
        _deps._db_ready = prev_ready

    out = capsys.readouterr().out
    assert "[deps]" not in out, "deps still print()s instead of logging"
    assert any(r.name == "deps" for r in caplog.records), "expected log records from the deps logger"


def test_deps_module_has_logger():
    assert isinstance(getattr(_deps, "logger", None), logging.Logger)
