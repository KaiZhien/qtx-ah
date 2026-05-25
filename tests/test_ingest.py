"""Tests for IngestPipeline — uses SQLite in-memory, no DATABASE_URL required."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pandas as pd
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
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
    """Module-scoped session: tests in this file build on each other sequentially.
    test_initial_insert runs first and inserts 3 patients; later tests depend on them.
    """
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


def _make_df(overrides: list[dict] | None = None) -> pd.DataFrame:
    """Return a minimal 3-row DataFrame matching dashboard_data.parquet schema."""
    base_rows = [
        {
            "sn": "1", "name": "Alice Tan", "gender": "F", "age": 65,
            "cohort": "Pain & Musculoskeletal", "primary_indication": "OA knee",
            "record_type": "Active", "usage_frequency": "Twice (2x/week, one leg per session)",
            "has_followup": "Y", "joined_with_pain": "Y", "pain_improved": "Y",
            "pain_location": "knee",
            "pre_vas": 6.0, "post_vas": 3.0, "vas_change": -3.0,
            "pre_tug_s": 14.0, "post_tug_s": 11.0, "tug_change_s": -3.0, "tug_change_pct": -0.21,
            "pre_5xsst_s": None, "post_5xsst_s": None, "sst_change_s": None, "sst_change_pct": None,
            "pre_normal_time_s": None, "post_normal_time_s": None,
            "pre_normal_gs_ms": 0.9, "post_normal_gs_ms": 1.1,
            "normal_gs_change_ms": 0.2, "normal_gs_change_pct": 0.22,
            "pre_fast_time_s": None, "post_fast_time_s": None,
            "pre_fast_gs_ms": None, "post_fast_gs_ms": None,
            "fast_gs_change_ms": None, "fast_gs_change_pct": None,
            "baseline_sppb": 8, "post_sppb": 10, "sppb_change": 2, "sppb_source": "clinic",
            "n_pre_post_pairs": 3, "composite_improvement": 0.45,
            "overall_responder": 1.0, "breadth_of_response": 2.0, "is_dropout": 0,
            "has_oa": 1, "has_diabetes": 0, "has_stroke": 0, "has_parkinsons": 0,
            "has_sarcopenia": 0, "has_frailty": 0, "has_balance_issue": 0,
            "has_post_surgery": 0, "has_chronic_pain": 0, "has_neuropathy": 0,
            "has_cancer": 0, "has_cardiovascular": 0, "has_hypertension": 0,
            "has_osteoporosis": 0, "has_spinal_issue": 0, "has_knee_issue": 1,
            "has_hip_issue": 0, "has_shoulder_issue": 0, "has_neurological": 0,
            "has_fracture": 0, "has_autoimmune": 0, "has_metabolic": 0,
            "has_wellness_only": 0, "has_fall_risk": 0,
            "grp_joint_disease": 1, "grp_spine_back": 0, "grp_neurological": 0,
            "grp_post_surgical": 0, "grp_frailty_sarcopenia": 0, "grp_balance_falls": 0,
            "grp_metabolic": 0, "grp_cardiovascular": 0, "grp_oncology": 0,
            "grp_autoimmune": 0, "grp_softtissue_injury": 0, "grp_generalised_pain": 0,
            "grp_osteoporosis": 0, "grp_wellness": 0,
            "rgn_knee": 1, "rgn_hip": 0, "rgn_spine": 0, "rgn_shoulder": 0,
            "rgn_ankle_foot": 0, "rgn_lower_limb": 0, "rgn_upper_limb": 0,
            "rgn_bilateral": 0, "rgn_trunk": 0,
        },
        {
            "sn": "2", "name": "Bob Lim", "gender": "M", "age": 72,
            "cohort": "Neurological", "primary_indication": "stroke",
            "record_type": "Active", "usage_frequency": "Once (1x/week, one leg)",
            "has_followup": "N", "joined_with_pain": None, "pain_improved": None,
            "pain_location": None,
            "pre_vas": None, "post_vas": None, "vas_change": None,
            "pre_tug_s": 25.0, "post_tug_s": 20.0, "tug_change_s": -5.0, "tug_change_pct": -0.20,
            "pre_5xsst_s": None, "post_5xsst_s": None, "sst_change_s": None, "sst_change_pct": None,
            "pre_normal_time_s": None, "post_normal_time_s": None,
            "pre_normal_gs_ms": None, "post_normal_gs_ms": None,
            "normal_gs_change_ms": None, "normal_gs_change_pct": None,
            "pre_fast_time_s": None, "post_fast_time_s": None,
            "pre_fast_gs_ms": None, "post_fast_gs_ms": None,
            "fast_gs_change_ms": None, "fast_gs_change_pct": None,
            "baseline_sppb": None, "post_sppb": None, "sppb_change": None, "sppb_source": None,
            "n_pre_post_pairs": 1, "composite_improvement": 0.2,
            "overall_responder": 1.0, "breadth_of_response": 1.0, "is_dropout": 0,
            "has_oa": 0, "has_diabetes": 0, "has_stroke": 1, "has_parkinsons": 0,
            "has_sarcopenia": 0, "has_frailty": 0, "has_balance_issue": 0,
            "has_post_surgery": 0, "has_chronic_pain": 0, "has_neuropathy": 0,
            "has_cancer": 0, "has_cardiovascular": 0, "has_hypertension": 0,
            "has_osteoporosis": 0, "has_spinal_issue": 0, "has_knee_issue": 0,
            "has_hip_issue": 0, "has_shoulder_issue": 0, "has_neurological": 1,
            "has_fracture": 0, "has_autoimmune": 0, "has_metabolic": 0,
            "has_wellness_only": 0, "has_fall_risk": 0,
            "grp_joint_disease": 0, "grp_spine_back": 0, "grp_neurological": 1,
            "grp_post_surgical": 0, "grp_frailty_sarcopenia": 0, "grp_balance_falls": 0,
            "grp_metabolic": 0, "grp_cardiovascular": 0, "grp_oncology": 0,
            "grp_autoimmune": 0, "grp_softtissue_injury": 0, "grp_generalised_pain": 0,
            "grp_osteoporosis": 0, "grp_wellness": 0,
            "rgn_knee": 0, "rgn_hip": 0, "rgn_spine": 0, "rgn_shoulder": 0,
            "rgn_ankle_foot": 0, "rgn_lower_limb": 0, "rgn_upper_limb": 0,
            "rgn_bilateral": 0, "rgn_trunk": 0,
        },
        {
            "sn": "3", "name": "Carol Wu", "gender": "F", "age": None,
            "cohort": "Wellness", "primary_indication": "wellness",
            "record_type": "Legacy", "usage_frequency": None,
            "has_followup": "N", "joined_with_pain": "N", "pain_improved": None,
            "pain_location": None,
            "pre_vas": None, "post_vas": None, "vas_change": None,
            "pre_tug_s": None, "post_tug_s": None, "tug_change_s": None, "tug_change_pct": None,
            "pre_5xsst_s": None, "post_5xsst_s": None, "sst_change_s": None, "sst_change_pct": None,
            "pre_normal_time_s": None, "post_normal_time_s": None,
            "pre_normal_gs_ms": None, "post_normal_gs_ms": None,
            "normal_gs_change_ms": None, "normal_gs_change_pct": None,
            "pre_fast_time_s": None, "post_fast_time_s": None,
            "pre_fast_gs_ms": None, "post_fast_gs_ms": None,
            "fast_gs_change_ms": None, "fast_gs_change_pct": None,
            "baseline_sppb": None, "post_sppb": None, "sppb_change": None, "sppb_source": None,
            "n_pre_post_pairs": 0, "composite_improvement": None,
            "overall_responder": None, "breadth_of_response": None, "is_dropout": 1,
            "has_oa": 0, "has_diabetes": 0, "has_stroke": 0, "has_parkinsons": 0,
            "has_sarcopenia": 0, "has_frailty": 0, "has_balance_issue": 0,
            "has_post_surgery": 0, "has_chronic_pain": 0, "has_neuropathy": 0,
            "has_cancer": 0, "has_cardiovascular": 0, "has_hypertension": 0,
            "has_osteoporosis": 0, "has_spinal_issue": 0, "has_knee_issue": 0,
            "has_hip_issue": 0, "has_shoulder_issue": 0, "has_neurological": 0,
            "has_fracture": 0, "has_autoimmune": 0, "has_metabolic": 0,
            "has_wellness_only": 1, "has_fall_risk": 0,
            "grp_joint_disease": 0, "grp_spine_back": 0, "grp_neurological": 0,
            "grp_post_surgical": 0, "grp_frailty_sarcopenia": 0, "grp_balance_falls": 0,
            "grp_metabolic": 0, "grp_cardiovascular": 0, "grp_oncology": 0,
            "grp_autoimmune": 0, "grp_softtissue_injury": 0, "grp_generalised_pain": 0,
            "grp_osteoporosis": 0, "grp_wellness": 1,
            "rgn_knee": 0, "rgn_hip": 0, "rgn_spine": 0, "rgn_shoulder": 0,
            "rgn_ankle_foot": 0, "rgn_lower_limb": 0, "rgn_upper_limb": 0,
            "rgn_bilateral": 0, "rgn_trunk": 0,
        },
    ]
    if overrides:
        for i, override in enumerate(overrides):
            if i < len(base_rows):
                base_rows[i] = {**base_rows[i], **override}
    return pd.DataFrame(base_rows)


def test_initial_insert(db_session):
    """First upsert inserts 3 patients, 3 sessions, and correct conditions."""
    from services.ingest import IngestPipeline
    from models.clinical import Patient, Session as ClinicalSession, PatientCondition

    df = _make_df()
    pipeline = IngestPipeline(db_session, source_filename="test.parquet")
    summary = pipeline.upsert(df)

    assert summary.inserted == 3
    assert summary.updated == 0
    assert summary.skipped == 0
    assert summary.errors == []

    assert db_session.query(Patient).count() == 3
    assert db_session.query(ClinicalSession).count() == 3

    # Alice has grp_joint_disease=1 → 1 condition row
    alice = db_session.query(Patient).filter_by(sn="1").one()
    conditions = db_session.query(PatientCondition).filter_by(patient_id=alice.id).all()
    assert len(conditions) == 1
    assert conditions[0].condition_group == "joint_disease"

    # Bob has grp_neurological=1 → 1 condition row
    bob = db_session.query(Patient).filter_by(sn="2").one()
    bob_conds = db_session.query(PatientCondition).filter_by(patient_id=bob.id).all()
    assert len(bob_conds) == 1
    assert bob_conds[0].condition_group == "neurological"


def test_upsert_updates_existing(db_session):
    """Re-running with a changed name updates the patient; count stays at 3."""
    from services.ingest import IngestPipeline
    from models.clinical import Patient

    df = _make_df(overrides=[{"sn": "1", "name": "Alice Renamed"}])
    pipeline = IngestPipeline(db_session)
    summary = pipeline.upsert(df)

    assert summary.inserted == 0
    assert summary.updated == 3  # all 3 rows updated
    assert db_session.query(Patient).count() == 3

    alice = db_session.query(Patient).filter_by(sn="1").one()
    assert alice.name == "Alice Renamed"


def test_null_sn_is_skipped(db_session):
    """A row with null sn is skipped and recorded in errors."""
    from services.ingest import IngestPipeline

    df = _make_df(overrides=[{"sn": None}])
    df.at[0, "sn"] = None  # force null
    pipeline = IngestPipeline(db_session)
    summary = pipeline.upsert(df)

    assert summary.skipped == 1
    assert len(summary.errors) == 1
    assert "sn is null" in summary.errors[0].reason


def test_float_sn_normalized(db_session):
    """sn '4.0' is stored as '4' (float-string normalization)."""
    from services.ingest import IngestPipeline
    from models.clinical import Patient

    new_row = _make_df()[0:1].copy()
    new_row["sn"] = "4.0"
    pipeline = IngestPipeline(db_session)
    pipeline.upsert(new_row)

    patient = db_session.query(Patient).filter_by(sn="4").first()
    assert patient is not None


def test_dropout_patient(db_session):
    """Carol (sn=3) has is_dropout=True."""
    from models.clinical import Patient, Session as ClinicalSession

    patient = db_session.query(Patient).filter_by(sn="3").first()
    assert patient is not None
    session = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
    assert session.is_dropout is True


def test_null_age_is_stored(db_session):
    """Carol (sn=3) has null age — stored as None, age_band is None."""
    from models.clinical import Patient

    carol = db_session.query(Patient).filter_by(sn="3").one()
    assert carol.age is None
    assert carol.age_band is None
