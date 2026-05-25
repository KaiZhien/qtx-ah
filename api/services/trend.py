"""Trend computation service for longitudinal patient data.

TrendEngine reads all sessions for a patient ordered by session_number,
computes a direction signal per tracked metric, and upserts the results
into the patient_trends table. Called inside the session-creation
transaction so failures roll back cleanly.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session as DBSession

from models.clinical import Session as ClinicalSession, PatientTrend

# metric name → (session column name, lower_is_better)
_TRACKED_METRICS: dict[str, tuple[str, bool]] = {
    "post_vas":          ("post_vas",          True),   # pain — lower is better
    "post_tug_s":        ("post_tug_s",        True),   # mobility — lower is better
    "post_5xsst_s":      ("post_5xsst_s",      True),   # sit-stand — lower is better
    "post_normal_gs_ms": ("post_normal_gs_ms", False),  # gait speed — higher is better
    "post_fast_gs_ms":   ("post_fast_gs_ms",   False),  # fast gait — higher is better
    "post_sppb":         ("post_sppb",         False),  # balance — higher is better
}


@dataclass
class TrendResult:
    metric:        str
    direction:     str   # "baseline_only" | "early_signal" | "improving" | "declining" | "stable"
    sessions_used: int
    magnitude:     float | None  # last_value - first_value
    first_value:   float | None
    last_value:    float | None


def _compute_direction(values: list[float], lower_is_better: bool) -> str:
    """Return direction label for an ordered list of non-null post-session values."""
    n = len(values)
    if n <= 1:
        return "baseline_only"
    if n == 2:
        return "early_signal"
    # n >= 3: majority-vote on last min(n, 4) values → up to 3 deltas
    recent = values[-(min(n, 4)):]
    deltas = [recent[i] - recent[i - 1] for i in range(1, len(recent))]
    if lower_is_better:
        improving = sum(1 for d in deltas if d < 0)
        declining = sum(1 for d in deltas if d > 0)
    else:
        improving = sum(1 for d in deltas if d > 0)
        declining = sum(1 for d in deltas if d < 0)
    if improving >= 2:
        return "improving"
    if declining >= 2:
        return "declining"
    return "stable"


class TrendEngine:
    """Compute and persist trend signals for a single patient."""

    def __init__(self, db: DBSession) -> None:
        self._db = db

    def compute_and_save(self, patient_id: uuid.UUID) -> list[TrendResult]:
        """Compute trends for all tracked metrics and upsert into patient_trends.

        Returns the list of TrendResult objects (one per metric with data).
        Metrics with zero valid readings are skipped entirely.
        Must be called inside an open transaction — caller commits or rolls back.
        """
        sessions = (
            self._db.query(ClinicalSession)
            .filter_by(patient_id=patient_id)
            .order_by(ClinicalSession.session_number.asc())
            .all()
        )

        results: list[TrendResult] = []

        for metric, (col, lower_is_better) in _TRACKED_METRICS.items():
            values = [
                float(getattr(s, col))
                for s in sessions
                if getattr(s, col) is not None
            ]
            if not values:
                continue  # no data for this metric — skip

            direction = _compute_direction(values, lower_is_better)
            first_val = values[0]
            last_val  = values[-1]
            magnitude = round(last_val - first_val, 3)

            result = TrendResult(
                metric=metric,
                direction=direction,
                sessions_used=len(values),
                magnitude=magnitude,
                first_value=first_val,
                last_value=last_val,
            )
            results.append(result)

            # Upsert into patient_trends
            existing = (
                self._db.query(PatientTrend)
                .filter_by(patient_id=patient_id, metric=metric)
                .first()
            )
            if existing is None:
                self._db.add(PatientTrend(
                    id=uuid.uuid4(),
                    patient_id=patient_id,
                    metric=metric,
                    direction=direction,
                    sessions_used=len(values),
                    magnitude=magnitude,
                    first_value=first_val,
                    last_value=last_val,
                    computed_at=datetime.utcnow(),
                ))
            else:
                existing.direction     = direction
                existing.sessions_used = len(values)
                existing.magnitude     = magnitude
                existing.first_value   = first_val
                existing.last_value    = last_val
                existing.computed_at   = datetime.utcnow()

            self._db.flush()

        return results
