"""API endpoint tests for POST /api/patient/{sn}/suggest_plan."""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-plan"
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


@pytest.fixture(scope="module")
def test_engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_plan?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def db(test_engine):
    Session = sessionmaker(bind=test_engine)
    session = Session()
    yield session
    session.rollback()
    session.close()


@pytest.fixture
def client(test_engine, db):
    from db import get_db
    from main import app
    import deps

    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    os.environ.pop("ANTHROPIC_API_KEY", None)

    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, raise_server_exceptions=False) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)


def _make_patient(db, sn: str):
    from models.clinical import Patient
    flags = {col: False for col in _FLAG_COLS}
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="F", age=72,
        age_band="70-79", record_type="Active",
        **flags,
    )
    db.add(p)
    db.flush()
    return p


def test_suggest_plan_returns_200_with_stub(client, db):
    """POST suggest_plan returns 200 with a plan string in stub mode."""
    _make_patient(db, "P001")
    db.commit()
    resp = client.post(
        "/api/patient/P001/suggest_plan",
        json={},
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "plan" in data
    assert isinstance(data["plan"], str) and len(data["plan"]) > 0
    assert "generated_at" in data


def test_suggest_plan_timeline_dict_omits_patient_name(client, db):
    """The timeline dict handed to InsightService.generate_treatment_plan
    (embedded into Claude prompts) must NOT contain the patient 'name' key."""
    from services.insight import InsightService

    _make_patient(db, "P010")
    db.commit()

    captured: dict = {}

    def _capture(self, timeline, patient_id, predictions=None, clinician_focus=None, plan_sessions=4):
        captured["timeline"] = timeline
        return "captured plan"

    with patch.object(InsightService, "generate_treatment_plan", _capture):
        resp = client.post(
            "/api/patient/P010/suggest_plan",
            json={},
            headers={"X-Api-Key": _TEST_API_KEY},
        )

    assert resp.status_code == 200
    assert "timeline" in captured, "InsightService.generate_treatment_plan was not called"
    patient_payload = captured["timeline"]["patient"]
    assert "name" not in patient_payload, f"Patient name leaked into prompt payload: {patient_payload}"
    assert patient_payload["sn"] == "P010"


def test_suggest_plan_404_for_unknown_sn(client, db):
    """Unknown patient SN is 404."""
    resp = client.post(
        "/api/patient/UNKNOWN_SN_XYZ/suggest_plan",
        json={},
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert resp.status_code == 404


def test_suggest_plan_writes_treatment_plan_row(client, db):
    """A treatment_plan row is written to patient_insights after the call."""
    from models.clinical import PatientInsight
    patient = _make_patient(db, "P002")
    db.commit()
    resp = client.post(
        "/api/patient/P002/suggest_plan",
        json={},
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert resp.status_code == 200
    row = (
        db.query(PatientInsight)
        .filter_by(patient_id=patient.id, insight_type="treatment_plan")
        .first()
    )
    assert row is not None
    assert row.content == resp.json()["plan"]


def test_suggest_plan_accepts_plan_sessions_6(client, db):
    """plan_sessions=6 is accepted without error."""
    _make_patient(db, "P003")
    db.commit()
    resp = client.post(
        "/api/patient/P003/suggest_plan",
        json={"plan_sessions": 6},
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json()["plan"], str)


def test_suggest_plan_503_when_db_not_ready(client, db):
    """When deps._db_ready is False, suggest_plan returns 503."""
    import deps
    with patch.object(deps, "_db_ready", False):
        resp = client.post(
            "/api/patient/P001/suggest_plan",
            json={},
            headers={"X-Api-Key": _TEST_API_KEY},
        )
    assert resp.status_code == 503


def test_suggest_plan_accepts_session_focus(client, db):
    """Passing session_focus in the body is accepted and returns 200."""
    _make_patient(db, "P004")
    db.commit()
    resp = client.post(
        "/api/patient/P004/suggest_plan",
        json={"session_focus": "balance"},
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "plan" in data
    assert isinstance(data["plan"], str) and len(data["plan"]) > 0


def test_suggest_plan_accepts_empty_body(client, db):
    """All body fields are optional — empty body {} is valid and returns 200."""
    _make_patient(db, "P005")
    db.commit()
    resp = client.post(
        "/api/patient/P005/suggest_plan",
        json={},
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "plan" in data
    assert isinstance(data["plan"], str) and len(data["plan"]) > 0
