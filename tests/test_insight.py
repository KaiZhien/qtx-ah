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


# ── Embedding persistence ─────────────────────────────────────────────────────

def test_saving_insight_stores_embedding(db_session, monkeypatch):
    """generate_session_insight stores the embedding returned by VoyageEmbedder."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    monkeypatch.setenv("VOYAGE_API_KEY", "test-voyage-key")
    from services.insight import InsightService
    from services.voyage import VoyageEmbedder
    from models.clinical import PatientInsight

    fake_vec = [0.1] * 512
    monkeypatch.setattr(VoyageEmbedder, "embed", lambda self, text, input_type="document": fake_vec)
    monkeypatch.setattr(InsightService, "_call_claude", lambda self, msg: "- Embedding test response")

    p = _make_patient(db_session, "I008")
    InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    db_session.flush()

    row = db_session.query(PatientInsight).filter_by(patient_id=p.id).one()
    assert row.embedding is not None
    # Embedding may be stored as a numpy array by the pgvector column type
    stored = list(row.embedding) if hasattr(row.embedding, "tolist") else row.embedding
    assert stored == fake_vec


def test_saving_insight_with_null_embedding_persists_row(db_session, monkeypatch):
    """Row is still saved even when VoyageEmbedder returns None."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from services.voyage import VoyageEmbedder
    from models.clinical import PatientInsight

    monkeypatch.setattr(VoyageEmbedder, "embed", lambda self, text, input_type="document": None)
    monkeypatch.setattr(InsightService, "_call_claude", lambda self, msg: "- No embedding response")

    p = _make_patient(db_session, "I009")
    InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    db_session.flush()

    row = db_session.query(PatientInsight).filter_by(patient_id=p.id).one()
    assert row is not None
    assert row.embedding is None
    assert row.content == "- No embedding response"


# ── _retrieve_relevant behaviour ─────────────────────────────────────────────

def test_retrieve_relevant_returns_empty_when_no_embeddings(db_session, monkeypatch):
    """_retrieve_relevant returns [] when the DB query finds no matching rows."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-voyage-key")
    from services.insight import InsightService
    from services.voyage import VoyageEmbedder
    from unittest.mock import MagicMock

    monkeypatch.setattr(VoyageEmbedder, "embed", lambda self, text, input_type="document": [0.1] * 512)

    p = _make_patient(db_session, "I010")

    # Mock the DB query chain to avoid pgvector ops on SQLite
    mock_query = MagicMock()
    mock_query.filter.return_value = mock_query
    mock_query.order_by.return_value = mock_query
    mock_query.limit.return_value = mock_query
    mock_query.all.return_value = []
    monkeypatch.setattr(db_session, "query", lambda *a, **kw: mock_query)

    service = InsightService(db_session)
    result = service._retrieve_relevant(p.id, "test question")
    assert result == []


def test_retrieve_relevant_returns_empty_when_question_embedding_is_none(db_session, monkeypatch):
    """_retrieve_relevant returns [] when VoyageEmbedder returns None for the question."""
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    from services.insight import InsightService
    from services.voyage import VoyageEmbedder

    monkeypatch.setattr(VoyageEmbedder, "embed", lambda self, text, input_type="document": None)

    p = _make_patient(db_session, "I011")
    service = InsightService(db_session)
    result = service._retrieve_relevant(p.id, "does this matter?")
    assert result == []


# ── answer_question prompt content ───────────────────────────────────────────

def test_answer_question_prompt_includes_retrieved_section(db_session, monkeypatch):
    """When _retrieve_relevant returns insights, the prompt includes 'Relevant past insights'."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from unittest.mock import MagicMock
    from datetime import datetime as dt

    fake_insight = MagicMock()
    fake_insight.insight_type = "session_summary"
    fake_insight.created_at = dt(2026, 1, 1)
    fake_insight.content = "Patient showed improvement in TUG"

    captured = {}
    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [fake_insight])
    monkeypatch.setattr(
        InsightService, "_call_claude",
        lambda self, msg: captured.update({"msg": msg}) or "Answer here.",
    )

    p = _make_patient(db_session, "I012")
    InsightService(db_session).answer_question(_FAKE_TIMELINE, p.id, "How is she doing?")
    db_session.flush()

    assert "Relevant past insights" in captured["msg"]


def test_answer_question_prompt_omits_retrieved_section_when_no_results(db_session, monkeypatch):
    """When _retrieve_relevant returns [], the prompt does NOT include 'Relevant past insights'."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService

    captured = {}
    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [])
    monkeypatch.setattr(
        InsightService, "_call_claude",
        lambda self, msg: captured.update({"msg": msg}) or "No retrieval answer.",
    )

    p = _make_patient(db_session, "I013")
    InsightService(db_session).answer_question(_FAKE_TIMELINE, p.id, "Any concerns?")
    db_session.flush()

    assert "Relevant past insights" not in captured["msg"]


def test_generate_session_insight_never_raises_when_claude_fails(db_session, monkeypatch):
    """When _call_claude raises, generate_session_insight does NOT raise — it
    persists a row with model='api_error' (same pattern as AnomalyDetector)
    so session creation can never fail on a Claude outage."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from models.clinical import PatientInsight

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(InsightService, "_call_claude", raise_exc)

    p = _make_patient(db_session, "I014")
    result = InsightService(db_session).generate_session_insight(_FAKE_TIMELINE, p.id, 1)
    db_session.flush()

    assert result == InsightService.API_ERROR_RESPONSE
    row = db_session.query(PatientInsight).filter_by(patient_id=p.id).one()
    assert row.model == "api_error"
    assert row.content == InsightService.API_ERROR_RESPONSE
    assert row.insight_type == "session_summary"
    assert row.embedding is None


def test_answer_question_raises_502_when_claude_fails(db_session, monkeypatch):
    """When _call_claude raises, answer_question propagates as HTTP 502."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-abc")
    from services.insight import InsightService
    from fastapi import HTTPException

    def raise_exc(self, msg):
        raise Exception("API down")

    monkeypatch.setattr(InsightService, "_call_claude", raise_exc)
    monkeypatch.setattr(InsightService, "_retrieve_relevant", lambda self, *a, **kw: [])

    p = _make_patient(db_session, "I015")
    with pytest.raises(HTTPException) as exc_info:
        InsightService(db_session).answer_question(_FAKE_TIMELINE, p.id, "Is she improving?")
    assert exc_info.value.status_code == 502


def test_retrieve_relevant_returns_empty_on_db_exception(db_session, monkeypatch):
    """_retrieve_relevant swallows DB query exceptions and returns []."""
    monkeypatch.setenv("VOYAGE_API_KEY", "test-voyage-key")
    from services.insight import InsightService
    from services.voyage import VoyageEmbedder
    from unittest.mock import MagicMock

    monkeypatch.setattr(VoyageEmbedder, "embed", lambda self, text, input_type="document": [0.1] * 512)

    p = _make_patient(db_session, "I016")

    mock_query = MagicMock()
    mock_query.filter.return_value = mock_query
    mock_query.order_by.return_value = mock_query
    mock_query.limit.return_value = mock_query
    mock_query.all.side_effect = Exception("DB exploded")
    monkeypatch.setattr(db_session, "query", lambda *a, **kw: mock_query)

    result = InsightService(db_session)._retrieve_relevant(p.id, "test question")
    assert result == []
