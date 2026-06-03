# Dual-Loop ML+AI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire ML model predictions into Claude's insight prompts and trigger automatic model retraining as sessions accumulate, closing both feedback loops.

**Architecture:** Sub-project 1 (ML→AI): new `SessionPrediction` DB row per session, `PredictionService` runs all models at session creation, `InsightService` injects predictions into Claude's prompt. Sub-project 2 (AI→ML): `RetrainService.check_and_trigger()` called after every session commit spawns `scripts/18_scheduled_retrain.py` as a background job when session count crosses a threshold; a new `/api/admin/reload-models` endpoint hot-swaps joblib files in the running API.

**Tech Stack:** FastAPI, SQLAlchemy, XGBoost, joblib, pandas, Anthropic Claude, PostgreSQL. Python `.venv/bin/python3.14`. Test runner: `PYTHONPATH=src:api .venv/bin/pytest`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/19_migrate_add_session_predictions.py` | Create | Add `session_predictions` table to PostgreSQL |
| `api/models/clinical.py` | Modify | Add `SessionPrediction` ORM class |
| `api/services/prediction.py` | Create | `PredictionService` + `_build_feature_vector_from_orm` |
| `api/services/insight.py` | Modify | Accept `predictions` kwarg, enrich prompt |
| `api/services/retrain.py` | Create | `RetrainService.check_and_trigger()` gate logic |
| `api/routers/admin.py` | Create | `POST /api/admin/reload-models` hot-reload endpoint |
| `api/routers/sessions.py` | Modify | Call `PredictionService` + `RetrainService` + pass predictions to insight |
| `api/main.py` | Modify | Register admin router, exempt `/api/admin/` from API key middleware |
| `scripts/18_scheduled_retrain.py` | Create | Background retrain job: QTX-only retrain + model save |
| `tests/test_prediction_service.py` | Create | Unit tests for `PredictionService` and feature vector builder |
| `tests/test_insight_predictions.py` | Create | Unit tests for enriched prompt paths |
| `tests/test_retrain_service.py` | Create | Unit tests for `check_and_trigger` threshold logic |

---

## Context You Must Know

**Project root:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah`

**Python:** `.venv/bin/python3.14`

**DB URL:** `postgresql+psycopg2://qtx:secret@localhost:5432/qtxah`

**Test runner:** `PYTHONPATH=src:api .venv/bin/pytest`

**API key:** The API requires `X-Api-Key` header matching env var `QTX_API_KEY`. The admin endpoint will be exempted from this (see Task 5).

**ORM pattern** (follow `api/models/clinical.py`):
```python
from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, Numeric, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from db import Base
import uuid
from datetime import datetime, timezone

class MyModel(Base):
    __tablename__ = "my_table"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
```

**Model loading** (`api/deps.py`):
- `deps.models` is a mutable dict: `{"classifier": ..., "regression": ..., "dropout": ..., "dosage": ..., "fall_risk": ..., "fall_risk_medians": ...}`
- `deps.load_all()` reloads all models into that dict in place — no server restart needed.

**Fall risk model** (`models/fall_risk_xgb.joblib`): XGBClassifier trained on 10 features: `["age", "gender_M", "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_frailty", "has_hypertension", "pre_5xsst_s", "pre_vas"]`. Medians stored in `fall_risk_medians.joblib`.

**`_build_feature_vector` in `api/routers/predict.py`** takes a Pydantic `PatientProfile` — the new `PredictionService` needs its own version that takes ORM objects. Do NOT modify `predict.py`.

**`retrain_state.json`** lives at project root. Already in `.gitignore` (the entry `models/*.joblib` covers models; add `retrain_state.json` explicitly in Task 6).

---

## Task 1: Migration + ORM — `session_predictions` Table

**Files:**
- Create: `scripts/19_migrate_add_session_predictions.py`
- Modify: `api/models/clinical.py`

- [ ] **Step 1: Write the migration script**

```python
# scripts/19_migrate_add_session_predictions.py
"""Migration 19 — add session_predictions table."""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from sqlalchemy import text
from db import _get_engine


def main() -> None:
    print("Running migration 19 ...")
    engine = _get_engine()
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS session_predictions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                fall_risk_score NUMERIC(5,4),
                fall_risk_label BOOLEAN,
                predicted_composite_improvement NUMERIC(7,4),
                responder_probability NUMERIC(5,4),
                dropout_probability NUMERIC(5,4),
                dosage_recommendation VARCHAR(100),
                model_versions JSONB,
                predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.commit()
        print("  session_predictions table: OK")
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS session_predictions_patient_id_idx "
            "ON session_predictions (patient_id)"
        ))
        conn.commit()
        print("  session_predictions_patient_id_idx: OK")
    print("Migration 19 complete.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Add `SessionPrediction` ORM class to `api/models/clinical.py`**

First, read `api/models/clinical.py` to see the existing imports. Add `JSON` to the sqlalchemy import line (it currently imports `Boolean, Date, DateTime, Numeric, SmallInteger, String, Text, UniqueConstraint, ForeignKey`). Then append this class at the end of the file:

```python
class SessionPrediction(Base):
    __tablename__ = "session_predictions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("patients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    fall_risk_score: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    fall_risk_label: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    predicted_composite_improvement: Mapped[float | None] = mapped_column(Numeric(7, 4), nullable=True)
    responder_probability: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    dropout_probability: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)
    dosage_recommendation: Mapped[str | None] = mapped_column(String(100), nullable=True)
    model_versions: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    predicted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
```

The `datetime` import already exists in clinical.py but `timezone` may not — check and add `from datetime import date, datetime, timezone` if needed.

- [ ] **Step 3: Run the migration**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/python3.14 scripts/19_migrate_add_session_predictions.py
```

Expected output:
```
Running migration 19 ...
  session_predictions table: OK
  session_predictions_patient_id_idx: OK
Migration 19 complete.
```

- [ ] **Step 4: Verify table exists**

```bash
PYTHONPATH=src:api .venv/bin/python3.14 -c "
import sys; sys.path.insert(0, 'api')
from db import _get_engine
from sqlalchemy import text
engine = _get_engine()
with engine.connect() as conn:
    result = conn.execute(text(\"SELECT COUNT(*) FROM session_predictions\"))
    print('Row count:', result.scalar())
"
```

Expected: `Row count: 0`

- [ ] **Step 5: Commit**

```bash
git add scripts/19_migrate_add_session_predictions.py api/models/clinical.py
git commit -m "feat: add session_predictions table and ORM model"
```

---

## Task 2: PredictionService + Unit Tests

