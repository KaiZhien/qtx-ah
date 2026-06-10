"""Integration tests for GET /api/calibration."""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

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
_TEST_API_KEY = "calibration-test-api-key"

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

import contextlib  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from services.calibration import CalibrationService  # noqa: E402


@pytest.fixture(autouse=True)
def _restore_api_key():
    prev = os.environ.get("QTX_API_KEY")
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    yield
    if prev is None:
        os.environ.pop("QTX_API_KEY", None)
    else:
        os.environ["QTX_API_KEY"] = prev


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


def test_calibration_requires_api_key():
    """GET /api/calibration without X-Api-Key header returns 401."""
    with _make_client() as client:
        resp = client.get("/api/calibration")
    assert resp.status_code == 401


def test_calibration_returns_report():
    """GET /api/calibration with correct X-Api-Key returns the mocked report."""
    _mock_report = {
        "cohorts": [
            {"cohort": "A", "mae": 1.2, "baseline_mae": 1.0, "drift_pct": 20.0, "status": "warn"}
        ]
    }

    with _make_client() as client:
        with patch.object(CalibrationService, "get_report", return_value=_mock_report):
            resp = client.get(
                "/api/calibration",
                headers={"X-Api-Key": _TEST_API_KEY},
            )

    assert resp.status_code == 200
    assert resp.json() == _mock_report
