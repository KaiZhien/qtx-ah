"""Tests for Terra webhook ingestion."""
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

@pytest.fixture
def db_engine(tmp_path):
    from api.db import Base
    import api.models.wearable  # noqa: F401 — registers ORM models with Base
    engine = create_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    return engine

@pytest.fixture
def db(db_engine):
    Session = sessionmaker(bind=db_engine)
    session = Session()
    yield session
    session.close()

def test_tables_created(db_engine):
    with db_engine.connect() as conn:
        tables = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table'")
        ).scalars().all()
    assert "wearable_enrollments" in tables
    assert "wearable_activity" in tables
    assert "wearable_body" in tables
    assert "wearable_sleep" in tables
    assert "wearable_events" in tables


import hashlib
import hmac as hmac_lib
import json
import time
from datetime import date as date_type

def _make_terra_signature(body: bytes, secret: str) -> str:
    ts = str(int(time.time()))
    sig = hmac_lib.new(
        secret.encode(),
        f"{ts}.{body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"t={ts},v1={sig}"


def test_verify_signature_valid():
    from api.services.terra import verify_signature
    body = b'{"type":"activity"}'
    secret = "test_secret"
    header = _make_terra_signature(body, secret)
    assert verify_signature(body, header, secret) is True


def test_verify_signature_invalid():
    from api.services.terra import verify_signature
    body = b'{"type":"activity"}'
    assert verify_signature(body, "t=123,v1=badhash", "test_secret") is False


def test_ingest_activity_payload(db):
    from api.services.terra import ingest_payload
    from api.models.wearable import WearableActivity

    payload = {
        "type": "activity",
        "user": {"user_id": "user_abc", "provider": "APPLE"},
        "data": [{
            "metadata": {"start_time": "2026-05-20T08:00:00Z"},
            "steps_data": {"steps": 9500},
            "active_durations_data": {
                "activity_seconds": 3600,
                "rest_seconds": 14400,
            },
            "movement_data": {"cadence_avg": 98.5},
            "distance_data": {"distance_meters": 7200.0},
            "device_data": {"num_on_wrist_seconds": 57600},
        }],
    }
    ingest_payload(payload, db)

    row = db.get(WearableActivity, ("user_abc", date_type(2026, 5, 20)))
    assert row is not None
    assert row.steps == 9500
    assert row.active_minutes == 60
    assert row.sedentary_minutes == 240
    assert row.walking_cadence_avg == 98.5
    assert row.distance_m == 7200.0
    assert row.wear_minutes == 960
    assert row.source_device == "APPLE"


def test_ingest_body_payload(db):
    from api.services.terra import ingest_payload
    from api.models.wearable import WearableBody

    payload = {
        "type": "body",
        "user": {"user_id": "user_abc", "provider": "GARMIN"},
        "data": [{
            "metadata": {"start_time": "2026-05-20T00:00:00Z"},
            "heart_data": {
                "heart_rate_data": {
                    "summary": {"resting_hr_bpm": 62, "avg_hr_bpm": 74}
                },
                "hrv": {"summary": {"rmssd_ms": 44.2}},
            },
            "oxygen_data": {"avg_saturation_percentage": 98.1},
        }],
    }
    ingest_payload(payload, db)

    row = db.get(WearableBody, ("user_abc", date_type(2026, 5, 20)))
    assert row is not None
    assert row.hr_resting == 62
    assert row.hrv_rmssd == 44.2
    assert row.spo2_avg == 98.1


def test_ingest_sleep_payload(db):
    from api.services.terra import ingest_payload
    from api.models.wearable import WearableSleep

    payload = {
        "type": "sleep",
        "user": {"user_id": "user_abc", "provider": "FITBIT"},
        "data": [{
            "metadata": {"start_time": "2026-05-19T22:00:00Z"},
            "sleep_durations_data": {
                "asleep": {"duration_asleep_state_seconds": 25200},
                "sleep_efficiency": 0.88,
                "stages": {
                    "deep_sleep_duration_seconds": 5400,
                    "rem_sleep_duration_seconds": 7200,
                    "awake_duration_seconds": 1800,
                },
            },
        }],
    }
    ingest_payload(payload, db)

    row = db.get(WearableSleep, ("user_abc", date_type(2026, 5, 19)))
    assert row is not None
    assert row.total_minutes == 420
    assert row.efficiency_pct == pytest.approx(88.0, abs=0.1)
    assert row.deep_minutes == 90
    assert row.rem_minutes == 120


def test_ingest_event_payload(db):
    from api.services.terra import ingest_payload
    from api.models.wearable import WearableEvent

    payload = {
        "type": "event",
        "user": {"user_id": "user_abc", "provider": "APPLE"},
        "data": [{
            "type": "fall_detected",
            "timestamp": "2026-05-20T14:32:00Z",
            "metadata": {"severity": "low"},
        }],
    }
    ingest_payload(payload, db)

    events = db.query(WearableEvent).filter_by(terra_user_id="user_abc").all()
    assert len(events) == 1
    assert events[0].event_type == "fall_detected"


def test_ingest_idempotent(db):
    """Re-ingesting the same activity day does not create a duplicate row."""
    from api.services.terra import ingest_payload
    from api.models.wearable import WearableActivity

    payload = {
        "type": "activity",
        "user": {"user_id": "user_xyz", "provider": "APPLE"},
        "data": [{"metadata": {"start_time": "2026-05-21T08:00:00Z"}, "steps_data": {"steps": 5000}}],
    }
    ingest_payload(payload, db)
    ingest_payload(payload, db)  # second time — must not duplicate

    rows = db.query(WearableActivity).filter_by(terra_user_id="user_xyz").all()
    assert len(rows) == 1
