"""Clinician triage rollup endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

import deps
from db import get_db
from services.triage import build_triage

router = APIRouter()


def _check_db_ready() -> None:
    if not deps._db_ready:
        raise HTTPException(
            status_code=503,
            detail="Patient data not available — DB is empty or unreachable.",
        )


@router.get("/triage")
def get_triage(db: DBSession = Depends(get_db)):
    """Cross-patient triage worklist: patients with an active attention signal."""
    _check_db_ready()
    return build_triage(db)
