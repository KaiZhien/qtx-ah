"""Anomaly warning endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from models.clinical import Patient, PatientInsight

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


@router.get("/patient/{sn}/anomalies/latest")
def get_latest_anomaly(
    sn: str,
    db: DBSession = Depends(get_db),
):
    """Return the most recent anomaly_warning insight for a patient, or null if none exists."""
    _check_db_ready()

    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    row = (
        db.query(PatientInsight)
        .filter_by(patient_id=patient.id, insight_type="anomaly_warning")
        .order_by(PatientInsight.session_number.desc(), PatientInsight.created_at.desc())
        .limit(1)
        .first()
    )

    if row is None:
        return None

    return {
        "session_number": row.session_number,
        "content": row.content,
        "created_at": row.created_at.isoformat(),
    }
