"""Wearable enrollment and data endpoints."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db import get_db
from models.clinical import Patient
from models.wearable import WearableEnrollment
from services import terra as terra_svc
from services import wearable_features as wf_svc

router = APIRouter()


class EnrollRequest(BaseModel):
    patient_id: uuid.UUID
    enrolled_by: str
    device_brand: str


class ConfirmEnrollmentRequest(BaseModel):
    patient_id: uuid.UUID
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
    try:
        session = terra_svc.create_widget_session(str(req.patient_id), dev_id, api_key)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Terra service unavailable: {exc}")
    return {"widget_url": session["url"], "patient_id": str(req.patient_id)}


@router.post("/wearable/confirm-enrollment")
def confirm_enrollment(req: ConfirmEnrollmentRequest, db: Session = Depends(get_db)):
    """Record a confirmed Terra device connection for a patient."""
    if db.get(Patient, req.patient_id) is None:
        raise HTTPException(status_code=404, detail=f"Patient {req.patient_id} not found")

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
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Enrollment conflict — patient already enrolled with a different Terra user ID")
    return {"status": "enrolled", "patient_id": str(req.patient_id)}


@router.delete("/wearable/enroll/{patient_id}")
def withdraw_enrollment(patient_id: uuid.UUID, db: Session = Depends(get_db)):
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
    return {"status": "withdrawn", "patient_id": str(patient_id)}


@router.get("/wearable/summary")
def get_wearable_summary(db: Session = Depends(get_db)):
    enrolled_count = db.query(WearableEnrollment).filter_by(active=True).count()
    return {"enrolled_count": enrolled_count}


@router.get("/wearable/{patient_id}/features")
def get_wearable_features(patient_id: str, db: Session = Depends(get_db)):
    """
    Return rolling-window wearable features for the fall risk model.
    Returns enrolled=False with source=clinic_only if no active enrollment
    exists (including when patient_id is not a valid UUID).
    """
    return wf_svc.get_patient_features(patient_id, db)
