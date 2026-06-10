"""HTTP-level tests for GET /patients and GET /patient/{sn}."""
from __future__ import annotations
import os, sys, types, math
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# Stub weasyprint before any app imports
if "weasyprint" not in sys.modules:
    _wp = types.ModuleType("weasyprint")
    class _HTML:
        def __init__(self, s): pass
        def write_pdf(self): return b"%PDF"
    _wp.HTML = _HTML
    sys.modules["weasyprint"] = _wp

_KEY = "patients-test-key"
_HEADERS = {"X-Api-Key": _KEY}
os.environ.setdefault("QTX_API_KEY", _KEY)
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TERRA_WEBHOOK_SECRET", "s")

import deps
_orig_load_all = deps.load_all
deps.load_all = lambda: None
from main import app
deps.load_all = _orig_load_all

import contextlib
import pytest
from fastapi.testclient import TestClient
from db import get_db
from models.clinical import Patient, Session as ClinicalSession


@pytest.fixture(autouse=True)
def _restore_api_key():
    """Ensure QTX_API_KEY is present for each test."""
    prev = os.environ.get("QTX_API_KEY")
    os.environ["QTX_API_KEY"] = _KEY
    yield
    if prev is None:
        os.environ.pop("QTX_API_KEY", None)
    else:
        os.environ["QTX_API_KEY"] = prev


@contextlib.contextmanager
def _client():
    deps.load_all = lambda: None
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        deps.load_all = _orig_load_all


# ---------------------------------------------------------------------------
# DB mock helpers
# ---------------------------------------------------------------------------

def _db_for_list(rows):
    """Mock db that chains .query(...).join(...).filter(...).all() → rows."""
    db = MagicMock()
    q = MagicMock()
    q.join.return_value = q
    q.filter.return_value = q
    q.all.return_value = rows
    db.query.return_value = q
    return db


def _make_patient(sn="P001", age=72, gender="F", cohort="QTX-A"):
    p = MagicMock(spec=Patient)
    p.sn = sn
    p.name = "Test Patient"
    p.age = age
    p.age_band = "70-79"
    p.gender = gender
    p.cohort = cohort
    p.primary_indication = None
    p.record_type = None
    p.phone_number = None
    p.tags = None
    p.id = "uuid-001"
    # Boolean flags: return False for all
    for col in [
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
    ]:
        setattr(p, col, False)
    return p


def _make_session(patient_id="uuid-001", pre_vas=None):
    s = MagicMock(spec=ClinicalSession)
    s.patient_id = patient_id
    s.session_number = 1
    s.usage_frequency = "weekly"
    s.has_followup = True
    s.joined_with_pain = True
    s.pain_improved = True
    s.pain_location = None
    s.pre_vas = pre_vas
    s.post_vas = 3.0
    s.vas_change = -2.0 if pre_vas is None or not math.isnan(float(pre_vas)) else float("nan")
    s.pre_tug_s = 14.0
    s.post_tug_s = 11.0
    s.tug_change_s = -3.0
    s.tug_change_pct = -21.4
    s.pre_5xsst_s = 18.0
    s.post_5xsst_s = 14.0
    s.sst_change_s = -4.0
    s.sst_change_pct = -22.2
    s.pre_normal_time_s = None
    s.post_normal_time_s = None
    s.pre_normal_gs_ms = None
    s.post_normal_gs_ms = None
    s.normal_gs_change_ms = None
    s.normal_gs_change_pct = None
    s.pre_fast_time_s = None
    s.post_fast_time_s = None
    s.pre_fast_gs_ms = None
    s.post_fast_gs_ms = None
    s.fast_gs_change_ms = None
    s.fast_gs_change_pct = None
    s.baseline_sppb = 8
    s.post_sppb = 10
    s.sppb_change = 2
    s.sppb_source = None
    s.n_pre_post_pairs = 3
    s.composite_improvement = 12.5
    s.overall_responder = True
    s.breadth_of_response = 3
    s.is_dropout = False
    return s


def _db_for_detail(patient, session):
    """Mock db that handles two sequential db.query(...) calls for GET /patient/{sn}."""
    db = MagicMock()

    def _query_side_effect(model):
        q = MagicMock()
        if model is Patient:
            q.filter.return_value.first.return_value = patient
        elif model is ClinicalSession:
            q.filter_by.return_value.first.return_value = session
        else:
            q.filter.return_value.first.return_value = None
            q.filter_by.return_value.first.return_value = None
        return q

    db.query.side_effect = _query_side_effect
    return db


# ===========================================================================
# GET /patients tests
# ===========================================================================

def test_list_patients_503_when_db_not_ready():
    with _client() as c:
        with patch.object(deps, "_db_ready", False):
            r = c.get("/api/patients", headers=_HEADERS)
    assert r.status_code == 503


def test_list_patients_200_empty_result():
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_list([])
            try:
                r = c.get("/api/patients", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    assert r.json() == []


def test_list_patients_200_with_results():
    patient = _make_patient()
    session = _make_session()
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_list([(patient, session)])
            try:
                r = c.get("/api/patients", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["sn"] == "P001"


def test_list_patients_cohort_filter_no_error():
    """Cohort filter param is passed through without error."""
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_list([])
            try:
                r = c.get("/api/patients?cohort=QTX-A", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200


def test_list_patients_nan_normalised_to_null():
    """NaN float values in patient fields become null in the JSON response."""
    patient = _make_patient()
    session = _make_session(pre_vas=float("nan"))
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_list([(patient, session)])
            try:
                r = c.get("/api/patients", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["pre_vas"] is None


# ===========================================================================
# GET /patient/{sn} tests
# ===========================================================================

def test_get_patient_503_when_db_not_ready():
    with _client() as c:
        with patch.object(deps, "_db_ready", False):
            r = c.get("/api/patient/P001", headers=_HEADERS)
    assert r.status_code == 503


def test_get_patient_404_for_unknown_sn():
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_detail(None, None)
            try:
                r = c.get("/api/patient/UNKNOWN", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 404


def test_get_patient_200_with_correct_shape():
    patient = _make_patient()
    session = _make_session()
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_detail(patient, session)
            try:
                r = c.get("/api/patient/P001", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    data = r.json()
    assert data["sn"] == "P001"
    assert data["age"] == 72
    assert data["gender"] == "F"
    assert data["cohort"] == "QTX-A"


def test_get_patient_nan_normalised_to_null():
    """NaN float in session pre_vas field becomes null in JSON response."""
    patient = _make_patient()
    session = _make_session(pre_vas=float("nan"))
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_detail(patient, session)
            try:
                r = c.get("/api/patient/P001", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    data = r.json()
    assert data["pre_vas"] is None


def test_get_patient_no_session_fields_are_null():
    """When no session exists for the patient, all session keys should be null."""
    patient = _make_patient()
    with _client() as c:
        with patch.object(deps, "_db_ready", True):
            app.dependency_overrides[get_db] = lambda: _db_for_detail(patient, None)
            try:
                r = c.get("/api/patient/P001", headers=_HEADERS)
            finally:
                app.dependency_overrides.pop(get_db, None)
    assert r.status_code == 200
    data = r.json()
    # All session-derived fields should be null
    for key in ["pre_vas", "post_vas", "vas_change", "pre_tug_s", "composite_improvement"]:
        assert data[key] is None, f"Expected {key} to be null, got {data[key]!r}"
