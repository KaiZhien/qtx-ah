"""Script 16 — Ingest RAISE combined dataset into PostgreSQL.

Reads Raise combined data (4 centres).xlsx and creates one Patient row
and one Session row (session_number=1) per patient.

Usage:
    DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \\
    PYTHONPATH=api .venv/bin/python3.14 scripts/16_ingest_raise_data.py
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import pandas as pd
from sqlalchemy.orm import Session as DBSession

EXCEL_PATH = Path(__file__).resolve().parent.parent / "data" / "Raise combined data (4 centres).xlsx"
SHEET = "All Combined 21Aug23"
SOURCE = "Raise combined data (4 centres).xlsx"


# ── helpers ───────────────────────────────────────────────────────────────────

def _to_float(val) -> float | None:
    if val is None:
        return None
    try:
        import math
        f = float(val)
        return None if math.isnan(f) else f
    except (ValueError, TypeError):
        return None


def _to_int(val) -> int | None:
    f = _to_float(val)
    return None if f is None else int(round(f))


def _age_band(age: int) -> str:
    if age < 50:
        return "<50"
    if age < 60:
        return "50-59"
    if age < 70:
        return "60-69"
    if age < 80:
        return "70-79"
    return "80+"


def _parse_tags(tags: str | None) -> dict:
    """Map free-text tags to has_* boolean flags."""
    import re as _re
    t = (tags or "").lower()
    has_stroke = "stroke" in t
    has_parkinsons = "parkinson" in t
    has_neurological = "dementia" in t or has_parkinsons or "neurolog" in t
    has_oa = bool(_re.search(r'\boa\b', t)) or "osteoarthritis" in t
    has_spinal = "back pain" in t or "spine" in t or "spinal" in t or "myelopathy" in t
    has_knee = "knee" in t
    has_shoulder = "shoulder" in t
    has_frailty = "frail" in t
    has_chronic_pain = "pain" in t
    return {
        "has_oa": has_oa,
        "has_diabetes": "diabetes" in t,
        "has_stroke": has_stroke,
        "has_parkinsons": has_parkinsons,
        "has_sarcopenia": "sarcopenia" in t,
        "has_frailty": has_frailty,
        "has_balance_issue": "balance" in t,
        "has_post_surgery": "surgery" in t or "post-op" in t,
        "has_chronic_pain": has_chronic_pain,
        "has_neuropathy": "numbness" in t or "neuropath" in t,
        "has_cancer": "cancer" in t,
        "has_cardiovascular": "cardiovascular" in t or "cholesterol" in t or "heart" in t,
        "has_hypertension": "hypertension" in t,
        "has_osteoporosis": "osteoporosis" in t or "osteopenia" in t,
        "has_spinal_issue": has_spinal,
        "has_knee_issue": has_knee,
        "has_hip_issue": "hip" in t,
        "has_shoulder_issue": has_shoulder,
        "has_neurological": has_neurological,
        "has_fracture": "fracture" in t,
        "has_autoimmune": "autoimmune" in t or "lupus" in t or "rheumatoid" in t,
        "has_metabolic": "metabolic" in t,
        "has_wellness_only": False,
        "has_fall_risk": "wheelchair" in t or "fall" in t,
        # Cohort groups
        "grp_joint_disease": has_oa or has_knee,
        "grp_spine_back": has_spinal,
        "grp_neurological": has_stroke or has_parkinsons or has_neurological,
        "grp_post_surgical": "surgery" in t,
        "grp_frailty_sarcopenia": has_frailty or "sarcopenia" in t,
        "grp_balance_falls": True,  # all RAISE patients did balance training
        "grp_metabolic": "diabetes" in t or "metabolic" in t,
        "grp_cardiovascular": "cardiovascular" in t or "cholesterol" in t,
        "grp_oncology": "cancer" in t,
        "grp_autoimmune": "autoimmune" in t or "rheumatoid" in t,
        "grp_softtissue_injury": "soft tissue" in t,
        "grp_generalised_pain": has_chronic_pain,
        "grp_osteoporosis": "osteoporosis" in t or "osteopenia" in t,
        "grp_wellness": False,
        # Region flags
        "rgn_knee": has_knee,
        "rgn_hip": "hip" in t,
        "rgn_spine": has_spinal,
        "rgn_shoulder": has_shoulder,
        "rgn_ankle_foot": "ankle" in t or "foot" in t,
        "rgn_lower_limb": has_knee or "lower limb" in t or "leg" in t,
        "rgn_upper_limb": has_shoulder or "upper limb" in t or "arm" in t,
        "rgn_bilateral": "bilateral" in t,
        "rgn_trunk": "trunk" in t or "back" in t,
    }


# ── load ─────────────────────────────────────────────────────────────────────

def _load() -> pd.DataFrame:
    df = pd.read_excel(EXCEL_PATH, sheet_name=SHEET, skiprows=3, header=0)
    df = df.dropna(subset=["Name"])
    return df


# ── ingest ────────────────────────────────────────────────────────────────────

def _ingest_row(row: pd.Series, db: DBSession) -> tuple[str, str]:
    """Insert Patient + Session for one RAISE row. Returns (sn, status)."""
    from models.clinical import Patient, Session

    sn = str(row["S/N"]).strip()
    name = str(row["Name"]).strip()
    gender_raw = str(row.get("Gender", "")).strip()
    gender = gender_raw[:1].upper() if gender_raw else None
    if gender not in ("M", "F"):
        gender = None

    age_val = _to_int(row.get("Age"))
    if age_val is None:
        dob = row.get("DOB")
        if pd.notna(dob) and hasattr(dob, "year"):
            age_val = 2023 - dob.year  # data collected Aug 2023

    tags = str(row.get("Tags", "")) if pd.notna(row.get("Tags")) else None
    flags = _parse_tags(tags)
    centre = sn.split()[0] if " " in sn else sn[:2]
    ab = _age_band(age_val) if age_val is not None else None

    # Check for existing patient
    existing = db.query(Patient).filter_by(sn=sn).first()
    if existing:
        return sn, "skipped (already exists)"

    now = datetime.now(timezone.utc)
    patient = Patient(
        id=uuid.uuid4(),
        sn=sn,
        name=name,
        gender=gender,
        age=age_val,
        age_band=ab,
        tags=tags,
        cohort=centre,
        record_type="Active",
        pre_tandem_s=_to_float(row.get("Pre Tandem result (s)")),
        baseline_sppb=_to_int(row.get("SPPB OVERALL SCORE")),
        created_at=now,
        updated_at=now,
        **flags,
    )
    db.add(patient)
    db.flush()

    session = Session(
        id=uuid.uuid4(),
        patient_id=patient.id,
        session_number=1,
        has_followup=True,
        is_dropout=False,
        ingested_from=SOURCE,
        ingested_at=now,
        pre_normal_gs_ms=_to_float(row.get("Pre Normal Gait Speed (m/s)")),
        pre_tug_s=_to_float(row.get("Pre TUG result (s)")),
        pre_5xsst_s=_to_float(row.get("Pre 5XSST result (s)")),
        pre_vas=_to_float(row.get("Pre Bixeps VAS")),
        post_tandem_s=_to_float(row.get("Post Tandem result (s)")),
        post_normal_gs_ms=_to_float(row.get("Post Normal Gait Speed (m/s)")),
        post_tug_s=_to_float(row.get("Post TUG result (s)")),
        post_5xsst_s=_to_float(row.get("Post 5XSST result (s)")),
        post_vas=_to_float(row.get("Post BIXEPS VAS")),
        post_sppb=_to_int(row.get("SPPB OVERALL SCORE.1")),
    )
    db.add(session)
    db.flush()

    return sn, "inserted"


def main() -> None:
    from db import init_db, get_db

    print(f"Loading {EXCEL_PATH.name} ...")
    df = _load()
    print(f"  {len(df)} patient rows found")

    print("Initialising DB ...")
    init_db()

    db = next(get_db())
    inserted = skipped = errors = 0
    error_list: list[str] = []

    try:
        for _, row in df.iterrows():
            try:
                sn, status = _ingest_row(row, db)
                if status == "inserted":
                    inserted += 1
                else:
                    skipped += 1
            except Exception as exc:
                sn = str(row.get("S/N", "?"))
                error_list.append(f"  {sn}: {exc}")
                errors += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print()
    print("=" * 50)
    print("  RAISE ingest complete")
    print("=" * 50)
    print(f"  Inserted : {inserted}")
    print(f"  Skipped  : {skipped}")
    print(f"  Errors   : {errors}")
    if error_list:
        print()
        print("Errors:")
        for e in error_list:
            print(e)


if __name__ == "__main__":
    main()
