"""Feature 3 — anomaly detection: boundary conditions and new high_dropout_risk rule.

Tests the corrected pain_worsened threshold (1.0 pt) and the new Rule 5.
"""
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


def _make_patient(db_session, sn: str, has_fall_risk: bool = True):
    from models.clinical import Patient
    flags = {col: False for col in _FLAG_COLS}
    flags["has_fall_risk"] = has_fall_risk
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="M", age=70,
        age_band="70-79", record_type="Active",
        **flags,
    )
    db_session.add(p)
    db_session.flush()
    return p


def _make_session(**kwargs):
    defaults = dict(
        post_vas=None, pre_vas=None,
        post_tug_s=None, pre_tug_s=None,
        composite_improvement=None,
    )
    defaults.update(kwargs)
    sess = MagicMock(spec=False)
    for k, v in defaults.items():
        setattr(sess, k, v)
    return sess


# ── Rule 2: pain_worsened — clinical threshold is +1.0 pt ────────────────────

def test_pain_worsened_does_not_fire_at_half_point_increase():
    """post_vas = pre_vas + 0.5 must NOT fire — below the 1.0-point clinical threshold."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(pre_vas=5.0, post_vas=5.5)  # delta = 0.5
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" not in flags


def test_pain_worsened_fires_at_one_and_half_point_increase():
    """post_vas = pre_vas + 1.5 MUST fire — exceeds the 1.0-point clinical threshold."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(pre_vas=5.0, post_vas=6.5)  # delta = 1.5
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" in flags


def test_pain_worsened_does_not_fire_at_exact_one_point():
    """post_vas = pre_vas + 1.0 must NOT fire — threshold is strictly greater than 1.0."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(pre_vas=5.0, post_vas=6.0)  # delta = exactly 1.0
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "pain_worsened" not in flags


# ── Rule 5: high_dropout_risk ─────────────────────────────────────────────────

def test_high_dropout_risk_fires_at_0_80():
    """dropout_probability=0.80 (> 0.75) must produce 'high_dropout_risk' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    predictions = {"dropout_probability": 0.80}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "high_dropout_risk" in flags


def test_high_dropout_risk_does_not_fire_at_0_74():
    """dropout_probability=0.74 (< 0.75) must NOT produce 'high_dropout_risk' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    predictions = {"dropout_probability": 0.74}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "high_dropout_risk" not in flags


def test_high_dropout_risk_does_not_fire_when_predictions_none():
    """predictions=None must not raise and must not produce 'high_dropout_risk' flag."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "high_dropout_risk" not in flags


def test_high_dropout_risk_does_not_fire_at_exact_threshold():
    """dropout_probability=0.75 (equal to threshold) must NOT fire — strictly greater."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session()
    predictions = {"dropout_probability": 0.75}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "high_dropout_risk" not in flags


# ── Rule 3: responder_mismatch ────────────────────────────────────────────────

def test_responder_mismatch_fires_when_negative_improvement_and_high_probability():
    """composite_improvement < 0 AND responder_probability > 0.5 fires 'responder_mismatch'."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(composite_improvement=-0.3)
    predictions = {"responder_probability": 0.65}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "responder_mismatch" in flags


def test_responder_mismatch_does_not_fire_when_improvement_positive():
    """composite_improvement >= 0 must not fire 'responder_mismatch' even with high probability."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(composite_improvement=0.2)
    predictions = {"responder_probability": 0.9}
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=predictions)

    assert "responder_mismatch" not in flags


# ── Rule 4: fall_risk_unregistered ───────────────────────────────────────────

def test_fall_risk_unregistered_fires_when_slow_tug_and_not_registered():
    """post_tug_s > 12.0 with has_fall_risk=False fires 'fall_risk_unregistered'."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=False)
    session = _make_session(post_tug_s=13.5)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "fall_risk_unregistered" in flags


def test_fall_risk_unregistered_does_not_fire_when_already_registered():
    """post_tug_s > 12.0 but has_fall_risk=True must NOT fire 'fall_risk_unregistered'."""
    from services.anomaly import AnomalyDetector

    patient = MagicMock(spec=False, has_fall_risk=True)
    session = _make_session(post_tug_s=15.0)
    detector = AnomalyDetector(db=MagicMock())
    flags = detector._detect_flags(patient, session, trends=[], predictions=None)

    assert "fall_risk_unregistered" not in flags


# ── check_and_warn: no flags → None ──────────────────────────────────────────

def test_check_and_warn_returns_none_when_no_flags_fire(db_session, monkeypatch):
    """All rules evaluate to false → check_and_warn returns None, no DB row written."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.anomaly import AnomalyDetector
    from models.clinical import PatientInsight

    patient = _make_patient(db_session, "DET001", has_fall_risk=True)
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


# ── check_and_warn: stub mode writes a row ────────────────────────────────────

def test_check_and_warn_stub_mode_returns_stub_and_writes_row(db_session, monkeypatch):
    """Flags fire, no ANTHROPIC_API_KEY → STUB_RESPONSE returned and row persisted."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.anomaly import AnomalyDetector
    from models.clinical import PatientInsight

    patient = _make_patient(db_session, "DET002", has_fall_risk=False)
    session = _make_session(post_tug_s=14.0)
    detector = AnomalyDetector(db=db_session)
    result = detector.check_and_warn(
        patient=patient,
        session=session,
        trends=[],
        predictions=None,
        session_number=2,
    )

    assert result == AnomalyDetector.STUB_RESPONSE

    row = db_session.query(PatientInsight).filter_by(
        patient_id=patient.id, insight_type="anomaly_warning"
    ).one()
    assert row.content == AnomalyDetector.STUB_RESPONSE
    assert row.model == "stub"
    assert row.session_number == 2


# ── _build_warning_prompt: includes dropout_probability when available ────────

def test_build_warning_prompt_includes_dropout_probability():
    """When predictions contains dropout_probability, it appears in the generated prompt."""
    from services.anomaly import AnomalyDetector

    session = _make_session(
        pre_tug_s=10.0, post_tug_s=14.0,
        pre_vas=3.0, post_vas=5.0,
        composite_improvement=-0.2,
    )
    predictions = {"responder_probability": 0.6, "dropout_probability": 0.82}
    detector = AnomalyDetector(db=MagicMock())
    prompt = detector._build_warning_prompt(
        flags=["high_dropout_risk"],
        session=session,
        predictions=predictions,
        session_number=3,
    )

    assert "0.82" in prompt


def test_build_warning_prompt_handles_missing_dropout_gracefully():
    """predictions without dropout_probability must not raise."""
    from services.anomaly import AnomalyDetector

    session = _make_session(pre_vas=3.0, post_vas=5.0)
    predictions = {"responder_probability": 0.7}
    detector = AnomalyDetector(db=MagicMock())
    prompt = detector._build_warning_prompt(
        flags=["pain_worsened"],
        session=session,
        predictions=predictions,
        session_number=1,
    )

    assert isinstance(prompt, str)
    assert len(prompt) > 0