**Files:**
- Create: `api/services/prediction.py`
- Create: `tests/test_prediction_service.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_prediction_service.py
"""Unit tests for PredictionService."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


def _make_patient(**kwargs):
    p = MagicMock()
    p.id = uuid.uuid4()
    p.age = 70
    p.gender = "F"
    p.cohort = "Pain"
    p.primary_indication = None
    p.has_oa = True
    p.has_diabetes = False
    p.has_stroke = False
    p.has_parkinsons = False
    p.has_sarcopenia = False
    p.has_frailty = True
    p.has_balance_issue = False
    p.has_post_surgery = False
    p.has_chronic_pain = True
    p.has_neuropathy = False
    p.has_cancer = False
    p.has_cardiovascular = False
    p.has_hypertension = True
    p.has_osteoporosis = False
    p.has_spinal_issue = False
    p.has_knee_issue = True
    p.has_hip_issue = False
    p.has_shoulder_issue = False
    p.has_neurological = False
    p.has_fracture = False
    p.has_autoimmune = False
    p.has_metabolic = False
    p.has_wellness_only = False
    p.has_fall_risk = False
    p.grp_joint_disease = True
    p.grp_spine_back = False
    p.grp_neurological = False
    p.grp_post_surgical = False
    p.grp_frailty_sarcopenia = False
    p.grp_balance_falls = False
    p.grp_metabolic = False
    p.grp_cardiovascular = False
    p.grp_oncology = False
    p.grp_autoimmune = False
    p.grp_softtissue_injury = False
    p.grp_generalised_pain = False
    p.grp_osteoporosis = False
    p.grp_wellness = False
    p.rgn_knee = True
    p.rgn_hip = False
    p.rgn_spine = False
    p.rgn_shoulder = False
    p.rgn_ankle_foot = False
    p.rgn_lower_limb = False
    p.rgn_upper_limb = False
    p.rgn_bilateral = False
    p.rgn_trunk = False
    p.baseline_sppb = 8
    for k, v in kwargs.items():
        setattr(p, k, v)
    return p


def _make_session(**kwargs):
    s = MagicMock()
    s.id = uuid.uuid4()
    s.pre_tug_s = 12.5
    s.pre_vas = 5.0
    s.pre_5xsst_s = 15.0
    s.pre_normal_gs_ms = 0.75
    s.pre_fast_gs_ms = None
    s.baseline_sppb = 8
    s.post_sppb = None
    s.usage_frequency = "Once / week"
    s.joined_with_pain = True
    for k, v in kwargs.items():
        setattr(s, k, v)
    return s


def _make_models():
    """Return a minimal mock models dict with correct feature_names_in_."""
    features = ["age", "baseline_sppb", "pre_tug_s", "pre_5xsst_s", "pre_vas",
                "pre_normal_gs_ms", "pre_fast_gs_ms", "has_oa", "has_diabetes",
                "has_hypertension", "has_frailty", "has_stroke", "has_parkinsons",
                "has_sarcopenia", "has_post_surgery", "has_balance_issue",
                "has_chronic_pain", "has_fall_risk", "has_neurological",
                "has_metabolic", "has_knee_issue", "has_spinal_issue",
                "grp_joint_disease", "grp_spine_back", "grp_neurological",
                "grp_post_surgical", "grp_frailty_sarcopenia", "grp_balance_falls",
                "grp_metabolic", "grp_softtissue_injury", "grp_osteoporosis",
                "rgn_spine", "rgn_knee", "rgn_ankle_foot", "rgn_hip",
                "rgn_lower_limb", "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
                "n_flags", "n_groups", "n_regions",
                "cohort_Pain", "gender_F"]
    
    reg = MagicMock()
    reg.feature_names_in_ = np.array(features)
    reg.predict.return_value = np.array([0.42])
    
    clf = MagicMock()
    clf.feature_names_in_ = np.array(features)
    clf.predict_proba.return_value = np.array([[0.29, 0.71]])
    
    drop = MagicMock()
    drop.feature_names_in_ = np.array(features)
    drop.predict_proba.return_value = np.array([[0.88, 0.12]])
    
    fr_features = ["age", "gender_M", "has_oa", "has_diabetes", "has_stroke",
                   "has_parkinsons", "has_frailty", "has_hypertension", "pre_5xsst_s", "pre_vas"]
    fr = MagicMock()
    fr.feature_names_in_ = np.array(fr_features)
    fr.predict_proba.return_value = np.array([[0.13, 0.87]])
    
    dos = MagicMock()
    dos.feature_names_in_ = np.array(["age", "gender_M", "joined_with_pain_Y",
                                       "hl_knee_issue", "hl_leg_issue", "hl_back_spine_issue",
                                       "hl_balance_issue", "hl_upper_body_issue", "hl_foot_ankle_issue",
                                       "hl_neuro_issue", "hl_frailty_issue", "hl_metabolic_issue",
                                       "hl_injury_surgery_issue", "hl_general_pain_issue",
                                       "age_above_65", "age_above_75", "bilateral_lower_limb_load",
                                       "inflammatory_burden", "elderly_frailty", "muscle_atrophy_risk",
                                       "pain_with_knee"])
    dos.predict.return_value = np.array([1])
    
    return {
        "regression": reg,
        "classifier": clf,
        "dropout": drop,
        "fall_risk": fr,
        "fall_risk_medians": {"pre_5xsst_s": 15.0, "pre_vas": 4.0},
        "dosage": dos,
    }


# ── _build_feature_vector_from_orm ───────────────────────────────────────────

def test_feature_vector_shape():
    from services.prediction import _build_feature_vector_from_orm
    features = ["age", "has_oa", "cohort_Pain", "gender_F", "n_flags"]
    patient = _make_patient()
    session = _make_session()
    df = _build_feature_vector_from_orm(patient, session, features)
    assert df.shape == (1, 5)
    assert list(df.columns) == features


def test_feature_vector_none_values_become_zero():
    from services.prediction import _build_feature_vector_from_orm
    features = ["pre_tug_s", "pre_fast_gs_ms"]
    session = _make_session(pre_tug_s=None, pre_fast_gs_ms=None)
    df = _build_feature_vector_from_orm(_make_patient(), session, features)
    assert df["pre_tug_s"].iloc[0] == 0.0
    assert df["pre_fast_gs_ms"].iloc[0] == 0.0


def test_feature_vector_cohort_onehot():
    from services.prediction import _build_feature_vector_from_orm
    features = ["cohort_Pain", "cohort_Neurological"]
    patient = _make_patient(cohort="Pain")
    df = _build_feature_vector_from_orm(patient, _make_session(), features)
    assert df["cohort_Pain"].iloc[0] == 1.0
    assert df["cohort_Neurological"].iloc[0] == 0.0


def test_feature_vector_gender_onehot():
    from services.prediction import _build_feature_vector_from_orm
    features = ["gender_M", "gender_F"]
    patient = _make_patient(gender="F")
    df = _build_feature_vector_from_orm(patient, _make_session(), features)
    assert df["gender_F"].iloc[0] == 1.0
    assert df["gender_M"].iloc[0] == 0.0


def test_feature_vector_n_flags_counts_true_has_cols():
    from services.prediction import _build_feature_vector_from_orm
    features = ["n_flags"]
    # has_oa=True, has_frailty=True, has_hypertension=True, has_knee_issue=True,
    # has_chronic_pain=True → 5 of the _HAS_COLS are True
    patient = _make_patient()
    df = _build_feature_vector_from_orm(patient, _make_session(), features)
    assert df["n_flags"].iloc[0] == 5.0


# ── PredictionService.run ─────────────────────────────────────────────────────

def test_run_returns_dict_with_all_keys():
    from services.prediction import PredictionService
    db = MagicMock()
    patient = _make_patient()
    session = _make_session()
    models = _make_models()
    svc = PredictionService(db, models)
    result = svc.run(patient, session)
    assert result is not None
    assert "fall_risk_score" in result
    assert "fall_risk_label" in result
    assert "predicted_composite_improvement" in result
    assert "responder_probability" in result
    assert "dropout_probability" in result
    assert "dosage_recommendation" in result


def test_run_writes_db_row():
    from services.prediction import PredictionService
    db = MagicMock()
    patient = _make_patient()
    session = _make_session()
    models = _make_models()
    PredictionService(db, models).run(patient, session)
    db.add.assert_called_once()
    db.flush.assert_called_once()


def test_run_returns_none_on_catastrophic_failure():
    from services.prediction import PredictionService
    db = MagicMock()
    db.add.side_effect = Exception("DB exploded")
    patient = _make_patient()
    session = _make_session()
    result = PredictionService(db, _make_models()).run(patient, session)
    assert result is None


def test_run_individual_model_failure_yields_none_field():
    from services.prediction import PredictionService
    db = MagicMock()
    models = _make_models()
    models["regression"].predict.side_effect = Exception("model broken")
    result = PredictionService(db, models).run(_make_patient(), _make_session())
    assert result is not None
    assert result["predicted_composite_improvement"] is None
    # Other fields still populated
    assert result["responder_probability"] is not None


def test_run_fall_risk_label_true_when_score_above_half():
    from services.prediction import PredictionService
    db = MagicMock()
    models = _make_models()
    models["fall_risk"].predict_proba.return_value = np.array([[0.13, 0.87]])
    result = PredictionService(db, models).run(_make_patient(), _make_session())
    assert result["fall_risk_label"] is True
    assert abs(result["fall_risk_score"] - 0.87) < 1e-6


def test_run_fall_risk_label_false_when_score_below_half():
    from services.prediction import PredictionService
    db = MagicMock()
    models = _make_models()
    models["fall_risk"].predict_proba.return_value = np.array([[0.80, 0.20]])
    result = PredictionService(db, models).run(_make_patient(), _make_session())
    assert result["fall_risk_label"] is False
```

