"""Tests for the in-process rate limiter (services/rate_limit.py)."""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-ratelimit"
_ADMIN_KEY = "test-admin-key-ratelimit"
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
_PATIENT_SN = "RL001"


# ── Unit: SlidingWindowLimiter ────────────────────────────────────────────────

def test_limiter_allows_up_to_limit():
    from services.rate_limit import SlidingWindowLimiter
    lim = SlidingWindowLimiter(window_seconds=60.0)
    for _ in range(5):
        assert lim.acquire("k", 5) is None
    retry = lim.acquire("k", 5)
    assert retry is not None
    assert 0 < retry <= 60.0


def test_limiter_keys_are_independent():
    from services.rate_limit import SlidingWindowLimiter
    lim = SlidingWindowLimiter(window_seconds=60.0)
    assert lim.acquire(("a", "ip1"), 1) is None
    assert lim.acquire(("a", "ip1"), 1) is not None
    assert lim.acquire(("a", "ip2"), 1) is None  # other IP unaffected
    assert lim.acquire(("b", "ip1"), 1) is None  # other route unaffected


def test_limiter_hits_expire():
    import time
    from services.rate_limit import SlidingWindowLimiter
    lim = SlidingWindowLimiter(window_seconds=0.05)
    assert lim.acquire("k", 1) is None
    assert lim.acquire("k", 1) is not None
    time.sleep(0.06)
    assert lim.acquire("k", 1) is None


def test_limit_for_env_overrides(monkeypatch):
    from services.rate_limit import _limit_for
    monkeypatch.delenv("QTX_RATE_LIMIT_ASK", raising=False)
    monkeypatch.delenv("QTX_RATE_LIMIT_DEFAULT", raising=False)
    assert _limit_for("ask", 30) == 30
    monkeypatch.setenv("QTX_RATE_LIMIT_DEFAULT", "12")
    assert _limit_for("ask", 30) == 12
    monkeypatch.setenv("QTX_RATE_LIMIT_ASK", "3")
    assert _limit_for("ask", 30) == 3
    monkeypatch.setenv("QTX_RATE_LIMIT_ASK", "junk")
    assert _limit_for("ask", 30) == 30


# ── Endpoint integration ──────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def test_engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_ratelimit?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(eng)

    from models.clinical import Patient
    Sess = sessionmaker(bind=eng)
    db = Sess()
    flags = {col: False for col in _FLAG_COLS}
    db.add(Patient(
        id=uuid.uuid4(), sn=_PATIENT_SN, name="Rate Limit Patient",
        gender="F", age=70, age_band="70-79", record_type="Active", **flags,
    ))
    db.commit()
    db.close()
    return eng


@pytest.fixture(autouse=True)
def _reset_limits():
    """Keep limiter state from leaking into (or out of) each test."""
    from services.rate_limit import reset_rate_limits
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.fixture
def client(test_engine):
    from db import get_db
    from main import app
    import deps

    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    os.environ["QTX_ADMIN_KEY"] = _ADMIN_KEY
    os.environ.pop("ANTHROPIC_API_KEY", None)  # stub mode — no network

    Sess = sessionmaker(bind=test_engine)

    def override_get_db():
        db = Sess()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}, raise_server_exceptions=False) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)
    os.environ.pop("QTX_ADMIN_KEY", None)


def test_ask_rate_limited_returns_429_with_retry_after(client, monkeypatch):
    monkeypatch.setenv("QTX_RATE_LIMIT_ASK", "2")
    r1 = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={"question": "q1"})
    r2 = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={"question": "q2"})
    r3 = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={"question": "q3"})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 429
    assert "Retry-After" in r3.headers
    assert int(r3.headers["Retry-After"]) >= 1
    assert "Rate limit" in r3.json()["detail"]


def test_session_rate_limited(client, monkeypatch):
    monkeypatch.setenv("QTX_RATE_LIMIT_SESSION", "1")
    r1 = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 10.0})
    r2 = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 9.0})
    assert r1.status_code == 201
    assert r2.status_code == 429


def test_suggest_plan_rate_limited(client, monkeypatch):
    monkeypatch.setenv("QTX_RATE_LIMIT_SUGGEST_PLAN", "1")
    r1 = client.post(f"/api/patient/{_PATIENT_SN}/suggest_plan", json={})
    r2 = client.post(f"/api/patient/{_PATIENT_SN}/suggest_plan", json={})
    assert r1.status_code == 200
    assert r2.status_code == 429


def test_prepare_session_rate_limited(client, monkeypatch):
    monkeypatch.setenv("QTX_RATE_LIMIT_PREPARE_SESSION", "1")
    r1 = client.post(f"/api/patient/{_PATIENT_SN}/prepare_session?force=true")
    r2 = client.post(f"/api/patient/{_PATIENT_SN}/prepare_session?force=true")
    assert r1.status_code == 200
    assert r2.status_code == 429


def test_trigger_retrain_rate_limited(client, monkeypatch):
    monkeypatch.setenv("QTX_RATE_LIMIT_TRIGGER_RETRAIN", "1")
    headers = {"X-Admin-Key": _ADMIN_KEY}
    from unittest.mock import patch as mock_patch
    with mock_patch("routers.admin._run_retrain"):
        r1 = client.post("/api/admin/trigger_retrain", headers=headers)
        r2 = client.post("/api/admin/trigger_retrain", headers=headers)
    assert r1.status_code == 200
    assert r2.status_code == 429


def test_zero_limit_disables(client, monkeypatch):
    monkeypatch.setenv("QTX_RATE_LIMIT_ASK", "0")
    for i in range(3):
        r = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={"question": f"q{i}"})
        assert r.status_code == 200


def test_unlimited_routes_not_affected(client, monkeypatch):
    """Non-expensive routes (e.g. GET insights) carry no limiter."""
    monkeypatch.setenv("QTX_RATE_LIMIT_DEFAULT", "1")
    for _ in range(4):
        r = client.get(f"/api/patient/{_PATIENT_SN}/insights")
        assert r.status_code == 200