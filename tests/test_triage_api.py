"""API endpoint tests for GET /api/triage (clinician triage rollup).

Fixtures mirror tests/test_anomaly_api.py: a module-scoped in-memory sqlite
engine (unique db name) + a per-test session that is ROLLED BACK on teardown.
Tests therefore use db.flush() (never db.commit()) so each test is fully
isolated — essential for an aggregate endpoint that counts ALL patients.
The endpoint reads the same overridden session, so flushed rows are visible.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-triage"
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
        "sqlite:///file:qtx_test_triage?mode=memory&cache=shared&uri=true",
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


# ── Insert helpers (flush only — never commit) ────────────────────────────────

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


def _make_session(db, patient_id, session_number, *, session_date=None,
                  composite_improvement=None):
    from models.clinical import Session
    s = Session(
        id=uuid.uuid4(),
        patient_id=patient_id,
        session_number=session_number,
        session_date=session_date,
        composite_improvement=composite_improvement,
    )
    db.add(s)
    db.flush()
    return s


def _make_trend(db, patient_id, metric, direction, sessions_used, magnitude=None):
    from models.clinical import PatientTrend
    t = PatientTrend(
        id=uuid.uuid4(),
        patient_id=patient_id,
        metric=metric,
        direction=direction,
        sessions_used=sessions_used,
        magnitude=magnitude,
    )
    db.add(t)
    db.flush()
    return t


def _make_anomaly(db, patient_id, session_number, *, content="Test warning",
                  model="stub", created_at=None):
    from models.clinical import PatientInsight
    row = PatientInsight(
        id=uuid.uuid4(),
        patient_id=patient_id,
        session_number=session_number,
        insight_type="anomaly_warning",
        content=content,
        model=model,
        created_at=created_at or datetime.now(timezone.utc),
        embedding=None,
        question=None,
    )
    db.add(row)
    db.flush()
    return row


def _make_prediction(db, session_id, patient_id, predicted, *, predicted_at=None):
    from models.clinical import SessionPrediction
    row = SessionPrediction(
        id=uuid.uuid4(),
        session_id=session_id,
        patient_id=patient_id,
        predicted_composite_improvement=predicted,
        predicted_at=predicted_at or datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row


def _get(client, **kwargs):
    return client.get("/api/triage", headers={"X-Api-Key": _TEST_API_KEY}, **kwargs)


def _item_by_sn(data, sn):
    for it in data["items"]:
        if it["sn"] == sn:
            return it
    return None


# ── Case 1: anomaly on latest session appears ─────────────────────────────────

def test_anomaly_on_latest_session_appears(client, db):
    p = _make_patient(db, "T001")
    _make_session(db, p.id, 1)
    _make_session(db, p.id, 2, session_date=date(2026, 7, 1))
    _make_anomaly(db, p.id, session_number=2, content="Anomaly on latest")

    resp = _get(client)
    assert resp.status_code == 200
    data = resp.json()
    item = _item_by_sn(data, "T001")
    assert item is not None
    anomaly = item["signals"]["anomaly"]
    assert anomaly is not None
    assert anomaly["session_number"] == 2
    assert anomaly["content"] == "Anomaly on latest"
    assert "created_at" in anomaly
    assert item["last_session_number"] == 2
    assert item["last_session_date"] == "2026-07-01"


# ── Case 2: anomaly on older session ages out ─────────────────────────────────

def test_anomaly_on_older_session_ages_out(client, db):
    p = _make_patient(db, "T002")
    _make_session(db, p.id, 1)
    _make_session(db, p.id, 2, session_date=date(2026, 7, 1))  # newer, clean
    _make_anomaly(db, p.id, session_number=1, content="Stale warning")

    resp = _get(client)
    assert resp.status_code == 200
    data = resp.json()
    # anomaly aged out and it was the only signal → patient omitted
    assert _item_by_sn(data, "T002") is None


# ── Case 3: api_error anomaly rows are ignored ────────────────────────────────

def test_api_error_anomaly_ignored(client, db):
    # Patient whose ONLY anomaly on the latest session is an api_error row → omitted.
    p_err = _make_patient(db, "T003a")
    _make_session(db, p_err.id, 1)
    _make_anomaly(db, p_err.id, session_number=1, model="api_error",
                  content="should be ignored")

    # Patient with a valid stub anomaly (older created_at) plus a LATER api_error
    # row on the same latest session → the valid one still surfaces.
    p_ok = _make_patient(db, "T003b")
    _make_session(db, p_ok.id, 1)
    base = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
    _make_anomaly(db, p_ok.id, session_number=1, model="stub",
                  content="real warning", created_at=base)
    _make_anomaly(db, p_ok.id, session_number=1, model="api_error",
                  content="error row", created_at=base + timedelta(hours=1))

    resp = _get(client)
    data = resp.json()
    assert _item_by_sn(data, "T003a") is None
    ok = _item_by_sn(data, "T003b")
    assert ok is not None
    assert ok["signals"]["anomaly"]["content"] == "real warning"


# ── Case 4: declining trends; improving/stable ignored; None magnitude → null ─

def test_declining_trends_populate_and_filter(client, db):
    p = _make_patient(db, "T004")
    _make_session(db, p.id, 1, session_date=date(2026, 6, 1))
    _make_trend(db, p.id, "post_tug_s", "declining", sessions_used=4, magnitude=1.2)
    _make_trend(db, p.id, "post_5xsst_s", "declining", sessions_used=3, magnitude=None)
    _make_trend(db, p.id, "post_vas", "improving", sessions_used=4, magnitude=-2.0)
    _make_trend(db, p.id, "post_sppb", "stable", sessions_used=4, magnitude=0.0)

    resp = _get(client)
    item = _item_by_sn(resp.json(), "T004")
    assert item is not None
    trends = item["signals"]["declining_trends"]
    by_metric = {t["metric"]: t for t in trends}
    # only declining metrics present
    assert set(by_metric) == {"post_tug_s", "post_5xsst_s"}
    assert by_metric["post_tug_s"]["magnitude"] == 1.2
    assert by_metric["post_tug_s"]["sessions_used"] == 4
    assert by_metric["post_5xsst_s"]["magnitude"] is None
    assert by_metric["post_5xsst_s"]["sessions_used"] == 3


# ── Case 5: divergence threshold behaviour + env override ──────────────────────

def test_divergence_below_threshold_no_signal(client, db):
    p = _make_patient(db, "T050")
    s = _make_session(db, p.id, 1, session_date=date(2026, 6, 1),
                      composite_improvement=0.20)
    _make_prediction(db, s.id, p.id, predicted=0.10)  # delta 0.10 < 0.15
    data = _get(client).json()
    assert _item_by_sn(data, "T050") is None


def test_divergence_at_threshold_fires(client, db):
    p = _make_patient(db, "T051")
    s = _make_session(db, p.id, 1, session_date=date(2026, 6, 1),
                      composite_improvement=0.25)
    _make_prediction(db, s.id, p.id, predicted=0.10)  # delta exactly 0.15
    item = _item_by_sn(_get(client).json(), "T051")
    assert item is not None
    div = item["signals"]["divergence"]
    assert div is not None
    assert div["session_number"] == 1
    assert div["predicted"] == 0.10
    assert div["actual"] == 0.25
    assert div["delta"] == 0.15


def test_divergence_above_threshold_fires_and_uses_latest_prediction(client, db):
    p = _make_patient(db, "T052")
    s = _make_session(db, p.id, 1, session_date=date(2026, 6, 1),
                      composite_improvement=-0.10)
    base = datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc)
    # older prediction would NOT diverge; the latest one (0.30) does.
    _make_prediction(db, s.id, p.id, predicted=-0.05, predicted_at=base)
    _make_prediction(db, s.id, p.id, predicted=0.30,
                     predicted_at=base + timedelta(hours=2))
    item = _item_by_sn(_get(client).json(), "T052")
    assert item is not None
    div = item["signals"]["divergence"]
    assert div is not None
    assert div["predicted"] == 0.30
    assert div["actual"] == -0.10
    assert div["delta"] == 0.40  # abs(-0.10 - 0.30)


def test_divergence_missing_prediction_no_signal(client, db):
    p = _make_patient(db, "T053")
    _make_session(db, p.id, 1, session_date=date(2026, 6, 1),
                  composite_improvement=0.90)  # large but no prediction row
    data = _get(client).json()
    assert _item_by_sn(data, "T053") is None


def test_divergence_env_override_respected(client, db, monkeypatch):
    # Threshold raised to 0.25. A delta of 0.20 (would fire at default 0.15)
    # must NOT fire; a delta of 0.25 must fire.
    monkeypatch.setenv("QTX_TRIAGE_DIVERGENCE_THRESHOLD", "0.25")

    p_lo = _make_patient(db, "T054a")
    s_lo = _make_session(db, p_lo.id, 1, session_date=date(2026, 6, 1),
                         composite_improvement=0.30)
    _make_prediction(db, s_lo.id, p_lo.id, predicted=0.10)  # delta 0.20 < 0.25

    p_hi = _make_patient(db, "T054b")
    s_hi = _make_session(db, p_hi.id, 1, session_date=date(2026, 6, 1),
                         composite_improvement=0.35)
    _make_prediction(db, s_hi.id, p_hi.id, predicted=0.10)  # delta 0.25 == thr

    data = _get(client).json()
    assert _item_by_sn(data, "T054a") is None
    hi = _item_by_sn(data, "T054b")
    assert hi is not None
    assert hi["signals"]["divergence"]["delta"] == 0.25


# ── Case 6: multi-signal patient; zero-signal omitted; total == len(items) ─────

def test_multi_signal_and_total(client, db):
    multi = _make_patient(db, "T060")
    s = _make_session(db, multi.id, 3, session_date=date(2026, 7, 1),
                      composite_improvement=0.40)
    _make_anomaly(db, multi.id, session_number=3, content="multi warning")
    _make_trend(db, multi.id, "post_tug_s", "declining", sessions_used=4, magnitude=2.0)
    _make_prediction(db, s.id, multi.id, predicted=0.10)  # delta 0.30 fires

    zero = _make_patient(db, "T061")
    sz = _make_session(db, zero.id, 2, session_date=date(2026, 7, 1),
                       composite_improvement=0.20)
    _make_trend(db, zero.id, "post_vas", "improving", sessions_used=4, magnitude=-1.0)
    _make_prediction(db, sz.id, zero.id, predicted=0.19)  # delta 0.01 < 0.15

    data = _get(client).json()
    m = _item_by_sn(data, "T060")
    assert m is not None
    assert m["signals"]["anomaly"] is not None
    assert m["signals"]["anomaly"]["session_number"] == 3
    assert len(m["signals"]["declining_trends"]) == 1
    assert m["signals"]["divergence"] is not None
    # zero-signal patient omitted
    assert _item_by_sn(data, "T061") is None
    # total is len(items)
    assert data["total"] == len(data["items"])


# ── Case 7: sort order ────────────────────────────────────────────────────────

def test_sort_order(client, db):
    # S001: anomaly only (count 1), date 2026-01-01
    a = _make_patient(db, "S001")
    _make_session(db, a.id, 1, session_date=date(2026, 1, 1))
    _make_anomaly(db, a.id, session_number=1)

    # S002: anomaly + declining (count 2), date 2026-01-01
    b = _make_patient(db, "S002")
    _make_session(db, b.id, 1, session_date=date(2026, 1, 1))
    _make_anomaly(db, b.id, session_number=1)
    _make_trend(db, b.id, "post_tug_s", "declining", sessions_used=4, magnitude=1.0)

    # S003: no anomaly, declining + divergence (count 2), date 2026-06-01
    c = _make_patient(db, "S003")
    sc = _make_session(db, c.id, 1, session_date=date(2026, 6, 1),
                       composite_improvement=0.40)
    _make_trend(db, c.id, "post_tug_s", "declining", sessions_used=4, magnitude=1.0)
    _make_prediction(db, sc.id, c.id, predicted=0.10)  # delta 0.30

    # S004: declining only (count 1), date 2026-06-10
    d = _make_patient(db, "S004")
    _make_session(db, d.id, 1, session_date=date(2026, 6, 10))
    _make_trend(db, d.id, "post_tug_s", "declining", sessions_used=4, magnitude=1.0)

    # S005: declining only (count 1), date 2026-06-10 (ties S004 → sn breaks)
    e = _make_patient(db, "S005")
    _make_session(db, e.id, 1, session_date=date(2026, 6, 10))
    _make_trend(db, e.id, "post_tug_s", "declining", sessions_used=4, magnitude=1.0)

    # S006: declining only (count 1), date None → nulls last
    f = _make_patient(db, "S006")
    _make_session(db, f.id, 1, session_date=None)
    _make_trend(db, f.id, "post_tug_s", "declining", sessions_used=4, magnitude=1.0)

    data = _get(client).json()
    order = [it["sn"] for it in data["items"]]
    assert order == ["S002", "S001", "S003", "S004", "S005", "S006"]


# ── Case 8: empty DB, db-not-ready, missing api key ──────────────────────────

def test_empty_db_returns_empty_envelope(client, db):
    resp = _get(client)
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []
    assert "generated_at" in data


def test_db_not_ready_returns_503(client, db):
    import deps
    deps._db_ready = False
    try:
        resp = _get(client)
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


def test_missing_api_key_returns_401(client, db):
    resp = client.get("/api/triage")
    assert resp.status_code == 401
