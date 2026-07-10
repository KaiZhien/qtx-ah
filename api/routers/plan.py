"""Treatment plan generation endpoint."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, SessionPrediction
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

    Shared implementation lives in services/timeline.py ("plan" variant).
    """
    return build_timeline_dict(patient, db, variant="plan")


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


@router.post(
    "/patient/{sn}/suggest_plan",
    dependencies=[Depends(rate_limit("suggest_plan"))],
)
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
