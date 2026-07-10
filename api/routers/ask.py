"""Clinician Q&A and insight history endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
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
            "usage_frequency":   s.usage_frequency,
            "notes":             s.notes,
            # Pre-session measurements
            "pre_vas":           _v(s.pre_vas),
            "pre_tug_s":         _v(s.pre_tug_s),
            "pre_5xsst_s":       _v(s.pre_5xsst_s),
            "pre_normal_gs":     _v(s.pre_normal_gs_ms),
            "pre_fast_gs":       _v(s.pre_fast_gs_ms),
            "baseline_sppb":     s.baseline_sppb,
            # Post-session measurements
            "post_vas":          _v(s.post_vas),
            "post_tug_s":        _v(s.post_tug_s),
            "post_5xsst_s":      _v(s.post_5xsst_s),
            "post_normal_gs":    _v(s.post_normal_gs_ms),
            "post_fast_gs":      _v(s.post_fast_gs_ms),
            "post_sppb":         s.post_sppb,
            "post_tandem_s":     _v(s.post_tandem_s),
            # Change scores
            "vas_change":        _v(s.vas_change),
            "tug_change_pct":    _v(s.tug_change_pct),
            "sst_change_pct":    _v(s.sst_change_pct),
            "normal_gs_change_pct": _v(s.normal_gs_change_pct),
            "fast_gs_change_pct":   _v(s.fast_gs_change_pct),
            "sppb_change":          s.sppb_change,
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
            "age":               patient.age,
            "age_band":          patient.age_band,
            "gender":            patient.gender,
            "cohort":            patient.cohort,
            "primary_indication": patient.primary_indication,
            "baseline_sppb":     patient.baseline_sppb,
            "pre_tandem_s":      float(patient.pre_tandem_s) if patient.pre_tandem_s is not None else None,
            # Key phenotype flags for RAISE-validated response patterns
            "has_frailty":       patient.has_frailty,
            "has_diabetes":      patient.has_diabetes,
            "has_neurological":  patient.has_neurological,
            "has_stroke":        patient.has_stroke,
            "has_parkinsons":    patient.has_parkinsons,
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


@router.post("/patient/{sn}/prepare_session")
def prepare_session(
    sn: str,
    force: bool = Query(default=False),
    db: DBSession = Depends(get_db),
) -> dict:
    """Return a pre-session briefing for the physiotherapist.

    If a brief already exists for the latest session_number it is returned from
    cache. Pass ?force=true to skip the cache and regenerate.
    """
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    latest_session = (
        db.query(ClinicalSession)
        .filter_by(patient_id=patient.id)
        .order_by(ClinicalSession.session_number.desc())
        .first()
    )
    session_number = latest_session.session_number if latest_session else 0

    if not force:
        existing = (
            db.query(PatientInsight)
            .filter(
                PatientInsight.patient_id == patient.id,
                PatientInsight.insight_type == "pre_session_brief",
                PatientInsight.session_number == session_number,
            )
            .order_by(PatientInsight.created_at.desc())
            .first()
        )
        if existing is not None:
            return {
                "brief": existing.content,
                "cached": True,
                "created_at": existing.created_at.isoformat(),
            }

    timeline = _build_timeline_dict(patient, db)
    brief = InsightService(db).generate_pre_session_brief(timeline, patient.id, session_number)
    db.commit()

    row = (
        db.query(PatientInsight)
        .filter(
            PatientInsight.patient_id == patient.id,
            PatientInsight.insight_type == "pre_session_brief",
            PatientInsight.session_number == session_number,
        )
        .order_by(PatientInsight.created_at.desc())
        .first()
    )
    created_at = row.created_at.isoformat() if row else ""

    return {"brief": brief, "cached": False, "created_at": created_at}


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
