"""Tests for POST /api/patient/{sn}/session and GET /api/patient/{sn}/timeline."""
from __future__ import annotations

import contextlib
import os
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# Stub weasyprint before any app imports (needed for mock-pattern tests)
if "weasyprint" not in sys.modules:
    _wp = types.ModuleType("weasyprint")
    class _HTML:
        def __init__(self, s): pass
        def write_pdf(self): return b"%PDF"
    _wp.HTML = _HTML
    sys.modules["weasyprint"] = _wp

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_TEST_API_KEY = "test-key-sessions"
_MOCK_KEY = "mock-test-key-sessions"

# Module-level setup for mock-pattern tests (benchmark/patients style)
os.environ.setdefault("QTX_API_KEY", _TEST_API_KEY)
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "s")

import deps as _deps  # noqa: E402
_orig_load_all = _deps.load_all
_deps.load_all = lambda: None
from main import app as _app  # noqa: E402
_deps.load_all = _orig_load_all

from db import get_db as _get_db  # noqa: E402


@contextlib.contextmanager
def _mock_client():
    """Context manager yielding a TestClient backed by mock DB (no seeded SQLite)."""
    _deps.load_all = lambda: None
    try:
        with TestClient(_app, raise_server_exceptions=False) as c:
            yield c
    finally:
        _deps.load_all = _orig_load_all


@pytest.fixture(autouse=True)
def _restore_api_key_sessions():
    """Ensure QTX_API_KEY is present for every test in this module."""
    prev = os.environ.get("QTX_API_KEY")
    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    yield
    if prev is None:
        os.environ.pop("QTX_API_KEY", None)
    else:
        os.environ["QTX_API_KEY"] = prev


def _make_mock_patient():
    """Return a minimal MagicMock patient compatible with the sessions router."""
    from models.clinical import Patient
    p = MagicMock(spec=Patient)
    p.id = uuid.uuid4()
    p.sn = "M001"
    p.name = "Mock Patient"
    p.age = 70
    p.age_band = "70-79"
    p.gender = "M"
    p.cohort = "QTX-A"
    p.primary_indication = None
    p.baseline_sppb = None
    p.pre_tandem_s = None
    p.has_frailty = False
    p.has_diabetes = False
    p.has_neurological = False
    p.has_stroke = False
    p.has_parkinsons = False
    return p


def _db_patient_found(patient):
    """Mock db: filter_by(sn=...).first() → patient; all other queries return empty."""
    db = MagicMock()

    def _query(model):
        q = MagicMock()
        q.filter_by.return_value.first.return_value = patient
        q.filter_by.return_value.order_by.return_value.all.return_value = []
        q.filter_by.return_value.order_by.return_value.first.return_value = None
        q.filter.return_value.scalar.return_value = 0  # max session_number → 0
        q.filter.return_value.first.return_value = None
        q.scalar.return_value = 1
        return q

    db.query.side_effect = _query
    db.add = MagicMock()
    db.flush = MagicMock()
    db.commit = MagicMock()
    return db


def _db_patient_not_found():
    """Mock db: all patient lookups return None."""
    db = MagicMock()
    q = MagicMock()
    q.filter_by.return_value.first.return_value = None
    q.filter_by.return_value.order_by.return_value.all.return_value = []
    q.filter.return_value.scalar.return_value = None
    db.query.return_value = q
    return db
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
_PATIENT_SN = "S001"
_PATIENT_ID = uuid.uuid4()


@pytest.fixture(scope="module")
def test_engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_sessions?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


def _seed(engine) -> None:
    from models.clinical import Patient, Session as ClinicalSession
    Sess = sessionmaker(bind=engine)
    db = Sess()
    flags = {col: False for col in _FLAG_COLS}
    flags["has_knee_issue"] = True
    flags["grp_joint_disease"] = True
    p = Patient(
        id=_PATIENT_ID, sn=_PATIENT_SN, name="Session Test Patient",
        gender="F", age=65, age_band="60-69",
        cohort="Pain & Musculoskeletal", record_type="Active",
        **flags,
    )
    db.add(p)
    db.flush()
    s1 = ClinicalSession(
        id=uuid.uuid4(), patient_id=_PATIENT_ID, session_number=1,
        has_followup=True, is_dropout=False,
        post_tug_s=14.0, post_vas=6.0, post_normal_gs_ms=0.9, post_sppb=7,
    )
    db.add(s1)
    db.commit()
    db.close()


