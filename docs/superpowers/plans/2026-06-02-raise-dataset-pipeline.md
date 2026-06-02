# RAISE Dataset Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load 162 RAISE eldercare patients from Excel into the existing PostgreSQL DB so they are fully queryable via the API, AI tab, and PDF export.

**Architecture:** Three sequential steps — EDA first to surface data quality issues, then a DB migration to add the Tandem stand columns (unique to RAISE), then an ingestion script that maps the Excel to Patient + Session rows using the existing ORM. Pre measurements → Patient baseline fields; post measurements → Session (session_number=1).

**Tech Stack:** Python 3.14, pandas, SQLAlchemy 2, PostgreSQL 17, existing `api/models/clinical.py` ORM, pytest.

---

## Pre-flight

- **Source file:** `/Users/reetmitra/Downloads/Raise combined data (4 centres).xlsx`, sheet `All Combined 21Aug23`, headers on row 3 (0-indexed), data from row 4.
- **Python:** `.venv/bin/python3.14` (from project root `/Users/reetmitra/Desktop/QTX/quantumtx-ah`)
- **Test runner:** `PYTHONPATH=src:api .venv/bin/pytest`
- **DB URL:** `postgresql+psycopg2://qtx:secret@localhost:5432/qtxah`

## Column mapping (Excel → DB)

| Excel column | DB field | Notes |
|---|---|---|
| `S/N` | `patients.sn` | e.g. "METTA 1", "LB 3", "PH 12" |
| `Name` | `patients.name` | |
| `Gender` | `patients.gender` | strip whitespace, take first char, uppercase |
| `Age` | `patients.age` | fallback: compute from DOB |
| `Tags` | `patients.tags` + `has_*` flags | parsed via keyword matching |
| S/N prefix | `patients.cohort` | "METTA", "LB", or "PH" |
| `Pre Tandem result (s)` | `patients.pre_tandem_s` | NEW — migration 14 |
| `Pre Normal Gait Speed (m/s)` | `patients.pre_normal_gs_ms` | |
| `Pre TUG result (s)` | `patients.pre_tug_s` | |
| `Pre 5XSST result (s)` | `patients.pre_5xsst_s` | |
| `Pre Bixeps VAS` (col 30) | `patients.pre_vas` | overall pain only |
| `SPPB OVERALL SCORE` (col 45) | `patients.baseline_sppb` | |
| `Post Tandem result (s)` | `sessions.post_tandem_s` | NEW — migration 14 |
| `Post Normal Gait Speed (m/s)` | `sessions.post_normal_gs_ms` | |
| `Post TUG result (s)` | `sessions.post_tug_s` | |
| `Post 5XSST result (s)` | `sessions.post_5xsst_s` | |
| `Post BIXEPS VAS` (col 31) | `sessions.post_vas` | |
| `SPPB OVERALL SCORE.1` (col 51) | `sessions.post_sppb` | |

**Tag → flag mapping:**
```
has_oa          ← "OA" or "Osteo" in tags
has_diabetes    ← "Diabetes" in tags
has_stroke      ← "Stroke" in tags
has_parkinsons  ← "Parkinson" in tags
has_hypertension← "Hypertension" in tags
has_neuropathy  ← "Numbness" in tags
has_frailty     ← "Frail" in tags
has_spinal_issue← "Back Pain" or "Spine" or "Spinal" in tags
has_knee_issue  ← "Knee" in tags
has_shoulder_issue ← "Shoulder" in tags
has_neurological← "Dementia" or "Parkinson" or "Neurolog" in tags
has_chronic_pain← "Pain" in tags (any kind)
has_cardiovascular ← "Cholesterol" or "Cardiovascular" in tags
has_cancer      ← "Cancer" in tags
has_fall_risk   ← "Wheelchair" in tags
grp_neurological← has_stroke or has_parkinsons or has_neurological
grp_balance_falls ← True (all RAISE patients did balance training)
grp_frailty_sarcopenia ← has_frailty
grp_joint_disease ← has_oa or has_knee_issue
grp_spine_back  ← has_spinal_issue
grp_cardiovascular ← has_cardiovascular
```

