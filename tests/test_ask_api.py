"""Tests for POST /api/patient/{sn}/ask and GET /api/patient/{sn}/insights."""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-ask"
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
_PATIENT_SN = "A001"
_PATIENT_ID = uuid.uuid4()


@pytest.fixture(scope="module")
def test_engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_ask?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


def _seed(engine) -> None:
    from models.clinical import Patient, Session as ClinicalSession
    Sess = sessionmaker(bind=engine)
    db = Sess()
    flags = {col: False for col in _FLAG_COLS}
    flags["has_knee_issue"] = True
    flags["grp_joint_disease"] = True
    p = Patient(
        id=_PATIENT_ID, sn=_PATIENT_SN, name="Ask Test Patient",
        gender="F", age=68, age_band="60-69",
        cohort="Pain & Musculoskeletal", record_type="Active",
        **flags,
    )
    db.add(p)
    db.flush()
    s1 = ClinicalSession(
        id=uuid.uuid4(), patient_id=_PATIENT_ID, session_number=1,
        has_followup=True, is_dropout=False,
        post_tug_s=14.0, post_vas=6.0,
    )
    db.add(s1)
    db.commit()
    db.close()


@pytest.fixture(scope="module", autouse=True)
def seeded(test_engine):
    _seed(test_engine)
    return test_engine


@pytest.fixture
def client(test_engine):
    from db import get_db
    from main import app
    import deps

    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    # Ensure no Anthropic key — all calls run in stub mode
    os.environ.pop("ANTHROPIC_API_KEY", None)

    Sess = sessionmaker(bind=test_engine)

    def override_get_db():
        db = Sess()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}, raise_server_exceptions=True) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)


# ── POST /api/patient/{sn}/ask ────────────────────────────────────────────────

def test_ask_returns_200(client):
    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask",
                       json={"question": "How is this patient progressing?"})
    assert resp.status_code == 200


def test_ask_response_has_answer_and_model(client):
    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask",
                       json={"question": "Is pain improving?"})
    data = resp.json()
    assert "answer" in data
    assert "model" in data
    assert isinstance(data["answer"], str)
    assert len(data["answer"]) > 0


def test_ask_stub_mode_returns_stub_text(client):
    """Without ANTHROPIC_API_KEY, answer contains the stub placeholder."""
    from services.insight import InsightService
    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask",
                       json={"question": "Stub test question"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["answer"] == InsightService.STUB_RESPONSE


def test_ask_unknown_sn_returns_404(client):
    resp = client.post("/api/patient/UNKNOWN_99/ask",
                       json={"question": "Is this patient improving?"})
    assert resp.status_code == 404


def test_ask_503_when_db_not_ready(client):
    import deps
    deps._db_ready = False
    try:
        resp = client.post(f"/api/patient/{_PATIENT_SN}/ask",
                           json={"question": "test"})
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


# ── GET /api/patient/{sn}/insights ───────────────────────────────────────────

def test_get_insights_returns_200(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/insights")
    assert resp.status_code == 200


def test_get_insights_returns_list(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/insights")
    data = resp.json()
    assert isinstance(data, list)


def test_get_insights_rows_have_expected_fields(client):
    # trigger at least one insight via POST /session in stub mode
    client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 12.0})
    resp = client.get(f"/api/patient/{_PATIENT_SN}/insights")
    rows = resp.json()
    assert len(rows) >= 1
    row = rows[0]
    for field in ("id", "session_number", "insight_type", "question", "content", "model", "created_at"):
        assert field in row, f"Missing field: {field}"


def test_get_insights_ordered_newest_first(client):
    """Multiple insight rows are returned newest-first."""
    client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 11.0})
    client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 10.0})
    resp = client.get(f"/api/patient/{_PATIENT_SN}/insights")
    rows = resp.json()
    dates = [r["created_at"] for r in rows]
    assert dates == sorted(dates, reverse=True)


def test_get_insights_unknown_sn_returns_404(client):
    resp = client.get("/api/patient/UNKNOWN_99/insights")
    assert resp.status_code == 404


def test_get_insights_503_when_db_not_ready(client):
    import deps
    deps._db_ready = False
    try:
        resp = client.get(f"/api/patient/{_PATIENT_SN}/insights")
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


# ── Retrieval-augmented ask tests ────────────────────────────────────────────

def test_ask_response_shape_unchanged_with_retrieval(client, monkeypatch):
    """API response shape is unchanged when _retrieve_relevant returns results."""
    from services.insight import InsightService
    from unittest.mock import MagicMock
    from datetime import datetime

    fake_insight = MagicMock()
    fake_insight.insight_type = "session_summary"
    fake_insight.created_at = datetime(2026, 1, 1)
    fake_insight.content = "Patient showed improvement"

    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [fake_insight])
    monkeypatch.setattr(InsightService, "_call_claude", lambda self, msg: "Test answer from retrieval")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={"question": "test?"})
    assert resp.status_code == 200
    data = resp.json()
    assert "answer" in data
    assert "model" in data


def test_stub_mode_returns_200_regardless_of_retrieval(client):
    """Stub mode (no ANTHROPIC_API_KEY) returns 200 even when retrieval would otherwise run."""
    # client fixture already removes ANTHROPIC_API_KEY — this confirms 200 in all cases
    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={"question": "stub retrieval test"})
    assert resp.status_code == 200
    data = resp.json()
    assert "answer" in data


def test_ask_missing_question_field_returns_422(client):
    """POST /ask with a missing 'question' field returns 422 Unprocessable Entity."""
    resp = client.post(f"/api/patient/{_PATIENT_SN}/ask", json={})
    assert resp.status_code == 422


def test_ask_returns_502_when_claude_api_fails(client, monkeypatch):
    """When Claude is configured but the API call raises, /ask returns 502."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "real-key")
    from services.insight import InsightService

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(InsightService, "_call_claude", raise_exc)
    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [])

    resp = client.post(
        f"/api/patient/{_PATIENT_SN}/ask",
        json={"question": "will this 502?"},
    )
    assert resp.status_code == 502
