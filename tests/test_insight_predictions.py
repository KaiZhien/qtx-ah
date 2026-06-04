"""Tests for InsightService predictions enrichment."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_FAKE_PREDS = {
    "predicted_composite_improvement": 0.42,
    "responder_probability": 0.71,
    "dropout_probability": 0.12,
    "dosage_recommendation": "Twice / week",
}

_FAKE_TIMELINE = {
    "patient": {"sn": "T001", "name": "Test", "age": 70, "gender": "F",
                "cohort": "Pain", "primary_indication": None},
    "sessions": [{"session_number": 1, "post_tug_s": 14.0, "post_vas": 5.0}],
    "trends": [],
}


def _make_db_patient(db, sn: str):
    from models.clinical import Patient
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="F", age=70,
        age_band="70-79", record_type="Active",
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


def _make_sqlite_db():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from db import Base
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)()


def test_generate_session_insight_includes_predictions_in_prompt(monkeypatch):
    """When predictions are provided, the prompt includes a model_predictions block."""
    db = _make_sqlite_db()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    from services.insight import InsightService
    captured = {}
    monkeypatch.setattr(InsightService, "_call_claude",
                        lambda self, msg: captured.update({"msg": msg}) or "- OK")
    p = _make_db_patient(db, "TP001")
    InsightService(db).generate_session_insight(_FAKE_TIMELINE, p.id, 1, predictions=_FAKE_PREDS)
    assert "model_predictions" in captured["msg"]
    assert "dosage_recommendation" in captured["msg"]
    db.close()


def test_generate_session_insight_without_predictions_no_model_block(monkeypatch):
    """When predictions=None, the prompt does NOT include model_predictions."""
    db = _make_sqlite_db()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    from services.insight import InsightService
    captured = {}
    monkeypatch.setattr(InsightService, "_call_claude",
                        lambda self, msg: captured.update({"msg": msg}) or "- OK")
    p = _make_db_patient(db, "TP002")
    InsightService(db).generate_session_insight(_FAKE_TIMELINE, p.id, 1, predictions=None)
    assert "model_predictions" not in captured["msg"]
    db.close()


def test_system_prompt_includes_prediction_instruction():
    """The system prompt tells Claude to reference predictions explicitly."""
    from services.insight import _SYSTEM_PROMPT
    assert "model predictions" in _SYSTEM_PROMPT.lower()


def test_format_predictions_includes_dropout_risk():
    """_format_predictions includes dropout_risk label when dropout_probability is present."""
    from services.insight import _format_predictions
    result = _format_predictions({"dropout_probability": 0.72, "dosage_recommendation": "Twice / week"})
    assert "HIGH" in result.get("dropout_risk", "")


def test_format_predictions_low_dropout():
    """_format_predictions shows LOW for dropout when probability <= 0.5."""
    from services.insight import _format_predictions
    result = _format_predictions({"dropout_probability": 0.20})
    assert "LOW" in result.get("dropout_risk", "")


def test_format_predictions_skips_none_fields():
    """_format_predictions omits keys where value is None."""
    from services.insight import _format_predictions
    result = _format_predictions({"predicted_composite_improvement": None,
                                   "dosage_recommendation": "Once / week"})
    assert "predicted_composite_improvement" not in result
    assert result.get("dosage_recommendation") == "Once / week"
