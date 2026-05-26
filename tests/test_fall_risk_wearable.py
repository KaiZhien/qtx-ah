"""Tests for wearable-augmented fall risk prediction."""
from __future__ import annotations

import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


@pytest.fixture
def db_with_enrolled_patient(tmp_path):
    from db import Base
    from models.wearable import (
        WearableActivity, WearableBody, WearableEnrollment, WearableEvent,
    )
    import models.wearable  # noqa: F401

    engine = create_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id="P_FR_TEST",
        terra_user_id="terra_fr",
        device_brand="apple_health",
        enrolled_at=datetime.now(timezone.utc),
        enrolled_by="clinician_01",
        consent_given_at=datetime.now(timezone.utc),
        active=True,
    ))

    today = date(2026, 5, 22)
    for i in range(30):
        d = today - timedelta(days=i)
        db.add(WearableActivity(
            terra_user_id="terra_fr",
            date=d,
            steps=2500,          # low — should increase risk
            active_minutes=20,
            sedentary_minutes=750,  # ~97% sedentary — should increase risk
            wear_minutes=960,
        ))

    for i in range(7):
        d = today - timedelta(days=i)
        db.add(WearableBody(terra_user_id="terra_fr", date=d, hrv_rmssd=20.0))  # low HRV

    db.add(WearableEvent(
        id=str(uuid.uuid4()),
        terra_user_id="terra_fr",
        occurred_at=datetime(2026, 4, 10, 12, 0, tzinfo=timezone.utc),
        event_type="fall_detected",
        payload_json={},
    ))

    db.commit()
    db.close()
    session = Session()
    try:
        yield session
    finally:
        session.close()


def test_get_patient_features_enrolled(db_with_enrolled_patient):
    from services.wearable_features import get_patient_features
    db = db_with_enrolled_patient
    result = get_patient_features("P_FR_TEST", db)
    assert result["enrolled"] is True
    assert result["source"] == "clinic_and_wearable"
    assert result["wearable_steps_30d_avg"] == pytest.approx(2500.0)
    assert result["wearable_fall_events_90d"] == 1
    assert result["wearable_compliance_rate_30d"] == pytest.approx(1.0)
    assert result["wearable_hrv_trend_7d"] == pytest.approx(20.0)


def test_get_patient_features_unenrolled(db_with_enrolled_patient):
    from services.wearable_features import get_patient_features
    db = db_with_enrolled_patient
    result = get_patient_features("UNKNOWN_PATIENT", db)
    assert result["enrolled"] is False
    assert result["source"] == "clinic_only"


from unittest.mock import patch


_BASE_REQUEST = {
    "age": 72,
    "gender": "F",
    "falls_history": 0,
    "walking_aid": "none",
    "exercise_frequency": "1-2",
    "has_oa": 0,
    "has_diabetes": 0,
    "has_stroke": 0,
    "has_parkinsons": 0,
    "has_hypertension": 0,
    "has_frailty": 0,
    "polypharmacy": 0,
}


@pytest.fixture
def test_db_override(tmp_path):
    from db import Base, get_db
    import models.wearable  # noqa: F401
    import models.clinical  # noqa: F401  — registers patients/sessions tables in Base.metadata
    engine = create_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    return Session, override


@pytest.fixture
def app_client(test_db_override):
    from fastapi.testclient import TestClient
    from main import app
    from db import get_db
    _, override = test_db_override
    app.dependency_overrides[get_db] = override
    os.environ.setdefault("QTX_API_KEY", "test-qtx-api-key")
    with TestClient(app, headers={"X-Api-Key": os.environ["QTX_API_KEY"]}) as c:
        yield c
    app.dependency_overrides.clear()


def test_prediction_without_patient_id_uses_clinic_only(app_client):
    """No patient_id — prediction runs as before, source is clinic_only."""
    resp = app_client.post("/api/predict/fall-risk", json=_BASE_REQUEST)
    assert resp.status_code == 200
    data = resp.json()
    assert "risk_score" in data
    assert data["source"] == "clinic_only"


def test_prediction_with_unenrolled_patient_id(app_client):
    """patient_id provided but patient not enrolled — falls back to clinic_only."""
    req = {**_BASE_REQUEST, "patient_id": "UNENROLLED_PATIENT"}
    resp = app_client.post("/api/predict/fall-risk", json=req)
    assert resp.status_code == 200
    data = resp.json()
    assert data["source"] == "clinic_only"


