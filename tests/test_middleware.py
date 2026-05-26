"""Tests for the API-key authentication middleware in api/main.py."""
from __future__ import annotations

import hashlib
import hmac as hmac_lib
import json
import os
import sys
import time
import types
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

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
_TEST_KEY = "mw-test-secret"
os.environ.setdefault("QTX_API_KEY", _TEST_KEY)
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "test-terra-secret")

# ---------------------------------------------------------------------------
# In-memory SQLite engine + session factory for tests
# ---------------------------------------------------------------------------
_FLAG_COLS = [
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_sarcopenia",
    "has_frailty", "has_balance_issue", "has_post_surgery", "has_chronic_pain",
    "has_neuropathy", "has_cancer", "has_cardiovascular", "has_hypertension",
    "has_osteoporosis", "has_spinal_issue", "has_knee_issue", "has_hip_issue",
    "has_shoulder_issue", "has_neurological", "has_fracture", "has_autoimmune",
    "has_metabolic", "has_wellness_only", "has_fall_risk",
    "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
    "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic", "grp_cardiovascular",
    "grp_oncology", "grp_autoimmune", "grp_softtissue_injury", "grp_generalised_pain",
    "grp_osteoporosis", "grp_wellness",
    "rgn_knee", "rgn_hip", "rgn_spine", "rgn_shoulder", "rgn_ankle_foot",
    "rgn_lower_limb", "rgn_upper_limb", "rgn_bilateral", "rgn_trunk",
]

# StaticPool ensures all connections reuse the same in-memory SQLite database
# object — without it each new connection gets a blank DB and sees no tables.
_engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)

# Enable SQLite FK support
@event.listens_for(_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _rec):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


_TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)

# ---------------------------------------------------------------------------
# Import application models so SQLAlchemy Base knows about all tables, then
# create all tables in the in-memory DB.
# ---------------------------------------------------------------------------
import models.clinical  # noqa: F401
import models.wearable  # noqa: F401
from db import Base  # noqa: E402

Base.metadata.create_all(bind=_engine)

# ---------------------------------------------------------------------------
# Seed one patient + session row so the /api/patients endpoint returns 200
# (not 503) when deps._db_ready is True.
# ---------------------------------------------------------------------------
from models.clinical import Patient, Session as ClinicalSession  # noqa: E402


def _seed_db():
    db = _TestingSessionLocal()
    try:
        if db.query(Patient).count() == 0:
            p = Patient(
                id=uuid.uuid4(),
                sn="TEST-001",
                name="Test Patient",
                gender="F",
                age=65,
                age_band="60-69",
                cohort="A",
                primary_indication="OA",
                record_type="full",
                **{col: False for col in _FLAG_COLS},
            )
            db.add(p)
            db.flush()
            s = ClinicalSession(
                id=uuid.uuid4(),
                patient_id=p.id,
                session_number=1,
                usage_frequency="regular",
                is_dropout=False,
            )
            db.add(s)
            db.commit()
    finally:
        db.close()


_seed_db()

# ---------------------------------------------------------------------------
# Patch deps.load_all to a no-op so TestClient lifespan doesn't try to
# connect to PostgreSQL or load ML model files.
# We save the original and restore it immediately after the app import so
# other test modules (e.g. test_fall_risk_api.py) are not affected.
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
# Override FastAPI's get_db dependency to use our in-memory SQLite session.
# ---------------------------------------------------------------------------
import db as _db_module  # noqa: E402
from db import get_db  # noqa: E402


def _override_get_db():
    session = _TestingSessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


app.dependency_overrides[get_db] = _override_get_db


# ---------------------------------------------------------------------------
# Helper: build a TestClient that does NOT raise on 4xx/5xx.
# The context manager below patches load_all for the duration of each
# TestClient lifespan so that no Postgres / ML-model connection is attempted.
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


