"""Clinician Q&A and insight history endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, Session as ClinicalSession, PatientInsight
from services.insight import InsightService
from services.rate_limit import rate_limit
from services.timeline import build_timeline_dict

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


def _build_timeline_dict(patient: Patient, db: DBSession) -> dict:
    """Build the timeline payload passed to InsightService.

    Shared implementation lives in services/timeline.py ("ask" variant).
    """
    return build_timeline_dict(patient, db, variant="ask")


class AskRequest(BaseModel):
    question: str


@router.post(
    "/patient/{sn}/ask",
    dependencies=[Depends(rate_limit("ask"))],
)
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


@router.post(
    "/patient/{sn}/prepare_session",
    dependencies=[Depends(rate_limit("prepare_session"))],
)
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
