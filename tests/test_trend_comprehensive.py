"""Comprehensive tests for TrendEngine — covers all tracked metrics, upsert, null handling,
tie cases, magnitude semantics, session count edge cases, and direction logic per metric.

Uses SQLite shared-cache in-memory DB so module-scoped engine + function-scoped rollback
sessions coexist without data leaking between tests.
"""
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


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_trend_comp?mode=memory&cache=shared&uri=true",
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
def db_session(engine):
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.rollback()
    s.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_patient(db, sn: str) -> "models.clinical.Patient":
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
    db.add(p)
    db.flush()
    return p


def _add_session(db, patient_id: uuid.UUID, session_number: int, **measurements):
    from models.clinical import Session as ClinicalSession
    s = ClinicalSession(
        id=uuid.uuid4(),
        patient_id=patient_id,
        session_number=session_number,
        has_followup=False,
        is_dropout=False,
        **measurements,
    )
    db.add(s)
    db.flush()
    return s


def _make_patient_with_sessions(db, metric_col: str, values: list) -> uuid.UUID:
    """Insert a patient and one session per value. None values stored as None."""
    sn = f"C{uuid.uuid4().hex[:6]}"
    p = _make_patient(db, sn)
    for i, val in enumerate(values, start=1):
        _add_session(db, p.id, i, **{metric_col: val})
    return p.id


# ── _compute_direction unit tests — all 6 metrics, direction semantics ────────

def test_compute_direction_post_vas_improving():
    """post_vas is lower_is_better; decreasing values → improving."""
    from services.trend import _compute_direction
    # 7 → 5 → 3: all deltas negative → 2 improving
    assert _compute_direction([7.0, 5.0, 3.0], lower_is_better=True) == "improving"


def test_compute_direction_post_vas_declining():
    """post_vas is lower_is_better; increasing values → declining."""
    from services.trend import _compute_direction
    assert _compute_direction([3.0, 5.0, 7.0], lower_is_better=True) == "declining"


def test_compute_direction_post_tug_s_improving():
    """post_tug_s is lower_is_better; decreasing values → improving."""
    from services.trend import _compute_direction
    assert _compute_direction([15.0, 12.0, 9.0], lower_is_better=True) == "improving"


def test_compute_direction_post_5xsst_s_improving():
    """post_5xsst_s is lower_is_better; decreasing values → improving."""
    from services.trend import _compute_direction
    assert _compute_direction([20.0, 17.0, 13.0], lower_is_better=True) == "improving"


def test_compute_direction_post_normal_gs_ms_improving():
    """post_normal_gs_ms is higher_is_better; increasing values → improving."""
    from services.trend import _compute_direction
    assert _compute_direction([800.0, 900.0, 1050.0], lower_is_better=False) == "improving"


def test_compute_direction_post_fast_gs_ms_improving():
    """post_fast_gs_ms is higher_is_better; increasing values → improving."""
    from services.trend import _compute_direction
    assert _compute_direction([1000.0, 1100.0, 1250.0], lower_is_better=False) == "improving"


def test_compute_direction_post_sppb_declining():
    """post_sppb is higher_is_better; decreasing values → declining."""
    from services.trend import _compute_direction
    assert _compute_direction([10.0, 8.0, 6.0], lower_is_better=False) == "declining"


def test_compute_direction_tie_majority_improving():
    """2 improving + 1 declining deltas → improving (majority wins at >= 2)."""
    from services.trend import _compute_direction
    # lower_is_better: deltas [−2, −1, +3] → improving=2, declining=1 → "improving"
    assert _compute_direction([10.0, 8.0, 7.0, 10.0], lower_is_better=True) == "improving"


def test_compute_direction_exact_tie_stable():
    """1 improving + 1 declining out of 2 deltas → stable (neither reaches >= 2)."""
    from services.trend import _compute_direction
    # lower_is_better: [10, 8, 12] → deltas −2, +4 → improving=1, declining=1 → stable
    assert _compute_direction([10.0, 8.0, 12.0], lower_is_better=True) == "stable"


def test_compute_direction_zero_delta_stable():
    """Same value repeated → all deltas are zero → stable."""
    from services.trend import _compute_direction
    assert _compute_direction([5.0, 5.0, 5.0], lower_is_better=True) == "stable"


