"""Treatment plan generation endpoint."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession, PatientTrend, SessionPrediction
from services.insight import InsightService

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


def _build_timeline_dict(patient: Patient, db: DBSession) -> dict:
    def _v(val):
        if val is None:
            return None
        if hasattr(val, "__float__"):
            return float(val)
        return val

    sessions = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number.asc())
        .all()
    )
    trends = db.query(PatientTrend).filter_by(patient_id=patient.id).all()

    def _sdict(s: ClinicalSession) -> dict:
        return {
            "session_number":        s.session_number,
            "session_date":          s.session_date.isoformat() if s.session_date else None,
            "usage_frequency":       s.usage_frequency,
            "pre_vas":               _v(s.pre_vas),
            "pre_tug_s":             _v(s.pre_tug_s),
            "pre_5xsst_s":           _v(s.pre_5xsst_s),
            "pre_normal_gs":         _v(s.pre_normal_gs_ms),
            "pre_fast_gs":           _v(s.pre_fast_gs_ms),
            "baseline_sppb":         s.baseline_sppb,
            "post_vas":              _v(s.post_vas),
            "post_tug_s":            _v(s.post_tug_s),
            "post_5xsst_s":          _v(s.post_5xsst_s),
            "post_normal_gs":        _v(s.post_normal_gs_ms),
            "post_fast_gs":          _v(s.post_fast_gs_ms),
            "post_sppb":             s.post_sppb,
            "post_tandem_s":         _v(s.post_tandem_s),
            "vas_change":            _v(s.vas_change),
            "tug_change_pct":        _v(s.tug_change_pct),
            "sst_change_pct":        _v(s.sst_change_pct),
            "normal_gs_change_pct":  _v(s.normal_gs_change_pct),
            "fast_gs_change_pct":    _v(s.fast_gs_change_pct),
            "sppb_change":           s.sppb_change,
            "composite_improvement": _v(s.composite_improvement),
            "overall_responder":     s.overall_responder,
            "is_dropout":            s.is_dropout,
        }

    def _tdict(t: PatientTrend) -> dict:
        return {
            "metric":        t.metric,
            "direction":     t.direction,
            "sessions_used": t.sessions_used,
            "magnitude":     float(t.magnitude) if t.magnitude is not None else None,
            "first_value":   float(t.first_value) if t.first_value is not None else None,
            "last_value":    float(t.last_value) if t.last_value is not None else None,
        }

    return {
        "patient": {
            "sn":                 patient.sn,
            "age":                patient.age,
            "age_band":           patient.age_band,
            "gender":             patient.gender,
            "cohort":             patient.cohort,
            "primary_indication": patient.primary_indication,
            "baseline_sppb":      patient.baseline_sppb,
            "has_frailty":        patient.has_frailty,
            "has_diabetes":       patient.has_diabetes,
            "has_neurological":   patient.has_neurological,
            "has_stroke":         patient.has_stroke,
            "has_fall_risk":      patient.has_fall_risk,
            "has_oa":             patient.has_oa,
            "has_balance_issue":  patient.has_balance_issue,
            "has_chronic_pain":   patient.has_chronic_pain,
            "has_knee_issue":     patient.has_knee_issue,
            "has_spinal_issue":   patient.has_spinal_issue,
        },
        "sessions": [_sdict(s) for s in sessions],
        "trends":   [_tdict(t) for t in trends],
    }


def _load_latest_predictions(patient: Patient, db: DBSession) -> dict | None:
    row = (
        db.query(SessionPrediction)
        .filter_by(patient_id=patient.id)
        .order_by(SessionPrediction.predicted_at.desc())
        .first()
    )
    if row is None:
        return None
    shap = row.shap_top5 if hasattr(row, "shap_top5") else None
    return {
        "predicted_composite_improvement": float(row.predicted_composite_improvement) if row.predicted_composite_improvement is not None else None,
        "responder_probability":           float(row.responder_probability) if row.responder_probability is not None else None,
        "dropout_probability":             float(row.dropout_probability) if row.dropout_probability is not None else None,
        "dosage_recommendation":           row.dosage_recommendation,
        "shap_top5":                       shap,
    }


class PlanRequest(BaseModel):
    session_focus: str | None = None
    plan_sessions: int = 4


@router.post("/patient/{sn}/suggest_plan")
def suggest_plan(
    sn: str,
    payload: PlanRequest,
    db: DBSession = Depends(get_db),
) -> dict:
    """Generate a structured treatment plan for a patient."""
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    timeline = _build_timeline_dict(patient, db)
    predictions = _load_latest_predictions(patient, db)

    plan = InsightService(db).generate_treatment_plan(
        timeline=timeline,
        patient_id=patient.id,
        predictions=predictions,
        clinician_focus=payload.session_focus,
        plan_sessions=payload.plan_sessions,
    )
    db.commit()

    return {
        "plan": plan,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