@pytest.fixture(scope="module", autouse=True)
def seeded(test_engine):
    _seed(test_engine)
    return test_engine


@pytest.fixture
def client(test_engine):
    from db import get_db
    from main import app
    import deps

    os.environ["QTX_API_KEY"] = _TEST_API_KEY
    Sess = sessionmaker(bind=test_engine)

    def override_get_db():
        db = Sess()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, headers={"X-Api-Key": _TEST_API_KEY}, raise_server_exceptions=False) as c:
        deps._db_ready = True
        yield c

    app.dependency_overrides.clear()
    os.environ.pop("QTX_API_KEY", None)


# ── POST /api/patient/{sn}/session ────────────────────────────────────────────

def test_create_session_returns_201(client):
    """Creating a second session returns HTTP 201."""
    resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={
        "post_tug_s": 11.5, "post_vas": 3.0,
        "notes": "Patient reported improvement.",
    })
    assert resp.status_code == 201


def test_create_session_increments_session_number(client):
    """session_number is auto-assigned as max + 1."""
    # Patient already has sessions 1 and 2 from previous test
    resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 10.0})
    assert resp.status_code == 201
    data = resp.json()
    assert data["session_number"] >= 1


def test_create_session_returns_trends(client):
    """Response includes trends list with direction and magnitude."""
    resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 9.0})
    assert resp.status_code == 201
    data = resp.json()
    assert "trends" in data
    tug = next((t for t in data["trends"] if t["metric"] == "post_tug_s"), None)
    assert tug is not None
    assert tug["direction"] in ("improving", "early_signal")  # depends on session accumulation
    assert tug["magnitude"] < 0  # lower is better, value decreased


def test_create_session_unknown_sn_returns_404(client):
    resp = client.post("/api/patient/UNKNOWN_SN_99/session", json={"post_tug_s": 10.0})
    assert resp.status_code == 404


def test_session_timeline_dict_omits_patient_name(client):
    """The timeline dict handed to InsightService (embedded into Claude prompts)
    must NOT contain the patient 'name' key — only 'sn' identifies the patient."""
    from services.insight import InsightService

    captured: dict = {}

    def _capture(self, timeline, patient_id, session_number, predictions=None):
        captured["timeline"] = timeline
        return "captured"

    with patch.object(InsightService, "generate_session_insight", _capture):
        resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={"post_tug_s": 8.5})

    assert resp.status_code == 201
    assert "timeline" in captured, "InsightService.generate_session_insight was not called"
    patient_payload = captured["timeline"]["patient"]
    assert "name" not in patient_payload, f"Patient name leaked into prompt payload: {patient_payload}"
    assert patient_payload["sn"] == _PATIENT_SN


def test_create_session_503_when_db_not_ready(client):
    import deps
    deps._db_ready = False
    try:
        resp = client.post(f"/api/patient/{_PATIENT_SN}/session", json={})
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


# ── GET /api/patient/{sn}/timeline ────────────────────────────────────────────