@pytest.fixture(autouse=True)
def _ensure_api_key():
    """Guarantee QTX_API_KEY is present and get_db is overridden for every
    middleware test.

    tests/test_import_api.py's module-scoped ``client`` fixture calls
    app.dependency_overrides.clear() and os.environ.pop("QTX_API_KEY") in
    teardown, undoing the module-level setup we did at import time.  This
    autouse fixture restores both before each test.
    """
    from db import get_db

    # Re-apply the get_db override in case another module's fixture cleared it.
    app.dependency_overrides[get_db] = _override_get_db

    # Set the env var directly — monkeypatch isn't used here to avoid any
    # interaction with the per-test monkeypatch fixture used inside test fns.
    _orig = os.environ.get("QTX_API_KEY")
    os.environ["QTX_API_KEY"] = _TEST_KEY
    yield
    # Restore previous state.
    if _orig is None:
        os.environ.pop("QTX_API_KEY", None)
    else:
        os.environ["QTX_API_KEY"] = _orig


def test_no_key_returns_401(monkeypatch):
    """GET /api/patients with no key header and no ?key= param returns 401."""
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)
    with _make_client() as c:
        resp = c.get("/api/patients")
    assert resp.status_code == 401
    assert "Invalid or missing API key" in resp.json()["detail"]


def test_wrong_header_key_returns_401(monkeypatch):
    """Wrong X-Api-Key header returns 401."""
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)
    with _make_client() as c:
        resp = c.get("/api/patients", headers={"X-Api-Key": "totally-wrong-key"})
    assert resp.status_code == 401
    assert "Invalid or missing API key" in resp.json()["detail"]


def test_correct_header_key_passes(monkeypatch):
    """Correct X-Api-Key header lets the request reach the router (200 from patients)."""
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)
    deps._db_ready = True
    try:
        with _make_client() as c:
            resp = c.get("/api/patients", headers={"X-Api-Key": _TEST_KEY})
    finally:
        deps._db_ready = False
    assert resp.status_code == 200


def test_correct_query_param_key_passes(monkeypatch):
    """No header but correct ?key= query param returns 200, proving ?key= works for all routes."""
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)
    deps._db_ready = True
    try:
        with _make_client() as c:
            resp = c.get("/api/patients", params={"key": _TEST_KEY})
    finally:
        deps._db_ready = False
    assert resp.status_code == 200


def test_wrong_query_param_returns_401(monkeypatch):
    """No header, wrong ?key= returns 401."""
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)
    with _make_client() as c:
        resp = c.get("/api/patients", params={"key": "bad-key"})
    assert resp.status_code == 401
    assert "Invalid or missing API key" in resp.json()["detail"]


def test_qtx_api_key_not_configured_returns_500(monkeypatch):
    """QTX_API_KEY env var deleted causes 500 with explanatory message."""
    monkeypatch.delenv("QTX_API_KEY", raising=False)
    with _make_client() as c:
        resp = c.get("/api/patients")
    assert resp.status_code == 500
    assert "QTX_API_KEY" in resp.json()["detail"]


def test_header_takes_priority_when_both_present(monkeypatch):
    """Correct X-Api-Key header + wrong ?key= returns 200 (header wins via `or` short-circuit)."""
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)
    deps._db_ready = True
    try:
        with _make_client() as c:
            resp = c.get(
                "/api/patients",
                headers={"X-Api-Key": _TEST_KEY},
                params={"key": "wrong-key-ignored"},
            )
    finally:
        deps._db_ready = False
    assert resp.status_code == 200


def test_webhook_route_bypasses_key_check(monkeypatch):
    """POST /webhooks/terra with valid Terra HMAC and no X-Api-Key returns 200."""
    secret = "test-terra-secret"
    monkeypatch.setenv("TERRA_WEBHOOK_SECRET", secret)
    # QTX_API_KEY is set — middleware MUST NOT check it for /webhooks/ paths.
    monkeypatch.setenv("QTX_API_KEY", _TEST_KEY)

    body = json.dumps({
        "type": "activity",
        "user": {"user_id": "u1", "provider": "APPLE"},
        "data": [{
            "metadata": {"start_time": "2026-01-01T08:00:00Z"},
            "steps_data": {"steps": 500},
        }],
    }).encode()

    ts = str(int(time.time()))
    sig = hmac_lib.new(
        secret.encode(),
        f"{ts}.{body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()

    with _make_client() as c:
        resp = c.post(
            "/webhooks/terra",
            content=body,
            headers={
                "Content-Type": "application/json",
                "terra-signature": f"t={ts},v1={sig}",
                # Deliberately no X-Api-Key — middleware must bypass key check
            },
        )
    assert resp.status_code == 200
    assert resp.json().get("status") == "ok"
