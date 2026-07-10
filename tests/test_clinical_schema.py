"""Tests for clinical ORM model structure and constraints.

Uses an in-memory SQLite engine — no DATABASE_URL required.
SQLite does not enforce FK constraints by default; we enable them with PRAGMA.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


@pytest.fixture(scope="module")
def engine():
    import models.clinical  # noqa: F401 — registers models with Base
    import models.wearable  # noqa: F401
    from db import Base

    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})

    # Enable FK enforcement in SQLite
    @event.listens_for(eng, "connect")
    def set_sqlite_pragma(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def db_session(engine):
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.rollback()
    session.close()


def _make_patient(**kwargs) -> dict:
    defaults = dict(
        id=uuid.uuid4(),
        sn=str(uuid.uuid4())[:8],
        name="Test Patient",
        gender="M",
        age=65,
        age_band="60-69",
        record_type="Active",
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
    defaults.update(kwargs)
    return defaults


def test_patient_table_creates(engine):
    """patients table exists and is queryable."""
    inspector = inspect(engine)
    assert "patients" in inspector.get_table_names()


def test_session_table_creates(engine):
    """sessions table exists."""
    inspector = inspect(engine)
    assert "sessions" in inspector.get_table_names()


def test_patient_condition_table_creates(engine):
    """patient_conditions table exists."""
    inspector = inspect(engine)
    assert "patient_conditions" in inspector.get_table_names()


def test_patient_insert_and_retrieve(db_session):
    """Can insert a Patient and read it back."""
    from models.clinical import Patient
    p = Patient(**_make_patient(sn="P001", name="Alice"))
    db_session.add(p)
    db_session.flush()
    retrieved = db_session.query(Patient).filter_by(sn="P001").one()
    assert retrieved.name == "Alice"


def test_sn_unique_constraint(db_session):
    """Inserting two patients with the same sn raises IntegrityError."""
    from models.clinical import Patient
    p1 = Patient(**_make_patient(sn="DUPE001"))
    p2 = Patient(**_make_patient(sn="DUPE001"))
    db_session.add(p1)
    db_session.flush()
    db_session.add(p2)
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_session_requires_valid_patient_fk(db_session):
    """Inserting a Session with a non-existent patient_id raises IntegrityError."""
    from models.clinical import Session as ClinicalSession
    s = ClinicalSession(
        id=uuid.uuid4(),
        patient_id=uuid.uuid4(),  # does not exist
        session_number=1,
        has_followup=False,
        is_dropout=False,
    )
    db_session.add(s)
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_session_unique_constraint(db_session):
    """Two sessions with the same patient_id + session_number raises IntegrityError."""
    from models.clinical import Patient, Session as ClinicalSession
    patient_id = uuid.uuid4()
    p = Patient(**_make_patient(id=patient_id, sn="SESSDUP"))
    db_session.add(p)
    db_session.flush()

    s1 = ClinicalSession(id=uuid.uuid4(), patient_id=patient_id, session_number=1, has_followup=False, is_dropout=False)
    s2 = ClinicalSession(id=uuid.uuid4(), patient_id=patient_id, session_number=1, has_followup=False, is_dropout=False)
    db_session.add(s1)
    db_session.flush()
    db_session.add(s2)
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_cascade_delete_removes_sessions(db_session):
    """Deleting a Patient cascades to delete its Sessions."""
    from models.clinical import Patient, Session as ClinicalSession
    patient_id = uuid.uuid4()
    p = Patient(**_make_patient(id=patient_id, sn="CASC001"))
    db_session.add(p)
    db_session.flush()

    s = ClinicalSession(id=uuid.uuid4(), patient_id=patient_id, session_number=1, has_followup=False, is_dropout=False)
    db_session.add(s)
    db_session.flush()

    db_session.delete(p)
    db_session.flush()

    remaining = db_session.query(ClinicalSession).filter_by(patient_id=patient_id).all()
    assert remaining == []


def test_cascade_delete_removes_conditions(db_session):
    """Deleting a Patient cascades to delete its PatientConditions."""
    from models.clinical import Patient, PatientCondition
    patient_id = uuid.uuid4()
    p = Patient(**_make_patient(id=patient_id, sn="CASC002"))
    db_session.add(p)
    db_session.flush()

    c = PatientCondition(
        id=uuid.uuid4(), patient_id=patient_id,
        condition_group="joint_disease", condition_label="Joint disease", source="tag_regex",
    )
    db_session.add(c)
    db_session.flush()

    db_session.delete(p)
    db_session.flush()

    remaining = db_session.query(PatientCondition).filter_by(patient_id=patient_id).all()
    assert remaining == []


def test_session_prediction_has_no_dead_fall_risk_columns():
    """fall_risk_score / fall_risk_label were never written — dropped from the ORM."""
    from models.clinical import SessionPrediction
    cols = {c.name for c in SessionPrediction.__table__.columns}
    assert "fall_risk_score" not in cols
    assert "fall_risk_label" not in cols


def test_wearable_enrollment_patient_id_is_uuid_fk():
    """wearable_enrollments.patient_id is a UUID FK to patients.id."""
    import uuid as _uuid
    from models.wearable import WearableEnrollment
    col = WearableEnrollment.__table__.columns["patient_id"]
    assert col.type.python_type is _uuid.UUID
    fks = list(col.foreign_keys)
    assert len(fks) == 1
    assert fks[0].column.table.name == "patients"
    assert fks[0].ondelete == "CASCADE"
    assert col.nullable is False


def test_wearable_enrollment_requires_valid_patient_fk(db_session):
    """Inserting a WearableEnrollment with a non-existent patient_id raises IntegrityError."""
    from datetime import datetime, timezone
    from models.wearable import WearableEnrollment
    now = datetime.now(timezone.utc)
    e = WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id=uuid.uuid4(),  # does not exist
        terra_user_id=f"terra_{uuid.uuid4().hex[:8]}",
        device_brand="garmin",
        enrolled_at=now,
        enrolled_by="cli",
        consent_given_at=now,
        active=True,
    )
    db_session.add(e)
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_cascade_delete_removes_wearable_enrollment(db_session):
    """Deleting a Patient cascades to delete its WearableEnrollment."""
    from datetime import datetime, timezone
    from models.clinical import Patient
    from models.wearable import WearableEnrollment
    patient_id = uuid.uuid4()
    p = Patient(**_make_patient(id=patient_id, sn="CASC003"))
    db_session.add(p)
    db_session.flush()

    now = datetime.now(timezone.utc)
    e = WearableEnrollment(
        id=str(uuid.uuid4()),
        patient_id=patient_id,
        terra_user_id=f"terra_{uuid.uuid4().hex[:8]}",
        device_brand="garmin",
        enrolled_at=now,
        enrolled_by="cli",
        consent_given_at=now,
        active=True,
    )
    db_session.add(e)
    db_session.flush()

    db_session.delete(p)
    db_session.flush()

    remaining = db_session.query(WearableEnrollment).filter_by(patient_id=patient_id).all()
    assert remaining == []
