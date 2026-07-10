"""Wearable feature aggregation — callable by both the API endpoint and the fall risk predictor."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from models.wearable import (
    WearableActivity,
    WearableBody,
    WearableEnrollment,
    WearableEvent,
)


def get_patient_features(patient_id: uuid.UUID | str, db: Session) -> dict:
    """
    Return rolling-window wearable features for a patient.

    ``patient_id`` may be a uuid.UUID or its string form (wearable_enrollments
    joins patients.id via a UUID FK). Unparseable ids can never match an
    enrollment, so they return the same "clinic_only" shape.
    Returns {"enrolled": False, "source": "clinic_only"} if no active enrollment exists.
    """
    try:
        pid = patient_id if isinstance(patient_id, uuid.UUID) else uuid.UUID(str(patient_id))
    except (ValueError, TypeError, AttributeError):
        return {"enrolled": False, "source": "clinic_only"}

    enrollment = db.query(WearableEnrollment).filter_by(
        patient_id=pid, active=True
    ).first()
    if not enrollment:
        return {"enrolled": False, "source": "clinic_only"}

    uid = enrollment.terra_user_id
    today = date.today()
    d30 = today - timedelta(days=30)
    d7 = today - timedelta(days=7)

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
            WearableEvent.occurred_at >= datetime(today.year, today.month, today.day, tzinfo=timezone.utc) - timedelta(days=90),
            WearableEvent.event_type == "fall_detected",
        )
        .count()
    )

    steps_values = [r.steps for r in activity_rows if r.steps is not None]
    cadence_vals = [r.walking_cadence_avg for r in activity_rows if r.walking_cadence_avg is not None]
    hrv_vals = [r.hrv_rmssd for r in body_rows if r.hrv_rmssd is not None]

    compliant_days = sum(1 for r in activity_rows if (r.wear_minutes or 0) >= 240)
    compliance_rate = compliant_days / min(30, len(activity_rows)) if activity_rows else 0.0

    def _avg(vals: list) -> float | None:
        return sum(vals) / len(vals) if vals else None

    # Pair active and sedentary from the SAME row — avoids positional mismatch
    # when fields are sparsely populated across different days.
    sedentary_pairs = [
        (r.active_minutes, r.sedentary_minutes)
        for r in activity_rows
        if r.active_minutes is not None and r.sedentary_minutes is not None
        and (r.active_minutes + r.sedentary_minutes) > 0
    ]
    sedentary_pct = (
        sum(s / (a + s) * 100 for a, s in sedentary_pairs) / len(sedentary_pairs)
        if sedentary_pairs else None
    )

    return {
        "enrolled": True,
        "source": "clinic_and_wearable",
        "wearable_steps_30d_avg": _avg(steps_values),
        "wearable_sedentary_pct_30d": sedentary_pct,
        "wearable_cadence_avg_30d": _avg(cadence_vals),
        "wearable_hrv_trend_7d": _avg(hrv_vals),
        "wearable_fall_events_90d": fall_count,
        "wearable_compliance_rate_30d": compliance_rate,
    }