def test_compute_direction_baseline_only_one_value():
    from services.trend import _compute_direction
    assert _compute_direction([14.0], lower_is_better=True) == "baseline_only"


def test_compute_direction_early_signal_two_values():
    from services.trend import _compute_direction
    assert _compute_direction([14.0, 11.0], lower_is_better=True) == "early_signal"


# ── TrendEngine end-to-end tests ──────────────────────────────────────────────

def test_e2e_one_session_all_metrics_baseline_only(db_session):
    """Patient with exactly 1 session → every metric with data is baseline_only."""
    from services.trend import TrendEngine

    pid = _make_patient_with_sessions(
        db_session, "post_tug_s", [14.0]
    )
    # Also add the rest of the tracked metrics to the single session
    from models.clinical import Session as ClinicalSession
    row = db_session.query(ClinicalSession).filter_by(patient_id=pid).one()
    row.post_vas = 6.0
    row.post_5xsst_s = 18.0
    row.post_normal_gs_ms = 900.0
    row.post_fast_gs_ms = 1100.0
    row.post_sppb = 8
    db_session.flush()

    results = TrendEngine(db_session).compute_and_save(pid)
    db_session.flush()

    assert len(results) == 6
    for r in results:
        assert r.direction == "baseline_only", f"{r.metric} should be baseline_only, got {r.direction}"
        assert r.sessions_used == 1


def test_e2e_two_sessions_all_metrics_early_signal(db_session):
    """Patient with exactly 2 sessions → every metric with data is early_signal."""
    from services.trend import TrendEngine

    sn = f"C{uuid.uuid4().hex[:6]}"
    p = _make_patient(db_session, sn)
    for i, vals in enumerate(
        [(6.0, 14.0, 18.0, 900.0, 1100.0, 8), (5.0, 12.0, 16.0, 950.0, 1150.0, 9)], start=1
    ):
        _add_session(
            db_session, p.id, i,
            post_vas=vals[0], post_tug_s=vals[1], post_5xsst_s=vals[2],
            post_normal_gs_ms=vals[3], post_fast_gs_ms=vals[4], post_sppb=vals[5],
        )

    results = TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()

    assert len(results) == 6
    for r in results:
        assert r.direction == "early_signal", f"{r.metric} expected early_signal, got {r.direction}"
        assert r.sessions_used == 2


