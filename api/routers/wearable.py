"""Wearable enrollment and data endpoints."""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db import get_db
from models.wearable import WearableActivity, WearableBody, WearableEnrollment, WearableEvent, WearableSleep
from services import terra as terra_svc

router = APIRouter()


class EnrollRequest(BaseModel):
    patient_id: str
    enrolled_by: str
    device_brand: str


class ConfirmEnrollmentRequest(BaseModel):
    patient_id: str
    terra_user_id: str
    device_brand: str
    enrolled_by: str


@router.post("/wearable/enroll")
def enroll_patient(req: EnrollRequest):
    """Create a Terra widget session URL for patient device connection."""
    dev_id = os.environ.get("TERRA_DEV_ID", "")
    api_key = os.environ.get("TERRA_API_KEY", "")
    if not dev_id or not api_key:
        raise HTTPException(status_code=503, detail="Terra credentials not configured")
    session = terra_svc.create_widget_session(req.patient_id, dev_id, api_key)
    return {"widget_url": session["url"], "patient_id": req.patient_id}


@router.post("/wearable/confirm-enrollment")
def confirm_enrollment(req: ConfirmEnrollmentRequest, db: Session = Depends(get_db)):
    """Record a confirmed Terra device connection for a patient."""
    now = datetime.now(timezone.utc)
    existing = db.query(WearableEnrollment).filter_by(patient_id=req.patient_id).first()
    if existing:
        existing.terra_user_id = req.terra_user_id
        existing.device_brand = req.device_brand
        existing.active = True
        existing.consent_withdrawn_at = None
    else:
        enrollment = WearableEnrollment(
            id=str(uuid.uuid4()),
            patient_id=req.patient_id,
            terra_user_id=req.terra_user_id,
            device_brand=req.device_brand,
            enrolled_at=now,
            enrolled_by=req.enrolled_by,
            consent_given_at=now,
            active=True,
        )
        db.add(enrollment)
    db.commit()
    return {"status": "enrolled", "patient_id": req.patient_id}


@router.delete("/wearable/enroll/{patient_id}")
def withdraw_enrollment(patient_id: str, db: Session = Depends(get_db)):
    """Withdraw patient consent — revoke Terra connection and mark inactive."""
    enrollment = db.query(WearableEnrollment).filter_by(
        patient_id=patient_id, active=True
    ).first()
    if not enrollment:
        raise HTTPException(status_code=404, detail="No active enrollment found")

    dev_id = os.environ.get("TERRA_DEV_ID", "")
    api_key = os.environ.get("TERRA_API_KEY", "")
    if dev_id and api_key:
        try:
            terra_svc.deactivate_user(enrollment.terra_user_id, dev_id, api_key)
        except Exception:
            pass

    enrollment.active = False
    enrollment.consent_withdrawn_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "withdrawn", "patient_id": patient_id}


@router.get("/wearable/{patient_id}/features")
def get_wearable_features(patient_id: str, db: Session = Depends(get_db)):
    """
    Return rolling-window wearable features for the fall risk model.
    Returns enrolled=False with source=clinic_only if no active enrollment exists.
    """
    enrollment = db.query(WearableEnrollment).filter_by(
        patient_id=patient_id, active=True
    ).first()
    if not enrollment:
        return {"enrolled": False, "source": "clinic_only"}

    uid = enrollment.terra_user_id
    today = date.today()
    d30 = today - timedelta(days=30)
    d7 = today - timedelta(days=7)
    d90 = today - timedelta(days=90)

    activity_rows = (
        db.query(WearableActivity)
        .filter(WearableActivity.terra_user_id == uid, WearableActivity.date >= d30)
        .all()
    )
    body_rows = (
        db.query(WearableBody)
        .filter(WearableBody.terra_user_id == uid, WearableBody.date >= d7)
        .all()
    )
    fall_count = (
        db.query(WearableEvent)
        .filter(
            WearableEvent.terra_user_id == uid,
            WearableEvent.occurred_at >= _to_dt(d90),
            WearableEvent.event_type == "fall_detected",
        )
        .count()
    )

    steps_values = [r.steps for r in activity_rows if r.steps is not None]
    active_vals = [r.active_minutes for r in activity_rows if r.active_minutes is not None]
    sedentary_vals = [r.sedentary_minutes for r in activity_rows if r.sedentary_minutes is not None]
    cadence_vals = [r.walking_cadence_avg for r in activity_rows if r.walking_cadence_avg is not None]
    hrv_vals = [r.hrv_rmssd for r in body_rows if r.hrv_rmssd is not None]

    compliant_days = sum(1 for r in activity_rows if (r.wear_minutes or 0) >= 240)
    compliance_rate = compliant_days / 30 if activity_rows else 0.0

    def _avg(vals: list) -> float | None:
        return sum(vals) / len(vals) if vals else None

    def _sedentary_pct(active: list, sedentary: list) -> float | None:
        if not active or not sedentary:
            return None
        pairs = [(a, s) for a, s in zip(active, sedentary) if a + s > 0]
        return sum(s / (a + s) * 100 for a, s in pairs) / len(pairs) if pairs else None

    return {
        "enrolled": True,
        "source": "clinic_and_wearable",
        "wearable_steps_30d_avg": _avg(steps_values),
        "wearable_sedentary_pct_30d": _sedentary_pct(active_vals, sedentary_vals),
        "wearable_cadence_avg_30d": _avg(cadence_vals),
        "wearable_hrv_trend_7d": _avg(hrv_vals),
        "wearable_fall_events_90d": fall_count,
        "wearable_compliance_rate_30d": compliance_rate,
    }


def _to_dt(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
