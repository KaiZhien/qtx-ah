"""Integration tests for GET /api/patient/{sn}/benchmark."""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

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
_TEST_API_KEY = "benchmark-test-api-key"

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

from fastapi.testclient import TestClient  # noqa: E402
from db import get_db  # noqa: E402


@contextlib.contextmanager
def _make_client():
    _orig = deps.load_all
    deps.load_all = lambda: None  # type: ignore[method-assign]
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
    finally:
        deps.load_all = _orig


def _mock_db_with_result(result_row):
    """Return a mock DB session whose .execute().first() returns result_row."""
    mock_db = MagicMock()
    mock_execute = MagicMock()
    mock_execute.first.return_value = result_row
    mock_db.execute.return_value = mock_execute
    return mock_db


# ===========================================================================
# Tests
# ===========================================================================


def test_benchmark_requires_api_key():
    """GET /api/patient/XYZ/benchmark without X-Api-Key returns 401."""
    with _make_client() as client:
        resp = client.get("/api/patient/XYZ/benchmark")
    assert resp.status_code == 401


def test_benchmark_returns_none_for_nonexistent_patient():
    """GET /api/patient/NONEXISTENT/benchmark → {"cohort_percentile": null}."""
    mock_db = _mock_db_with_result(None)

    with _make_client() as client:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: mock_db
            try:
                resp = client.get(
                    "/api/patient/NONEXISTENT/benchmark",
                    headers={"X-Api-Key": _TEST_API_KEY},
                )
            finally:
                app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 200
    data = resp.json()
    assert data == {"cohort_percentile": None}


def test_benchmark_structure():
    """Verify response has cohort_percentile key."""
    mock_row = MagicMock()
    mock_row._mapping = {"cohort_percentile": 62}
    mock_db = _mock_db_with_result(mock_row)

    with _make_client() as client:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: mock_db
            try:
                resp = client.get(
                    "/api/patient/P001/benchmark",
                    headers={"X-Api-Key": _TEST_API_KEY},
                )
            finally:
                app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 200
    data = resp.json()
    assert "cohort_percentile" in data
    assert data["cohort_percentile"] == 62


def test_benchmark_returns_503_when_db_not_ready():
    """GET /api/patient/P001/benchmark returns 503 when DB is not ready."""
    with _make_client() as client:
        with patch.object(deps, "_db_ready", False):
            resp = client.get(
                "/api/patient/P001/benchmark",
                headers={"X-Api-Key": _TEST_API_KEY},
            )
    assert resp.status_code == 503
