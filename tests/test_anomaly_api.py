"""API endpoint tests for GET /api/patient/{sn}/anomalies/latest."""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-anomaly"
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
        "sqlite:///file:qtx_test_anomaly?mode=memory&cache=shared&uri=true",
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
    """Yield a fresh DB session per test, rolling back between tests."""
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
            pass  # managed by fixture

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, raise_server_exceptions=True) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)


def _make_patient(db, sn: str):
    from models.clinical import Patient
    flags = {col: False for col in _FLAG_COLS}
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="F", age=65,
        age_band="60-69", record_type="Active",
        **flags,
    )
    db.add(p)
    db.flush()
    return p


def _make_anomaly_row(db, patient_id: uuid.UUID, session_number: int, content: str = "Test warning"):
    from models.clinical import PatientInsight
    row = PatientInsight(
        id=uuid.uuid4(),
        patient_id=patient_id,
        session_number=session_number,
        insight_type="anomaly_warning",
        content=content,
        model="stub",
        created_at=datetime.now(timezone.utc),
        embedding=None,
        question=None,
    )
    db.add(row)
    db.flush()
    return row


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_anomaly_latest_returns_null_when_no_rows(client, db):
    """Patient exists, no anomaly_warning rows → response is null (JSON)."""
    _make_patient(db, "B001")
    db.commit()

    resp = client.get("/api/patient/B001/anomalies/latest",
                      headers={"X-Api-Key": _TEST_API_KEY})
    assert resp.status_code == 200
    assert resp.json() is None


def test_anomaly_latest_returns_most_recent(client, db):
    """Two rows with session_number=1 and session_number=2 → response has session_number=2."""
    patient = _make_patient(db, "B002")
    _make_anomaly_row(db, patient.id, session_number=1, content="Warning session 1")
    _make_anomaly_row(db, patient.id, session_number=2, content="Warning session 2")
    db.commit()

    resp = client.get("/api/patient/B002/anomalies/latest",
                      headers={"X-Api-Key": _TEST_API_KEY})
    assert resp.status_code == 200
    data = resp.json()
    assert data is not None
    assert data["session_number"] == 2
    assert data["content"] == "Warning session 2"


def test_anomaly_latest_unknown_sn_returns_404(client, db):
    """Unknown SN → 404."""
    resp = client.get("/api/patient/UNKNOWN_SN_999/anomalies/latest",
                      headers={"X-Api-Key": _TEST_API_KEY})
    assert resp.status_code == 404


def test_anomaly_requires_api_key(client, db):
    """No X-Api-Key header → 401."""
    _make_patient(db, "B003")
    db.commit()

    resp = client.get("/api/patient/B003/anomalies/latest")
    assert resp.status_code == 401


# ── Wearable anomaly flags integration test ──────────────────────────────────

def test_wearable_anomaly_flags_fire_via_session_post(client, db):
    """POSTing a session with wearable features that cross thresholds causes
    `high_sedentary_risk` and `fall_event_recorded` flags to fire, resulting
    in an anomaly_warning row readable from GET /api/patient/{sn}/anomalies/latest.

    _get_wearable_features is patched so the router receives controlled values
    without needing a real Terra / DB wearable table.
    """
    from unittest.mock import patch

    sn = "W001"
    _make_patient(db, sn)
    db.commit()

    # Values that cross rule thresholds:
    #   sedentary_pct_30d=85 > _SEDENTARY_RISK_THRESHOLD (80) → high_sedentary_risk
    #   fall_events_90d=2    > 0                              → fall_event_recorded
    #   compliance_rate_30d=0.80 (healthy, won't mask HRV)
    wearable_stub = {
        "wearable_sedentary_pct_30d": 85.0,
        "wearable_fall_events_90d": 2,
        "wearable_compliance_rate_30d": 0.80,
        "wearable_cadence_avg_30d": 95.0,
        "wearable_steps_30d_avg": 3500,
        "wearable_hrv_trend_7d": None,
    }

    with patch("routers.sessions._get_wearable_features", return_value=wearable_stub):
        resp = client.post(
            f"/api/patient/{sn}/session",
            json={"post_tug_s": 14.0, "post_vas": 5.0},
            headers={"X-Api-Key": _TEST_API_KEY},
        )

    assert resp.status_code == 201, f"Session POST failed: {resp.text}"

    # The anomaly detection runs synchronously inside the session endpoint.
    # Fetch the latest anomaly warning and confirm it was persisted.
    anomaly_resp = client.get(
        f"/api/patient/{sn}/anomalies/latest",
        headers={"X-Api-Key": _TEST_API_KEY},
    )
    assert anomaly_resp.status_code == 200, f"Anomaly GET failed: {anomaly_resp.text}"

    data = anomaly_resp.json()
    assert data is not None, "Expected an anomaly_warning row but got null"
    assert data.get("content"), "anomaly_warning content must be non-empty"