def test_e2e_post_fast_gs_ms_higher_is_better_improving(db_session):
    """post_fast_gs_ms (higher is better): 3 increasing values → improving."""
    from services.trend import TrendEngine

    pid = _make_patient_with_sessions(
        db_session, "post_fast_gs_ms", [1000.0, 1100.0, 1250.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_fast_gs_ms")
    assert r.direction == "improving"
    assert r.sessions_used == 3


def test_e2e_post_sppb_higher_is_better_declining(db_session):
    """post_sppb (higher is better): decreasing values → declining."""
    from services.trend import TrendEngine

    pid = _make_patient_with_sessions(
        db_session, "post_sppb", [10.0, 8.0, 6.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_sppb")
    assert r.direction == "declining"


def test_e2e_post_vas_lower_is_better_improving(db_session):
    """post_vas (lower is better): decreasing values → improving."""
    from services.trend import TrendEngine

    pid = _make_patient_with_sessions(
        db_session, "post_vas", [8.0, 6.0, 4.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_vas")
    assert r.direction == "improving"


def test_e2e_magnitude_is_last_minus_first(db_session):
    """Magnitude = last_value - first_value (not sum or avg of deltas)."""
    from services.trend import TrendEngine

    # 10 → 7 → 4 : first=10, last=4, magnitude = 4 - 10 = -6
    pid = _make_patient_with_sessions(
        db_session, "post_tug_s", [10.0, 7.0, 4.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_tug_s")
    assert r.first_value == pytest.approx(10.0)
    assert r.last_value == pytest.approx(4.0)
    assert r.magnitude == pytest.approx(-6.0, abs=0.01)


def test_e2e_mixed_null_values_only_non_null_used(db_session):
    """Sessions with None for a metric are skipped; non-null sessions still produce a trend."""
    from services.trend import TrendEngine

    sn = f"C{uuid.uuid4().hex[:6]}"
    p = _make_patient(db_session, sn)
    # Session 1: tug=14, vas=None
    _add_session(db_session, p.id, 1, post_tug_s=14.0, post_vas=None)
    # Session 2: tug=None, vas=6
    _add_session(db_session, p.id, 2, post_tug_s=None, post_vas=6.0)
    # Session 3: tug=10, vas=None
    _add_session(db_session, p.id, 3, post_tug_s=10.0, post_vas=None)

    results = TrendEngine(db_session).compute_and_save(p.id)

    metrics = {r.metric: r for r in results}
    # tug has values at s1 and s3 → 2 non-null → early_signal
    assert "post_tug_s" in metrics
    assert metrics["post_tug_s"].sessions_used == 2
    assert metrics["post_tug_s"].direction == "early_signal"
    # vas has only 1 non-null value → baseline_only
    assert "post_vas" in metrics
    assert metrics["post_vas"].direction == "baseline_only"


def test_e2e_all_null_metric_not_returned(db_session):
    """A metric whose values are all None across all sessions is absent from results."""
    from services.trend import TrendEngine

    sn = f"C{uuid.uuid4().hex[:6]}"
    p = _make_patient(db_session, sn)
    _add_session(db_session, p.id, 1, post_tug_s=14.0, post_vas=None)
    _add_session(db_session, p.id, 2, post_tug_s=11.0, post_vas=None)
    _add_session(db_session, p.id, 3, post_tug_s=9.0, post_vas=None)

    results = TrendEngine(db_session).compute_and_save(p.id)

    metrics = {r.metric for r in results}
    assert "post_vas" not in metrics


def test_e2e_upsert_updates_existing_row(db_session):
    """compute_and_save called twice updates the existing PatientTrend row — not a new insert."""
    from services.trend import TrendEngine
    from models.clinical import PatientTrend

    pid = _make_patient_with_sessions(db_session, "post_sppb", [7.0])

    TrendEngine(db_session).compute_and_save(pid)
    db_session.flush()

    # Add a second session and call again
    _add_session(db_session, pid, 2, post_sppb=9.0)
    TrendEngine(db_session).compute_and_save(pid)
    db_session.flush()

    rows = db_session.query(PatientTrend).filter_by(patient_id=pid, metric="post_sppb").all()
    assert len(rows) == 1
    assert rows[0].direction == "early_signal"
    assert rows[0].sessions_used == 2


def test_e2e_upsert_no_duplicates_after_multiple_calls(db_session):
    """Three calls to compute_and_save still yield exactly one row per metric."""
    from services.trend import TrendEngine
    from models.clinical import PatientTrend

    sn = f"C{uuid.uuid4().hex[:6]}"
    p = _make_patient(db_session, sn)
    _add_session(db_session, p.id, 1, post_tug_s=14.0)
    _add_session(db_session, p.id, 2, post_tug_s=12.0)
    _add_session(db_session, p.id, 3, post_tug_s=10.0)

    TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()
    TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()
    TrendEngine(db_session).compute_and_save(p.id)
    db_session.flush()

    rows = db_session.query(PatientTrend).filter_by(patient_id=p.id, metric="post_tug_s").all()
    assert len(rows) == 1


def test_e2e_compute_and_save_returns_trend_result_fields(db_session):
    """compute_and_save returns TrendResult objects with all expected fields populated."""
    from services.trend import TrendEngine, TrendResult

    pid = _make_patient_with_sessions(
        db_session, "post_tug_s", [14.0, 12.0, 10.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    tug = next(r for r in results if r.metric == "post_tug_s")
    assert isinstance(tug, TrendResult)
    assert tug.metric == "post_tug_s"
    assert tug.direction in {"baseline_only", "early_signal", "improving", "declining", "stable"}
    assert isinstance(tug.sessions_used, int)
    assert tug.first_value is not None
    assert tug.last_value is not None
    assert tug.magnitude is not None


def test_e2e_tie_case_two_improving_one_declining(db_session):
    """2 improving + 1 declining delta → direction is improving (>= 2 threshold)."""
    from services.trend import TrendEngine

    # lower_is_better metric (post_tug_s): [10, 8, 7, 10]
    # deltas: −2, −1, +3 → improving=2, declining=1 → "improving"
    pid = _make_patient_with_sessions(
        db_session, "post_tug_s", [10.0, 8.0, 7.0, 10.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_tug_s")
    assert r.direction == "improving"


def test_e2e_exact_tie_one_improving_one_declining(db_session):
    """1 improving + 1 declining delta (3 sessions → 2 deltas) → stable."""
    from services.trend import TrendEngine

    # lower_is_better: [10, 8, 12] → deltas −2, +4 → improving=1, declining=1 → stable
    pid = _make_patient_with_sessions(
        db_session, "post_tug_s", [10.0, 8.0, 12.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_tug_s")
    assert r.direction == "stable"


def test_e2e_zero_delta_stable(db_session):
    """Same value repeated across 3 sessions → all deltas zero → stable."""
    from services.trend import TrendEngine

    pid = _make_patient_with_sessions(
        db_session, "post_vas", [5.0, 5.0, 5.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_vas")
    assert r.direction == "stable"
    assert r.magnitude == pytest.approx(0.0, abs=0.001)


def test_e2e_persists_to_db(db_session):
    """After compute_and_save, PatientTrend rows are queryable from the DB."""
    from services.trend import TrendEngine
    from models.clinical import PatientTrend

    pid = _make_patient_with_sessions(
        db_session, "post_normal_gs_ms", [850.0, 920.0, 1000.0]
    )
    TrendEngine(db_session).compute_and_save(pid)
    db_session.flush()

    row = db_session.query(PatientTrend).filter_by(
        patient_id=pid, metric="post_normal_gs_ms"
    ).one()
    assert row.direction == "improving"
    assert row.first_value == pytest.approx(850.0)
    assert row.last_value == pytest.approx(1000.0)
    assert row.magnitude == pytest.approx(150.0, abs=0.01)


def test_e2e_magnitude_for_higher_is_better_metric(db_session):
    """Magnitude = last_value - first_value for higher-is-better metrics too."""
    from services.trend import TrendEngine

    # post_fast_gs_ms: 1000 → 1200 → 1400. magnitude = 1400 - 1000 = 400
    pid = _make_patient_with_sessions(
        db_session, "post_fast_gs_ms", [1000.0, 1200.0, 1400.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_fast_gs_ms")
    assert r.magnitude == pytest.approx(400.0, abs=0.01)
    assert r.first_value == pytest.approx(1000.0)
    assert r.last_value == pytest.approx(1400.0)


def test_e2e_five_sessions_uses_last_four(db_session):
    """With 5 sessions, only the last 4 are used for delta calculation."""
    from services.trend import TrendEngine

    # post_tug_s (lower is better):
    # sessions: [20, 18, 16, 14, 12] — last 4 = [18, 16, 14, 12]
    # deltas: −2, −2, −2 → improving=3 → "improving"
    # (first session value of 20 does not affect direction, but magnitude uses all: last-first = 12-20 = -8)
    pid = _make_patient_with_sessions(
        db_session, "post_tug_s", [20.0, 18.0, 16.0, 14.0, 12.0]
    )
    results = TrendEngine(db_session).compute_and_save(pid)

    r = next(r for r in results if r.metric == "post_tug_s")
    assert r.direction == "improving"
    assert r.sessions_used == 5
    assert r.magnitude == pytest.approx(-8.0, abs=0.01)


def test_e2e_all_six_tracked_metrics_present_when_all_have_data(db_session):
    """When all 6 metrics have data, compute_and_save returns exactly 6 TrendResult objects."""
    from services.trend import TrendEngine

    sn = f"C{uuid.uuid4().hex[:6]}"
    p = _make_patient(db_session, sn)
    for i in range(1, 4):
        _add_session(
            db_session, p.id, i,
            post_vas=float(8 - i),
            post_tug_s=float(15 - i),
            post_5xsst_s=float(20 - i),
            post_normal_gs_ms=float(850 + i * 50),
            post_fast_gs_ms=float(1000 + i * 100),
            post_sppb=float(6 + i),
        )

    results = TrendEngine(db_session).compute_and_save(p.id)

    metric_names = {r.metric for r in results}
    assert metric_names == {
        "post_vas", "post_tug_s", "post_5xsst_s",
        "post_normal_gs_ms", "post_fast_gs_ms", "post_sppb",
    }
    assert len(results) == 6