**Constants for all RAISE rows:**
```
record_type     = "Active"
usage_frequency = "Once weekly (BIXEPS)"
ingested_from   = "Raise combined data (4 centres).xlsx"
has_followup    = True   (on session row)
is_dropout      = False  (on session row)
session_number  = 1
```

---

## Files created / modified

| File | Action |
|---|---|
| `scripts/14_eda_raise_data.py` | Create — EDA + data quality report |
| `scripts/15_migrate_add_tandem.py` | Create — adds pre/post_tandem_s columns |
| `api/models/clinical.py` | Modify — add tandem fields to Patient + Session |
| `scripts/16_ingest_raise_data.py` | Create — maps Excel → Patient + Session rows |
| `tests/test_raise_ingest.py` | Create — unit tests for mapper and tag parser |

---

## Task 1: EDA + data quality report

**Files:**
- Create: `scripts/14_eda_raise_data.py`

- [ ] **Step 1: Create the EDA script**

Create `/Users/reetmitra/Desktop/QTX/quantumtx-ah/scripts/14_eda_raise_data.py`:

```python
"""Script 14 — EDA for RAISE combined dataset (4 eldercare centres).

Usage:
    .venv/bin/python3.14 scripts/14_eda_raise_data.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

EXCEL_PATH = Path("/Users/reetmitra/Downloads/Raise combined data (4 centres).xlsx")
SHEET = "All Combined 21Aug23"


def _load() -> pd.DataFrame:
    df = pd.read_excel(EXCEL_PATH, sheet_name=SHEET, skiprows=3, header=0)
    df = df.dropna(subset=["Name"])
    df["Gender"] = df["Gender"].astype(str).str.strip().str[:1].str.upper()
    df["Centre"] = df["S/N"].astype(str).str.extract(r"^([A-Z]+)")[0]
    df["Age_clean"] = pd.to_numeric(df["Age"], errors="coerce")
    return df


def _section(title: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


def _outcome_stats(df: pd.DataFrame, pre_col: str, post_col: str, label: str) -> None:
    pre = pd.to_numeric(df[pre_col], errors="coerce")
    post = pd.to_numeric(df[post_col], errors="coerce")
    paired = pre.notna() & post.notna()
    n = paired.sum()
    if n == 0:
        print(f"  {label}: no paired data")
        return
    delta = post[paired] - pre[paired]
    # direction: negative delta = improvement for TUG/5XSST/tandem(time); positive = improvement for gait speed/SPPB/VAS_pain_reduction
    print(f"  {label}:")
    print(f"    n paired       = {n}")
    print(f"    pre  mean±sd   = {pre[paired].mean():.2f} ± {pre[paired].std():.2f}  [{pre[paired].min():.1f}–{pre[paired].max():.1f}]")
    print(f"    post mean±sd   = {post[paired].mean():.2f} ± {post[paired].std():.2f}  [{post[paired].min():.1f}–{post[paired].max():.1f}]")
    print(f"    delta mean±sd  = {delta.mean():.2f} ± {delta.std():.2f}")


def main() -> None:
    df = _load()

    _section("OVERVIEW")
    print(f"  Total patient rows : {len(df)}")
    print(f"  Columns            : {len(df.columns)}")
    print()
    print("  Patients per centre:")
    for centre, cnt in df["Centre"].value_counts().items():
        print(f"    {centre}: {cnt}")
    print()
    print(f"  Age: {df['Age_clean'].min():.0f}–{df['Age_clean'].max():.0f}, mean {df['Age_clean'].mean():.1f}, median {df['Age_clean'].median():.0f}")
    print(f"  Gender: {df['Gender'].value_counts().to_dict()}")

    _section("DATA QUALITY")
    key_cols = {
        "Pre Tandem result (s)": "Pre Tandem (s)",
        "Post Tandem result (s)": "Post Tandem (s)",
        "Pre Normal Gait Speed (m/s)": "Pre NGS (m/s)",
        "Post Normal Gait Speed (m/s)": "Post NGS (m/s)",
        "Pre TUG result (s)": "Pre TUG (s)",
        "Post TUG result (s)": "Post TUG (s)",
        "Pre 5XSST result (s)": "Pre 5XSST (s)",
        "Post 5XSST result (s)": "Post 5XSST (s)",
        "Pre Bixeps VAS": "Pre VAS",
        "Post BIXEPS VAS": "Post VAS",
        "SPPB OVERALL SCORE": "Pre SPPB",
        "SPPB OVERALL SCORE.1": "Post SPPB",
    }
    for col, label in key_cols.items():
        if col not in df.columns:
            print(f"  ⚠  MISSING COLUMN: {col!r}")
            continue
        numeric = pd.to_numeric(df[col], errors="coerce")
        n_valid = numeric.notna().sum()
        n_total = len(df)
        print(f"  {label:<20}: {n_valid:3d}/{n_total} valid  ({100*n_valid/n_total:.0f}%)")

    _section("OUTCOME DISTRIBUTIONS")
    _outcome_stats(df, "Pre Tandem result (s)", "Post Tandem result (s)", "Tandem stand (s, higher=better)")
    _outcome_stats(df, "Pre Normal Gait Speed (m/s)", "Post Normal Gait Speed (m/s)", "Normal gait speed (m/s, higher=better)")
    _outcome_stats(df, "Pre TUG result (s)", "Post TUG result (s)", "TUG (s, lower=better)")
    _outcome_stats(df, "Pre 5XSST result (s)", "Post 5XSST result (s)", "5xSST (s, lower=better)")
    _outcome_stats(df, "Pre Bixeps VAS", "Post BIXEPS VAS", "Overall VAS (lower=better)")
    _outcome_stats(df, "SPPB OVERALL SCORE", "SPPB OVERALL SCORE.1", "SPPB total (higher=better)")

    _section("CENTRE COMPARISON — mean pre TUG (s)")
    for centre, grp in df.groupby("Centre"):
        tug = pd.to_numeric(grp["Pre TUG result (s)"], errors="coerce")
        print(f"  {centre}: n={tug.notna().sum()}  mean={tug.mean():.2f}s  median={tug.median():.2f}s")

    _section("CENTRE COMPARISON — mean pre SPPB")
    for centre, grp in df.groupby("Centre"):
        sppb = pd.to_numeric(grp["SPPB OVERALL SCORE"], errors="coerce")
        print(f"  {centre}: n={sppb.notna().sum()}  mean={sppb.mean():.2f}  median={sppb.median():.2f}")

    _section("TAG / CONDITION FREQUENCY")
    tags_all = df["Tags"].dropna().str.lower()
    conditions = {
        "Stroke": "stroke",
        "Diabetes": "diabetes",
        "OA / osteoarthritis": "oa",
        "Hypertension": "hypertension",
        "Parkinson": "parkinson",
        "Dementia": "dementia",
        "Back/Spine": "back pain|spine|spinal",
        "Knee pain": "knee",
        "Shoulder pain": "shoulder",
        "Numbness": "numbness",
        "Cramps": "cramps",
        "Cancer": "cancer",
        "Cholesterol": "cholesterol",
        "Wheelchair": "wheelchair",
        "Frailty": "frail",
    }
    for label, kw in conditions.items():
        n = tags_all.str.contains(kw, regex=True, na=False).sum()
        print(f"  {label:<25}: {n:3d}  ({100*n/len(df):.0f}%)")

    _section("MISSING / EDGE CASES")
    missing_age = df["Age_clean"].isna().sum()
    missing_name = df["Name"].isna().sum()
    bad_gender = (~df["Gender"].isin(["M", "F"])).sum()
    print(f"  Missing Age        : {missing_age}")
    print(f"  Missing Name       : {missing_name}")
    print(f"  Non M/F gender     : {bad_gender}")
    # S/N duplicates
    dup_sn = df["S/N"].duplicated().sum()
    print(f"  Duplicate S/N      : {dup_sn}")
    print()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the EDA and read the output**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
.venv/bin/python3.14 scripts/14_eda_raise_data.py 2>&1
```

