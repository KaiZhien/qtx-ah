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


@pytest.fixture
def client(test_db):
    engine, override_get_db = test_db
    from main import app
    from db import get_db
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_webhook_returns_ok(client):
    payload = {
        "type": "activity",
        "user": {"user_id": "u1", "provider": "APPLE"},
        "data": [{
            "metadata": {"start_time": "2026-05-20T08:00:00Z"},
            "steps_data": {"steps": 7000},
        }],
    }
    resp = client.post(
        "/webhooks/terra",
        content=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


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
