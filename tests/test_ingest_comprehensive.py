"""Comprehensive tests for IngestPipeline and private helper functions.

Covers _normalize_sn, _normalize_age_band, _bool, _coerce, and end-to-end
IngestPipeline behaviour with an SQLite in-memory database.
"""
from __future__ import annotations

import math
import sys
import uuid
from pathlib import Path

import pandas as pd
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # registers metadata  # noqa: F401
import models.wearable   # registers metadata  # noqa: F401

# ---------------------------------------------------------------------------
# Column lists (mirrors ingest.py exactly)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def engine():
    from db import Base
    eng = create_engine(
        "sqlite:///file:qtx_test_ingest_comp?mode=memory&cache=shared&uri=true",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def set_fk(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def db_session(engine):
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.rollback()
    s.close()


# ---------------------------------------------------------------------------
# Helper: build a minimal valid row dict
# ---------------------------------------------------------------------------

def _make_minimal_row(**overrides) -> dict:
    """Return a dict for a single patient row with all required columns defaulted."""
    row = {
        # Identity
        "sn": str(uuid.uuid4())[:8],
        "name": "Test Patient",
        "gender": "M",
        "age": 65,
        "phone_number": None,
        "tags": None,
        "primary_indication": "OA knee",
        "cohort": "Pain & Musculoskeletal",
        "record_type": "Active",
        # Session / measurement
        "usage_frequency": None,
        "has_followup": 0,
        "joined_with_pain": None,
        "pain_improved": None,
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
        "n_pre_post_pairs": 0,
        "composite_improvement": None,
        "overall_responder": None,
        "breadth_of_response": None,
        "is_dropout": 0,
    }
    # All flag columns default to 0
    for col in _FLAG_COLS:
        row[col] = 0
    row.update(overrides)
    return row


def _single_row_df(**overrides) -> pd.DataFrame:
    """Return a one-row DataFrame from _make_minimal_row."""
    return pd.DataFrame([_make_minimal_row(**overrides)])


# ---------------------------------------------------------------------------
# Tests for _normalize_sn
# ---------------------------------------------------------------------------

class TestNormalizeSn:
    def test_none_returns_none(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn(None) is None

    def test_float_nan_returns_none(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn(float("nan")) is None

    def test_whitespace_only_returns_none(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn("  ") is None

    def test_float_string_one_returns_one(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn("1.0") == "1"

    def test_float_string_hundred_returns_hundred(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn("100.0") == "100"

    def test_plain_int_string(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn("42") == "42"

    def test_int_input(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn(42) == "42"

    def test_float_input(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn(42.0) == "42"

    def test_alphanumeric_sn_unchanged(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn("SN-001") == "SN-001"

    def test_whitespace_around_float_string(self):
        from services.ingest import _normalize_sn
        assert _normalize_sn("  5.0  ") == "5"


# ---------------------------------------------------------------------------
# Tests for _normalize_age_band
# ---------------------------------------------------------------------------

class TestNormalizeAgeBand:
    def test_25_is_under_50(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(25) == "<50"

    def test_49_is_under_50(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(49) == "<50"

    def test_50_is_50_59(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(50) == "50-59"

    def test_59_is_50_59(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(59) == "50-59"

    def test_60_is_60_69(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(60) == "60-69"

    def test_69_is_60_69(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(69) == "60-69"

    def test_70_is_70_79(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(70) == "70-79"

    def test_79_is_70_79(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(79) == "70-79"

    def test_80_is_80_plus(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(80) == "80+"

    def test_95_is_80_plus(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(95) == "80+"

    def test_none_returns_none(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band(None) is None

    def test_non_numeric_string_returns_none(self):
        from services.ingest import _normalize_age_band
        assert _normalize_age_band("not a number") is None


# ---------------------------------------------------------------------------
# Tests for _bool
# ---------------------------------------------------------------------------

class TestBool:
    def test_int_one_is_true(self):
        from services.ingest import _bool
        assert _bool(1) is True

    def test_int_zero_is_false(self):
        from services.ingest import _bool
        assert _bool(0) is False

    def test_true_literal(self):
        from services.ingest import _bool
        assert _bool(True) is True

    def test_false_literal(self):
        from services.ingest import _bool
        assert _bool(False) is False

    def test_none_is_false(self):
        from services.ingest import _bool
        assert _bool(None) is False

    def test_nan_is_false(self):
        from services.ingest import _bool
        assert _bool(float("nan")) is False

    def test_truthy_string_Y(self):
        from services.ingest import _bool
        assert _bool("Y") is True


# ---------------------------------------------------------------------------
# Tests for _coerce
# ---------------------------------------------------------------------------

class TestCoerce:
    def test_none_returns_none(self):
        from services.ingest import _coerce
        assert _coerce(None) is None

    def test_nan_returns_none(self):
        from services.ingest import _coerce
        assert _coerce(float("nan")) is None

    def test_int_passthrough(self):
        from services.ingest import _coerce
        assert _coerce(42) == 42

    def test_string_passthrough(self):
        from services.ingest import _coerce
        assert _coerce("hello") == "hello"


# ---------------------------------------------------------------------------
# IngestPipeline end-to-end tests
# ---------------------------------------------------------------------------

class TestIngestPipelineEndToEnd:

    def test_empty_dataframe_returns_zero_counts(self, db_session):
        from services.ingest import IngestPipeline
        df = pd.DataFrame(columns=["sn"] + _FLAG_COLS)
        pipeline = IngestPipeline(db_session, source_filename="empty.parquet")
        summary = pipeline.upsert(df)
        assert summary.inserted == 0
        assert summary.updated == 0
        assert summary.skipped == 0

    def test_single_row_insert(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient
        sn = "comp-single-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn)
        pipeline = IngestPipeline(db_session)
        summary = pipeline.upsert(df)
        assert summary.inserted == 1
        assert summary.updated == 0
        assert summary.skipped == 0
        patient = db_session.query(Patient).filter_by(sn=sn).first()
        assert patient is not None

    def test_multiple_condition_groups_two_rows(self, db_session):
        """grp_joint_disease=1 AND grp_neurological=1 produces 2 PatientCondition rows."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient, PatientCondition
        sn = "comp-multi-cond-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, grp_joint_disease=1, grp_neurological=1)
        pipeline = IngestPipeline(db_session)
        pipeline.upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        conditions = db_session.query(PatientCondition).filter_by(patient_id=patient.id).all()
        groups = {c.condition_group for c in conditions}
        assert len(conditions) == 2
        assert "joint_disease" in groups
        assert "neurological" in groups

    def test_has_followup_Y_string_stored_as_true(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-fup-y-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, has_followup="Y")
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.has_followup is True

    def test_has_followup_zero_int_stored_as_false(self, db_session):
        """has_followup=0 (integer) normalised via _bool → stored as False."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-fup-0-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, has_followup=0)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.has_followup is False

    def test_joined_with_pain_Y_stored_as_true(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-jwp-y-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, joined_with_pain="Y")
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.joined_with_pain is True

    def test_joined_with_pain_N_stored_as_false(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-jwp-n-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, joined_with_pain="N")
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.joined_with_pain is False

    def test_pain_improved_Y_stored_as_true(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-pi-y-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, pain_improved="Y")
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.pain_improved is True

    def test_overall_responder_one_float_stored_as_true(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-or-1-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, overall_responder=1.0)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.overall_responder is True

    def test_overall_responder_none_stored_as_none(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-or-none-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, overall_responder=None)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.overall_responder is None

    def test_overall_responder_nan_stored_as_none(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-or-nan-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, overall_responder=float("nan"))
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.overall_responder is None

    def test_null_sn_in_middle_of_batch_skips_that_row(self, db_session):
        """Row with null sn in middle of batch: that row is skipped, others inserted."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient
        sn_a = "comp-batch-a-" + uuid.uuid4().hex[:4]
        sn_c = "comp-batch-c-" + uuid.uuid4().hex[:4]
        rows = [
            _make_minimal_row(sn=sn_a),
            _make_minimal_row(sn=None),    # will be skipped
            _make_minimal_row(sn=sn_c),
        ]
        df = pd.DataFrame(rows)
        pipeline = IngestPipeline(db_session)
        summary = pipeline.upsert(df)
        assert summary.inserted == 2
        assert summary.skipped == 1
        assert len(summary.errors) == 1
        assert "sn is null" in summary.errors[0].reason
        assert db_session.query(Patient).filter_by(sn=sn_a).first() is not None
        assert db_session.query(Patient).filter_by(sn=sn_c).first() is not None

    def test_age_49_maps_to_under_50_band(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient
        sn = "comp-age49-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, age=49)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        assert patient.age_band == "<50"

    def test_age_80_maps_to_80_plus_band(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient
        sn = "comp-age80-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn, age=80)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        assert patient.age_band == "80+"

    def test_upsert_second_run_updates_not_inserts(self, db_session):
        """Running the pipeline twice on the same sn produces inserted=1 then updated=1."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient
        sn = "comp-upsert-" + uuid.uuid4().hex[:6]
        df1 = _single_row_df(sn=sn, name="First Name")
        summary1 = IngestPipeline(db_session).upsert(df1)
        assert summary1.inserted == 1
        assert summary1.updated == 0

        df2 = _single_row_df(sn=sn, name="Updated Name")
        summary2 = IngestPipeline(db_session).upsert(df2)
        assert summary2.inserted == 0
        assert summary2.updated == 1

        patient = db_session.query(Patient).filter_by(sn=sn).one()
        assert patient.name == "Updated Name"

    def test_conditions_rebuilt_on_upsert(self, db_session):
        """PatientCondition rows are deleted and reinserted each upsert."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient, PatientCondition
        sn = "comp-cond-rebuild-" + uuid.uuid4().hex[:4]

        df1 = _single_row_df(sn=sn, grp_joint_disease=1)
        IngestPipeline(db_session).upsert(df1)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        conds_first = db_session.query(PatientCondition).filter_by(patient_id=patient.id).all()
        assert len(conds_first) == 1
        assert conds_first[0].condition_group == "joint_disease"

        # Second upsert switches to neurological only
        df2 = _single_row_df(sn=sn, grp_joint_disease=0, grp_neurological=1)
        IngestPipeline(db_session).upsert(df2)
        db_session.expire_all()
        conds_second = db_session.query(PatientCondition).filter_by(patient_id=patient.id).all()
        assert len(conds_second) == 1
        assert conds_second[0].condition_group == "neurological"

    def test_source_filename_stored_on_session(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-src-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn)
        IngestPipeline(db_session, source_filename="audit_test.parquet").upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id, session_number=1).one()
        assert sess.ingested_from == "audit_test.parquet"

    def test_float_sn_normalized_on_insert(self, db_session):
        """sn '7.0' normalizes to '7' before storage."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient
        df = _single_row_df(sn="7.0")
        # Insert with float-string sn
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn="7").first()
        assert patient is not None
        # Make sure it was NOT stored as "7.0"
        assert db_session.query(Patient).filter_by(sn="7.0").first() is None

    def test_no_condition_groups_produces_zero_patient_conditions(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, PatientCondition
        sn = "comp-no-grp-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn)  # all flags default to 0
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        conditions = db_session.query(PatientCondition).filter_by(patient_id=patient.id).all()
        assert conditions == []

    def test_all_grp_flags_produce_correct_condition_count(self, db_session):
        """All 14 grp_* flags set to 1 produces exactly 14 PatientCondition rows."""
        from services.ingest import IngestPipeline
        from models.clinical import Patient, PatientCondition
        sn = "comp-all-grp-" + uuid.uuid4().hex[:4]
        all_grps = {col: 1 for col in _FLAG_COLS if col.startswith("grp_")}
        df = _single_row_df(sn=sn, **all_grps)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        conditions = db_session.query(PatientCondition).filter_by(patient_id=patient.id).all()
        assert len(conditions) == 14

    def test_whitespace_sn_is_skipped(self, db_session):
        from services.ingest import IngestPipeline
        df = _single_row_df(sn="   ")
        summary = IngestPipeline(db_session).upsert(df)
        assert summary.skipped == 1
        assert len(summary.errors) == 1

    def test_nan_sn_is_skipped(self, db_session):
        from services.ingest import IngestPipeline
        df = _single_row_df(sn=float("nan"))
        summary = IngestPipeline(db_session).upsert(df)
        assert summary.skipped == 1
        assert summary.inserted == 0

    def test_session_created_with_session_number_one(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn = "comp-sessnum-" + uuid.uuid4().hex[:6]
        df = _single_row_df(sn=sn)
        IngestPipeline(db_session).upsert(df)
        patient = db_session.query(Patient).filter_by(sn=sn).one()
        sess = db_session.query(ClinicalSession).filter_by(patient_id=patient.id).one()
        assert sess.session_number == 1

    def test_is_dropout_flag_stored_correctly(self, db_session):
        from services.ingest import IngestPipeline
        from models.clinical import Patient, Session as ClinicalSession
        sn_drop = "comp-drop-" + uuid.uuid4().hex[:6]
        sn_active = "comp-active-" + uuid.uuid4().hex[:6]
        df = pd.DataFrame([
            _make_minimal_row(sn=sn_drop, is_dropout=1),
            _make_minimal_row(sn=sn_active, is_dropout=0),
        ])
        IngestPipeline(db_session).upsert(df)
        p_drop = db_session.query(Patient).filter_by(sn=sn_drop).one()
        p_active = db_session.query(Patient).filter_by(sn=sn_active).one()
        sess_drop = db_session.query(ClinicalSession).filter_by(patient_id=p_drop.id, session_number=1).one()
        sess_active = db_session.query(ClinicalSession).filter_by(patient_id=p_active.id, session_number=1).one()
        assert sess_drop.is_dropout is True
        assert sess_active.is_dropout is False