Read the output carefully. Note any ⚠ missing column warnings — those mean the column name in the Excel differs from what the script expects and will need fixing before the ingestion script runs.

- [ ] **Step 3: Commit**

```bash
git add scripts/14_eda_raise_data.py
git commit -m "feat: add EDA script for RAISE combined dataset (4 centres)"
```

---

## Task 2: Migration 15 — add Tandem stand columns

**Files:**
- Create: `scripts/15_migrate_add_tandem.py`
- Modify: `api/models/clinical.py`

- [ ] **Step 1: Create the migration script**

Create `/Users/reetmitra/Desktop/QTX/quantumtx-ah/scripts/15_migrate_add_tandem.py`:

```python
"""Migration 15 — add pre_tandem_s to patients, post_tandem_s to sessions."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 15 ...")
    engine = _get_engine()

    with engine.connect() as conn:
        conn.execute(text(
            "ALTER TABLE patients ADD COLUMN IF NOT EXISTS pre_tandem_s NUMERIC(7,2)"
        ))
        conn.commit()
        print("  patients.pre_tandem_s: OK")

        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS post_tandem_s NUMERIC(7,2)"
        ))
        conn.commit()
        print("  sessions.post_tandem_s: OK")

    print("Migration 15 complete.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the migration**

```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=api .venv/bin/python3.14 scripts/15_migrate_add_tandem.py
```

Expected:
```
Running migration 15 ...
  patients.pre_tandem_s: OK
  sessions.post_tandem_s: OK
