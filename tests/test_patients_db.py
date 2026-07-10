"""Tests for patient list/detail API endpoints backed by a real DB session.

Uses SQLite in-memory + FastAPI dependency override — no DATABASE_URL required.
"""
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

import models.clinical   # noqa: F401
import models.wearable   # noqa: F401

_TEST_API_KEY = "test-key"

# All boolean flag column names on Patient that must be non-None in responses
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
    # Use a named shared-cache in-memory DB so all connections within the process
    # share the same data (plain ":memory:" creates an isolated DB per connection).
    eng = create_engine(
        "sqlite:///file:qtx_test_patients?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


def _zero_flags() -> dict:
    return {col: False for col in _FLAG_COLS}


def _seed_db(engine) -> None:
    """Insert 3 test patients and their sessions into the test DB."""
    from models.clinical import Patient, Session as ClinicalSession

    Session = sessionmaker(bind=engine)
    db = Session()

    patients_data = [
        {"id": uuid.uuid4(), "sn": "101", "name": "Patient One", "gender": "F", "age": 65,
         "age_band": "60-69", "cohort": "Neurological", "record_type": "Active",
         **_zero_flags(), "grp_neurological": True, "has_neurological": True},
        {"id": uuid.uuid4(), "sn": "102", "name": "Patient Two", "gender": "M", "age": 72,
         "age_band": "70-79", "cohort": "Pain & Musculoskeletal", "record_type": "Active",
         **_zero_flags(), "grp_joint_disease": True, "has_oa": True},
        {"id": uuid.uuid4(), "sn": "103", "name": "Patient Three", "gender": "F", "age": 45,
         "age_band": "<50", "cohort": "Wellness", "record_type": "Legacy",
         **_zero_flags(), "grp_wellness": True, "has_wellness_only": True},
    ]

    for pd_data in patients_data:
        p = Patient(**pd_data)
        db.add(p)
    db.flush()

    sessions_data = [
        {"patient_id": patients_data[0]["id"], "session_number": 1, "has_followup": True,
         "is_dropout": False, "usage_frequency": "Once (1x/week, one leg)",
         "pre_tug_s": 25.0, "post_tug_s": 20.0},
        {"patient_id": patients_data[1]["id"], "session_number": 1, "has_followup": True,
         "is_dropout": False, "usage_frequency": "Twice (2x/week, one leg per session)",
         "pre_vas": 5.0, "post_vas": 2.0},
        {"patient_id": patients_data[2]["id"], "session_number": 1, "has_followup": False,
         "is_dropout": True},
    ]

    for s_data in sessions_data:
        s = ClinicalSession(id=uuid.uuid4(), **s_data)
        db.add(s)

    db.commit()
    db.close()


@pytest.fixture(scope="module", autouse=True)
def seeded_engine(test_engine):
    _seed_db(test_engine)
    return test_engine


@pytest.fixture
def client(test_engine):
    from db import get_db
    from main import app

    os.environ["QTX_API_KEY"] = _TEST_API_KEY

    Session = sessionmaker(bind=test_engine)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}, raise_server_exceptions=True) as c:
        # Set _db_ready AFTER lifespan completes — lifespan sets it False (no DATABASE_URL
        # in test env). The dependency override supplies the real seeded test DB session.
        import deps
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)


def test_list_all_patients(client):
    """GET /api/patients returns a paginated envelope wrapping all 3 patients."""
    resp = client.get("/api/patients")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) == {"items", "total", "limit", "offset"}
    assert len(data["items"]) == 3
    assert data["total"] == 3
    assert data["limit"] == 500
    assert data["offset"] == 0


def test_list_patients_required_keys(client):
    """Every patient dict inside items contains the expected top-level keys."""
    resp = client.get("/api/patients")
    assert resp.status_code == 200
    p = resp.json()["items"][0]
    for key in ["sn", "name", "gender", "age", "cohort", "record_type",
                "is_dropout", "has_followup", "usage_frequency"] + _FLAG_COLS:
        assert key in p, f"Missing key: {key}"


def test_list_patients_pagination_slices_and_reports_total(client):
    """limit/offset actually slice the result set while total stays the full count."""
    first = client.get("/api/patients", params={"limit": 2, "offset": 0})
    assert first.status_code == 200
    fd = first.json()
    assert fd["total"] == 3
    assert fd["limit"] == 2 and fd["offset"] == 0
    assert len(fd["items"]) == 2

    second = client.get("/api/patients", params={"limit": 2, "offset": 2})
    assert second.status_code == 200
    sd = second.json()
    assert sd["total"] == 3
    assert sd["offset"] == 2
    assert len(sd["items"]) == 1

    # No overlap between the two pages — every patient seen exactly once.
    sns = {p["sn"] for p in fd["items"]} | {p["sn"] for p in sd["items"]}
    assert sns == {"101", "102", "103"}


def test_filter_by_cohort(client):
    """?cohort=Neurological returns only Patient One."""
    resp = client.get("/api/patients", params={"cohort": "Neurological"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert len(data["items"]) == 1
    assert data["items"][0]["sn"] == "101"


def test_filter_by_gender(client):
    """?gender=M returns only Patient Two."""
    resp = client.get("/api/patients", params={"gender": "M"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["items"]) == 1
    assert data["items"][0]["sn"] == "102"


def test_filter_fu_only(client):
    """?fu_only=true excludes Patient Three (is_dropout=True)."""
    resp = client.get("/api/patients", params={"fu_only": "true"})
    assert resp.status_code == 200
    data = resp.json()
    sns = {p["sn"] for p in data["items"]}
    assert "103" not in sns
    assert len(data["items"]) == 2
    assert data["total"] == 2


def test_filter_by_age_band(client):
    """?age_band=<50 returns only Patient Three."""
    resp = client.get("/api/patients", params={"age_band": "<50"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["items"]) == 1
    assert data["items"][0]["sn"] == "103"


def test_get_patient_by_sn(client):
    """GET /api/patient/101 returns Patient One."""
    resp = client.get("/api/patient/101")
    assert resp.status_code == 200
    data = resp.json()
    assert data["sn"] == "101"
    assert data["name"] == "Patient One"
    assert data["cohort"] == "Neurological"


def test_get_patient_not_found(client):
    """GET /api/patient/999 returns 404."""
    resp = client.get("/api/patient/999")
    assert resp.status_code == 404


def test_patients_503_when_db_not_ready(client):
    """GET /api/patients returns 503 when _db_ready is False."""
    import deps
    deps._db_ready = False
    try:
        resp = client.get("/api/patients")
        assert resp.status_code == 503
    finally:
        deps._db_ready = True
