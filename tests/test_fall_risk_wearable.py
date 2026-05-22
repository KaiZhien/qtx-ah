"""Tests for wearable-augmented fall risk prediction."""
from __future__ import annotations

import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

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
    yield Session()


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
