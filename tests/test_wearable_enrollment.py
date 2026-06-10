"""Tests for wearable enrollment and webhook endpoints."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


@pytest.fixture
def test_db(tmp_path):
    from db import Base, get_db
    import models.wearable  # noqa: F401
    engine = create_engine(f"sqlite:///{tmp_path}/test.db")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    return engine, override_get_db


_TEST_API_KEY = "test-qtx-api-key"


@pytest.fixture(autouse=True)
def set_api_key_env():
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    yield
    os.environ.pop("QTX_API_KEY", None)


@pytest.fixture
def client(test_db):
    engine, override_get_db = test_db
    from main import app
    from db import get_db
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


def test_webhook_returns_ok(client, monkeypatch):
    import hashlib
    import hmac as hmac_lib
    import time

    secret = "test_secret_value"
    monkeypatch.setenv("TERRA_WEBHOOK_SECRET", secret)

    body_bytes = json.dumps({
        "type": "activity",
        "user": {"user_id": "u1", "provider": "APPLE"},
        "data": [{
            "metadata": {"start_time": "2026-05-20T08:00:00Z"},
            "steps_data": {"steps": 7000},
        }],
    }).encode()

    ts = str(int(time.time()))
    sig = hmac_lib.new(
        secret.encode(),
        f"{ts}.{body_bytes.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    terra_sig = f"t={ts},v1={sig}"

    resp = client.post(
        "/webhooks/terra",
        content=body_bytes,
        headers={
            "Content-Type": "application/json",
            "terra-signature": terra_sig,
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_webhook_rejects_when_secret_unset(client, monkeypatch):
    """Endpoint must return 500 (misconfiguration) when TERRA_WEBHOOK_SECRET is not set."""
    monkeypatch.delenv("TERRA_WEBHOOK_SECRET", raising=False)
    resp = client.post(
        "/webhooks/terra",
        content=b'{"type":"activity","user":{"user_id":"u1","provider":"APPLE"},"data":[]}',
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 500
    assert "TERRA_WEBHOOK_SECRET" in resp.json()["detail"]


def test_webhook_rejects_malformed_json(client, monkeypatch):
    import hashlib
    import hmac as hmac_lib
    import time

    secret = "test_secret_value"
    monkeypatch.setenv("TERRA_WEBHOOK_SECRET", secret)

    body_bytes = b'not valid json{'
    ts = str(int(time.time()))
    sig = hmac_lib.new(
        secret.encode(),
        f"{ts}.{body_bytes.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    terra_sig = f"t={ts},v1={sig}"

    resp = client.post(
        "/webhooks/terra",
        content=body_bytes,
        headers={"Content-Type": "application/json", "terra-signature": terra_sig},
    )
    assert resp.status_code == 400


def test_webhook_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setenv("TERRA_WEBHOOK_SECRET", "real_secret")
    resp = client.post(
        "/webhooks/terra",
        content=b'{"type":"activity","user":{"user_id":"u1","provider":"APPLE"},"data":[]}',
        headers={
            "Content-Type": "application/json",
            "terra-signature": "t=123,v1=badsig",
        },
    )
    assert resp.status_code == 401


def test_enroll_returns_widget_url(client, monkeypatch):
    monkeypatch.setenv("TERRA_DEV_ID", "test_dev")
    monkeypatch.setenv("TERRA_API_KEY", "test_key")
    mock_response = {"url": "https://widget.tryterra.co/session/abc123", "expires_in": 900}
    with patch("services.terra.create_widget_session", return_value=mock_response):
        resp = client.post("/api/wearable/enroll", json={
            "patient_id": "P001",
            "enrolled_by": "clinician_01",
            "device_brand": "apple_health",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert data["widget_url"] == "https://widget.tryterra.co/session/abc123"
    assert data["patient_id"] == "P001"


def test_confirm_enrollment_creates_record(client, test_db):
    engine, _ = test_db
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=engine)

    resp = client.post("/api/wearable/confirm-enrollment", json={
        "patient_id": "P002",
        "terra_user_id": "terra_u2",
        "device_brand": "garmin",
        "enrolled_by": "clinician_01",
    })
    assert resp.status_code == 200

    db = Session()
    from models.wearable import WearableEnrollment
    row = db.query(WearableEnrollment).filter_by(patient_id="P002").first()
    assert row is not None
    assert row.terra_user_id == "terra_u2"
    assert row.active is True
    db.close()


def test_withdraw_enrollment(client, test_db):
    engine, _ = test_db
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=engine)

    client.post("/api/wearable/confirm-enrollment", json={
        "patient_id": "P003",
        "terra_user_id": "terra_u3",
        "device_brand": "fitbit",
        "enrolled_by": "clinician_01",
    })

    with patch("services.terra.deactivate_user"):
        resp = client.delete("/api/wearable/enroll/P003")
    assert resp.status_code == 200

    db = Session()
    from models.wearable import WearableEnrollment
    row = db.query(WearableEnrollment).filter_by(patient_id="P003").first()
    assert row.active is False
    assert row.consent_withdrawn_at is not None
    db.close()


# ---------------------------------------------------------------------------
# GET /api/wearable/summary
# ---------------------------------------------------------------------------

def test_wearable_summary_returns_enrolled_count(client):
    """Summary endpoint returns 200 with an enrolled_count key."""
    resp = client.get("/api/wearable/summary")
    assert resp.status_code == 200
    data = resp.json()
    assert "enrolled_count" in data


def test_wearable_summary_enrolled_count_is_integer(client):
    """enrolled_count must be an integer (not null, not a string)."""
    # Seed one active enrollment so the count is non-trivially interesting.
    client.post("/api/wearable/confirm-enrollment", json={
        "patient_id": "P_SUM1",
        "terra_user_id": "terra_sum1",
        "device_brand": "apple_health",
        "enrolled_by": "clinician_01",
    })
    resp = client.get("/api/wearable/summary")
    assert resp.status_code == 200
    enrolled_count = resp.json()["enrolled_count"]
    assert isinstance(enrolled_count, int)
    assert enrolled_count >= 1


# ---------------------------------------------------------------------------
# DELETE /api/wearable/enroll/{patient_id}
# ---------------------------------------------------------------------------

def test_wearable_delete_enrollment_404_when_not_enrolled(client):
    """Deleting enrollment for a patient with no active enrollment returns 404."""
    resp = client.delete("/api/wearable/enroll/NONEXISTENT_PATIENT_999",
                         headers={"X-Api-Key": _TEST_API_KEY})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/wearable/{patient_id}/features
# ---------------------------------------------------------------------------

def test_wearable_features_inactive_enrollment_shape(client, test_db):
    """Features endpoint returns enrolled=false when the stored enrollment is inactive."""
    engine, _ = test_db
    from sqlalchemy.orm import sessionmaker
    import uuid
    from datetime import datetime, timezone
    Session = sessionmaker(bind=engine)

    # Insert an enrollment that is already inactive (consent withdrawn).
    db = Session()
    from models.wearable import WearableEnrollment
    now = datetime.now(timezone.utc)
    inactive = WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id="P_INACTIVE1",
        terra_user_id="terra_inactive1",
        device_brand="garmin",
        enrolled_at=now,
        enrolled_by="clinician_01",
        consent_given_at=now,
        consent_withdrawn_at=now,
        active=False,
    )
    db.add(inactive)
    db.commit()
    db.close()

    resp = client.get("/api/wearable/P_INACTIVE1/features")
    assert resp.status_code == 200
    data = resp.json()
    assert "enrolled" in data
    assert data["enrolled"] is False
