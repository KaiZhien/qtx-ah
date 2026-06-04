"""Ingestion pipeline: upserts a processed patient DataFrame into PostgreSQL.

Accepts a DataFrame in the shape of dashboard_data.parquet (73 columns,
all derived values already computed). Normalises sn, upserts patients and
sessions, rebuilds patient_conditions from grp_* flags.
"""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session

from models.clinical import Patient, Session as ClinicalSession, PatientCondition

# Maps grp_* DataFrame column → (condition_group, condition_label)
_CONDITION_GROUP_MAP: dict[str, tuple[str, str]] = {
    "grp_joint_disease":     ("joint_disease",     "Joint disease"),
    "grp_spine_back":        ("spine_back",         "Spine/Back"),
    "grp_neurological":      ("neurological",       "Neurological"),
    "grp_post_surgical":     ("post_surgical",      "Post-Surgical/Rehab"),
    "grp_frailty_sarcopenia":("frailty_sarcopenia", "Frailty/Sarcopenia"),
    "grp_balance_falls":     ("balance_falls",      "Balance/Falls"),
    "grp_metabolic":         ("metabolic",          "Metabolic"),
    "grp_cardiovascular":    ("cardiovascular",     "Cardiovascular"),
    "grp_oncology":          ("oncology",           "Oncology"),
    "grp_autoimmune":        ("autoimmune",         "Autoimmune"),
    "grp_softtissue_injury": ("softtissue_injury",  "Soft-tissue injury"),
    "grp_generalised_pain":  ("generalised_pain",   "Generalised pain"),
    "grp_osteoporosis":      ("osteoporosis",       "Osteoporosis"),
    "grp_wellness":          ("wellness",           "Wellness"),
}

# All boolean flag columns that live on the Patient table
_PATIENT_FLAG_COLS: list[str] = [
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_sarcopenia",
    "has_frailty", "has_balance_issue", "has_post_surgery", "has_chronic_pain",
    "has_neuropathy", "has_cancer", "has_cardiovascular", "has_hypertension",
    "has_osteoporosis", "has_spinal_issue", "has_knee_issue", "has_hip_issue",
    "has_shoulder_issue", "has_neurological", "has_fracture", "has_autoimmune",
    "has_metabolic", "has_wellness_only", "has_fall_risk",
    "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
    "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic", "grp_cardiovascular",
    "grp_oncology", "grp_autoimmune", "grp_softtissue_injury", "grp_generalised_pain",
    "grp_osteoporosis", "grp_wellness",
    "rgn_knee", "rgn_hip", "rgn_spine", "rgn_shoulder", "rgn_ankle_foot",
    "rgn_lower_limb", "rgn_upper_limb", "rgn_bilateral", "rgn_trunk",
]

# All measurement + outcome columns that live on the Session table
_SESSION_COLS: list[str] = [
    "usage_frequency", "has_followup", "joined_with_pain", "pain_improved", "pain_location",
    "pre_vas", "post_vas", "vas_change",
    "pre_tug_s", "post_tug_s", "tug_change_s", "tug_change_pct",
    "pre_5xsst_s", "post_5xsst_s", "sst_change_s", "sst_change_pct",
    "pre_normal_time_s", "post_normal_time_s",
    "pre_normal_gs_ms", "post_normal_gs_ms", "normal_gs_change_ms", "normal_gs_change_pct",
    "pre_fast_time_s", "post_fast_time_s",
    "pre_fast_gs_ms", "post_fast_gs_ms", "fast_gs_change_ms", "fast_gs_change_pct",
    "baseline_sppb", "post_sppb", "sppb_change", "sppb_source",
    "n_pre_post_pairs", "composite_improvement", "overall_responder",
    "breadth_of_response", "is_dropout",
]


@dataclass
class RowError:
    row_index: int
    sn: str
    reason: str


@dataclass
class IngestSummary:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[RowError] = field(default_factory=list)


def _normalize_sn(raw_sn: Any) -> str | None:
    """Convert '1.0' -> '1', '42' -> '42'. Returns None if invalid."""
    if raw_sn is None or (isinstance(raw_sn, float) and math.isnan(raw_sn)):
        return None
    s = str(raw_sn).strip()
    if not s:
        return None
    # Strip trailing .0 from float-formatted Excel serials
    if s.endswith(".0"):
        s = s[:-2]
    return s


def _normalize_age_band(age: Any) -> str | None:
    """Map numeric age to dashboard age-band label."""
    try:
        a = int(age)
    except (TypeError, ValueError):
        return None
    if a < 50:   return "<50"
    if a < 60:   return "50-59"
    if a < 70:   return "60-69"
    if a < 80:   return "70-79"
    return "80+"