Migration 15 complete.
```

- [ ] **Step 3: Add tandem fields to the ORM models**

In `/Users/reetmitra/Desktop/QTX/quantumtx-ah/api/models/clinical.py`:

Find the SPPB block in the `Session` class (around line 145–149):
```python
    # SPPB
    baseline_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    post_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    sppb_change: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    sppb_source: Mapped[str | None] = mapped_column(String(50), nullable=True)
```

Add tandem field **before** the SPPB block:
```python
    # Tandem stand (RAISE / BIXEPS data)
    post_tandem_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)

    # SPPB
    baseline_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    post_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    sppb_change: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    sppb_source: Mapped[str | None] = mapped_column(String(50), nullable=True)
```

Now find the SPPB block in the `Patient` class (around line 146–147):
```python
    baseline_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    post_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
```

Add tandem field **before** it:
```python
    # Tandem stand (RAISE / BIXEPS data)
    pre_tandem_s: Mapped[float | None] = mapped_column(Numeric(7, 2), nullable=True)

    baseline_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    post_sppb: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
```

- [ ] **Step 4: Verify the API still starts (ORM model check)**

```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=api .venv/bin/python3.14 -c "
from db import init_db
from models.clinical import Patient, Session
init_db()
print('ORM OK — Patient fields:', [c.key for c in Patient.__table__.columns if 'tandem' in c.key])
print('ORM OK — Session fields:', [c.key for c in Session.__table__.columns if 'tandem' in c.key])
"
```

Expected:
```
ORM OK — Patient fields: ['pre_tandem_s']
ORM OK — Session fields: ['post_tandem_s']
```

- [ ] **Step 5: Commit**

```bash
git add scripts/15_migrate_add_tandem.py api/models/clinical.py
git commit -m "feat: add pre_tandem_s / post_tandem_s columns for RAISE tandem stand data"
```

---

## Task 3: RAISE ingestion script + tests

**Files:**
- Create: `scripts/16_ingest_raise_data.py`
- Create: `tests/test_raise_ingest.py`

### 3a — Tests first

- [ ] **Step 1: Create the test file**

Create `/Users/reetmitra/Desktop/QTX/quantumtx-ah/tests/test_raise_ingest.py`:

```python
"""Unit tests for RAISE data ingestion mapper — no DB required."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# Module names starting with a digit can't be imported normally — load via spec.
_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "16_ingest_raise_data.py"


def _m():
    """Load the ingestion module fresh (avoids digit-prefix import issue)."""
    spec = importlib.util.spec_from_file_location("ingest_raise", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── age_band ─────────────────────────────────────────────────────────────────

def test_age_band_under_50():
    assert _m()._age_band(45) == "<50"

def test_age_band_50s():
    assert _m()._age_band(55) == "50-59"

def test_age_band_60s():
    assert _m()._age_band(65) == "60-69"

def test_age_band_70s():
    assert _m()._age_band(74) == "70-79"

def test_age_band_80_plus():
    assert _m()._age_band(84) == "80+"


# ── _parse_tags ───────────────────────────────────────────────────────────────

def test_parse_tags_stroke_diabetes():
    flags = _m()._parse_tags("Stroke, Diabetes, Shoulder pain")
    assert flags["has_stroke"] is True
    assert flags["has_diabetes"] is True
    assert flags["has_shoulder_issue"] is True
    assert flags["has_oa"] is False

def test_parse_tags_oa_hypertension():
    flags = _m()._parse_tags("OA Knees, Hypertension, Back Pain")
    assert flags["has_oa"] is True
    assert flags["has_hypertension"] is True
    assert flags["has_spinal_issue"] is True
    assert flags["has_stroke"] is False

def test_parse_tags_empty():
    flags = _m()._parse_tags("")
    assert flags["has_stroke"] is False
    assert flags["has_oa"] is False

def test_parse_tags_none():
    flags = _m()._parse_tags(None)
    assert flags["has_stroke"] is False

def test_parse_tags_numbness_maps_to_neuropathy():
    flags = _m()._parse_tags("Numbness, Cramps")
    assert flags["has_neuropathy"] is True

def test_parse_tags_parkinson_maps_neurological():
    flags = _m()._parse_tags("Parkinsons disease")
    assert flags["has_parkinsons"] is True
    assert flags["has_neurological"] is True
    assert flags["grp_neurological"] is True

def test_parse_tags_grp_balance_falls_always_true():
    flags = _m()._parse_tags("General fitness")
    assert flags["grp_balance_falls"] is True


# ── _to_float / _to_int ───────────────────────────────────────────────────────

def test_to_float_numeric():
    assert _m()._to_float(12.5) == 12.5

def test_to_float_string_number():
    assert _m()._to_float("14.3") == 14.3

def test_to_float_none_returns_none():
    assert _m()._to_float(None) is None

def test_to_float_text_returns_none():
    assert _m()._to_float("NA") is None

def test_to_int_returns_int():
    assert _m()._to_int(7.0) == 7

def test_to_int_none_returns_none():
    assert _m()._to_int(None) is None
```

- [ ] **Step 2: Run the tests — expect ImportError (module doesn't exist yet)**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_ingest.py -v 2>&1 | head -20
```

Expected: `ModuleNotFoundError` on `16_ingest_raise_data` — confirms tests are wired correctly.

### 3b — Ingestion script

- [ ] **Step 3: Create the ingestion script**

Create `/Users/reetmitra/Desktop/QTX/quantumtx-ah/scripts/16_ingest_raise_data.py`:

```python
"""Script 16 — Ingest RAISE combined dataset into PostgreSQL.

