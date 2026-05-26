"""Comprehensive ORM tests for PatientTrend and PatientInsight models,
plus cascade delete verification for all 5 tables.

Uses SQLite shared-cache in-memory mode — no DATABASE_URL required.
FK constraints are enabled via PRAGMA foreign_keys=ON.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

_SHARED_CACHE_URL = (
    "sqlite:///file:qtx_test_orm_comp?mode=memory&cache=shared&uri=true"
)

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


def _make_patient(**kwargs) -> dict:
    defaults = dict(
        id=uuid.uuid4(),
        sn=str(uuid.uuid4())[:8],
        name="ORM Test",
        gender="F",
        age=65,
        age_band="60-69",
        record_type="Active",
        **{col: False for col in _FLAG_COLS},
    )
    defaults.update(kwargs)
    return defaults


# ---------------------------------------------------------------------------
# Module-scoped engine — created once, tables created once
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def engine():
    import models.clinical  # noqa: F401 — registers models with Base
    from db import Base

    eng = create_engine(
        _SHARED_CACHE_URL,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(eng, "connect")
    def _set_fk_pragma(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


# ---------------------------------------------------------------------------
# Function-scoped session — rolls back after every test
# ---------------------------------------------------------------------------

@pytest.fixture
def db_session(engine):
    SessionFactory = sessionmaker(bind=engine)
    session = SessionFactory()
    yield session
    session.rollback()
    session.close()


# ===========================================================================
# PatientTrend tests
# ===========================================================================

class TestPatientTrend:
    """Tests 1-7: PatientTrend model."""

    def test_insert_and_read_back_all_fields(self, db_session):
        """Test 1: Can insert PatientTrend with all fields and read it back."""
        from models.clinical import Patient, PatientTrend

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PT-T01"))
        db_session.add(p)
        db_session.flush()

        trend_id = uuid.uuid4()
        now = datetime.utcnow()
        trend = PatientTrend(
            id=trend_id,
            patient_id=patient_id,
            metric="vas",
            direction="improving",
            sessions_used=5,
            magnitude=Decimal("2.500"),
            first_value=Decimal("7.000"),
            last_value=Decimal("4.500"),
            computed_at=now,
        )
        db_session.add(trend)
        db_session.flush()

        retrieved = db_session.query(PatientTrend).filter_by(id=trend_id).one()
        assert retrieved.patient_id == patient_id
        assert retrieved.metric == "vas"
        assert retrieved.direction == "improving"
        assert retrieved.sessions_used == 5
        assert float(retrieved.magnitude) == pytest.approx(2.5, abs=1e-3)
        assert float(retrieved.first_value) == pytest.approx(7.0, abs=1e-3)
        assert float(retrieved.last_value) == pytest.approx(4.5, abs=1e-3)

    def test_fk_constraint_nonexistent_patient(self, db_session):
        """Test 2: PatientTrend.patient_id FK constraint rejects non-existent patient."""
        from models.clinical import PatientTrend

        trend = PatientTrend(
            id=uuid.uuid4(),
            patient_id=uuid.uuid4(),  # does not exist
            metric="tug",
            direction="stable",
            sessions_used=3,
            computed_at=datetime.utcnow(),
        )
        db_session.add(trend)
        with pytest.raises(IntegrityError):
            db_session.flush()

    def test_multiple_trends_same_patient_different_metrics(self, db_session):
        """Test 3: Multiple PatientTrend rows for same patient with different metrics."""
        from models.clinical import Patient, PatientTrend

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PT-T03"))
        db_session.add(p)
        db_session.flush()

        for metric in ["vas", "tug", "sst"]:
            trend = PatientTrend(
                id=uuid.uuid4(),
                patient_id=patient_id,
                metric=metric,
                direction="improving",
                sessions_used=4,
                computed_at=datetime.utcnow(),
            )
            db_session.add(trend)
        db_session.flush()

        trends = db_session.query(PatientTrend).filter_by(patient_id=patient_id).all()
        assert len(trends) == 3
        assert {t.metric for t in trends} == {"vas", "tug", "sst"}

    def test_metric_and_direction_fields_store_correctly(self, db_session):
        """Test 4: PatientTrend.metric and direction fields store and retrieve correctly."""
        from models.clinical import Patient, PatientTrend

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PT-T04"))
        db_session.add(p)
        db_session.flush()

        trend = PatientTrend(
            id=uuid.uuid4(),
            patient_id=patient_id,
            metric="normal_gait_speed",
            direction="worsening",
            sessions_used=6,
            computed_at=datetime.utcnow(),
        )
        db_session.add(trend)
        db_session.flush()

        retrieved = db_session.query(PatientTrend).filter_by(patient_id=patient_id).one()
        assert retrieved.metric == "normal_gait_speed"
        assert retrieved.direction == "worsening"

    def test_magnitude_first_last_value_can_be_none(self, db_session):
        """Test 5: PatientTrend.magnitude, first_value, last_value can be None."""
        from models.clinical import Patient, PatientTrend

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PT-T05"))
        db_session.add(p)
        db_session.flush()

        trend_id = uuid.uuid4()
        trend = PatientTrend(
            id=trend_id,
            patient_id=patient_id,
            metric="sppb",
            direction="stable",
            sessions_used=2,
            magnitude=None,
            first_value=None,
            last_value=None,
            computed_at=datetime.utcnow(),
        )
        db_session.add(trend)
        db_session.flush()

        retrieved = db_session.query(PatientTrend).filter_by(id=trend_id).one()
        assert retrieved.magnitude is None
        assert retrieved.first_value is None
        assert retrieved.last_value is None

    def test_cascade_delete_removes_trends(self, db_session):
        """Test 6: Deleting Patient cascades to delete its PatientTrend rows."""
        from models.clinical import Patient, PatientTrend

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PT-T06"))
        db_session.add(p)
        db_session.flush()

        for metric in ["vas", "tug"]:
            db_session.add(PatientTrend(
                id=uuid.uuid4(),
                patient_id=patient_id,
                metric=metric,
                direction="improving",
                sessions_used=3,
                computed_at=datetime.utcnow(),
            ))
        db_session.flush()

        db_session.delete(p)
        db_session.flush()

        remaining = db_session.query(PatientTrend).filter_by(patient_id=patient_id).all()
        assert remaining == []

    def test_sessions_used_stores_correctly(self, db_session):
        """Test 7: PatientTrend.sessions_used stores and retrieves the integer correctly."""
        from models.clinical import Patient, PatientTrend

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PT-T07"))
        db_session.add(p)
        db_session.flush()

        trend_id = uuid.uuid4()
        db_session.add(PatientTrend(
            id=trend_id,
            patient_id=patient_id,
            metric="fast_gait_speed",
            direction="improving",
            sessions_used=12,
            computed_at=datetime.utcnow(),
        ))
        db_session.flush()

        retrieved = db_session.query(PatientTrend).filter_by(id=trend_id).one()
        assert retrieved.sessions_used == 12


# ===========================================================================
# PatientInsight tests
# ===========================================================================

class TestPatientInsight:
    """Tests 8-15: PatientInsight model."""

    def test_insert_session_summary_all_fields(self, db_session):
        """Test 8: Can insert PatientInsight (session_summary type) with all fields and read it back."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T08"))
        db_session.add(p)
        db_session.flush()

        insight_id = uuid.uuid4()
        now = datetime.utcnow()
        insight = PatientInsight(
            id=insight_id,
            patient_id=patient_id,
            session_number=3,
            insight_type="session_summary",
            question=None,
            content="Patient showed significant improvement in TUG scores.",
            model="claude-sonnet-4-6",
            created_at=now,
        )
        db_session.add(insight)
        db_session.flush()

        retrieved = db_session.query(PatientInsight).filter_by(id=insight_id).one()
        assert retrieved.patient_id == patient_id
        assert retrieved.session_number == 3
        assert retrieved.insight_type == "session_summary"
        assert retrieved.question is None
        assert "TUG scores" in retrieved.content
        assert retrieved.model == "claude-sonnet-4-6"

    def test_insert_qa_response_with_question(self, db_session):
        """Test 9: Can insert PatientInsight (qa_response type) with question field."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T09"))
        db_session.add(p)
        db_session.flush()

        insight_id = uuid.uuid4()
        insight = PatientInsight(
            id=insight_id,
            patient_id=patient_id,
            session_number=None,
            insight_type="qa_response",
            question="What is the patient's overall trend?",
            content="The patient has been consistently improving across all tracked metrics.",
            model="claude-opus-4",
            created_at=datetime.utcnow(),
        )
        db_session.add(insight)
        db_session.flush()

        retrieved = db_session.query(PatientInsight).filter_by(id=insight_id).one()
        assert retrieved.insight_type == "qa_response"
        assert retrieved.question == "What is the patient's overall trend?"
        assert "consistently improving" in retrieved.content

    def test_fk_constraint_nonexistent_patient(self, db_session):
        """Test 10: PatientInsight.patient_id FK constraint rejects non-existent patient."""
        from models.clinical import PatientInsight

        insight = PatientInsight(
            id=uuid.uuid4(),
            patient_id=uuid.uuid4(),  # does not exist
            session_number=1,
            insight_type="session_summary",
            content="This should fail.",
            model="claude-sonnet-4-6",
            created_at=datetime.utcnow(),
        )
        db_session.add(insight)
        with pytest.raises(IntegrityError):
            db_session.flush()

    def test_session_number_can_be_none(self, db_session):
        """Test 11: PatientInsight.session_number can be None (for Q&A responses)."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T11"))
        db_session.add(p)
        db_session.flush()

        insight_id = uuid.uuid4()
        db_session.add(PatientInsight(
            id=insight_id,
            patient_id=patient_id,
            session_number=None,
            insight_type="qa_response",
            content="Aggregated answer across all sessions.",
            model="claude-sonnet-4-6",
            created_at=datetime.utcnow(),
        ))
        db_session.flush()

        retrieved = db_session.query(PatientInsight).filter_by(id=insight_id).one()
        assert retrieved.session_number is None

    def test_question_can_be_none(self, db_session):
        """Test 12: PatientInsight.question can be None (for session summaries)."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T12"))
        db_session.add(p)
        db_session.flush()

        insight_id = uuid.uuid4()
        db_session.add(PatientInsight(
            id=insight_id,
            patient_id=patient_id,
            session_number=1,
            insight_type="session_summary",
            question=None,
            content="First session summary content.",
            model="claude-haiku-4",
            created_at=datetime.utcnow(),
        ))
        db_session.flush()

        retrieved = db_session.query(PatientInsight).filter_by(id=insight_id).one()
        assert retrieved.question is None

    def test_multiple_insights_same_patient(self, db_session):
        """Test 13: Multiple PatientInsight rows can be stored for the same patient."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T13"))
        db_session.add(p)
        db_session.flush()

        for session_num in [1, 2, 3]:
            db_session.add(PatientInsight(
                id=uuid.uuid4(),
                patient_id=patient_id,
                session_number=session_num,
                insight_type="session_summary",
                content=f"Summary for session {session_num}.",
                model="claude-sonnet-4-6",
                created_at=datetime.utcnow(),
            ))
        db_session.flush()

        insights = db_session.query(PatientInsight).filter_by(patient_id=patient_id).all()
        assert len(insights) == 3
        assert {i.session_number for i in insights} == {1, 2, 3}

    def test_cascade_delete_removes_insights(self, db_session):
        """Test 14: Deleting Patient cascades to delete its PatientInsight rows."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T14"))
        db_session.add(p)
        db_session.flush()

        for i in range(3):
            db_session.add(PatientInsight(
                id=uuid.uuid4(),
                patient_id=patient_id,
                session_number=i + 1,
                insight_type="session_summary",
                content=f"Insight {i}.",
                model="claude-sonnet-4-6",
                created_at=datetime.utcnow(),
            ))
        db_session.flush()

        db_session.delete(p)
        db_session.flush()

        remaining = db_session.query(PatientInsight).filter_by(patient_id=patient_id).all()
        assert remaining == []

    def test_model_field_stores_correctly(self, db_session):
        """Test 15: PatientInsight.model field stores and retrieves the model name correctly."""
        from models.clinical import Patient, PatientInsight

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="PI-T15"))
        db_session.add(p)
        db_session.flush()

        insight_id = uuid.uuid4()
        model_name = "claude-opus-4-5"
        db_session.add(PatientInsight(
            id=insight_id,
            patient_id=patient_id,
            session_number=2,
            insight_type="session_summary",
            content="Detailed clinical summary.",
            model=model_name,
            created_at=datetime.utcnow(),
        ))
        db_session.flush()

        retrieved = db_session.query(PatientInsight).filter_by(id=insight_id).one()
        assert retrieved.model == model_name


# ===========================================================================
# All 5 table cascade delete test
# ===========================================================================

class TestCascadeDeleteAllTables:
    """Test 16: Full cascade delete — Patient + Session + Condition + Trend + Insight."""

    def test_delete_patient_cascades_all_four_related_tables(self, db_session):
        """Test 16: Deleting a Patient removes rows from all 4 related tables."""
        from models.clinical import (
            Patient,
            Session as ClinicalSession,
            PatientCondition,
            PatientTrend,
            PatientInsight,
        )

        patient_id = uuid.uuid4()
        p = Patient(**_make_patient(id=patient_id, sn="CASC-ALL"))
        db_session.add(p)
        db_session.flush()

        # Insert one Session
        session = ClinicalSession(
            id=uuid.uuid4(),
            patient_id=patient_id,
            session_number=1,
            has_followup=False,
            is_dropout=False,
        )
        db_session.add(session)

        # Insert one PatientCondition
        condition = PatientCondition(
            id=uuid.uuid4(),
            patient_id=patient_id,
            condition_group="metabolic",
            condition_label="Diabetes",
            source="tag_regex",
        )
        db_session.add(condition)

        # Insert one PatientTrend
        trend = PatientTrend(
            id=uuid.uuid4(),
            patient_id=patient_id,
            metric="vas",
            direction="improving",
            sessions_used=3,
            magnitude=Decimal("1.200"),
            first_value=Decimal("6.000"),
            last_value=Decimal("4.800"),
            computed_at=datetime.utcnow(),
        )
        db_session.add(trend)

        # Insert one PatientInsight
        insight = PatientInsight(
            id=uuid.uuid4(),
            patient_id=patient_id,
            session_number=1,
            insight_type="session_summary",
            content="Comprehensive summary for cascade test.",
            model="claude-sonnet-4-6",
            created_at=datetime.utcnow(),
        )
        db_session.add(insight)

        db_session.flush()

        # Verify all 4 related rows exist before delete
        assert db_session.query(ClinicalSession).filter_by(patient_id=patient_id).count() == 1
        assert db_session.query(PatientCondition).filter_by(patient_id=patient_id).count() == 1
        assert db_session.query(PatientTrend).filter_by(patient_id=patient_id).count() == 1
        assert db_session.query(PatientInsight).filter_by(patient_id=patient_id).count() == 1

        # Delete the patient
        db_session.delete(p)
        db_session.flush()

        # All 4 related rows must be gone
        assert db_session.query(ClinicalSession).filter_by(patient_id=patient_id).count() == 0
        assert db_session.query(PatientCondition).filter_by(patient_id=patient_id).count() == 0
        assert db_session.query(PatientTrend).filter_by(patient_id=patient_id).count() == 0
        assert db_session.query(PatientInsight).filter_by(patient_id=patient_id).count() == 0