def _coerce(value: Any) -> Any:
    """Replace NaN / pandas NA / ML sentinel '__missing__' with None for DB insertion."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    try:
        import pandas as _pd
        if value is _pd.NA:
            return None
    except Exception:
        pass
    # ML pipeline uses '__missing__' as a categorical sentinel — treat as NULL in the DB
    if value == "__missing__":
        return None
    return value


def _bool(value: Any) -> bool:
    """Coerce int 0/1 or NaN to bool."""
    v = _coerce(value)
    if v is None:
        return False
    return bool(v)


class IngestPipeline:
    """Upsert a processed patient DataFrame into the clinical PostgreSQL tables.

    Args:
        db: An open SQLAlchemy Session (caller is responsible for commit/rollback).
        source_filename: Optional label written to sessions.ingested_from for audit.
    """

    def __init__(self, db: Session, source_filename: str | None = None):
        self._db = db
        self._source = source_filename

    def upsert(self, df: pd.DataFrame) -> IngestSummary:
        """Process every row in df. Returns an IngestSummary."""
        summary = IngestSummary()

        for idx, row in df.iterrows():
            sn = _normalize_sn(row.get("sn"))
            if not sn:
                summary.errors.append(RowError(row_index=idx, sn="<missing>", reason="sn is null or empty"))
                summary.skipped += 1
                continue

            try:
                # Use a savepoint so only this row is rolled back on failure,
                # not the entire session (which would wipe all previous inserts).
                with self._db.begin_nested():
                    was_inserted = self._upsert_row(row, sn)
                if was_inserted:
                    summary.inserted += 1
                else:
                    summary.updated += 1
            except Exception as exc:
                summary.errors.append(RowError(row_index=idx, sn=sn, reason=str(exc)))
                summary.skipped += 1

        return summary

    def _upsert_row(self, row: pd.Series, sn: str) -> bool:
        """Upsert one patient + session + conditions. Returns True if inserted."""
        # --- Patient upsert ---
        existing = self._db.query(Patient).filter_by(sn=sn).first()
        was_inserted = existing is None

        patient_data = {
            "sn": sn,
            "name": str(_coerce(row.get("name")) or ""),
            "gender": _coerce(row.get("gender")),
            "age": _coerce(row.get("age")),
            "age_band": _normalize_age_band(row.get("age")),
            "phone_number": _coerce(row.get("phone_number")),
            "tags": _coerce(row.get("tags")),
            "primary_indication": _coerce(row.get("primary_indication")),
            "cohort": _coerce(row.get("cohort")),
            "record_type": str(_coerce(row.get("record_type")) or "Active"),
            "updated_at": datetime.now(timezone.utc),
        }
        for col in _PATIENT_FLAG_COLS:
            patient_data[col] = _bool(row.get(col, False))

        if existing is None:
            patient = Patient(id=uuid.uuid4(), **patient_data)
            self._db.add(patient)
            self._db.flush()
        else:
            for k, v in patient_data.items():
                setattr(existing, k, v)
            self._db.flush()
            patient = existing

        # --- Session upsert (session_number=1 for all historical rows) ---
        existing_session = (
            self._db.query(ClinicalSession)
            .filter_by(patient_id=patient.id, session_number=1)
            .first()
        )

        session_data: dict[str, Any] = {"ingested_from": self._source}
        for col in _SESSION_COLS:
            raw = row.get(col)
            session_data[col] = _coerce(raw)

        # Normalize boolean columns explicitly
        session_data["has_followup"] = _bool(row.get("has_followup", False))
        session_data["is_dropout"] = _bool(row.get("is_dropout", False))

        joined = _coerce(row.get("joined_with_pain"))
        session_data["joined_with_pain"] = (
            None if joined is None
            else (joined == "Y" if isinstance(joined, str) else _bool(joined))
        )

        improved = _coerce(row.get("pain_improved"))
        session_data["pain_improved"] = (
            None if improved is None
            else (improved == "Y" if isinstance(improved, str) else _bool(improved))
        )

        overall = _coerce(row.get("overall_responder"))
        session_data["overall_responder"] = None if overall is None else _bool(overall)

        if existing_session is None:
            sess = ClinicalSession(
                id=uuid.uuid4(),
                patient_id=patient.id,
                session_number=1,
                **session_data,
            )
            self._db.add(sess)
        else:
            for k, v in session_data.items():
                setattr(existing_session, k, v)
        self._db.flush()

        # --- PatientConditions: delete + reinsert from grp_* flags ---
        self._db.query(PatientCondition).filter_by(patient_id=patient.id).delete()
        for grp_col, (grp_key, grp_label) in _CONDITION_GROUP_MAP.items():
            if _bool(row.get(grp_col, False)):
                self._db.add(PatientCondition(
                    id=uuid.uuid4(),
                    patient_id=patient.id,
                    condition_group=grp_key,
                    condition_label=grp_label,
                    source="tag_regex",
                ))
        self._db.flush()

        return was_inserted