Reads Raise combined data (4 centres).xlsx and creates one Patient row
and one Session row (session_number=1) per patient.

Usage:
    DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
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

EXCEL_PATH = Path("/Users/reetmitra/Downloads/Raise combined data (4 centres).xlsx")
SHEET = "All Combined 21Aug23"
SOURCE = "Raise combined data (4 centres).xlsx"


# ── helpers ───────────────────────────────────────────────────────────────────

def _to_float(val) -> float | None:
    if val is None:
        return None
    try:
        f = float(val)
        return None if (f != f) else f  # NaN check
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
    t = (tags or "").lower()
    has_stroke = "stroke" in t
    has_parkinsons = "parkinson" in t
    has_neurological = "dementia" in t or has_parkinsons or "neurolog" in t
    has_oa = "oa " in t or " oa" in t or "osteoarthritis" in t or "oa\n" in t or t.startswith("oa")
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
        usage_frequency="Once weekly (BIXEPS)",
        pre_tandem_s=_to_float(row.get("Pre Tandem result (s)")),
        pre_normal_gs_ms=_to_float(row.get("Pre Normal Gait Speed (m/s)")),
        pre_tug_s=_to_float(row.get("Pre TUG result (s)")),
        pre_5xsst_s=_to_float(row.get("Pre 5XSST result (s)")),
        pre_vas=_to_float(row.get("Pre Bixeps VAS")),
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
                db.rollback()
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
```

- [ ] **Step 4: Run the tests — all should pass now**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_ingest.py -v
```