def test_timeline_returns_200(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    assert resp.status_code == 200


def test_timeline_has_expected_shape(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    data = resp.json()
    assert "patient" in data
    assert "sessions" in data
    assert "trends" in data


def test_timeline_sessions_ordered(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    sessions = resp.json()["sessions"]
    numbers = [s["session_number"] for s in sessions]
    assert numbers == sorted(numbers)


def test_timeline_notes_stored(client):
    """Notes from session 2 are visible in the timeline."""
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    sessions = resp.json()["sessions"]
    sess2 = next(s for s in sessions if s["session_number"] == 2)
    assert sess2["notes"] == "Patient reported improvement."


def test_timeline_patient_fields(client):
    resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
    patient = resp.json()["patient"]
    assert patient["sn"] == _PATIENT_SN
    assert patient["name"] == "Session Test Patient"
    assert patient["cohort"] == "Pain & Musculoskeletal"


def test_timeline_unknown_sn_returns_404(client):
    resp = client.get("/api/patient/UNKNOWN_SN_99/timeline")
    assert resp.status_code == 404


def test_timeline_503_when_db_not_ready(client):
    import deps
    deps._db_ready = False
    try:
        resp = client.get(f"/api/patient/{_PATIENT_SN}/timeline")
        assert resp.status_code == 503
    finally:
        deps._db_ready = True


# ── Mock-pattern tests (no seeded DB — follow benchmark/patients style) ───────

_MOCK_HEADERS = {"X-Api-Key": _TEST_API_KEY}


# POST /api/patient/{sn}/session — auth / 503 / 404 / 201 via mock DB

def test_create_session_requires_api_key():
    """POST without X-Api-Key header → 401."""
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            r = c.post("/api/patient/M001/session", json={"post_tug_s": 10.0})
    assert r.status_code == 401


def test_create_session_503_when_db_not_ready_mock():
    """POST when DB not ready → 503 (mock-DB variant)."""
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", False):
            r = c.post(
                "/api/patient/M001/session",
                json={},
                headers=_MOCK_HEADERS,
            )
    assert r.status_code == 503


def test_create_session_404_for_unknown_patient():
    """POST for a patient not in DB → 404 (mock DB returns None)."""
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_patient_not_found()
            try:
                r = c.post(
                    "/api/patient/GHOST/session",
                    json={"post_tug_s": 10.0},
                    headers=_MOCK_HEADERS,
                )
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 404


def test_create_session_201_on_valid_payload():
    """POST with valid payload and a found patient → 201."""
    patient = _make_mock_patient()
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_patient_found(patient)
            try:
                r = c.post(
                    "/api/patient/M001/session",
                    json={"post_tug_s": 9.5, "post_vas": 3.0},
                    headers=_MOCK_HEADERS,
                )
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 201


# GET /api/patient/{sn}/timeline — 404 / 200 shape / sessions is list via mock DB

def test_get_timeline_404_for_unknown_patient():
    """GET timeline for unknown patient → 404 (mock DB patient lookup is None)."""
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_patient_not_found()
            try:
                r = c.get("/api/patient/GHOST/timeline", headers=_MOCK_HEADERS)
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 404


def test_get_timeline_200_returns_shape():
    """GET timeline for a found patient → 200 with keys patient, sessions, trends."""
    patient = _make_mock_patient()
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_patient_found(patient)
            try:
                r = c.get("/api/patient/M001/timeline", headers=_MOCK_HEADERS)
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 200
    data = r.json()
    assert "patient" in data
    assert "sessions" in data
    assert "trends" in data


def test_get_timeline_sessions_is_array():
    """GET timeline response['sessions'] is a list."""
    patient = _make_mock_patient()
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_patient_found(patient)
            try:
                r = c.get("/api/patient/M001/timeline", headers=_MOCK_HEADERS)
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 200
    assert isinstance(r.json()["sessions"], list)


# GET /api/patient/{sn}/predictions/latest — empty and populated

def _db_predictions(patient, prediction_row=None):
    """Mock db for predictions endpoint: patient found, optional prediction row."""
    from models.clinical import Patient, SessionPrediction

    db = MagicMock()

    def _query(model):
        q = MagicMock()
        if model is Patient:
            q.filter_by.return_value.first.return_value = patient
        elif model is SessionPrediction:
            q.filter_by.return_value.order_by.return_value.first.return_value = prediction_row
        else:
            q.filter_by.return_value.first.return_value = None
        return q

    db.query.side_effect = _query
    return db


def _make_mock_prediction(patient_id):
    """Return a minimal MagicMock SessionPrediction row."""
    from datetime import datetime, timezone
    row = MagicMock()
    row.predicted_composite_improvement = 12.5
    row.responder_probability = 0.78
    row.dropout_probability = 0.12
    row.dosage_recommendation = "3x/week"
    row.predicted_at = datetime(2024, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
    row.shap_top5 = [{"feature": "post_tug_s", "value": -0.3}]
    row.bias_correction = 0.05
    return row


def test_get_predictions_200_empty_when_no_predictions():
    """GET predictions/latest with no stored prediction → 200 and empty object."""
    patient = _make_mock_patient()
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_predictions(patient, None)
            try:
                r = c.get("/api/patient/M001/predictions/latest", headers=_MOCK_HEADERS)
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 200
    assert r.json() == {}


def test_get_predictions_200_with_fields_when_exist():
    """GET predictions/latest with a stored prediction → 200 and response has expected keys."""
    patient = _make_mock_patient()
    pred = _make_mock_prediction(patient.id)
    with _mock_client() as c:
        with patch.object(_deps, "_db_ready", True):
            _app.dependency_overrides[_get_db] = lambda: _db_predictions(patient, pred)
            try:
                r = c.get("/api/patient/M001/predictions/latest", headers=_MOCK_HEADERS)
            finally:
                _app.dependency_overrides.pop(_get_db, None)
    assert r.status_code == 200
    data = r.json()
    assert len(data) >= 1
    assert "responder_probability" in data
    assert "predicted_composite_improvement" in data
