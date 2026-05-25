"""Tests for the fall risk prediction endpoint."""
from __future__ import annotations

import sys
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

MINIMAL_PATIENT = {
    "age": 68,
    "gender": "F",
    "falls_history": 1,
    "walking_aid": "none",
    "exercise_frequency": "1-2",
    "has_oa": 1,
    "has_diabetes": 0,
    "has_stroke": 0,
    "has_parkinsons": 0,
    "has_hypertension": 0,
    "has_frailty": 0,
    "polypharmacy": 0,
}

FULL_PATIENT = {
    **MINIMAL_PATIENT,
    "pre_tug_s": 14.5,
    "pre_5xsst_s": 18.0,
    "pre_normal_gs_ms": 0.72,
    "baseline_sppb": 7,
    "pre_vas": 4.0,
}


@pytest.fixture(scope="module")
def client():
    import models.clinical  # noqa: F401
    import models.wearable  # noqa: F401
    from db import Base, get_db
    from main import app
    import deps

    eng = create_engine(
        "sqlite:///file:qtx_test_fall_risk?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    os.environ.setdefault("QTX_API_KEY", "test-qtx-api-key")

    with TestClient(app, headers={"X-Api-Key": os.environ["QTX_API_KEY"]}) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    deps._db_ready = False


def test_fall_risk_patient_only(client):
    resp = client.post("/api/predict/fall-risk", json=MINIMAL_PATIENT)
    assert resp.status_code == 200
    body = resp.json()
    assert 0 <= body["risk_score"] <= 100
    assert body["risk_label"] in {"low", "moderate", "elevated", "high"}
    assert body["confidence"] == "standard"
    assert isinstance(body["top_factors"], list)
    assert len(body["top_factors"]) >= 1
    assert "cohort_stat" in body


def test_fall_risk_with_clinician_data(client):
    resp = client.post("/api/predict/fall-risk", json=FULL_PATIENT)
    assert resp.status_code == 200
    body = resp.json()
    assert 0 <= body["risk_score"] <= 100
    assert body["confidence"] == "high"


def test_fall_risk_score_higher_with_prior_falls(client):
    no_fall = {**MINIMAL_PATIENT, "falls_history": 0}
    two_falls = {**MINIMAL_PATIENT, "falls_history": 2}
    r1 = client.post("/api/predict/fall-risk", json=no_fall).json()
    r2 = client.post("/api/predict/fall-risk", json=two_falls).json()
    assert r2["risk_score"] > r1["risk_score"]


def test_fall_risk_invalid_age(client):
    bad = {**MINIMAL_PATIENT, "age": -5}
    resp = client.post("/api/predict/fall-risk", json=bad)
    assert resp.status_code == 422
