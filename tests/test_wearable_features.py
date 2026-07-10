"""Tests for wearable features endpoint.

wearable_enrollments.patient_id is a UUID (FK to patients.id); the features
service accepts UUIDs or UUID strings and treats unparseable ids as
"not enrolled" (clinic_only).
"""
from __future__ import annotations

import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

_PATIENT_UUID = uuid.uuid4()


@pytest.fixture
def populated_db(tmp_path):
    from db import Base
    from models.wearable import (
        WearableActivity, WearableBody, WearableEnrollment, WearableEvent,
    )
    import models.clinical  # noqa: F401 — patients table (FK target)
    import models.wearable  # noqa: F401

    engine = create_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id=_PATIENT_UUID,
        terra_user_id="terra_feat",
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
            terra_user_id="terra_feat",
            date=d,
            steps=8000,
            active_minutes=45,
            sedentary_minutes=600,
            walking_cadence_avg=96.0,
            wear_minutes=960,
        ))

    for i in range(7):
        d = today - timedelta(days=i)
        db.add(WearableBody(
            terra_user_id="terra_feat",
            date=d,
            hrv_rmssd=40.0 + i,
        ))

    db.add(WearableEvent(
        id=str(uuid.uuid4()),
        terra_user_id="terra_feat",
        occurred_at=datetime.now(timezone.utc) - timedelta(days=30),
        event_type="fall_detected",
        payload_json={},
    ))

    db.commit()
    db.close()

    def override_get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    return override_get_db


_TEST_API_KEY = "test-qtx-api-key"


@pytest.fixture(autouse=True)
def set_api_key_env():
    import os
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    yield
    os.environ.pop("QTX_API_KEY", None)


@pytest.fixture
def client_with_data(populated_db):
    from main import app
    from db import get_db
    app.dependency_overrides[get_db] = populated_db
    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}) as c:
        yield c
    app.dependency_overrides.clear()


def test_features_enrolled_patient(client_with_data):
    resp = client_with_data.get(f"/api/wearable/{_PATIENT_UUID}/features")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enrolled"] is True
    assert data["wearable_steps_30d_avg"] == pytest.approx(8000.0)
    assert 0.0 < data["wearable_sedentary_pct_30d"] < 100.0
    assert data["wearable_fall_events_90d"] == 1
    assert data["wearable_compliance_rate_30d"] == pytest.approx(1.0)
    assert data["source"] == "clinic_and_wearable"


def test_features_unenrolled_patient(client_with_data):
    resp = client_with_data.get(f"/api/wearable/{uuid.uuid4()}/features")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enrolled"] is False
    assert data["source"] == "clinic_only"


def test_features_non_uuid_patient_id_is_clinic_only(client_with_data):
    """A junk (non-UUID) id can never match an enrollment — clinic_only, not 500."""
    resp = client_with_data.get("/api/wearable/UNKNOWN_PATIENT/features")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enrolled"] is False
    assert data["source"] == "clinic_only"


def test_features_service_accepts_uuid_object_and_string(populated_db):
    """get_patient_features accepts both uuid.UUID and its string form."""
    from services.wearable_features import get_patient_features
    gen = populated_db()
    db = next(gen)
    try:
        by_uuid = get_patient_features(_PATIENT_UUID, db)
        by_str = get_patient_features(str(_PATIENT_UUID), db)
    finally:
        db.close()
    assert by_uuid["enrolled"] is True
    assert by_str["enrolled"] is True
    assert by_uuid == by_str


def test_sedentary_pct_with_sparse_data(tmp_path):
    """sedentary_pct must pair active and sedentary from the same row, not by position."""
    from db import Base
    from models.wearable import WearableActivity, WearableEnrollment
    import models.clinical  # noqa: F401
    import models.wearable  # noqa: F401
    from services.wearable_features import get_patient_features

    engine = create_engine(f"sqlite:///{tmp_path}/sparse.db")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    sparse_pid = uuid.uuid4()
    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id=sparse_pid,
        terra_user_id="terra_sparse",
        device_brand="garmin",
        enrolled_at=datetime.now(timezone.utc),
        enrolled_by="cli",
        consent_given_at=datetime.now(timezone.utc),
        active=True,
    ))

    today = date.today()
    # 3 rows with BOTH fields populated
    for i in range(3):
        db.add(WearableActivity(
            terra_user_id="terra_sparse",
            date=today - timedelta(days=i),
            steps=5000,
            active_minutes=60,
            sedentary_minutes=600,
            wear_minutes=960,
        ))
    # 2 rows with only active_minutes (sedentary_minutes=None)
    for i in range(3, 5):
        db.add(WearableActivity(
            terra_user_id="terra_sparse",
            date=today - timedelta(days=i),
            steps=5000,
            active_minutes=45,
            sedentary_minutes=None,
            wear_minutes=960,
        ))
    db.commit()

    features = get_patient_features(sparse_pid, db)
    db.close()

    # Only the 3 rows where BOTH fields are present should count
    # 600 / (60 + 600) * 100 = 90.909...%
    assert features["wearable_sedentary_pct_30d"] == pytest.approx(
        600 / (60 + 600) * 100, abs=0.1
    )