- [ ] **Step 2: Run tests — expect ImportError (module doesn't exist yet)**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/pytest tests/test_prediction_service.py -v 2>&1 | head -20
```

Expected: `ModuleNotFoundError: No module named 'services.prediction'`

- [ ] **Step 3: Create `api/services/prediction.py`**

```python
# api/services/prediction.py
"""PredictionService — runs all ML models for a patient+session and persists results."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

import pandas as pd
from sqlalchemy.orm import Session as DBSession

logger = logging.getLogger(__name__)

_GRP_COLS = [
    "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
    "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic",
    "grp_softtissue_injury", "grp_osteoporosis",
]
_RGN_COLS = [
    "rgn_spine", "rgn_knee", "rgn_ankle_foot", "rgn_hip", "rgn_lower_limb",
    "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
]
_HAS_COLS = [
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_sarcopenia",
    "has_post_surgery", "has_balance_issue", "has_chronic_pain", "has_hypertension",
    "has_frailty", "has_fall_risk", "has_neurological", "has_metabolic",
    "has_knee_issue", "has_spinal_issue",
]
_DOSAGE_LABEL_MAP = {0: "Once / week", 1: "Twice / week", 2: "L+R 10 (both legs)"}


def _f(val, default: float = 0.0) -> float:
    """Safe float conversion — returns default for None."""
    return float(val) if val is not None else default


def _build_feature_vector_from_orm(patient, session, feature_names: list[str]) -> pd.DataFrame:
    """Build a single-row DataFrame from ORM Patient + Session objects."""
    row: dict[str, float] = {}

    row["age"] = _f(patient.age)
    sppb = session.baseline_sppb if session.baseline_sppb is not None else patient.baseline_sppb
    row["baseline_sppb"] = _f(sppb)
    row["pre_normal_gs_ms"] = _f(session.pre_normal_gs_ms)
    row["pre_tug_s"] = _f(session.pre_tug_s)
    row["pre_5xsst_s"] = _f(session.pre_5xsst_s)
    row["pre_vas"] = _f(session.pre_vas)
    row["pre_fast_gs_ms"] = _f(session.pre_fast_gs_ms)

    for col in _HAS_COLS:
        row[col] = _f(getattr(patient, col, False))
    for col in _GRP_COLS:
        row[col] = _f(getattr(patient, col, False))
    for col in _RGN_COLS:
        row[col] = _f(getattr(patient, col, False))

    row["n_flags"] = sum(row.get(c, 0.0) for c in _HAS_COLS)
    row["n_groups"] = sum(row.get(c, 0.0) for c in _GRP_COLS)
    row["n_regions"] = sum(row.get(c, 0.0) for c in _RGN_COLS)

    cohort = patient.cohort or ""
    usage = session.usage_frequency or ""
    gender = (patient.gender or "").upper()

    for col in feature_names:
        if col.startswith("cohort_"):
            row[col] = 1.0 if cohort == col[len("cohort_"):] else 0.0
        elif col.startswith("usage_frequency_"):
            row[col] = 1.0 if usage == col[len("usage_frequency_"):] else 0.0
        elif col.startswith("gender_"):
            row[col] = 1.0 if gender == col[len("gender_"):].upper() else 0.0
        elif col.startswith("primary_indication_"):
            row[col] = 0.0

    for feat in feature_names:
        if feat not in row:
            row[feat] = 0.0

    return pd.DataFrame([row])[feature_names]


def _build_dosage_vector_from_orm(patient, session, feature_names: list[str]) -> pd.DataFrame:
    """Build dosage model feature vector from ORM objects using proxy field mappings."""
    age = _f(patient.age)
    age65 = float(age >= 65)
    age75 = float(age >= 75)
    joined_pain = float(bool(session.joined_with_pain))
    knee = float(bool(getattr(patient, "has_knee_issue", False)) or bool(getattr(patient, "rgn_knee", False)))
    leg = float(bool(getattr(patient, "rgn_lower_limb", False)))
    back = float(bool(getattr(patient, "has_spinal_issue", False)) or bool(getattr(patient, "rgn_spine", False)))
    balance = float(bool(getattr(patient, "has_balance_issue", False)))
    upper = float(bool(getattr(patient, "rgn_upper_limb", False)) or bool(getattr(patient, "has_shoulder_issue", False)))
    foot = float(bool(getattr(patient, "rgn_ankle_foot", False)))
    neuro = float(bool(getattr(patient, "has_neurological", False)))
    frail = float(bool(getattr(patient, "has_frailty", False)))
    metabolic = float(bool(getattr(patient, "has_metabolic", False)))
    surgery = float(bool(getattr(patient, "has_post_surgery", False)))
    pain = float(bool(getattr(patient, "has_chronic_pain", False)))
    gender_m = 1.0 if (patient.gender or "").upper() == "M" else 0.0

    base = {
        "age": age, "gender_M": gender_m,
        "joined_with_pain_Y": joined_pain,
        "hl_knee_issue": knee, "hl_leg_issue": leg,
        "hl_back_spine_issue": back, "hl_balance_issue": balance,
        "hl_upper_body_issue": upper, "hl_foot_ankle_issue": foot,
        "hl_neuro_issue": neuro, "hl_frailty_issue": frail,
        "hl_metabolic_issue": metabolic, "hl_injury_surgery_issue": surgery,
        "hl_general_pain_issue": pain,
        "age_above_65": age65, "age_above_75": age75,
        "bilateral_lower_limb_load": min(knee + leg + foot + balance, 4.0),
        "inflammatory_burden": knee + back + pain + surgery,
        "elderly_frailty": age65 * frail,
        "muscle_atrophy_risk": min(age65 * (frail + neuro + leg), 3.0),
        "pain_with_knee": knee * joined_pain,
    }
    row = {feat: float(base.get(feat, 0.0)) for feat in feature_names}
    return pd.DataFrame([row], columns=feature_names)


class PredictionService:
    def __init__(self, db: DBSession, models: dict) -> None:
        self._db = db
        self._models = models

    def run(self, patient, session) -> dict | None:
        """Run all model inferences for a patient+session.

        Writes a SessionPrediction row (caller commits). Returns prediction dict or None.
        """
        try:
            return self._run(patient, session)
        except Exception as exc:
            logger.warning("PredictionService.run failed: %s", exc)
            return None

    def _run(self, patient, session) -> dict:
        from models.clinical import SessionPrediction

        predictions: dict = {}
        model_versions: dict = {}

        try:
            reg = self._models["regression"]
            X = _build_feature_vector_from_orm(patient, session, list(reg.feature_names_in_))
            predictions["predicted_composite_improvement"] = float(reg.predict(X)[0])
            model_versions["regression"] = "regression_xgb.joblib"
        except Exception as exc:
            logger.warning("Regression inference failed: %s", exc)
            predictions["predicted_composite_improvement"] = None

        try:
            clf = self._models["classifier"]
            X = _build_feature_vector_from_orm(patient, session, list(clf.feature_names_in_))
            predictions["responder_probability"] = float(clf.predict_proba(X)[0][1])
            model_versions["classifier"] = "classifier_xgb.joblib"
        except Exception as exc:
            logger.warning("Classifier inference failed: %s", exc)
            predictions["responder_probability"] = None

        try:
            drop = self._models["dropout"]
            X = _build_feature_vector_from_orm(patient, session, list(drop.feature_names_in_))
            predictions["dropout_probability"] = float(drop.predict_proba(X)[0][1])
            model_versions["dropout"] = "dropout_xgb.joblib"
        except Exception as exc:
            logger.warning("Dropout inference failed: %s", exc)
            predictions["dropout_probability"] = None

        try:
            fr = self._models["fall_risk"]
            medians = self._models["fall_risk_medians"]
            fr_features = list(fr.feature_names_in_)
            fr_row = {
                "age": _f(patient.age),
                "gender_M": 1.0 if (patient.gender or "").upper() == "M" else 0.0,
                "has_oa": _f(patient.has_oa),
                "has_diabetes": _f(patient.has_diabetes),
                "has_stroke": _f(patient.has_stroke),
                "has_parkinsons": _f(patient.has_parkinsons),
                "has_frailty": _f(patient.has_frailty),
                "has_hypertension": _f(patient.has_hypertension),
                "pre_5xsst_s": float(session.pre_5xsst_s) if session.pre_5xsst_s is not None else medians.get("pre_5xsst_s", 15.0),
                "pre_vas": float(session.pre_vas) if session.pre_vas is not None else medians.get("pre_vas", 4.0),
            }
            X_fr = pd.DataFrame([{feat: float(fr_row.get(feat, 0.0)) for feat in fr_features}], columns=fr_features)
            fr_score = float(fr.predict_proba(X_fr)[0][1])
            predictions["fall_risk_score"] = fr_score
            predictions["fall_risk_label"] = fr_score > 0.50
            model_versions["fall_risk"] = "fall_risk_xgb.joblib"
        except Exception as exc:
            logger.warning("Fall risk inference failed: %s", exc)
            predictions["fall_risk_score"] = None
            predictions["fall_risk_label"] = None

        try:
            dos = self._models["dosage"]
            X = _build_dosage_vector_from_orm(patient, session, list(dos.feature_names_in_))
            dos_class = int(dos.predict(X)[0])
            predictions["dosage_recommendation"] = _DOSAGE_LABEL_MAP.get(dos_class, str(dos_class))
            model_versions["dosage"] = "dosage_frequency.joblib"
        except Exception as exc:
            logger.warning("Dosage inference failed: %s", exc)
            predictions["dosage_recommendation"] = None

        row = SessionPrediction(
            id=uuid.uuid4(),
            session_id=session.id,
            patient_id=patient.id,
            fall_risk_score=predictions.get("fall_risk_score"),
            fall_risk_label=predictions.get("fall_risk_label"),
            predicted_composite_improvement=predictions.get("predicted_composite_improvement"),
            responder_probability=predictions.get("responder_probability"),
            dropout_probability=predictions.get("dropout_probability"),
            dosage_recommendation=predictions.get("dosage_recommendation"),
            model_versions=model_versions,
            predicted_at=datetime.now(timezone.utc),
        )
        self._db.add(row)
        self._db.flush()
        return predictions
```

- [ ] **Step 4: Run tests — all 12 should pass**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_prediction_service.py -v
```

Expected: `12 passed`

- [ ] **Step 5: Confirm existing tests still pass**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -x --ignore=tests/test_prediction_service.py -q 2>&1 | tail -5
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add api/services/prediction.py tests/test_prediction_service.py
git commit -m "feat: add PredictionService and feature vector builder from ORM"
```

---

## Task 3: InsightService Prompt Enrichment + Tests

**Files:**
- Modify: `api/services/insight.py`
- Create: `tests/test_insight_predictions.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_insight_predictions.py
"""Tests for InsightService predictions enrichment."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import models.clinical  # noqa: F401
import models.wearable  # noqa: F401

_FAKE_PREDS = {
    "fall_risk_score": 0.87,
    "fall_risk_label": True,
    "predicted_composite_improvement": 0.42,
    "responder_probability": 0.71,
    "dropout_probability": 0.12,
    "dosage_recommendation": "Twice / week",
}

_FAKE_TIMELINE = {
    "patient": {"sn": "T001", "name": "Test", "age": 70, "gender": "F",
                "cohort": "Pain", "primary_indication": None},
    "sessions": [{"session_number": 1, "post_tug_s": 14.0, "post_vas": 5.0}],
    "trends": [],
}


def _make_db_patient(db, sn: str):
    """Create a minimal Patient row in the given SQLite session."""
    from models.clinical import Patient
    p = Patient(
        id=uuid.uuid4(), sn=sn, name=f"Patient {sn}", gender="F", age=70,
        age_band="70-79", record_type="Active",
        has_oa=False, has_diabetes=False, has_stroke=False, has_parkinsons=False,
        has_sarcopenia=False, has_frailty=False, has_balance_issue=False,
        has_post_surgery=False, has_chronic_pain=False, has_neuropathy=False,
        has_cancer=False, has_cardiovascular=False, has_hypertension=False,
        has_osteoporosis=False, has_spinal_issue=False, has_knee_issue=False,
        has_hip_issue=False, has_shoulder_issue=False, has_neurological=False,
        has_fracture=False, has_autoimmune=False, has_metabolic=False,
        has_wellness_only=False, has_fall_risk=False,
        grp_joint_disease=False, grp_spine_back=False, grp_neurological=False,
        grp_post_surgical=False, grp_frailty_sarcopenia=False, grp_balance_falls=False,
        grp_metabolic=False, grp_cardiovascular=False, grp_oncology=False,
        grp_autoimmune=False, grp_softtissue_injury=False, grp_generalised_pain=False,
        grp_osteoporosis=False, grp_wellness=False,
        rgn_knee=False, rgn_hip=False, rgn_spine=False, rgn_shoulder=False,
        rgn_ankle_foot=False, rgn_lower_limb=False, rgn_upper_limb=False,
        rgn_bilateral=False, rgn_trunk=False,
    )
    db.add(p)
    db.flush()
    return p


def test_generate_session_insight_includes_predictions_in_prompt(monkeypatch):
    """When predictions are provided, the prompt includes a model_predictions block."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from db import Base
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    from services.insight import InsightService
    captured = {}
    monkeypatch.setattr(InsightService, "_call_claude",
                        lambda self, msg: captured.update({"msg": msg}) or "- OK")
    p = _make_db_patient(db, "TP001")
    InsightService(db).generate_session_insight(_FAKE_TIMELINE, p.id, 1, predictions=_FAKE_PREDS)
    assert "model_predictions" in captured["msg"]
    assert "HIGH" in captured["msg"]
    db.close()


def test_generate_session_insight_without_predictions_no_model_block(monkeypatch):
    """When predictions=None, the prompt does NOT include model_predictions."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from db import Base
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    from services.insight import InsightService
    captured = {}
    monkeypatch.setattr(InsightService, "_call_claude",
                        lambda self, msg: captured.update({"msg": msg}) or "- OK")
    p = _make_db_patient(db, "TP002")
    InsightService(db).generate_session_insight(_FAKE_TIMELINE, p.id, 1, predictions=None)
    assert "model_predictions" not in captured["msg"]
    db.close()


def test_system_prompt_includes_prediction_instruction():
    """The system prompt tells Claude to reference predictions explicitly."""
    from services.insight import _SYSTEM_PROMPT
    assert "model predictions" in _SYSTEM_PROMPT.lower()


def test_format_predictions_high_fall_risk():
    """_format_predictions returns HIGH label when fall_risk_label is True."""
    from services.insight import _format_predictions
    result = _format_predictions({"fall_risk_score": 0.87, "fall_risk_label": True,
                                   "predicted_composite_improvement": 0.42,
                                   "responder_probability": 0.71,
                                   "dropout_probability": 0.12,
                                   "dosage_recommendation": "Twice / week"})
    assert "HIGH" in result.get("fall_risk", "")


def test_format_predictions_low_fall_risk():
    """_format_predictions returns LOW label when fall_risk_label is False."""
    from services.insight import _format_predictions
    result = _format_predictions({"fall_risk_score": 0.20, "fall_risk_label": False})
    assert "LOW" in result.get("fall_risk", "")


def test_format_predictions_skips_none_fields():
    """_format_predictions omits keys where value is None."""
    from services.insight import _format_predictions
    result = _format_predictions({"fall_risk_score": None, "fall_risk_label": None,
                                   "dosage_recommendation": "Once / week"})
    assert "fall_risk" not in result
    assert result.get("dosage_recommendation") == "Once / week"
```

- [ ] **Step 2: Run tests — expect failures (function not yet modified)**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_insight_predictions.py -v 2>&1 | head -30
```

Expected: several failures — `_format_predictions` not found, predictions kwarg not accepted.

- [ ] **Step 3: Modify `api/services/insight.py`**

Make these four changes:

**3a. Update `_SYSTEM_PROMPT`** — replace the existing constant:

```python
_SYSTEM_PROMPT = (
    "You are a clinical physiotherapy assistant reviewing longitudinal data for a single patient. "
    "Reason only from the data provided. Do not compare this patient to others. "
    "Be concise and clinically relevant. Never speculate beyond what the data supports. "
    "Where model predictions are provided, reference them explicitly — flag when actual "
    "measurements diverge significantly from what was predicted."
)
```

**3b. Add `_format_predictions` function** — add after `_QA_TEMPLATE`:

```python
def _format_predictions(predictions: dict) -> dict:
    """Format model prediction dict for inclusion in timeline JSON."""
    result: dict = {}
    fr_score = predictions.get("fall_risk_score")
    fr_label = predictions.get("fall_risk_label")
    if fr_score is not None:
        label_str = "HIGH" if fr_label else "LOW"
        result["fall_risk"] = f"{label_str} ({fr_score:.2f}) [threshold > 0.50]"
    pci = predictions.get("predicted_composite_improvement")
    if pci is not None:
        result["predicted_composite_improvement"] = round(float(pci), 2)
    rp = predictions.get("responder_probability")
    if rp is not None:
        result["responder_probability"] = round(float(rp), 2)
    dp = predictions.get("dropout_probability")
    if dp is not None:
        result["dropout_risk"] = f"{'HIGH' if dp > 0.5 else 'LOW'} ({dp:.2f})"
    dr = predictions.get("dosage_recommendation")
    if dr is not None:
        result["dosage_recommendation"] = dr
    return result
```

**3c. Update `generate_session_insight` signature and body** — add `predictions: dict | None = None` parameter and inject into timeline before building the prompt:

Change the signature from:
```python
def generate_session_insight(
    self,
    timeline: dict,
    patient_id: uuid.UUID,
    session_number: int,
) -> str:
```

To:
```python
def generate_session_insight(
    self,
    timeline: dict,
    patient_id: uuid.UUID,
    session_number: int,
    predictions: dict | None = None,
) -> str:
```

And in the stub path (no API key), pass timeline unchanged.

In the real path, replace:
```python
        user_message = _SESSION_SUMMARY_TEMPLATE.format(
            timeline_json=json.dumps(timeline, indent=2),
            session_number=session_number,
        )
```

With:
```python
        tl = dict(timeline)
        if predictions:
            tl["model_predictions"] = _format_predictions(predictions)
        user_message = _SESSION_SUMMARY_TEMPLATE.format(
            timeline_json=json.dumps(tl, indent=2),
            session_number=session_number,
        )
```

**3d. Add `_get_latest_predictions` method and enrich `answer_question`** — add this method to `InsightService` before `answer_question`:

```python
    def _get_latest_predictions(self, patient_id: uuid.UUID) -> dict | None:
        """Query the latest SessionPrediction row for a patient."""
        from models.clinical import SessionPrediction
        try:
            row = (
                self._db.query(SessionPrediction)
                .filter_by(patient_id=patient_id)
                .order_by(SessionPrediction.predicted_at.desc())
                .first()
            )
            if row is None:
                return None
            return {
                "fall_risk_score": float(row.fall_risk_score) if row.fall_risk_score is not None else None,
                "fall_risk_label": row.fall_risk_label,
                "predicted_composite_improvement": float(row.predicted_composite_improvement) if row.predicted_composite_improvement is not None else None,
                "responder_probability": float(row.responder_probability) if row.responder_probability is not None else None,
                "dropout_probability": float(row.dropout_probability) if row.dropout_probability is not None else None,
                "dosage_recommendation": row.dosage_recommendation,
            }
        except Exception as exc:
            logger.warning("_get_latest_predictions failed: %s", exc)
            return None
```

At the start of `answer_question`'s real-path (after the stub check), add:
```python
        predictions = self._get_latest_predictions(patient_id)
```

And in the QA prompt building, add predictions to timeline same as session insight:
```python
        tl = dict(timeline)
        if predictions:
            tl["model_predictions"] = _format_predictions(predictions)
        # then use tl instead of timeline in the json.dumps calls
```

Replace both `json.dumps(timeline, ...)` occurrences in `answer_question` with `json.dumps(tl, ...)`.

- [ ] **Step 4: Run new tests**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_insight_predictions.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Run existing insight tests to confirm no regressions**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_insight.py -v 2>&1 | tail -10
```

Expected: all existing insight tests pass.

- [ ] **Step 6: Commit**

```bash
git add api/services/insight.py tests/test_insight_predictions.py
git commit -m "feat: enrich insight prompts with ML model predictions"
```

---

## Task 4: Wire PredictionService into Session Creation

**Files:**
- Modify: `api/routers/sessions.py`

- [ ] **Step 1: Read `api/routers/sessions.py` current state**, then add the following imports at the top (after existing imports):

```python
import deps
from services.prediction import PredictionService
```

(Note: `deps` is already imported — check and skip if present.)

- [ ] **Step 2: In the `create_session` function, add PredictionService call between the trend commit and the insight call**

Current code (lines ~177–184):
```python
    trends = TrendEngine(db).compute_and_save(patient.id)
    db.commit()  # commit session + trends before calling external API

    timeline = _build_timeline_dict(patient, db)
    insight_text = InsightService(db).generate_session_insight(
        timeline, patient.id, new_sn
    )
    db.commit()  # commit PatientInsight row
```

Replace with:
```python
    trends = TrendEngine(db).compute_and_save(patient.id)
    db.commit()  # commit session + trends before calling external API

    predictions = None
    if deps.models:
        predictions = PredictionService(db, deps.models).run(patient, session)
        db.commit()  # commit SessionPrediction row

    timeline = _build_timeline_dict(patient, db)
    insight_text = InsightService(db).generate_session_insight(
        timeline, patient.id, new_sn, predictions=predictions
    )
    db.commit()  # commit PatientInsight row
```

- [ ] **Step 3: Smoke-test by running the existing session tests**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -x -q 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/routers/sessions.py
git commit -m "feat: call PredictionService on session creation and pass predictions to insight"
```

---

## Task 5: Admin Hot-Reload Endpoint

**Files:**
- Create: `api/routers/admin.py`
- Modify: `api/main.py`

- [ ] **Step 1: Create `api/routers/admin.py`**

```python
# api/routers/admin.py
"""Admin endpoints — model hot-reload. No auth in dev; add bearer gate for production."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

import deps

router = APIRouter()


@router.post("/admin/reload-models")
def reload_models() -> dict:
    """Reload all ML model files from disk into the running process.

    Safe to call while the API is serving requests — deps.models is a mutable
    dict and the swap is atomic at the Python interpreter level.
    """
    deps.load_all()
    loaded = [str(Path(p).name) for p in [
        "classifier_xgb.joblib", "regression_xgb.joblib", "dropout_xgb.joblib",
        "dosage_frequency.joblib", "fall_risk_xgb.joblib", "fall_risk_medians.joblib",
    ]]
    return {"status": "ok", "models_loaded": loaded}
```

- [ ] **Step 2: Register admin router in `api/main.py`**

Change:
```python
from routers import patients, predict, fall_risk, wearable, webhooks, import_data, sessions, ask, report
```

To:
```python
from routers import patients, predict, fall_risk, wearable, webhooks, import_data, sessions, ask, report, admin
```

Add before the last `app.include_router(report.router, ...)` line:
```python
app.include_router(admin.router, prefix="/api")
```

- [ ] **Step 3: Exempt `/api/admin/` from the API key middleware**

In `api/main.py`, find the middleware function:
```python
async def api_key_middleware(request: Request, call_next):
    if not request.url.path.startswith("/webhooks"):
```

Change to:
```python
async def api_key_middleware(request: Request, call_next):
    exempt = request.url.path.startswith("/webhooks") or request.url.path.startswith("/api/admin")
    if not exempt:
```

- [ ] **Step 4: Test the endpoint**

Start the API (if not running) in a separate terminal:
```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/uvicorn api.main:app --port 8000 --reload
```

Then in another terminal:
```bash
curl -s -X POST http://localhost:8000/api/admin/reload-models | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"
```

Expected:
```json
{
  "status": "ok",
  "models_loaded": ["classifier_xgb.joblib", "regression_xgb.joblib", "dropout_xgb.joblib", "dosage_frequency.joblib", "fall_risk_xgb.joblib", "fall_risk_medians.joblib"]
}
```

- [ ] **Step 5: Commit**

```bash
git add api/routers/admin.py api/main.py
git commit -m "feat: add admin reload-models endpoint with middleware exemption"
```

---

## Task 6: RetrainService + Retrain Script + Tests

**Files:**
- Create: `api/services/retrain.py`
- Create: `scripts/18_scheduled_retrain.py`
- Create: `tests/test_retrain_service.py`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_retrain_service.py
"""Unit tests for RetrainService.check_and_trigger threshold logic."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))


def _make_state(last_count: int, state_path: Path) -> None:
    state_path.write_text(json.dumps({
        "last_retrain_session_count": last_count,
        "last_retrain_at": "2026-01-01T00:00:00",
        "last_metrics": {"rmse_mean": 0.70, "r2_mean": 0.06, "auc_roc_mean": 0.89},
    }))


def test_no_trigger_when_below_threshold(tmp_path):
    """Does not spawn subprocess when count delta < threshold."""
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)

    from services.retrain import RetrainService
    svc = RetrainService(state_path=state_file, threshold=50)
    with patch("subprocess.Popen") as mock_popen:
        svc.check_and_trigger(session_count=130)  # delta=30 < 50
        mock_popen.assert_not_called()


def test_triggers_when_at_threshold(tmp_path):
    """Spawns subprocess when count delta == threshold."""
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)

    from services.retrain import RetrainService
    svc = RetrainService(state_path=state_file, threshold=50)
    with patch("subprocess.Popen") as mock_popen:
        svc.check_and_trigger(session_count=150)  # delta=50 == 50
        mock_popen.assert_called_once()


def test_triggers_when_above_threshold(tmp_path):
    """Spawns subprocess when count delta > threshold."""
    state_file = tmp_path / "retrain_state.json"
    _make_state(100, state_file)

    from services.retrain import RetrainService
    svc = RetrainService(state_path=state_file, threshold=50)
    with patch("subprocess.Popen") as mock_popen:
        svc.check_and_trigger(session_count=200)  # delta=100 > 50
        mock_popen.assert_called_once()


def test_no_trigger_when_state_file_missing(tmp_path):
    """When no state file exists, treat last count as 0 — triggers if count >= threshold."""
    state_file = tmp_path / "retrain_state.json"
    # Don't create the file

    from services.retrain import RetrainService
    svc = RetrainService(state_path=state_file, threshold=50)
    with patch("subprocess.Popen") as mock_popen:
        svc.check_and_trigger(session_count=60)  # delta=60 >= 50
        mock_popen.assert_called_once()


def test_no_trigger_when_already_triggered_same_count(tmp_path):
    """Does not double-trigger if called again with same count."""
    state_file = tmp_path / "retrain_state.json"
    _make_state(150, state_file)  # last retrain was at 150

    from services.retrain import RetrainService
    svc = RetrainService(state_path=state_file, threshold=50)
    with patch("subprocess.Popen") as mock_popen:
        svc.check_and_trigger(session_count=150)  # delta=0 < 50
        mock_popen.assert_not_called()
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_retrain_service.py -v 2>&1 | head -15
```

Expected: `ModuleNotFoundError: No module named 'services.retrain'`

- [ ] **Step 3: Create `api/services/retrain.py`**

```python
# api/services/retrain.py
"""RetrainService — check session count threshold and spawn background retrain job."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent.parent
_RETRAIN_SCRIPT = _ROOT / "scripts" / "18_scheduled_retrain.py"
_DEFAULT_STATE_PATH = _ROOT / "retrain_state.json"
_DEFAULT_THRESHOLD = int(os.environ.get("RETRAIN_THRESHOLD", "50"))


class RetrainService:
    def __init__(
        self,
        state_path: Path = _DEFAULT_STATE_PATH,
        threshold: int = _DEFAULT_THRESHOLD,
    ) -> None:
        self._state_path = state_path
        self._threshold = threshold

    def _read_state(self) -> dict:
        if not self._state_path.exists():
            return {"last_retrain_session_count": 0}
        try:
            return json.loads(self._state_path.read_text())
        except Exception:
            return {"last_retrain_session_count": 0}

    def check_and_trigger(self, session_count: int) -> None:
        """Spawn retrain job as background subprocess if threshold exceeded.

        Non-blocking — returns immediately. Safe to call on every session creation.
        """
        state = self._read_state()
        last_count = state.get("last_retrain_session_count", 0)
        delta = session_count - last_count

        if delta < self._threshold:
            return

        logger.info(
            "Retrain threshold reached (delta=%d >= %d) — spawning background retrain",
            delta, self._threshold,
        )
        try:
            python = sys.executable
            env = os.environ.copy()
            env["PYTHONPATH"] = str(_ROOT / "src") + os.pathsep + str(_ROOT / "api")
            subprocess.Popen(
                [python, str(_RETRAIN_SCRIPT)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as exc:
            logger.warning("Failed to spawn retrain subprocess: %s", exc)
```

- [ ] **Step 4: Run tests — 5 should pass**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_retrain_service.py -v
```

Expected: `5 passed`

- [ ] **Step 5: Create `scripts/18_scheduled_retrain.py`**

```python
# scripts/18_scheduled_retrain.py
"""Script 18 — Scheduled retraining job.

Retrains outcome regression and fall risk models on current QTX data.
Saves new models only if CV metrics hold or improve versus last_metrics.
Updates retrain_state.json and calls the admin reload endpoint.

Usage (called automatically by RetrainService.check_and_trigger):
    PYTHONPATH=src:api python scripts/18_scheduled_retrain.py
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "api"))

import joblib
import numpy as np
import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from xgboost import XGBClassifier, XGBRegressor
from sklearn.model_selection import KFold, StratifiedKFold, cross_val_score
from sklearn.metrics import mean_squared_error, r2_score

from qtx.outcomes.change_scores import compute_change_scores
from qtx.outcomes.composite import compute_composite

DB_URL = "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah"
MODELS_DIR = ROOT / "models"
STATE_PATH = ROOT / "retrain_state.json"
RELOAD_URL = "http://localhost:8000/api/admin/reload-models"

REGRESSION_FEATURES_NUMERIC = [
    "age", "baseline_sppb", "pre_normal_gs_ms", "pre_tug_s", "pre_5xsst_s",
    "pre_vas", "pre_fast_gs_ms", "has_oa", "has_diabetes", "has_stroke",
    "has_parkinsons", "has_sarcopenia", "has_post_surgery", "has_balance_issue",
    "has_chronic_pain", "has_hypertension", "has_frailty", "has_fall_risk",
    "has_neurological", "has_metabolic", "has_knee_issue", "has_spinal_issue",
    "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
    "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic",
    "grp_softtissue_injury", "grp_osteoporosis",
    "rgn_spine", "rgn_knee", "rgn_ankle_foot", "rgn_hip", "rgn_lower_limb",
    "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
    "n_flags", "n_groups", "n_regions",
]
FALL_RISK_FEATURES = [
    "age", "gender_M", "has_oa", "has_diabetes", "has_stroke",
    "has_parkinsons", "has_frailty", "has_hypertension", "pre_5xsst_s", "pre_vas",
]


def _load_qtx_sessions() -> pd.DataFrame:
    engine = create_engine(DB_URL)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT
                p.age, p.gender, p.cohort, p.baseline_sppb AS patient_sppb,
                p.has_oa, p.has_diabetes, p.has_stroke, p.has_parkinsons,
                p.has_sarcopenia, p.has_frailty, p.has_balance_issue,
                p.has_post_surgery, p.has_chronic_pain, p.has_neuropathy,
                p.has_cardiovascular, p.has_hypertension, p.has_osteoporosis,
                p.has_spinal_issue, p.has_knee_issue, p.has_hip_issue,
                p.has_shoulder_issue, p.has_neurological, p.has_fracture,
                p.has_autoimmune, p.has_metabolic, p.has_wellness_only, p.has_fall_risk,
                p.grp_joint_disease, p.grp_spine_back, p.grp_neurological,
                p.grp_post_surgical, p.grp_frailty_sarcopenia, p.grp_balance_falls,
                p.grp_metabolic, p.grp_cardiovascular, p.grp_oncology,
                p.grp_autoimmune, p.grp_softtissue_injury, p.grp_generalised_pain,
                p.grp_osteoporosis, p.grp_wellness,
                p.rgn_knee, p.rgn_hip, p.rgn_spine, p.rgn_shoulder,
                p.rgn_ankle_foot, p.rgn_lower_limb, p.rgn_upper_limb,
                p.rgn_bilateral, p.rgn_trunk,
                s.usage_frequency, s.pre_vas, s.post_vas,
                s.pre_tug_s, s.post_tug_s, s.pre_5xsst_s, s.post_5xsst_s,
                s.pre_normal_gs_ms, s.post_normal_gs_ms,
                s.pre_fast_gs_ms, s.post_fast_gs_ms,
                s.baseline_sppb AS session_sppb, s.post_sppb
            FROM patients p
            JOIN sessions s ON s.patient_id = p.id
            WHERE s.ingested_from IS NULL OR s.ingested_from NOT ILIKE '%raise%'
        """)).fetchall()
    records = []
    for r in rows:
        d = dict(r._mapping)
        s_sppb = d.pop("session_sppb", None)
        p_sppb = d.pop("patient_sppb", None)
        d["baseline_sppb"] = s_sppb if s_sppb is not None else p_sppb
        gender = (d.get("gender") or "").upper()
        d["gender_M"] = 1.0 if gender == "M" else 0.0
        n_flags = sum(1 for k in d if k.startswith("has_") and d.get(k))
        n_groups = sum(1 for k in d if k.startswith("grp_") and d.get(k))
        n_regions = sum(1 for k in d if k.startswith("rgn_") and d.get(k))
        d["n_flags"] = n_flags
        d["n_groups"] = n_groups
        d["n_regions"] = n_regions
        records.append(d)
    df = pd.DataFrame(records)
    df = compute_change_scores(df)
    df = compute_composite(df)
    return df


def _retrain_regression(df: pd.DataFrame) -> tuple[dict, object] | None:
    df_m = df[df["composite_improvement"].notna()].copy()
    if len(df_m) < 20:
        print(f"  WARNING: only {len(df_m)} rows — skipping regression retrain")
        return None
    cols = [c for c in REGRESSION_FEATURES_NUMERIC if c in df_m.columns]
    X = df_m[cols].astype(float).values
    y = df_m["composite_improvement"].astype(float).values
    model = XGBRegressor(n_estimators=300, max_depth=4, learning_rate=0.05,
                         subsample=0.8, tree_method="hist", random_state=42, n_jobs=-1, verbosity=0)
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    from sklearn.base import clone
    rmse_scores, r2_scores = [], []
    for tr, val in kf.split(X):
        m = clone(model)
        m.fit(X[tr], y[tr])
        preds = m.predict(X[val])
        rmse_scores.append(math.sqrt(mean_squared_error(y[val], preds)))
        r2_scores.append(r2_score(y[val], preds))
    model.fit(X, y)
    metrics = {"rmse_mean": float(np.mean(rmse_scores)), "r2_mean": float(np.mean(r2_scores)), "n": len(df_m)}
    return metrics, model


def _make_fall_risk_label(df: pd.DataFrame):
    tug_ok = df["pre_tug_s"].notna()
    gait_ok = df["pre_normal_gs_ms"].notna()
    sppb_ok = df["baseline_sppb"].notna()
    slow_tug = tug_ok & (df["pre_tug_s"].astype(float) >= 12)
    slow_gait = gait_ok & (df["pre_normal_gs_ms"].astype(float) < 0.8)
    low_sppb = sppb_ok & (df["baseline_sppb"].astype(float) <= 6)
    measurable = tug_ok.astype(int) + gait_ok.astype(int) + sppb_ok.astype(int)
    labellable = measurable >= 2
    score = slow_tug.astype(int) + slow_gait.astype(int) + low_sppb.astype(int)
    label = (score >= 2).astype(int)
    return label, labellable


def _retrain_fall_risk(df: pd.DataFrame) -> tuple[dict, object, dict] | None:
    label, labellable = _make_fall_risk_label(df)
    df_m = df[labellable].copy()
    df_m["_label"] = label[labellable].values
    if len(df_m) < 20 or df_m["_label"].nunique() < 2:
        print("  WARNING: insufficient labellable rows or single class — skipping fall risk retrain")
        return None
    if "gender_M" not in df_m.columns:
        df_m["gender_M"] = df_m["gender"].str.upper().map({"M": 1.0, "F": 0.0})
    cols = [c for c in FALL_RISK_FEATURES if c in df_m.columns]
    X = df_m[cols].astype(float).values
    y = df_m["_label"].values
    medians = pd.DataFrame(X, columns=cols).median().to_dict()
    X_filled = pd.DataFrame(X, columns=cols).fillna(medians).values
    model = XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05,
                          subsample=0.8, tree_method="hist", random_state=42, n_jobs=-1, verbosity=0)
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(model, X_filled, y, cv=skf, scoring="roc_auc", n_jobs=-1)
    model.fit(X_filled, y)
    metrics = {"auc_roc_mean": float(np.mean(auc_scores)), "n": len(df_m)}
    return metrics, model, medians


def _read_state() -> dict:
    if not STATE_PATH.exists():
        return {"last_retrain_session_count": 0, "last_metrics": {}}
    return json.loads(STATE_PATH.read_text())


def _write_state(session_count: int, metrics: dict) -> None:
    STATE_PATH.write_text(json.dumps({
        "last_retrain_session_count": session_count,
        "last_retrain_at": datetime.now(timezone.utc).isoformat(),
        "last_metrics": metrics,
    }, indent=2))


def _metrics_improved_or_equal(old: dict, new_reg: dict, new_fr: dict) -> bool:
    """True if new metrics are at least as good as old on all comparable keys."""
    checks = []
    if "rmse_mean" in old and "rmse_mean" in new_reg:
        checks.append(new_reg["rmse_mean"] <= old["rmse_mean"] + 1e-6)
    if "r2_mean" in old and "r2_mean" in new_reg:
        checks.append(new_reg["r2_mean"] >= old["r2_mean"] - 1e-6)
    if "auc_roc_mean" in old and "auc_roc_mean" in new_fr:
        checks.append(new_fr["auc_roc_mean"] >= old["auc_roc_mean"] - 1e-6)
    return all(checks) if checks else True


def main() -> None:
    print("=== Scheduled Retrain Job ===")
    print("Loading QTX sessions from DB ...")
    df = _load_qtx_sessions()
    session_count = len(df)
    print(f"  Loaded {session_count} QTX sessions")

    state = _read_state()
    old_metrics = state.get("last_metrics", {})

    print("Retraining regression model ...")
    reg_result = _retrain_regression(df)
    print("Retraining fall risk model ...")
    fr_result = _retrain_fall_risk(df)

    if reg_result is None or fr_result is None:
        print("Retrain aborted — insufficient data.")
        return

    new_reg_metrics, reg_model = reg_result
    new_fr_metrics, fr_model, fr_medians = fr_result

    print(f"  Regression: RMSE={new_reg_metrics['rmse_mean']:.4f}, R²={new_reg_metrics['r2_mean']:.4f}")
    print(f"  Fall risk:  AUC={new_fr_metrics['auc_roc_mean']:.4f}")

    if _metrics_improved_or_equal(old_metrics, new_reg_metrics, new_fr_metrics):
        print("Metrics held or improved — saving models ...")
        joblib.dump(reg_model, MODELS_DIR / "regression_xgb.joblib")
        joblib.dump(fr_model, MODELS_DIR / "fall_risk_xgb.joblib")
        joblib.dump(fr_medians, MODELS_DIR / "fall_risk_medians.joblib")
        print("  Saved: regression_xgb.joblib, fall_risk_xgb.joblib, fall_risk_medians.joblib")

        combined_metrics = {**new_reg_metrics, **new_fr_metrics}
        _write_state(session_count, combined_metrics)

        try:
            import urllib.request
            req = urllib.request.Request(RELOAD_URL, method="POST")
            with urllib.request.urlopen(req, timeout=5) as resp:
                print(f"  Hot-reload: {resp.read().decode()}")
        except Exception as exc:
            print(f"  WARNING: hot-reload call failed: {exc} — API still using old models")
    else:
        print("Metrics did not improve — not saving models.")
        _write_state(session_count, old_metrics)

    print("=== Retrain complete ===")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Add `retrain_state.json` to `.gitignore`**

Open `.gitignore` and append:
```
retrain_state.json
```

- [ ] **Step 7: Run retrain tests — confirm 5 pass**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_retrain_service.py -v
```

Expected: `5 passed`

- [ ] **Step 8: Commit**

```bash
git add api/services/retrain.py scripts/18_scheduled_retrain.py tests/test_retrain_service.py .gitignore
git commit -m "feat: add RetrainService, scheduled retrain job, and retrain state management"
```

---

## Task 7: Wire Retrain Trigger into Session Creation

**Files:**
- Modify: `api/routers/sessions.py`

- [ ] **Step 1: Add retrain trigger import to `api/routers/sessions.py`**

Add to the imports section at the top:
```python
from sqlalchemy import func
from services.retrain import RetrainService
```

(`from sqlalchemy import func` is already present — skip if it is.)

- [ ] **Step 2: After the final `db.commit()` in `create_session`, add the trigger call**

Current final block:
```python
    db.commit()  # commit PatientInsight row

    return {
        "sn":             sn,
        "session_number": new_sn,
        ...
    }
```

Add between the commit and the return:
```python
    # Non-blocking retrain trigger — fires background subprocess when threshold met
    try:
        session_count = db.query(func.count(ClinicalSession.id)).scalar() or 0
        RetrainService().check_and_trigger(session_count)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Retrain trigger failed: %s", exc)
```

- [ ] **Step 3: Run full test suite**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -q 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/routers/sessions.py
git commit -m "feat: wire retrain trigger into session creation endpoint"
```

---

## Task 8: Integration Test + Push

- [ ] **Step 1: Start the API**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/uvicorn api.main:app --port 8000
```

Confirm startup output includes `DB ready — N patients loaded` and no model errors.

- [ ] **Step 2: Create a test session via the API**

Get the first patient SN from the DB:
```bash
PYTHONPATH=src:api .venv/bin/python3.14 -c "
import sys; sys.path.insert(0, 'api')
from db import _get_engine
from sqlalchemy import text
engine = _get_engine()
with engine.connect() as conn:
    sn = conn.execute(text('SELECT sn FROM patients LIMIT 1')).scalar()
    print('SN:', sn)
"
```

Then create a session (replace `YOUR_API_KEY` with the value in `.env`):
```bash
SN="<paste SN here>"
API_KEY="<value of QTX_API_KEY from .env>"
curl -s -X POST "http://localhost:8000/api/patient/${SN}/session" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${API_KEY}" \
  -d '{"pre_tug_s": 14.0, "post_tug_s": 12.5, "pre_vas": 6.0, "post_vas": 4.0, "session_date": "2026-06-03"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('session_number:', d.get('session_number')); print('insight:', d.get('insight','')[:100])"
```

Expected: session_number returned, insight text present.

- [ ] **Step 3: Verify `session_predictions` row was created**

```bash
PYTHONPATH=src:api .venv/bin/python3.14 -c "
import sys; sys.path.insert(0, 'api')
from db import _get_engine
from sqlalchemy import text
engine = _get_engine()
with engine.connect() as conn:
    rows = conn.execute(text(
        'SELECT fall_risk_score, fall_risk_label, predicted_composite_improvement, dosage_recommendation FROM session_predictions ORDER BY predicted_at DESC LIMIT 1'
    )).fetchall()
    for r in rows:
        print(dict(r._mapping))
"
```

Expected: row with numeric predictions printed.

- [ ] **Step 4: Run full test suite one final time**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -q 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Push**

```bash
git push
```
