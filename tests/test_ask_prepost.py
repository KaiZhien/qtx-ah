"""Unit tests verifying that pre/post measurement pairs appear in the AI context timeline."""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event
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

_PATIENT_ID = uuid.uuid4()
_PATIENT_SN = "PREPOST001"


@pytest.fixture(scope="module")
def engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_prepost?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


@pytest.fixture(scope="module")
def seeded_db(engine):
    """Seed one patient with a fully-populated session including pre/post pairs."""
    from models.clinical import Patient, Session as ClinicalSession

    Sess = sessionmaker(bind=engine)
    db = Sess()

    flags = {col: False for col in _FLAG_COLS}
    flags["has_knee_issue"] = True
    flags["grp_joint_disease"] = True

    patient = Patient(
        id=_PATIENT_ID, sn=_PATIENT_SN, name="PrePost Test Patient",
        gender="M", age=72, age_band="70-79",
        cohort="Pain & Musculoskeletal", record_type="Active",
        **flags,
    )
    db.add(patient)
    db.flush()

    session = ClinicalSession(
        id=uuid.uuid4(),
        patient_id=_PATIENT_ID,
        session_number=1,
        has_followup=True,
        is_dropout=False,
        # VAS
        pre_vas=7.5,
        post_vas=4.0,
        vas_change=-3.5,
        # TUG
        pre_tug_s=18.2,
        post_tug_s=14.5,
        tug_change_pct=-0.2033,
        # 5xSST
        pre_5xsst_s=22.0,
        post_5xsst_s=17.5,
        sst_change_pct=-0.2045,
        # Normal gait
        pre_normal_gs_ms=850.0,
        post_normal_gs_ms=980.0,
        # Fast gait
        pre_fast_gs_ms=1100.0,
        post_fast_gs_ms=1250.0,
        # SPPB
        baseline_sppb=7,
        post_sppb=9,
        # Outcomes
        composite_improvement=0.2136,
        overall_responder=True,
    )
    db.add(session)
    db.commit()
    db.close()

    return engine


def _get_timeline(engine) -> dict:
    """Call _build_timeline_dict directly using the seeded DB."""
    from routers.ask import _build_timeline_dict
    from models.clinical import Patient

    Sess = sessionmaker(bind=engine)
    db = Sess()
    try:
        patient = db.query(Patient).filter_by(sn=_PATIENT_SN).first()
        return _build_timeline_dict(patient, db)
    finally:
        db.close()


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_timeline_has_one_session(seeded_db):
    tl = _get_timeline(seeded_db)
    assert len(tl["sessions"]) == 1


def test_pre_vas_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "pre_vas" in sdict
    assert sdict["pre_vas"] == pytest.approx(7.5)


def test_vas_change_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "vas_change" in sdict
    assert sdict["vas_change"] == pytest.approx(-3.5)


def test_pre_tug_s_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "pre_tug_s" in sdict
    assert sdict["pre_tug_s"] == pytest.approx(18.2)


def test_tug_change_pct_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "tug_change_pct" in sdict
    assert sdict["tug_change_pct"] == pytest.approx(-0.2033)


def test_pre_5xsst_s_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "pre_5xsst_s" in sdict
    assert sdict["pre_5xsst_s"] == pytest.approx(22.0)


def test_post_5xsst_s_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "post_5xsst_s" in sdict
    assert sdict["post_5xsst_s"] == pytest.approx(17.5)


def test_sst_change_pct_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "sst_change_pct" in sdict
    assert sdict["sst_change_pct"] == pytest.approx(-0.2045)


def test_pre_normal_gs_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "pre_normal_gs" in sdict
    assert sdict["pre_normal_gs"] == pytest.approx(850.0)


def test_post_normal_gs_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "post_normal_gs" in sdict
    assert sdict["post_normal_gs"] == pytest.approx(980.0)


def test_pre_fast_gs_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "pre_fast_gs" in sdict
    assert sdict["pre_fast_gs"] == pytest.approx(1100.0)


def test_post_fast_gs_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "post_fast_gs" in sdict
    assert sdict["post_fast_gs"] == pytest.approx(1250.0)


def test_normal_gs_change_pct_present(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "normal_gs_change_pct" in sdict


def test_fast_gs_change_pct_present(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "fast_gs_change_pct" in sdict


def test_sppb_change_present(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "sppb_change" in sdict


def test_baseline_sppb_present_and_correct(seeded_db):
    sdict = _get_timeline(seeded_db)["sessions"][0]
    assert "baseline_sppb" in sdict
    assert sdict["baseline_sppb"] == 7


def test_all_new_fields_are_floats_or_none(seeded_db):
    """All numeric new fields are returned as Python floats (via _v helper), not Decimal."""
    sdict = _get_timeline(seeded_db)["sessions"][0]
    numeric_fields = [
        "pre_vas", "vas_change",
        "pre_tug_s", "tug_change_pct",
        "pre_5xsst_s", "post_5xsst_s", "sst_change_pct",
        "pre_normal_gs", "post_normal_gs",
        "pre_fast_gs", "post_fast_gs",
        "normal_gs_change_pct", "fast_gs_change_pct",
    ]
    for field in numeric_fields:
        val = sdict[field]
        assert val is None or isinstance(val, float), (
            f"Field {field!r} expected float or None, got {type(val).__name__}"
        )


def test_null_pre_fields_return_none_not_missing(engine):
    """A session with no pre-measurements returns None for pre fields, not KeyError."""
    from models.clinical import Patient, Session as ClinicalSession

    null_patient_id = uuid.uuid4()
    Sess = sessionmaker(bind=engine)
    db = Sess()

    flags = {col: False for col in _FLAG_COLS}
    p = Patient(
        id=null_patient_id, sn="PREPOST_NULL", name="Null PrePost Patient",
        gender="F", age=65, age_band="60-69",
        cohort="Pain & Musculoskeletal", record_type="Active",
        **flags,
    )
    db.add(p)
    db.flush()

    s = ClinicalSession(
        id=uuid.uuid4(),
        patient_id=null_patient_id,
        session_number=1,
        has_followup=False,
        is_dropout=False,
        post_tug_s=13.0,
        post_vas=5.0,
        # All pre fields intentionally omitted (None)
    )
    db.add(s)
    db.commit()

    from routers.ask import _build_timeline_dict
    patient = db.query(Patient).filter_by(sn="PREPOST_NULL").first()
    tl = _build_timeline_dict(patient, db)
    db.close()

    sdict = tl["sessions"][0]
    for field in ("pre_vas", "pre_tug_s", "pre_5xsst_s", "pre_normal_gs",
                  "pre_fast_gs", "baseline_sppb", "vas_change",
                  "tug_change_pct", "sst_change_pct"):
        assert field in sdict, f"Field {field!r} missing from sdict"
        assert sdict[field] is None, f"Expected None for {field!r}, got {sdict[field]!r}"