Expected: `21 passed`

- [ ] **Step 5: Dry-run the ingestion (check one row loads without error)**

```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=api .venv/bin/python3.14 -c "
import sys; sys.path.insert(0, 'scripts')
import pandas as pd
from pathlib import Path

# Load just the first data row
df = pd.read_excel('/Users/reetmitra/Downloads/Raise combined data (4 centres).xlsx',
                   sheet_name='All Combined 21Aug23', skiprows=3, header=0)
df = df.dropna(subset=['Name'])
row = df.iloc[0]
print('S/N:', row['S/N'])
print('Name:', row['Name'])

import importlib, importlib.util
spec = importlib.util.spec_from_file_location('ingest16', 'scripts/16_ingest_raise_data.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

print('age_band:', m._age_band(int(row['Age'])) if pd.notna(row['Age']) else 'N/A')
print('pre_tug_s:', m._to_float(row['Pre TUG result (s)']))
print('post_tug_s:', m._to_float(row['Post TUG result (s)']))
flags = m._parse_tags(str(row['Tags']) if pd.notna(row['Tags']) else None)
print('flags sample:', {k: v for k, v in flags.items() if v is True})
print('dry-run OK')
"
```

Expected: prints patient details and `dry-run OK` with no exceptions.

- [ ] **Step 6: Run the full ingestion**

```bash
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
PYTHONPATH=api .venv/bin/python3.14 scripts/16_ingest_raise_data.py
```

Expected:
```
Loading Raise combined data (4 centres).xlsx ...
  162 patient rows found
Initialising DB ...
==================================================
  RAISE ingest complete
==================================================
  Inserted : 162
  Skipped  : 0
  Errors   : 0
```

- [ ] **Step 7: Verify patients appear in the API**

Start the API and query:

```bash
# Terminal 1
DATABASE_URL=postgresql+psycopg2://qtx:secret@localhost:5432/qtxah \
source .venv/bin/activate && cd api && uvicorn main:app --port 8000 &

# Terminal 2 — wait 3s then query
sleep 3
API_KEY=$(grep NEXT_PUBLIC_API_KEY web/.env.local | cut -d= -f2)
curl -s "http://localhost:8000/api/patients" -H "X-Api-Key: $API_KEY" | \
  python3.14 -c "import sys,json; d=json.load(sys.stdin); raise_pts=[p for p in d if str(p['sn']).startswith(('METTA','LB','PH'))]; print(f'RAISE patients visible in API: {len(raise_pts)}')"
```

Expected: `RAISE patients visible in API: 162`

- [ ] **Step 8: Commit**

```bash
kill $(lsof -ti:8000) 2>/dev/null
git add scripts/16_ingest_raise_data.py tests/test_raise_ingest.py
git commit -m "feat: ingest RAISE eldercare dataset (162 patients, 3 centres) into PostgreSQL"
```

---

## Task 4: Final verification + push

- [ ] **Step 1: Run the full test suite to check for regressions**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -v 2>&1 | tail -5
```

Expected: all existing tests pass + 21 new RAISE tests.

- [ ] **Step 2: Spot-check a RAISE patient via the PDF endpoint**

```bash
source .venv/bin/activate && cd api && uvicorn main:app --port 8000 &
sleep 3
API_KEY=$(grep NEXT_PUBLIC_API_KEY /Users/reetmitra/Desktop/QTX/quantumtx-ah/web/.env.local | cut -d= -f2)
curl -s -o /tmp/raise_patient.pdf \
  -w "HTTP %{http_code} | size: %{size_download} bytes" \
  "http://localhost:8000/api/patient/METTA%201/report.pdf?key=$API_KEY"
head -c 4 /tmp/raise_patient.pdf | xxd
kill $(lsof -ti:8000) 2>/dev/null
```

Expected: `HTTP 200 | size: ~20000+ bytes` and `%PDF` magic bytes.

- [ ] **Step 3: Push**

```bash
git push
```
