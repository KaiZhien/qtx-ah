"""Unit tests for InsightService — SQLite in-memory, no Anthropic key required."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

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
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


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


_FAKE_TIMELINE = {
    "patient": {"sn": "I001", "name": "Test Patient", "age": 65, "gender": "F",
                "cohort": "Pain", "primary_indication": "OA knee"},
    "sessions": [{"session_number": 1, "post_tug_s": 14.0, "post_vas": 6.0}],
    "trends": [{"metric": "post_tug_s", "direction": "baseline_only",
                "sessions_used": 1, "magnitude": 0.0, "first_value": 14.0, "last_value": 14.0}],
}


# ── Stub mode (no API key) ────────────────────────────────────────────────────

def test_stub_mode_returns_stub_response(db_session, monkeypatch):
    """When ANTHROPIC_API_KEY is absent, generate_session_insight returns STUB_RESPONSE."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.insight import InsightService
    p = _make_patient(db_session, "I001")

    result = InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    db_session.flush()

    assert result == InsightService.STUB_RESPONSE


def test_stub_mode_saves_row_with_model_stub(db_session, monkeypatch):
    """Stub mode persists a PatientInsight row with model='stub'."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.insight import InsightService
    from models.clinical import PatientInsight
    p = _make_patient(db_session, "I002")

    InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    db_session.flush()

    row = db_session.query(PatientInsight).filter_by(patient_id=p.id).one()
    assert row.model == "stub"
    assert row.insight_type == "session_summary"
    assert row.session_number == 1
    assert row.content == InsightService.STUB_RESPONSE


def test_stub_mode_qa_saves_row(db_session, monkeypatch):
    """Stub mode for answer_question saves a qa_response row with question set."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from services.insight import InsightService
    from models.clinical import PatientInsight
    p = _make_patient(db_session, "I003")

    result = InsightService(db_session).answer_question(
        _FAKE_TIMELINE, p.id, "How is the patient progressing?"
    )
    db_session.flush()

    assert result == InsightService.STUB_RESPONSE
    row = db_session.query(PatientInsight).filter_by(patient_id=p.id).one()
    assert row.insight_type == "qa_response"
    assert row.question == "How is the patient progressing?"
    assert row.session_number is None


# ── Real mode (monkeypatched _call_claude) ────────────────────────────────────

def test_real_mode_returns_claude_response(db_session, monkeypatch):
    """With API key set and _call_claude patched, returns the mock response."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    monkeypatch.setattr(InsightService, "_call_claude", lambda self, msg: "- Pain improved\n- TUG stable")

    p = _make_patient(db_session, "I004")
    result = InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 2)
    db_session.flush()

    assert result == "- Pain improved\n- TUG stable"


def test_real_mode_saves_row_with_correct_model(db_session, monkeypatch):
    """Real mode saves a PatientInsight row with model=InsightService.MODEL."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from models.clinical import PatientInsight
    monkeypatch.setattr(InsightService, "_call_claude", lambda self, msg: "- Good progress")

    p = _make_patient(db_session, "I005")
    InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    db_session.flush()

    row = db_session.query(PatientInsight).filter_by(patient_id=p.id).one()
    assert row.model == InsightService.MODEL
    assert row.content == "- Good progress"


def test_real_mode_prompt_contains_session_number(db_session, monkeypatch):
    """The session summary prompt includes the session number."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    captured = {}
    monkeypatch.setattr(
        InsightService, "_call_claude",
        lambda self, msg: captured.update({"msg": msg}) or "- OK",
    )

    p = _make_patient(db_session, "I006")
    InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 3)
    db_session.flush()

    assert "session 3" in captured["msg"]


def test_real_mode_qa_prompt_contains_question(db_session, monkeypatch):
    """The Q&A prompt includes the clinician's question."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    captured = {}
    monkeypatch.setattr(
        InsightService, "_call_claude",
        lambda self, msg: captured.update({"msg": msg}) or "She is improving.",
    )

    p = _make_patient(db_session, "I007")
    q = "Is her gait speed improving?"
    InsightService(db_session).answer_question(_FAKE_TIMELINE, p.id, q)
    db_session.flush()

    assert q in captured["msg"]
