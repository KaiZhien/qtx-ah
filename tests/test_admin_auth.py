"""Tests for admin endpoint authentication (QTX_ADMIN_KEY / X-Admin-Key)."""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Path setup — must happen before any api/ imports
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# ---------------------------------------------------------------------------
# Stub weasyprint before importing main so the report router doesn't blow up
# ---------------------------------------------------------------------------
if "weasyprint" not in sys.modules:
    _wp_stub = types.ModuleType("weasyprint")

    class _StubHTML:
        def __init__(self, s):
            pass

        def write_pdf(self):
            return b"%PDF-stub"

    _wp_stub.HTML = _StubHTML
    sys.modules["weasyprint"] = _wp_stub

# ---------------------------------------------------------------------------
# Env vars that must be present before main.py is imported
# ---------------------------------------------------------------------------
_TEST_API_KEY = "admin-test-api-key"
_TEST_ADMIN_KEY = "admin-test-secret"

os.environ.setdefault("QTX_API_KEY", _TEST_API_KEY)
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "test-terra-secret")

# ---------------------------------------------------------------------------
# Patch deps.load_all to a no-op so TestClient lifespan doesn't try to
# load ML model files from disk.
# ---------------------------------------------------------------------------
import deps  # noqa: E402

_original_load_all = deps.load_all
deps.load_all = lambda: None  # type: ignore[method-assign]

# ---------------------------------------------------------------------------
# Import app AFTER patching load_all
# ---------------------------------------------------------------------------
from main import app  # noqa: E402

# Restore load_all so subsequent test files see the real implementation.
deps.load_all = _original_load_all

# ---------------------------------------------------------------------------
# Helper: build a TestClient that patches load_all for the lifespan duration.
# ---------------------------------------------------------------------------
import contextlib  # noqa: E402


@contextlib.contextmanager
def _make_client():
    _orig = deps.load_all
    deps.load_all = lambda: None  # type: ignore[method-assign]
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
    finally:
        deps.load_all = _orig


# ===========================================================================
# Tests
# ===========================================================================


def test_correct_admin_key_returns_200(monkeypatch):
    """Correct X-Admin-Key header → route executes and returns 200."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    # Use _make_client to handle the lifespan setup, then patch load_all for the request only
    with _make_client() as c:
        with patch.object(deps, "load_all") as mock_load:
            resp = c.post(
                "/api/admin/reload-models",
                headers={"X-Admin-Key": _TEST_ADMIN_KEY},
            )
            mock_load.assert_called_once()
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "models_loaded" in body


def test_wrong_admin_key_returns_401(monkeypatch):
    """Wrong X-Admin-Key header → 401."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    with _make_client() as c:
        resp = c.post(
            "/api/admin/reload-models",
            headers={"X-Admin-Key": "totally-wrong-key"},
        )
    assert resp.status_code == 401
    assert "Invalid or missing admin key" in resp.json()["detail"]


def test_no_admin_key_header_returns_401(monkeypatch):
    """No X-Admin-Key header → 401."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    with _make_client() as c:
        resp = c.post("/api/admin/reload-models")
    assert resp.status_code == 401
    assert "Invalid or missing admin key" in resp.json()["detail"]


def test_admin_key_env_var_unset_returns_503(monkeypatch):
    """QTX_ADMIN_KEY env var unset → 503."""
    monkeypatch.delenv("QTX_ADMIN_KEY", raising=False)
    with _make_client() as c:
        resp = c.post("/api/admin/reload-models")
    assert resp.status_code == 503
    assert "QTX_ADMIN_KEY" in resp.json()["detail"]


def test_model_status_no_key_returns_401(monkeypatch):
    """No X-Admin-Key → 401."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    with _make_client() as c:
        resp = c.get("/api/admin/model_status")
    assert resp.status_code == 401


def test_model_status_wrong_key_returns_401(monkeypatch):
    """Wrong X-Admin-Key → 401."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    with _make_client() as c:
        resp = c.get("/api/admin/model_status", headers={"X-Admin-Key": "wrong"})
    assert resp.status_code == 401


def test_model_status_correct_key_returns_200(monkeypatch, tmp_path):
    """Correct key → 200 with models + retrain_state + db_ready keys."""
    import json
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    state = {
        "last_retrain_at": "2026-06-03T05:05:51Z",
        "last_retrain_session_count": 100,
        "last_metrics": {"rmse_mean": 0.7, "r2_mean": 0.02, "n": 100, "auc_roc_mean": 0.89},
    }
    state_file = tmp_path / "retrain_state.json"
    state_file.write_text(json.dumps(state))
    import routers.admin as admin_mod
    monkeypatch.setattr(admin_mod, "_RETRAIN_STATE_PATH", state_file)
    monkeypatch.setattr(admin_mod, "_MODELS_DIR", tmp_path)
    with _make_client() as c:
        resp = c.get("/api/admin/model_status", headers={"X-Admin-Key": _TEST_ADMIN_KEY})
    assert resp.status_code == 200
    body = resp.json()
    assert "models" in body
    assert "retrain_state" in body
    assert "db_ready" in body


def test_trigger_retrain_no_key_returns_401(monkeypatch):
    """No X-Admin-Key → 401."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    with _make_client() as c:
        resp = c.post("/api/admin/trigger_retrain")
    assert resp.status_code == 401


def test_trigger_retrain_correct_key_returns_200(monkeypatch):
    """Correct key → 200 with retrain_scheduled status."""
    monkeypatch.setenv("QTX_ADMIN_KEY", _TEST_ADMIN_KEY)
    with _make_client() as c:
        resp = c.post(
            "/api/admin/trigger_retrain",
            headers={"X-Admin-Key": _TEST_ADMIN_KEY},
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "retrain_scheduled"