def test_prediction_with_wearable_data_raises_score(app_client, test_db_override):
    """Enrolled patient with high-risk wearable signals gets higher score than clinic-only."""
    Session, _ = test_db_override
    from models.wearable import WearableActivity, WearableBody, WearableEnrollment, WearableEvent

    db = Session()
    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id="P_HIGH_RISK",
        terra_user_id="terra_high",
        device_brand="apple_health",
        enrolled_at=datetime.now(timezone.utc),
        enrolled_by="clinician_01",
        consent_given_at=datetime.now(timezone.utc),
        active=True,
    ))

    today = date.today()
    for i in range(30):
        d = today - timedelta(days=i)
        db.add(WearableActivity(
            terra_user_id="terra_high",
            date=d,
            steps=1500,
            active_minutes=10,
            sedentary_minutes=800,
            wear_minutes=900,
        ))

    db.add(WearableEvent(
        id=str(uuid.uuid4()),
        terra_user_id="terra_high",
        occurred_at=datetime.now(timezone.utc) - timedelta(days=10),
        event_type="fall_detected",
        payload_json={},
    ))
    db.commit()
    db.close()

    # Clinic-only baseline
    baseline_resp = app_client.post("/api/predict/fall-risk", json=_BASE_REQUEST)
    baseline_score = baseline_resp.json()["risk_score"]

    # With wearable data
    wearable_resp = app_client.post("/api/predict/fall-risk", json={**_BASE_REQUEST, "patient_id": "P_HIGH_RISK"})
    assert wearable_resp.status_code == 200
    wearable_data = wearable_resp.json()
    assert wearable_data["source"] == "clinic_and_wearable"
    assert wearable_data["risk_score"] > baseline_score


def test_prediction_wearable_factors_appear_in_top_factors(app_client, test_db_override):
    """Wearable fall events appear in top_factors when patient is enrolled."""
    Session, _ = test_db_override
    from models.wearable import WearableActivity, WearableEnrollment, WearableEvent

    db = Session()
    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id="P_FACTORS",
        terra_user_id="terra_factors",
        device_brand="garmin",
        enrolled_at=datetime.now(timezone.utc),
        enrolled_by="clinician_01",
        consent_given_at=datetime.now(timezone.utc),
        active=True,
    ))

    today = date.today()
    for i in range(30):
        d = today - timedelta(days=i)
        db.add(WearableActivity(terra_user_id="terra_factors", date=d, steps=4000, wear_minutes=600))

    db.add(WearableEvent(
        id=str(uuid.uuid4()),
        terra_user_id="terra_factors",
        occurred_at=datetime.now(timezone.utc) - timedelta(days=5),
        event_type="fall_detected",
        payload_json={},
    ))
    db.commit()
    db.close()

    resp = app_client.post("/api/predict/fall-risk", json={**_BASE_REQUEST, "patient_id": "P_FACTORS"})
    assert resp.status_code == 200
    factors = resp.json()["top_factors"]
    factor_labels = [f["label"] for f in factors]
    assert any("fall" in label.lower() or "wearable" in label.lower() for label in factor_labels)


def test_low_compliance_wearable_data_does_not_dominate(app_client, test_db_override):
    """Wearable data with <30% compliance is ignored in score adjustment."""
    Session, _ = test_db_override
    from models.wearable import WearableActivity, WearableEnrollment

    db = Session()
    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id="P_LOW_COMPLY",
        terra_user_id="terra_low",
        device_brand="fitbit",
        enrolled_at=datetime.now(timezone.utc),
        enrolled_by="clinician_01",
        consent_given_at=datetime.now(timezone.utc),
        active=True,
    ))

    today = date.today()
    # Only 5 days of data out of 30 — 17% compliance
    for i in range(5):
        d = today - timedelta(days=i)
        db.add(WearableActivity(
            terra_user_id="terra_low", date=d, steps=500, wear_minutes=120,
        ))
    db.commit()
    db.close()

    baseline_resp = app_client.post("/api/predict/fall-risk", json=_BASE_REQUEST)
    wearable_resp = app_client.post("/api/predict/fall-risk", json={**_BASE_REQUEST, "patient_id": "P_LOW_COMPLY"})

    assert wearable_resp.status_code == 200
    assert wearable_resp.json()["risk_score"] == baseline_resp.json()["risk_score"]
