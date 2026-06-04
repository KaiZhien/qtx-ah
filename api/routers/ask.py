"""Clinician Q&A and insight history endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession, PatientTrend, PatientInsight
from services.insight import InsightService

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


def _build_timeline_dict(patient: Patient, db: DBSession) -> dict:
    """Build the timeline payload passed to InsightService."""
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
            "session_number":    s.session_number,
            "session_date":      s.session_date.isoformat() if s.session_date else None,
            "notes":             s.notes,
            # Pre-session measurements
            "pre_vas":           _v(s.pre_vas),
            "pre_tug_s":         _v(s.pre_tug_s),
            "pre_5xsst_s":       _v(s.pre_5xsst_s),
            "pre_normal_gs_ms":  _v(s.pre_normal_gs_ms),
            "pre_fast_gs_ms":    _v(s.pre_fast_gs_ms),
            "baseline_sppb":     s.baseline_sppb,
            # Post-session measurements
            "post_vas":          _v(s.post_vas),
            "post_tug_s":        _v(s.post_tug_s),
            "post_5xsst_s":      _v(s.post_5xsst_s),
            "post_normal_gs_ms": _v(s.post_normal_gs_ms),
            "post_fast_gs_ms":   _v(s.post_fast_gs_ms),
            "post_sppb":         s.post_sppb,
            # Change scores
            "vas_change":        _v(s.vas_change),
            "tug_change_pct":    _v(s.tug_change_pct),
            "sst_change_pct":    _v(s.sst_change_pct),
            # Outcomes
            "composite_improvement": _v(s.composite_improvement),
            "overall_responder": s.overall_responder,
            "is_dropout":        s.is_dropout,
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
            "sn":                patient.sn,
            "name":              patient.name,
            "age":               patient.age,
            "gender":            patient.gender,
            "cohort":            patient.cohort,
            "primary_indication": patient.primary_indication,
        },
        "sessions": [_sdict(s) for s in sessions],
        "trends":   [_tdict(t) for t in trends],
    }


class AskRequest(BaseModel):
    question: str


@router.post("/patient/{sn}/ask")
def ask_question(
    sn: str,
    payload: AskRequest,
    db: DBSession = Depends(get_db),
) -> dict:
    """Answer a clinician's free-text question using the patient's longitudinal data."""
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    timeline = _build_timeline_dict(patient, db)
    answer = InsightService(db).answer_question(timeline, patient.id, payload.question)
    db.commit()

    return {"answer": answer, "model": InsightService.MODEL}


@router.get("/patient/{sn}/insights")
def get_insights(
    sn: str,
    db: DBSession = Depends(get_db),
) -> list:
    """Return all saved AI insights for a patient, newest first."""
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    rows = (
        db.query(PatientInsight)
        .filter_by(patient_id=patient.id)
        .order_by(PatientInsight.created_at.desc())
        .all()
    )

    return [
        {
            "id":             str(r.id),
            "session_number": r.session_number,
            "insight_type":   r.insight_type,
            "question":       r.question,
            "content":        r.content,
            "model":          r.model,
            "created_at":     r.created_at.isoformat(),
        }
        for r in rows
    ]
