"""Tests for TrendEngine — uses SQLite in-memory, no DATABASE_URL required."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401 — registers all models with Base
import models.wearable  # noqa: F401


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


# ── _compute_direction unit tests ────────────────────────────────────────────

def test_direction_baseline_only_one_value():
    from services.trend import _compute_direction
    assert _compute_direction([14.0], lower_is_better=True) == "baseline_only"


def test_direction_baseline_only_zero_values():
    """_compute_direction is never called with 0 values — but guard works."""
    from services.trend import _compute_direction
    assert _compute_direction([], lower_is_better=True) == "baseline_only"


def test_direction_early_signal_two_values():
    from services.trend import _compute_direction
    assert _compute_direction([14.0, 11.0], lower_is_better=True) == "early_signal"


def test_direction_improving_lower_is_better():
    """Three sessions all decreasing → improving."""
    from services.trend import _compute_direction
    assert _compute_direction([14.0, 12.0, 10.0], lower_is_better=True) == "improving"


def test_direction_improving_higher_is_better():
    """Three sessions all increasing gait speed → improving."""
    from services.trend import _compute_direction
    assert _compute_direction([0.8, 0.9, 1.1], lower_is_better=False) == "improving"


def test_direction_declining():
    """Three sessions all increasing TUG → declining."""
    from services.trend import _compute_direction
    assert _compute_direction([10.0, 12.0, 14.0], lower_is_better=True) == "declining"


def test_direction_stable_mixed():
    """Two of three deltas in opposite directions → stable."""
    from services.trend import _compute_direction
    # [14, 12, 13] → deltas -2, +1 → improving=1, declining=1 → stable
    assert _compute_direction([14.0, 12.0, 13.0], lower_is_better=True) == "stable"


def test_direction_four_sessions_uses_last_three_deltas():
    """With 4 sessions, uses last 4 values → 3 deltas. All improving."""
    from services.trend import _compute_direction
    # [20, 15, 14, 12] → deltas -5, -1, -2 → 3 improving → "improving"
    assert _compute_direction([20.0, 15.0, 14.0, 12.0], lower_is_better=True) == "improving"


# ── TrendEngine end-to-end tests ─────────────────────────────────────────────

def _make_patient(db_session, sn: str):
    from models.clinical import Patient
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="F", age=65,
        age_band="60-69", record_type="Active",
        has_oa=False, has_diabetes=False, has_stroke=False, has_parkinsons=False,
        has_sarcopenia=False, has_frailty=False, has_balance_issue=False,
        has_post_surgery=False, has_chronic_pain=False, has_neuropathy=False,
        has_cancer=False, has_cardiovascular=False, has_hypertension=False,
        has_osteoporosis=False, has_spinal_issue=False, has_knee_issue=False,
        has_hip_issue=False, has_shoulder_issue=False, has_neurological=False,
        has_fracture=False, has_autoimmune=False, has_metabolic=False,
        has_wellness_only=False, has_fall_risk=False,
        grp_joint_disease=False, grp_spine_back=False, grp_neurological=False,
        grp_post_surgical=False, grp_frailty_sarcopenia=False, grp_balance_falls=False,
        grp_metabolic=False, grp_cardiovascular=False, grp_oncology=False,
        grp_autoimmune=False, grp_softtissue_injury=False, grp_generalised_pain=False,
        grp_osteoporosis=False, grp_wellness=False,
        rgn_knee=False, rgn_hip=False, rgn_spine=False, rgn_shoulder=False,
        rgn_ankle_foot=False, rgn_lower_limb=False, rgn_upper_limb=False,
        rgn_bilateral=False, rgn_trunk=False,
    )
    db_session.add(p)
    db_session.flush()
    return p


def _add_session(db_session, patient_id, session_number, **measurements):
    from models.clinical import Session as ClinicalSession
    s = ClinicalSession(
        id=uuid.uuid4(),
        patient_id=patient_id,
        session_number=session_number,
        has_followup=False,
        is_dropout=False,
        **measurements,
    )
    db_session.add(s)
    db_session.flush()
    return s


def test_trend_baseline_only_one_session(db_session):
    """With one session, post_tug_s trend is baseline_only."""
    from services.trend import TrendEngine
    from models.clinical import PatientTrend

    p = _make_patient(db_session, "T001")
    _add_session(db_session, p.id, 1, post_tug_s=14.0, post_vas=6.0)

    results = TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()

    tug = next(r for r in results if r.metric == "post_tug_s")
    assert tug.direction == "baseline_only"
    assert tug.sessions_used == 1
    assert tug.magnitude == 0.0
    assert tug.first_value == 14.0
    assert tug.last_value == 14.0

    # Persisted in DB
    row = db_session.query(PatientTrend).filter_by(patient_id=p.id, metric="post_tug_s").one()
    assert row.direction == "baseline_only"


def test_trend_early_signal_two_sessions(db_session):
    """With two sessions, direction is early_signal and magnitude is correct."""
    from services.trend import TrendEngine

    p = _make_patient(db_session, "T002")
    _add_session(db_session, p.id, 1, post_tug_s=14.0)
    _add_session(db_session, p.id, 2, post_tug_s=11.5)

    results = TrendEngine(db_session).compute_and_save(p.id)

    tug = next(r for r in results if r.metric == "post_tug_s")
    assert tug.direction == "early_signal"
    assert tug.sessions_used == 2
    assert tug.magnitude == pytest.approx(-2.5, abs=0.01)


def test_trend_improving_three_sessions(db_session):
    """Three consistently improving sessions → confirmed 'improving'."""
    from services.trend import TrendEngine

    p = _make_patient(db_session, "T003")
    _add_session(db_session, p.id, 1, post_tug_s=14.0)
    _add_session(db_session, p.id, 2, post_tug_s=12.0)
    _add_session(db_session, p.id, 3, post_tug_s=10.5)

    results = TrendEngine(db_session).compute_and_save(p.id)

    tug = next(r for r in results if r.metric == "post_tug_s")
    assert tug.direction == "improving"
    assert tug.magnitude == pytest.approx(-3.5, abs=0.01)


def test_trend_null_values_skipped(db_session):
    """Null post-session values are excluded; non-null ones still produce a trend."""
    from services.trend import TrendEngine

    p = _make_patient(db_session, "T004")
    _add_session(db_session, p.id, 1, post_tug_s=14.0, post_vas=None)
    _add_session(db_session, p.id, 2, post_tug_s=11.0, post_vas=None)

    results = TrendEngine(db_session).compute_and_save(p.id)

    metrics = {r.metric for r in results}
    assert "post_tug_s" in metrics
    assert "post_vas" not in metrics  # both null → skipped


def test_trend_upsert_overwrites_on_second_call(db_session):
    """Calling compute_and_save twice updates the existing row rather than inserting a duplicate."""
    from services.trend import TrendEngine
    from models.clinical import PatientTrend

    p = _make_patient(db_session, "T005")
    _add_session(db_session, p.id, 1, post_sppb=7)
    TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()

    _add_session(db_session, p.id, 2, post_sppb=9)
    TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()

    rows = db_session.query(PatientTrend).filter_by(patient_id=p.id, metric="post_sppb").all()
    assert len(rows) == 1  # upsert — not two rows
    assert rows[0].direction == "early_signal"
    assert rows[0].sessions_used == 2


def test_trend_higher_is_better_improving(db_session):
    """post_sppb increases → direction is improving (higher is better)."""
    from services.trend import TrendEngine

    p = _make_patient(db_session, "T006")
    _add_session(db_session, p.id, 1, post_sppb=6)
    _add_session(db_session, p.id, 2, post_sppb=8)
    _add_session(db_session, p.id, 3, post_sppb=10)

    results = TrendEngine(db_session).compute_and_save(p.id)
    sppb = next(r for r in results if r.metric == "post_sppb")
    assert sppb.direction == "improving"
