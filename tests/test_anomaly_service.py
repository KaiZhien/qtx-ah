"""Unit tests for AnomalyDetector._detect_flags (pure) and check_and_warn."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def engine():
    from db import Base
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


@pytest.fixture(scope="module")
def db_session(engine):
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


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


def _make_patient(db_session, sn: str, has_fall_risk: bool = False):
    from models.clinical import Patient
    flags = {col: False for col in _FLAG_COLS}
    flags["has_fall_risk"] = has_fall_risk
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="F", age=65,
        age_band="60-69", record_type="Active",
        **flags,
    )
    db_session.add(p)
    db_session.flush()
    return p


def _make_session(**kwargs):
    """Return a MagicMock that behaves like a ClinicalSession with given attributes."""
    defaults = dict(
        post_vas=None,
        pre_vas=None,
        post_tug_s=None,
        pre_tug_s=None,
        composite_improvement=None,
    )
    defaults.update(kwargs)
    sess = MagicMock(spec=False)
    for k, v in defaults.items():
        setattr(sess, k, v)
    return sess


def _trend(metric: str, direction: str) -> "TrendResult":
    from services.trend import TrendResult
    return TrendResult(
        metric=metric,
        direction=direction,
        sessions_used=3,
        magnitude=None,
        first_value=None,
        last_value=None,
    )


# ── _detect_flags: Rule 1 — metric declining ─────────────────────────────────

def test_detect_flags_metric_declining():
    """TrendResult with direction='declining' produces 'metric_declining:post_tug_s' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)  # disable other rules
    session = _make_session()
    trends = [_trend("post_tug_s", "declining")]
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends, predictions=None)

    assert "metric_declining:post_tug_s" in flags


def test_detect_flags_metric_not_declining():
    """TrendResult with direction='improving' produces no metric_declining flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    trends = [_trend("post_tug_s", "improving")]
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends, predictions=None)

    assert not any(f.startswith("metric_declining") for f in flags)


# ── _detect_flags: Rule 2 — pain worsened ────────────────────────────────────

def test_detect_flags_pain_worsened():
    """post_vas > pre_vas (both set) produces 'pain_worsened' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(pre_vas=4.0, post_vas=7.0)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" in flags


def test_detect_flags_pain_not_worsened():
    """post_vas < pre_vas produces no pain_worsened flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(pre_vas=7.0, post_vas=4.0)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" not in flags


def test_detect_flags_pain_null_skipped():
    """post_vas=None skips the pain rule — no flag and no error."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(pre_vas=4.0, post_vas=None)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" not in flags


# ── _detect_flags: Rule 3 — responder mismatch ───────────────────────────────

def test_detect_flags_responder_mismatch():
    """composite_improvement < 0 AND responder_probability > 0.5 → 'responder_mismatch' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(composite_improvement=-0.5)
    predictions = {"responder_probability": 0.8}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "responder_mismatch" in flags


def test_detect_flags_responder_no_mismatch():
    """responder_probability=0.3 even with negative improvement → no mismatch flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(composite_improvement=-0.5)
    predictions = {"responder_probability": 0.3}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "responder_mismatch" not in flags


# ── _detect_flags: Rule 4 — fall risk unregistered ───────────────────────────

def test_detect_flags_fall_risk_unregistered():
    """post_tug_s=13.0, has_fall_risk=False → 'fall_risk_unregistered' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=False)
    session = _make_session(post_tug_s=13.0)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "fall_risk_unregistered" in flags


def test_detect_flags_fall_risk_already_registered():
    """post_tug_s=13.0, has_fall_risk=True → no fall_risk_unregistered flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(post_tug_s=13.0)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "fall_risk_unregistered" not in flags


# ── _detect_flags: multiple flags ────────────────────────────────────────────

def test_detect_flags_multiple_flags():
    """Two conditions firing simultaneously → both flags in list."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=False)
    session = _make_session(pre_vas=4.0, post_vas=7.0, post_tug_s=13.0)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" in flags
    assert "fall_risk_unregistered" in flags


# ── _detect_flags: is pure (no DB required) ──────────────────────────────────

def test_detect_flags_is_pure():
    """_detect_flags works with no DB access — it's a pure function."""
    from services.anomaly import AnomalyDetector

    # Pass None as db — _detect_flags must not touch it
    detector = AnomalyDetector(db=None)
    patient = MagicMock(spec=False, has_fall_risk=False)
    session = _make_session(post_tug_s=13.0)
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "fall_risk_unregistered" in flags


# ── check_and_warn: no flags → None ──────────────────────────────────────────

