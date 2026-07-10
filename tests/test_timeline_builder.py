"""Tests for the shared timeline builder (services/timeline.py).

The three routers (sessions, ask, plan) previously carried copy-pasted
_build_timeline_dict implementations with subtly different field sets.
These tests pin the exact per-variant field sets so consolidation cannot
silently change what each Claude prompt receives.
"""
from __future__ import annotations

import sys
import uuid
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

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
def db():
    from db import Base
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    session = sessionmaker(bind=eng)()
    yield session
    session.close()


@pytest.fixture(scope="module")
def patient(db):
    from models.clinical import Patient, Session as ClinicalSession, PatientTrend
    flags = {col: False for col in _FLAG_COLS}
    flags["has_diabetes"] = True
    p = Patient(
        id=uuid.uuid4(), sn="TL001", name="Timeline Patient", gender="F", age=71,
        age_band="70-79", cohort="Frailty", primary_indication="frailty",
        record_type="Active", baseline_sppb=7, pre_tandem_s=8.5,
        **flags,
    )
    db.add(p)
    db.flush()
    s = ClinicalSession(
        id=uuid.uuid4(), patient_id=p.id, session_number=1,
        session_date=date(2026, 6, 1), notes="note text",
        has_followup=True, is_dropout=False, usage_frequency="weekly",
        joined_with_pain=True, pain_improved=False, pain_location="knee",
        pre_vas=6.0, post_vas=4.0, vas_change=-2.0,
        pre_tug_s=14.0, post_tug_s=12.0, tug_change_pct=-0.14,
        pre_5xsst_s=20.0, post_5xsst_s=18.0, sst_change_pct=-0.10,
        pre_normal_gs_ms=0.8, post_normal_gs_ms=0.9, normal_gs_change_pct=0.125,
        pre_fast_gs_ms=1.1, post_fast_gs_ms=1.2, fast_gs_change_pct=0.09,
        baseline_sppb=7, post_sppb=8, sppb_change=1,
        post_tandem_s=9.0, composite_improvement=0.21, overall_responder=True,
    )
    db.add(s)
    t = PatientTrend(
        id=uuid.uuid4(), patient_id=p.id, metric="post_tug_s",
        direction="improving", sessions_used=2, magnitude=-2.0,
        first_value=14.0, last_value=12.0,
    )
    db.add(t)
    db.flush()
    return p


_COMMON_SESSION_KEYS = {
    "session_number", "session_date", "usage_frequency",
    "pre_vas", "post_vas", "vas_change",
    "pre_tug_s", "post_tug_s", "tug_change_pct",
    "pre_5xsst_s", "post_5xsst_s", "sst_change_pct",
    "normal_gs_change_pct", "fast_gs_change_pct",
    "baseline_sppb", "post_sppb", "sppb_change",
    "post_tandem_s", "composite_improvement", "overall_responder", "is_dropout",
}

_CLINICAL_PATIENT_KEYS = {
    "sn", "age", "age_band", "gender", "cohort", "primary_indication",
    "baseline_sppb", "pre_tandem_s",
    "has_frailty", "has_diabetes", "has_neurological", "has_stroke", "has_parkinsons",
}

_PLAN_PATIENT_KEYS = {
    "sn", "age", "age_band", "gender", "cohort", "primary_indication",
    "baseline_sppb",
    "has_frailty", "has_diabetes", "has_neurological", "has_stroke",
    "has_fall_risk", "has_oa", "has_balance_issue", "has_chronic_pain",
    "has_knee_issue", "has_spinal_issue",
}


def test_top_level_shape(db, patient):
    from services.timeline import build_timeline_dict
    tl = build_timeline_dict(patient, db, variant="session")
    assert set(tl.keys()) == {"patient", "sessions", "trends"}
    assert len(tl["sessions"]) == 1
    assert len(tl["trends"]) == 1


def test_session_variant_field_sets(db, patient):
    """The session (create_session) variant keeps full gait key names and pain detail."""
    from services.timeline import build_timeline_dict
    tl = build_timeline_dict(patient, db, variant="session")
    assert set(tl["patient"].keys()) == _CLINICAL_PATIENT_KEYS
    expected = _COMMON_SESSION_KEYS | {
        "notes", "has_followup", "joined_with_pain", "pain_improved", "pain_location",
        "pre_normal_gs_ms", "post_normal_gs_ms", "pre_fast_gs_ms", "post_fast_gs_ms",
    }
    assert set(tl["sessions"][0].keys()) == expected


def test_ask_variant_field_sets(db, patient):
    """The ask variant uses short gait key names and keeps notes."""
    from services.timeline import build_timeline_dict
    tl = build_timeline_dict(patient, db, variant="ask")
    assert set(tl["patient"].keys()) == _CLINICAL_PATIENT_KEYS
    expected = _COMMON_SESSION_KEYS | {
        "notes", "pre_normal_gs", "post_normal_gs", "pre_fast_gs", "post_fast_gs",
    }
    assert set(tl["sessions"][0].keys()) == expected


def test_plan_variant_field_sets(db, patient):
    """The plan variant has the extended phenotype block and no notes."""
    from services.timeline import build_timeline_dict
    tl = build_timeline_dict(patient, db, variant="plan")
    assert set(tl["patient"].keys()) == _PLAN_PATIENT_KEYS
    expected = _COMMON_SESSION_KEYS | {
        "pre_normal_gs", "post_normal_gs", "pre_fast_gs", "post_fast_gs",
    }
    assert set(tl["sessions"][0].keys()) == expected


def test_no_variant_leaks_patient_name(db, patient):
    from services.timeline import build_timeline_dict
    for variant in ("session", "ask", "plan"):
        tl = build_timeline_dict(patient, db, variant=variant)
        assert "name" not in tl["patient"], f"name leaked in variant {variant}"


def test_numeric_values_are_floats_and_ints_stay_ints(db, patient):
    from services.timeline import build_timeline_dict
    tl = build_timeline_dict(patient, db, variant="session")
    s = tl["sessions"][0]
    assert isinstance(s["pre_vas"], float)
    assert isinstance(s["composite_improvement"], float)
    assert isinstance(s["baseline_sppb"], int)
    assert isinstance(s["post_sppb"], int)
    assert s["overall_responder"] is True
    assert isinstance(tl["patient"]["pre_tandem_s"], float)
    assert s["session_date"] == "2026-06-01"


def test_trend_dict_shape(db, patient):
    from services.timeline import build_timeline_dict
    tl = build_timeline_dict(patient, db, variant="ask")
    t = tl["trends"][0]
    assert set(t.keys()) == {
        "metric", "direction", "sessions_used", "magnitude", "first_value", "last_value",
    }
    assert t["metric"] == "post_tug_s"
    assert t["magnitude"] == pytest.approx(-2.0)


def test_unknown_variant_raises(db, patient):
    from services.timeline import build_timeline_dict
    with pytest.raises(ValueError):
        build_timeline_dict(patient, db, variant="bogus")


def test_router_wrappers_delegate_to_shared_builder(db, patient):
    """Each router's _build_timeline_dict matches the shared builder output."""
    from services.timeline import build_timeline_dict
    from routers.sessions import _build_timeline_dict as sessions_build
    from routers.ask import _build_timeline_dict as ask_build
    from routers.plan import _build_timeline_dict as plan_build

    assert sessions_build(patient, db) == build_timeline_dict(patient, db, variant="session")
    assert ask_build(patient, db) == build_timeline_dict(patient, db, variant="ask")
    assert plan_build(patient, db) == build_timeline_dict(patient, db, variant="plan")
