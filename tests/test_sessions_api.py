"""Tests for POST /api/patient/{sn}/session and GET /api/patient/{sn}/timeline."""
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

_TEST_API_KEY = "test-key-sessions"
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
_PATIENT_SN = "S001"
_PATIENT_ID = uuid.uuid4()


@pytest.fixture(scope="module")
def test_engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_sessions?mode=memory&cache=shared&uri=true",
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
        id=_PATIENT_ID, sn=_PATIENT_SN, name="Session Test Patient",
        gender="F", age=65, age_band="60-69",
        cohort="Pain & Musculoskeletal", record_type="Active",
        **flags,
    )
    db.add(p)
    db.flush()
    s1 = ClinicalSession(
        id=uuid.uuid4(), patient_id=_PATIENT_ID, session_number=1,
        has_followup=True, is_dropout=False,
        post_tug_s=14.0, post_vas=6.0, post_normal_gs_ms=0.9, post_sppb=7,
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


# ── POST /api/patient/{sn}/session ────────────────────────────────────────────

def test_create_session_returns_201(client):
    """Creating a second session returns HTTP 201."""
    resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={
        "post_tug_s": 11.5, "post_vas": 3.0,
        "notes": "Patient reported improvement.",
    })
    assert resp.status_code == 201


def test_create_session_increments_session_number(client):
    """session_number is auto-assigned as max + 1."""
    # Patient already has sessions 1 and 2 from previous test
    resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 10.0})
    assert resp.status_code == 201
    data = resp.json()
    assert data["session_number"] == 3


def test_create_session_returns_trends(client):
    """Response includes trends list with direction and magnitude."""
    resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 9.0})
    assert resp.status_code == 201
    data = resp.json()
    assert "trends" in data
    tug = next((t for t in data["trends"] if t["metric"] == "post_tug_s"), None)
    assert tug is not None
    assert tug["direction"] in ("improving", "early_signal")  # depends on session accumulation
    assert tug["magnitude"] < 0  # lower is better, value decreased


def test_create_session_unknown_sn_returns_404(client):
    resp = client.post("/api/patient/UNKNOWN_SN_99/session", json={"post_tug_s": 10.0})
    assert resp.status_code == 404


def test_create_session_503_when_db_not_ready(client):
    import deps
    deps._db_ready = False
    try:
        resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={})
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


# ── GET /api/patient/{sn}/timeline ────────────────────────────────────────────

def test_timeline_returns_200(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    assert resp.status_code == 200


def test_timeline_has_expected_shape(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    data = resp.json()
    assert "patient" in data
    assert "sessions" in data
    assert "trends" in data


def test_timeline_sessions_ordered(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    sessions = resp.json()["sessions"]
    numbers = [s["session_number"] for s in sessions]
    assert numbers == sorted(numbers)


def test_timeline_notes_stored(client):
    """Notes from session 2 are visible in the timeline."""
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    sessions = resp.json()["sessions"]
    sess2 = next(s for s in sessions if s["session_number"] == 2)
    assert sess2["notes"] == "Patient reported improvement."


def test_timeline_patient_fields(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    patient = resp.json()["patient"]
    assert patient["sn"] == _PATIENT_SN
    assert patient["name"] == "Session Test Patient"
    assert patient["cohort"] == "Pain & Musculoskeletal"


def test_timeline_unknown_sn_returns_404(client):
    resp = client.get("/api/patient/UNKNOWN_SN_99/timeline")
    assert resp.status_code == 404


def test_timeline_503_when_db_not_ready(client):
    import deps
    deps._db_ready = False
    try:
        resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
        assert resp.status_code == 503
    finally:
        deps._db_ready = True
