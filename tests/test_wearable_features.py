"""Tests for wearable features endpoint."""
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


@pytest.fixture
def populated_db(tmp_path):
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
        patient_id="P_FEAT",
        terra_user_id="terra_feat",
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
        occurred_at=datetime(2026, 4, 1, 10, 0, tzinfo=timezone.utc),
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


@pytest.fixture
def client_with_data(populated_db):
    from main import app
    from db import get_db
    app.dependency_overrides[get_db] = populated_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_features_enrolled_patient(client_with_data):
    resp = client_with_data.get("/api/wearable/P_FEAT/features")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enrolled"] is True
    assert data["wearable_steps_30d_avg"] == pytest.approx(8000.0)
    assert 0.0 < data["wearable_sedentary_pct_30d"] < 100.0
    assert data["wearable_fall_events_90d"] == 1
    assert data["wearable_compliance_rate_30d"] == pytest.approx(1.0)
    assert data["source"] == "clinic_and_wearable"


def test_features_unenrolled_patient(client_with_data):
    resp = client_with_data.get("/api/wearable/UNKNOWN_PATIENT/features")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enrolled"] is False
    assert data["source"] == "clinic_only"


def test_sedentary_pct_with_sparse_data(tmp_path):
    """sedentary_pct must pair active and sedentary from the same row, not by position."""
    import uuid
    from datetime import date, datetime, timedelta, timezone
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

    from db import Base
    from models.wearable import WearableActivity, WearableEnrollment
    import models.wearable  # noqa: F401
    from services.wearable_features import get_patient_features

    engine = create_engine(f"sqlite:///{tmp_path}/sparse.db")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    db.add(WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id="P_SPARSE",
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

    features = get_patient_features("P_SPARSE", db)
    db.close()

    # Only the 3 rows where BOTH fields are present should count
    # 600 / (60 + 600) * 100 = 90.909...%
    assert features["wearable_sedentary_pct_30d"] == pytest.approx(
        600 / (60 + 600) * 100, abs=0.1
    )