def test_check_and_warn_no_flags_returns_none(db_session, monkeypatch):
    """No conditions met → returns None and no DB row is written."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.anomaly import AnomalyDetector
    from models.clinical import PatientInsight

    patient = _make_patient(db_session, "ANO001", has_fall_risk=True)
    session = _make_session()
    detector = AnomalyDetector(db=db_session)
    result = detector.check_and_warn(
        patient=patient,
        session=session,
        trends=[],
        predictions=None,
        session_number=1,
    )

    assert result is None
    count = db_session.query(PatientInsight).filter_by(
        patient_id=patient.id, insight_type="anomaly_warning"
    ).count()
    assert count == 0


# ── check_and_warn: stub mode ─────────────────────────────────────────────────

def test_check_and_warn_stub_mode(db_session, monkeypatch):
    """Flags fire, no ANTHROPIC_API_KEY → stub row persisted (model='stub'), no exception."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.anomaly import AnomalyDetector
    from models.clinical import PatientInsight

    patient = _make_patient(db_session, "ANO002", has_fall_risk=False)
    session = _make_session(post_tug_s=13.0)
    detector = AnomalyDetector(db=db_session)
    result = detector.check_and_warn(
        patient=patient,
        session=session,
        trends=[],
        predictions=None,
        session_number=1,
    )

    assert result == AnomalyDetector.STUB_RESPONSE

    row = db_session.query(PatientInsight).filter_by(
        patient_id=patient.id, insight_type="anomaly_warning"
    ).one()
    assert row.model == "stub"
    assert row.content == AnomalyDetector.STUB_RESPONSE


# ── check_and_warn: api error fallback ───────────────────────────────────────

def test_check_and_warn_api_error_fallback(db_session, monkeypatch):
    """Flags fire, _call_claude raises → row persisted with model='api_error', STUB_RESPONSE content."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.anomaly import AnomalyDetector
    from models.clinical import PatientInsight

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(AnomalyDetector, "_call_claude", raise_exc)

    patient = _make_patient(db_session, "ANO003", has_fall_risk=False)
    session = _make_session(post_tug_s=13.0)
    detector = AnomalyDetector(db=db_session)
    result = detector.check_and_warn(
        patient=patient,
        session=session,
        trends=[],
        predictions=None,
        session_number=1,
    )

    assert result == AnomalyDetector.STUB_RESPONSE

    row = db_session.query(PatientInsight).filter_by(
        patient_id=patient.id, insight_type="anomaly_warning"
    ).one()
    assert row.model == "api_error"
    assert row.content == AnomalyDetector.STUB_RESPONSE


# ── Rule 5 — LOW_CADENCE_RISK ─────────────────────────────────────────────────

def test_detect_flags_low_cadence_fires():
    """cadence_avg_30d=75 (below 80) → 'low_cadence_risk' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(
        patient, session, trends=[], predictions=None,
        wearable_feats={"wearable_cadence_avg_30d": 75.0},
    )

    assert "low_cadence_risk" in flags


def test_detect_flags_low_cadence_no_fire_above_threshold():
    """cadence_avg_30d=90 (at or above 80) → no 'low_cadence_risk' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(
        patient, session, trends=[], predictions=None,
        wearable_feats={"wearable_cadence_avg_30d": 90.0},
    )

    assert "low_cadence_risk" not in flags


def test_detect_flags_low_cadence_none_value_no_fire():
    """cadence_avg_30d=None → no 'low_cadence_risk' flag, no exception."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(
        patient, session, trends=[], predictions=None,
        wearable_feats={"wearable_cadence_avg_30d": None},
    )

    assert "low_cadence_risk" not in flags


def test_check_and_warn_backwards_compat_no_wearable_feats(monkeypatch):
    """check_and_warn works correctly when wearable_feats is not passed (backwards compat)."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    detector = AnomalyDetector(db=MagicMock())
    result = detector.check_and_warn(
        patient=patient,
        session=session,
        trends=[],
        predictions=None,
        session_number=1,
    )

    assert result is None


# ── _build_warning_prompt: new wearable fields ───────────────────────────────

def test_warning_prompt_includes_new_wearable_fields():
    """_build_warning_prompt includes sedentary_pct, fall_events, compliance, hrv when provided."""
    from services.anomaly import AnomalyDetector
    detector = AnomalyDetector(db=None)
    session = MagicMock()
    session.pre_tug_s = 14.0
    session.post_tug_s = 12.0
    session.pre_vas = 6.0
    session.post_vas = 4.0
    session.composite_improvement = 0.3
    wearable_feats = {
        "wearable_sedentary_pct_30d": 85.0,
        "wearable_fall_events_90d": 1,
        "wearable_compliance_rate_30d": 0.20,
        "wearable_hrv_trend_7d": 16.0,
        "wearable_cadence_avg_30d": 75.0,
    }
    predictions = {"responder_probability": 0.6, "dropout_probability": 0.4}
    flags = ["high_sedentary_risk", "fall_event_recorded"]

    prompt = detector._build_warning_prompt(flags, session, predictions, session_number=3, wearable_feats=wearable_feats)

    assert "sedentary_pct" in prompt or "85.0" in prompt
    assert "fall_events" in prompt or "1" in prompt
    assert "compliance" in prompt or "0.20" in prompt or "20%" in prompt
    assert "hrv" in prompt or "16.0" in prompt
