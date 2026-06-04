"""Calibration endpoint — model drift status per cohort."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from db import get_db
from services.calibration import CalibrationService

router = APIRouter()


@router.get("/calibration")
def get_calibration(db: Session = Depends(get_db)) -> dict:
    """Return per-cohort MAE drift status vs stored baseline."""
    return CalibrationService.get_report(db)
