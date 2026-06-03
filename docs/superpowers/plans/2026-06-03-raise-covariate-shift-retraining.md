# RAISE Covariate Shift & Conditional Retraining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `scripts/17_raise_model_evaluation.py` — a pipeline that tests whether RAISE and QTX populations are safe to merge, then conditionally retrains the outcome regression and fall risk models on combined data.

**Architecture:** Pure helper functions (gate logic, flag counts) are unit-tested in isolation. Data loading, shift test, and retraining functions integrate with the existing `src/qtx/` modules. The `main()` function chains everything and prints a comparison report.

**Tech Stack:** XGBoost, SHAP, scikit-learn, SQLAlchemy, pandas, joblib. All in `.venv`. Run with `PYTHONPATH=src:api`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/17_raise_model_evaluation.py` | Create | Full pipeline: data assembly → shift test → gates → retrain → report |
| `tests/test_raise_evaluation.py` | Create | Unit tests for pure helpers (flag counts, gates, save decision) |

No changes to any existing files.

---

## Context You Must Know

**Project root:** `/Users/reetmitra/Desktop/QTX/quantumtx-ah`

**Python:** `.venv/bin/python3.14`

**Test runner:** `PYTHONPATH=src:api .venv/bin/pytest`

**DB URL:** `postgresql+psycopg2://qtx:secret@localhost:5432/qtxah`

**Parquet:** `data/processed/dashboard_data.parquet` (1716 QTX patients, 73 columns)

**Key imports from existing code:**
- `from qtx.outcomes.change_scores import compute_change_scores` — needs `PYTHONPATH=src`
- `from qtx.outcomes.composite import compute_composite` — needs `PYTHONPATH=src`
- `from qtx.utils.config import get_models_config` — loads `config/models.yaml`
- Both `Patient` and `Session` ORM models live in `api/models/clinical.py` — needs `PYTHONPATH=...api`

**Fall risk model:** `models/fall_risk_xgb.joblib` was trained in `scripts/09_train_fall_risk_model.py` using a **proxy label** (not the `has_fall_risk` DB column which is all-zero in QTX). The proxy: `high_risk = (pre_tug_s >= 12) + (pre_normal_gs_ms < 0.8) + (baseline_sppb <= 6) >= 2`. Use the same label here. Features: `['age', 'gender_M', 'has_oa', 'has_diabetes', 'has_stroke', 'has_parkinsons', 'has_frailty', 'has_hypertension', 'pre_5xsst_s', 'pre_vas']`.

**RAISE rows in DB:** identified by `sessions.ingested_from LIKE 'raise%'`. Session has pre_* clinical columns; Patient has demographic + flag columns. Both needed.

**Flag column groups (for n_flags / n_groups / n_regions):**
```python
HAS_COLS = ["has_oa","has_diabetes","has_stroke","has_parkinsons","has_sarcopenia",
            "has_frailty","has_balance_issue","has_post_surgery","has_chronic_pain",
            "has_neuropathy","has_cancer","has_cardiovascular","has_hypertension",
            "has_osteoporosis","has_spinal_issue","has_knee_issue","has_hip_issue",
            "has_shoulder_issue","has_neurological","has_fracture","has_autoimmune",
            "has_metabolic","has_wellness_only","has_fall_risk"]
GRP_COLS = ["grp_joint_disease","grp_spine_back","grp_neurological","grp_post_surgical",
            "grp_frailty_sarcopenia","grp_balance_falls","grp_metabolic","grp_cardiovascular",
            "grp_oncology","grp_autoimmune","grp_softtissue_injury","grp_generalised_pain",
            "grp_osteoporosis","grp_wellness"]
RGN_COLS = ["rgn_knee","rgn_hip","rgn_spine","rgn_shoulder","rgn_ankle_foot",
            "rgn_lower_limb","rgn_upper_limb","rgn_bilateral","rgn_trunk"]
```

**Feature list for shift test and regression model** (from `config/models.yaml` `regression_composite.features`):
```python
SHIFT_FEATURES = [
    "age","gender","baseline_sppb","pre_normal_gs_ms","pre_tug_s","pre_5xsst_s",
    "usage_frequency","cohort","has_oa","has_diabetes","has_stroke","has_parkinsons",
    "has_sarcopenia","has_post_surgery","has_balance_issue","has_chronic_pain",
    "pre_vas","pre_fast_gs_ms","n_flags","n_regions","n_groups","has_hypertension",
    "has_frailty","has_fall_risk","has_neurological","has_metabolic","has_knee_issue",
    "has_spinal_issue","grp_joint_disease","grp_spine_back","grp_neurological",
    "grp_post_surgical","grp_frailty_sarcopenia","grp_balance_falls","grp_metabolic",
    "grp_softtissue_injury","grp_osteoporosis","rgn_spine","rgn_knee","rgn_ankle_foot",
    "rgn_hip","rgn_lower_limb","rgn_shoulder","rgn_upper_limb","rgn_trunk",
    "primary_indication",
]
```

Categorical columns that need label-encoding for XGBoost:
```python
CAT_COLS = ["gender", "cohort", "usage_frequency", "primary_indication"]
```

---

## Task 1: Scaffold + Pure Helper Functions + Unit Tests

**Files:**
- Create: `scripts/17_raise_model_evaluation.py`
- Create: `tests/test_raise_evaluation.py`

This task scaffolds the full script with all imports and function stubs, implements the pure helpers (no DB/file I/O), and writes unit tests for them.

- [ ] **Step 1: Create the script scaffold**

```python
# scripts/17_raise_model_evaluation.py
"""Script 17 — RAISE covariate shift analysis and conditional retraining.

Tests whether RAISE and QTX populations are safe to merge using two gates:
  1. XGBoost shift classifier AUC < 0.70  (populations indistinguishable)
  2. Cohort + usage_frequency SHAP < 15%  (separation not driven by programme)

If both gates pass, retrains outcome regression and fall risk models on combined
data and saves augmented models if combined metrics >= QTX-only metrics.

Usage:
    PYTHONPATH=src:api python scripts/17_raise_model_evaluation.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "api"))

import math
import numpy as np
import pandas as pd
import joblib
import shap
from xgboost import XGBClassifier, XGBRegressor
from sklearn.model_selection import StratifiedKFold, KFold, cross_val_score
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from qtx.outcomes.change_scores import compute_change_scores
from qtx.outcomes.composite import compute_composite

DB_URL = "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah"
PARQUET = ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = ROOT / "models"

HAS_COLS = [
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons", "has_sarcopenia",
    "has_frailty", "has_balance_issue", "has_post_surgery", "has_chronic_pain",
    "has_neuropathy", "has_cancer", "has_cardiovascular", "has_hypertension",
    "has_osteoporosis", "has_spinal_issue", "has_knee_issue", "has_hip_issue",
    "has_shoulder_issue", "has_neurological", "has_fracture", "has_autoimmune",
    "has_metabolic", "has_wellness_only", "has_fall_risk",
]
GRP_COLS = [
    "grp_joint_disease", "grp_spine_back", "grp_neurological", "grp_post_surgical",
    "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic", "grp_cardiovascular",
    "grp_oncology", "grp_autoimmune", "grp_softtissue_injury", "grp_generalised_pain",
    "grp_osteoporosis", "grp_wellness",
]
RGN_COLS = [
    "rgn_knee", "rgn_hip", "rgn_spine", "rgn_shoulder", "rgn_ankle_foot",
    "rgn_lower_limb", "rgn_upper_limb", "rgn_bilateral", "rgn_trunk",
]
SHIFT_FEATURES = [
    "age", "gender", "baseline_sppb", "pre_normal_gs_ms", "pre_tug_s", "pre_5xsst_s",
    "usage_frequency", "cohort", "has_oa", "has_diabetes", "has_stroke", "has_parkinsons",
    "has_sarcopenia", "has_post_surgery", "has_balance_issue", "has_chronic_pain",
    "pre_vas", "pre_fast_gs_ms", "n_flags", "n_regions", "n_groups", "has_hypertension",
    "has_frailty", "has_fall_risk", "has_neurological", "has_metabolic", "has_knee_issue",
    "has_spinal_issue", "grp_joint_disease", "grp_spine_back", "grp_neurological",
    "grp_post_surgical", "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic",
    "grp_softtissue_injury", "grp_osteoporosis", "rgn_spine", "rgn_knee", "rgn_ankle_foot",
    "rgn_hip", "rgn_lower_limb", "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
    "primary_indication",
]
CAT_COLS = ["gender", "cohort", "usage_frequency", "primary_indication"]
FALL_RISK_FEATURES = [
    "age", "gender_M", "has_oa", "has_diabetes", "has_stroke", "has_parkinsons",
    "has_frailty", "has_hypertension", "pre_5xsst_s", "pre_vas",
]


def _compute_flag_counts(row: dict) -> dict:
    """Return n_flags, n_groups, n_regions from a patient row dict."""
    n_flags = sum(bool(row.get(c, False)) for c in HAS_COLS)
    n_groups = sum(bool(row.get(c, False)) for c in GRP_COLS)
    n_regions = sum(bool(row.get(c, False)) for c in RGN_COLS)
    return {"n_flags": n_flags, "n_groups": n_groups, "n_regions": n_regions}


def auc_gate(auc_score: float, threshold: float = 0.70) -> bool:
    """Return True (PASS) if AUC < threshold (populations indistinguishable)."""
    return auc_score < threshold


def shap_gate(
    shap_df: pd.DataFrame,
    confound_cols: list[str],
    threshold: float = 0.15,
) -> tuple[bool, float]:
    """Return (passes, confound_pct).

    passes=True when combined confound SHAP importance < threshold.
    confound_cols are prefix-matched (post-dummies names like 'cohort_Pain').
    shap_df must have columns: feature, mean_abs_shap.
    """
    total = shap_df["mean_abs_shap"].sum()
    if total == 0:
        return True, 0.0
    confound_mask = shap_df["feature"].apply(
        lambda f: any(f == c or f.startswith(c + "_") for c in confound_cols)
    )
    confound_shap = shap_df.loc[confound_mask, "mean_abs_shap"].sum()
    pct = confound_shap / total
    return pct < threshold, float(pct)


def should_save_models(baseline: dict, combined: dict) -> bool:
    """Return True if combined metrics are at least as good as baseline on all keys.

    For RMSE: lower is better (combined_rmse <= baseline_rmse).
    For R2 and AUC: higher is better (combined >= baseline).
    Comparison keys must exist in both dicts. Unknown keys are ignored.
    """
    for key in baseline:
        if key not in combined:
            continue
        b, c = baseline[key], combined[key]
        if b is None or c is None:
            continue
        if "rmse" in key:
            if c > b + 1e-9:
                return False
        else:
            if c < b - 1e-9:
                return False
    return True


def load_qtx_df(parquet_path: Path | str = PARQUET) -> pd.DataFrame:
    """Load QTX parquet and add dataset=0 flag."""
    raise NotImplementedError


def load_raise_df(db_url: str = DB_URL) -> pd.DataFrame:
    """Query RAISE patients + sessions from DB, compute change scores + composite."""
    raise NotImplementedError


def assemble_combined(qtx_df: pd.DataFrame, raise_df: pd.DataFrame) -> pd.DataFrame:
    """Concatenate QTX + RAISE dataframes, ensuring consistent columns."""
    raise NotImplementedError


def _label_encode_cats(df: pd.DataFrame, cat_cols: list[str] = CAT_COLS) -> pd.DataFrame:
    """Label-encode categorical columns in-place (NaN → -1, XGBoost handles as missing)."""
    raise NotImplementedError


def run_shift_test(df: pd.DataFrame) -> tuple[float, pd.DataFrame]:
    """Train XGBoost binary classifier to predict dataset (0=QTX, 1=RAISE).

    Returns (mean_auc_roc, shap_df) from 5-fold stratified CV.
    shap_df has columns: feature, mean_abs_shap.
    """
    raise NotImplementedError


def _make_fall_risk_label(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Derive proxy fall-risk label. Returns (label, labellable_mask)."""
    raise NotImplementedError


def cv_metrics_regression(df: pd.DataFrame) -> dict:
    """5-fold CV RMSE and R2 for composite_improvement prediction."""
    raise NotImplementedError


def cv_metrics_fall_risk(df: pd.DataFrame) -> dict:
    """5-fold CV AUC-ROC for fall risk proxy label prediction."""
    raise NotImplementedError


def _print_report(
    shift_auc: float,
    shift_passes: bool,
    confound_pct: float,
    shap_passes: bool,
    qtx_reg: dict | None = None,
    comb_reg: dict | None = None,
    qtx_fr: dict | None = None,
    comb_fr: dict | None = None,
    models_saved: bool = False,
    skip_reason: str = "",
) -> None:
    """Print the formatted comparison report to stdout."""
    raise NotImplementedError


def main() -> None:
    raise NotImplementedError


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write failing tests for the pure helpers**

```python
# tests/test_raise_evaluation.py
"""Unit tests for scripts/17_raise_model_evaluation.py pure helpers."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pandas as pd
import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "17_raise_model_evaluation.py"
spec = importlib.util.spec_from_file_location("raise_eval", _SCRIPT)
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)

_compute_flag_counts = _mod._compute_flag_counts
auc_gate = _mod.auc_gate
shap_gate = _mod.shap_gate
should_save_models = _mod.should_save_models


# ── _compute_flag_counts ──────────────────────────────────────────────────────

def test_flag_counts_all_false():
    row = {c: False for c in _mod.HAS_COLS + _mod.GRP_COLS + _mod.RGN_COLS}
    counts = _compute_flag_counts(row)
    assert counts == {"n_flags": 0, "n_groups": 0, "n_regions": 0}


def test_flag_counts_some_true():
    row = {"has_oa": True, "has_frailty": True, "grp_balance_falls": True, "rgn_knee": True}
    counts = _compute_flag_counts(row)
    assert counts["n_flags"] == 2
    assert counts["n_groups"] == 1
    assert counts["n_regions"] == 1


def test_flag_counts_missing_keys_treated_as_false():
    counts = _compute_flag_counts({})
    assert counts == {"n_flags": 0, "n_groups": 0, "n_regions": 0}


def test_flag_counts_truthy_int():
    row = {"has_diabetes": 1, "has_stroke": 0}
    counts = _compute_flag_counts(row)
    assert counts["n_flags"] == 1


# ── auc_gate ─────────────────────────────────────────────────────────────────

def test_auc_gate_passes_below_threshold():
    assert auc_gate(0.65) is True


def test_auc_gate_fails_at_threshold():
    assert auc_gate(0.70) is False


def test_auc_gate_fails_above_threshold():
    assert auc_gate(0.85) is False


def test_auc_gate_custom_threshold():
    assert auc_gate(0.60, threshold=0.55) is False
    assert auc_gate(0.50, threshold=0.55) is True


# ── shap_gate ─────────────────────────────────────────────────────────────────

def _make_shap_df(rows: list[tuple[str, float]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["feature", "mean_abs_shap"])


def test_shap_gate_passes_when_confound_low():
    shap_df = _make_shap_df([
        ("age", 0.50), ("pre_tug_s", 0.30), ("cohort_Pain", 0.05), ("usage_frequency_weekly", 0.05)
    ])
    passes, pct = shap_gate(shap_df, ["cohort", "usage_frequency"])
    assert passes is True
    assert abs(pct - 0.10) < 1e-9


def test_shap_gate_fails_when_confound_high():
    shap_df = _make_shap_df([
        ("age", 0.20), ("cohort_Pain", 0.50), ("usage_frequency_bixeps", 0.30)
    ])
    passes, pct = shap_gate(shap_df, ["cohort", "usage_frequency"])
    assert passes is False
    assert pct > 0.15


def test_shap_gate_exact_feature_name_match():
    shap_df = _make_shap_df([("cohort", 0.10), ("age", 0.90)])
    passes, pct = shap_gate(shap_df, ["cohort"])
    assert abs(pct - 0.10) < 1e-9


def test_shap_gate_zero_total_returns_pass():
    shap_df = _make_shap_df([("cohort", 0.0), ("age", 0.0)])
    passes, pct = shap_gate(shap_df, ["cohort"])
    assert passes is True
    assert pct == 0.0


# ── should_save_models ────────────────────────────────────────────────────────

def test_should_save_when_combined_better():
    b = {"rmse_mean": 1.0, "r2_mean": 0.5}
    c = {"rmse_mean": 0.9, "r2_mean": 0.6}
    assert should_save_models(b, c) is True


def test_should_not_save_when_rmse_worse():
    b = {"rmse_mean": 1.0}
    c = {"rmse_mean": 1.1}
    assert should_save_models(b, c) is False


def test_should_not_save_when_r2_worse():
    b = {"r2_mean": 0.5}
    c = {"r2_mean": 0.4}
    assert should_save_models(b, c) is False


def test_should_save_when_combined_equal():
    b = {"rmse_mean": 1.0, "auc_roc_mean": 0.75}
    c = {"rmse_mean": 1.0, "auc_roc_mean": 0.75}
    assert should_save_models(b, c) is True


def test_should_save_skips_missing_keys():
    b = {"rmse_mean": 1.0}
    c = {"rmse_mean": 0.9, "extra": 99}
    assert should_save_models(b, c) is True
```

- [ ] **Step 3: Run tests — expect import error on NotImplementedError functions, but pure helpers should load**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_evaluation.py -v 2>&1 | head -60
```

Expected: The module will load (stubs are functions, not errors). Pure helper tests should PASS (17 tests). The `NotImplementedError` stubs don't affect import.

- [ ] **Step 4: Implement `_compute_flag_counts`, `auc_gate`, `shap_gate`, `should_save_models` if any tests fail**

They are already implemented in Step 1. If any test fails, fix the function.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_evaluation.py -v
```

Expected: 17 PASSED, 0 failed.

- [ ] **Step 6: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add scripts/17_raise_model_evaluation.py tests/test_raise_evaluation.py
git commit -m "feat: scaffold raise evaluation script + pure helper tests"
```

---

## Task 2: Data Loading Functions

**Files:**
- Modify: `scripts/17_raise_model_evaluation.py` — implement `load_qtx_df`, `load_raise_df`, `assemble_combined`, `_label_encode_cats`

All four `NotImplementedError` stubs from Task 1 for data loading are implemented here.

- [ ] **Step 1: Implement `load_qtx_df`**

Replace the `raise NotImplementedError` in `load_qtx_df`:

```python
def load_qtx_df(parquet_path: Path | str = PARQUET) -> pd.DataFrame:
    """Load QTX parquet and add dataset=0 flag."""
    df = pd.read_parquet(parquet_path)
    df["dataset"] = 0
    return df
```

- [ ] **Step 2: Implement `load_raise_df`**

Replace the `raise NotImplementedError` in `load_raise_df`:

```python
def load_raise_df(db_url: str = DB_URL) -> pd.DataFrame:
    """Query RAISE patients + sessions from DB, compute change scores + composite."""
    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        rows = db.execute(text("""
            SELECT
                p.age, p.gender, p.cohort, p.tags, p.primary_indication,
                p.baseline_sppb AS patient_baseline_sppb,
                p.pre_tandem_s,
                p.has_oa, p.has_diabetes, p.has_stroke, p.has_parkinsons,
                p.has_sarcopenia, p.has_frailty, p.has_balance_issue,
                p.has_post_surgery, p.has_chronic_pain, p.has_neuropathy,
                p.has_cancer, p.has_cardiovascular, p.has_hypertension,
                p.has_osteoporosis, p.has_spinal_issue, p.has_knee_issue,
                p.has_hip_issue, p.has_shoulder_issue, p.has_neurological,
                p.has_fracture, p.has_autoimmune, p.has_metabolic,
                p.has_wellness_only, p.has_fall_risk,
                p.grp_joint_disease, p.grp_spine_back, p.grp_neurological,
                p.grp_post_surgical, p.grp_frailty_sarcopenia, p.grp_balance_falls,
                p.grp_metabolic, p.grp_cardiovascular, p.grp_oncology,
                p.grp_autoimmune, p.grp_softtissue_injury, p.grp_generalised_pain,
                p.grp_osteoporosis, p.grp_wellness,
                p.rgn_knee, p.rgn_hip, p.rgn_spine, p.rgn_shoulder,
                p.rgn_ankle_foot, p.rgn_lower_limb, p.rgn_upper_limb,
                p.rgn_bilateral, p.rgn_trunk,
                s.usage_frequency,
                s.pre_vas, s.post_vas,
                s.pre_tug_s, s.post_tug_s,
                s.pre_5xsst_s, s.post_5xsst_s,
                s.pre_normal_gs_ms, s.post_normal_gs_ms,
                s.pre_fast_gs_ms, s.post_fast_gs_ms,
                s.baseline_sppb AS session_baseline_sppb,
                s.post_sppb
            FROM patients p
            JOIN sessions s ON s.patient_id = p.id
            WHERE s.ingested_from LIKE 'raise%'
        """)).fetchall()
    finally:
        db.close()

    if not rows:
        return pd.DataFrame()

    records = []
    for r in rows:
        row_dict = dict(r._mapping)
        # Use session baseline_sppb if available, else patient (cannot use `or` — 0 is valid)
        s_sppb = row_dict.pop("session_baseline_sppb", None)
        p_sppb = row_dict.pop("patient_baseline_sppb", None)
        row_dict["baseline_sppb"] = s_sppb if s_sppb is not None else p_sppb
        counts = _compute_flag_counts(row_dict)
        row_dict.update(counts)
        row_dict["dataset"] = 1
        records.append(row_dict)

    df = pd.DataFrame(records)
    df = compute_change_scores(df)
    # fast_gs NaN for RAISE — fast_gs_improvement col may not exist
    if "fast_gs_improvement" not in df.columns:
        df["fast_gs_improvement"] = float("nan")
    df = compute_composite(df)
    return df
```

- [ ] **Step 3: Implement `assemble_combined`**

Replace the `raise NotImplementedError` in `assemble_combined`:

```python
def assemble_combined(qtx_df: pd.DataFrame, raise_df: pd.DataFrame) -> pd.DataFrame:
    """Concatenate QTX + RAISE dataframes, ensuring consistent columns."""
    # Add missing columns to RAISE that QTX has
    for col in qtx_df.columns:
        if col not in raise_df.columns:
            raise_df = raise_df.copy()
            raise_df[col] = float("nan")
    # Add missing columns to QTX that RAISE has (unlikely but safe)
    for col in raise_df.columns:
        if col not in qtx_df.columns:
            qtx_df = qtx_df.copy()
            qtx_df[col] = float("nan")
    combined = pd.concat([qtx_df, raise_df], ignore_index=True)
    return combined
```

- [ ] **Step 4: Implement `_label_encode_cats`**

Replace the `raise NotImplementedError` in `_label_encode_cats`:

```python
def _label_encode_cats(df: pd.DataFrame, cat_cols: list[str] = CAT_COLS) -> pd.DataFrame:
    """Label-encode categorical columns in-place (NaN → -1, XGBoost handles as missing)."""
    df = df.copy()
    for col in cat_cols:
        if col not in df.columns:
            df[col] = -1
            continue
        cat = pd.Categorical(df[col].astype(str).where(df[col].notna(), other=None))
        df[col] = cat.codes.astype(float)
        df[col] = df[col].replace(-1, float("nan"))
    return df
```

- [ ] **Step 5: Smoke-test data loading against the real DB**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/python3.14 -c "
from scripts import __init__  # import won't work due to digit prefix
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location('re17', 'scripts/17_raise_model_evaluation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
qtx = m.load_qtx_df()
print('QTX shape:', qtx.shape)
raise_df = m.load_raise_df()
print('RAISE shape:', raise_df.shape)
print('RAISE composite non-null:', raise_df['composite_improvement'].notna().sum())
combined = m.assemble_combined(qtx, raise_df)
print('Combined shape:', combined.shape)
print('dataset counts:', combined['dataset'].value_counts().to_dict())
"
```

Expected: QTX shape (1716, 74+), RAISE shape (162, ~60+), Combined shape ~(1878, N), dataset {0: 1716, 1: 162}.

- [ ] **Step 6: Run existing tests to confirm no regressions**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_evaluation.py -v
```

Expected: 17 PASSED.

- [ ] **Step 7: Commit**

```bash
git add scripts/17_raise_model_evaluation.py
git commit -m "feat: implement data loading functions for raise evaluation"
```

---

## Task 3: Shift Test Function

**Files:**
- Modify: `scripts/17_raise_model_evaluation.py` — implement `run_shift_test`

- [ ] **Step 1: Implement `run_shift_test`**

Replace the `raise NotImplementedError` in `run_shift_test`:

```python
def run_shift_test(df: pd.DataFrame) -> tuple[float, pd.DataFrame]:
    """Train XGBoost binary classifier to predict dataset (0=QTX, 1=RAISE).

    Returns (mean_auc_roc, shap_df) from 5-fold stratified CV.
    shap_df has columns: feature, mean_abs_shap. Computed on full dataset after final fit.
    """
    feature_cols = [c for c in SHIFT_FEATURES if c in df.columns]
    X = _label_encode_cats(df[feature_cols + ["dataset"]].copy())[feature_cols]
    y = df["dataset"].astype(int)

    # Drop rows missing the target
    mask = y.notna()
    X, y = X[mask], y[mask]

    X_arr = X.values.astype(float)
    y_arr = y.values

    clf = XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        tree_method="hist",
        random_state=42,
        n_jobs=-1,
        verbosity=0,
    )

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(clf, X_arr, y_arr, cv=skf, scoring="roc_auc", n_jobs=-1)
    mean_auc = float(np.mean(auc_scores))

    # Fit on full data for SHAP
    clf.fit(X_arr, y_arr)
    X_sample = X if len(X) <= 300 else X.sample(300, random_state=42)
    explainer = shap.TreeExplainer(clf)
    shap_vals = explainer.shap_values(X_sample.values.astype(float))
    if isinstance(shap_vals, list):
        shap_vals = shap_vals[1]
    mean_abs = np.abs(shap_vals).mean(axis=0)
    shap_df = pd.DataFrame({"feature": X_sample.columns.tolist(), "mean_abs_shap": mean_abs})
    shap_df = shap_df.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)

    return mean_auc, shap_df
```

- [ ] **Step 2: Smoke-test the shift test**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/python3.14 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('re17', 'scripts/17_raise_model_evaluation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
qtx = m.load_qtx_df()
raise_df = m.load_raise_df()
combined = m.assemble_combined(qtx, raise_df)
auc, shap_df = m.run_shift_test(combined)
print(f'Shift AUC: {auc:.3f}')
print('Top 10 SHAP features:')
print(shap_df.head(10).to_string())
passes_auc = m.auc_gate(auc)
confound_pct_result = m.shap_gate(shap_df, ['cohort', 'usage_frequency'])
print(f'AUC gate: {\"PASS\" if passes_auc else \"FAIL\"}')
print(f'SHAP gate: {\"PASS\" if confound_pct_result[0] else \"FAIL\"} ({confound_pct_result[1]*100:.1f}%)')
"
```

Expected: AUC printed (likely > 0.70 given METTA heterogeneity), SHAP table showing top features. Script should complete without errors.

- [ ] **Step 3: Run tests**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_evaluation.py -v
```

Expected: 17 PASSED.

- [ ] **Step 4: Commit**

```bash
git add scripts/17_raise_model_evaluation.py
git commit -m "feat: implement covariate shift test with SHAP for raise evaluation"
```

---

## Task 4: Retraining Functions

**Files:**
- Modify: `scripts/17_raise_model_evaluation.py` — implement `_make_fall_risk_label`, `cv_metrics_regression`, `cv_metrics_fall_risk`

- [ ] **Step 1: Implement `_make_fall_risk_label`**

Replace the `raise NotImplementedError` in `_make_fall_risk_label`:

```python
def _make_fall_risk_label(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Derive proxy fall-risk label (same method as scripts/09_train_fall_risk_model.py).

    Returns (label Series, labellable_mask Series).
    High risk = 2+ of: TUG >= 12s, gait < 0.8 m/s, SPPB <= 6.
    Only patients with >= 2 of the 3 measurements are labellable.
    """
    tug_ok  = df["pre_tug_s"].notna()
    gait_ok = df["pre_normal_gs_ms"].notna()
    sppb_ok = df["baseline_sppb"].notna()

    slow_tug  = tug_ok  & (df["pre_tug_s"].astype(float)          >= 12)
    slow_gait = gait_ok & (df["pre_normal_gs_ms"].astype(float)    < 0.8)
    low_sppb  = sppb_ok & (df["baseline_sppb"].astype(float)       <= 6)

    measurable = tug_ok.astype(int) + gait_ok.astype(int) + sppb_ok.astype(int)
    labellable = measurable >= 2

    score = slow_tug.astype(int) + slow_gait.astype(int) + low_sppb.astype(int)
    label = (score >= 2).astype(int)
    return label, labellable
```

- [ ] **Step 2: Implement `cv_metrics_regression`**

Replace the `raise NotImplementedError` in `cv_metrics_regression`:

```python
def cv_metrics_regression(df: pd.DataFrame) -> dict:
    """5-fold CV RMSE and R2 for composite_improvement prediction.

    Uses SHIFT_FEATURES (same feature set as shift test). Label-encodes categoricals.
    XGBoost handles NaN natively. Returns {"rmse_mean", "r2_mean"} or {} if insufficient data.
    """
    df_model = df[df["composite_improvement"].notna()].copy()
    if len(df_model) < 20:
        print(f"  WARNING: only {len(df_model)} rows with composite_improvement — skipping regression CV")
        return {}

    feature_cols = [c for c in SHIFT_FEATURES if c in df_model.columns]
    df_enc = _label_encode_cats(df_model[feature_cols])
    X = df_enc.values.astype(float)
    y = df_model["composite_improvement"].astype(float).values

    model = XGBRegressor(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=42, n_jobs=-1, verbosity=0,
    )
    kf = KFold(n_splits=5, shuffle=True, random_state=42)

    from sklearn.metrics import mean_squared_error, r2_score
    from sklearn.base import clone
    rmse_scores, r2_scores = [], []
    for train_idx, val_idx in kf.split(X):
        m = clone(model)
        m.fit(X[train_idx], y[train_idx])
        preds = m.predict(X[val_idx])
        rmse_scores.append(math.sqrt(mean_squared_error(y[val_idx], preds)))
        r2_scores.append(r2_score(y[val_idx], preds))

    return {
        "rmse_mean": float(np.mean(rmse_scores)),
        "r2_mean": float(np.mean(r2_scores)),
        "n": len(df_model),
    }
```

- [ ] **Step 3: Implement `cv_metrics_fall_risk`**

Replace the `raise NotImplementedError` in `cv_metrics_fall_risk`:

```python
def cv_metrics_fall_risk(df: pd.DataFrame) -> dict:
    """5-fold CV AUC-ROC for fall risk proxy label prediction.

    Uses the same proxy label and features as scripts/09_train_fall_risk_model.py.
    Returns {"auc_roc_mean", "n"} or {} if only one class or insufficient data.
    """
    label, labellable = _make_fall_risk_label(df)
    df_model = df[labellable].copy()
    df_model["_fall_label"] = label[labellable].values

    if len(df_model) < 20:
        print(f"  WARNING: only {len(df_model)} labellable rows — skipping fall risk CV")
        return {}

    if df_model["_fall_label"].nunique() < 2:
        print(f"  WARNING: only one class for fall risk in this dataset — skipping CV")
        return {"auc_roc_mean": None, "n": len(df_model)}

    # Build features: encode gender as gender_M, then select FALL_RISK_FEATURES
    df_feat = df_model.copy()
    if "gender_M" not in df_feat.columns:
        gender_upper = df_feat["gender"].astype(str).str.upper()
        df_feat["gender_M"] = gender_upper.map({"M": 1.0, "F": 0.0})

    feature_cols = [c for c in FALL_RISK_FEATURES if c in df_feat.columns]
    X = df_feat[feature_cols].astype(float).values
    y = df_feat["_fall_label"].astype(int).values

    model = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=42, n_jobs=-1, verbosity=0,
    )
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(model, X, y, cv=skf, scoring="roc_auc", n_jobs=-1)
    return {"auc_roc_mean": float(np.mean(auc_scores)), "n": len(df_model)}
```

- [ ] **Step 4: Smoke-test retraining functions on QTX-only data**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/python3.14 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('re17', 'scripts/17_raise_model_evaluation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
qtx = m.load_qtx_df()
print('=== QTX-only metrics ===')
reg = m.cv_metrics_regression(qtx)
print('Regression:', reg)
fr = m.cv_metrics_fall_risk(qtx)
print('Fall risk:', fr)
"
```

Expected: Regression dict with rmse_mean, r2_mean. Fall risk dict with auc_roc_mean. No errors.

- [ ] **Step 5: Run tests**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_evaluation.py -v
```

Expected: 17 PASSED.

- [ ] **Step 6: Commit**

```bash
git add scripts/17_raise_model_evaluation.py
git commit -m "feat: implement retraining CV metrics functions for raise evaluation"
```

---

## Task 5: Main Function, Report, Model Saving + End-to-End

**Files:**
- Modify: `scripts/17_raise_model_evaluation.py` — implement `_print_report` and `main`

- [ ] **Step 1: Implement `_print_report`**

Replace the `raise NotImplementedError` in `_print_report`:

```python
def _print_report(
    shift_auc: float,
    shift_passes: bool,
    confound_pct: float,
    shap_passes: bool,
    qtx_reg: dict | None = None,
    comb_reg: dict | None = None,
    qtx_fr: dict | None = None,
    comb_fr: dict | None = None,
    models_saved: bool = False,
    skip_reason: str = "",
) -> None:
    """Print the formatted comparison report to stdout."""
    print()
    print("=" * 50)
    print("=== Covariate Shift Report ===")
    print(f"Shift classifier AUC : {shift_auc:.3f}  → {'PASS' if shift_passes else 'FAIL'} (threshold < 0.70)")
    print(f"Confound SHAP        : {confound_pct*100:.1f}%  → {'PASS' if shap_passes else 'FAIL'} (threshold < 15%)")
    print()

    if skip_reason:
        print(f"Retraining skipped: {skip_reason}")
        print("=" * 50)
        return

    print("=== Retraining Comparison ===")
    print(f"{'Metric':<22} {'QTX-only':>10} {'Combined':>10} {'Delta':>10}")
    print("-" * 54)

    if qtx_reg and comb_reg:
        for key, label in [("rmse_mean", "Outcome RMSE"), ("r2_mean", "Outcome R²")]:
            b = qtx_reg.get(key)
            c = comb_reg.get(key)
            if b is not None and c is not None:
                delta = c - b
                sign = "↓" if key == "rmse_mean" and delta < 0 else ("↑" if delta > 0 else "")
                print(f"{label:<22} {b:>10.4f} {c:>10.4f} {delta:>+10.4f} {sign}")
    else:
        print(f"{'Outcome metrics':<22} {'N/A':>10} {'N/A':>10}")

    if qtx_fr and comb_fr:
        b = qtx_fr.get("auc_roc_mean")
        c = comb_fr.get("auc_roc_mean")
        if b is not None and c is not None:
            delta = c - b
            print(f"{'Fall Risk AUC':<22} {b:>10.4f} {c:>10.4f} {delta:>+10.4f}")
        elif b is None:
            print(f"{'Fall Risk AUC':<22} {'N/A (1 class)':>10} {c if c else 'N/A':>10}")
    else:
        print(f"{'Fall Risk AUC':<22} {'N/A':>10} {'N/A':>10}")

    print("-" * 54)
    print(f"Models saved: {'YES' if models_saved else 'NO'}")
    print("=" * 50)
    print()
```

- [ ] **Step 2: Implement `main`**

Replace the `raise NotImplementedError` in `main`:

```python
def main() -> None:
    print("Loading QTX data ...")
    qtx_df = load_qtx_df()
    print(f"  QTX: {len(qtx_df)} patients")

    print("Loading RAISE data from DB ...")
    raise_df = load_raise_df()
    if raise_df.empty:
        print("  ERROR: No RAISE rows found in DB. Run scripts 15 + 16 first.")
        sys.exit(1)
    print(f"  RAISE: {len(raise_df)} patients, {raise_df['composite_improvement'].notna().sum()} with composite_improvement")

    print("Assembling combined dataset ...")
    combined = assemble_combined(qtx_df, raise_df)
    print(f"  Combined: {len(combined)} rows (QTX={len(qtx_df)}, RAISE={len(raise_df)})")

    print("Running covariate shift test (XGBoost 5-fold CV) ...")
    shift_auc, shap_df = run_shift_test(combined)
    print(f"  Shift AUC: {shift_auc:.3f}")

    print("Top 5 shift SHAP features:")
    for _, row in shap_df.head(5).iterrows():
        print(f"  {row['feature']:<35} {row['mean_abs_shap']:.4f}")

    shift_passes = auc_gate(shift_auc)
    shap_passes, confound_pct = shap_gate(shap_df, ["cohort", "usage_frequency"])

    if not shift_passes:
        _print_report(
            shift_auc, shift_passes, confound_pct, shap_passes,
            skip_reason=f"AUC {shift_auc:.3f} >= 0.70 — populations too different to merge",
        )
        sys.exit(0)

    if not shap_passes:
        _print_report(
            shift_auc, shift_passes, confound_pct, shap_passes,
            skip_reason=f"Confound SHAP {confound_pct*100:.1f}% >= 15% — separation driven by programme/centre",
        )
        sys.exit(0)

    print("Both gates passed — retraining models ...")

    print("  QTX-only regression CV ...")
    qtx_reg = cv_metrics_regression(qtx_df)
    print(f"    RMSE={qtx_reg.get('rmse_mean', 'N/A'):.4f}, R²={qtx_reg.get('r2_mean', 'N/A'):.4f}")

    print("  Combined regression CV ...")
    comb_reg = cv_metrics_regression(combined)
    print(f"    RMSE={comb_reg.get('rmse_mean', 'N/A'):.4f}, R²={comb_reg.get('r2_mean', 'N/A'):.4f}")

    print("  QTX-only fall risk CV ...")
    qtx_fr = cv_metrics_fall_risk(qtx_df)
    auc_qtx = qtx_fr.get("auc_roc_mean")
    print(f"    AUC={auc_qtx:.4f}" if auc_qtx is not None else "    AUC=N/A (single class)")

    print("  Combined fall risk CV ...")
    comb_fr = cv_metrics_fall_risk(combined)
    auc_comb = comb_fr.get("auc_roc_mean")
    print(f"    AUC={auc_comb:.4f}" if auc_comb is not None else "    AUC=N/A (single class)")

    # Decide whether to save
    baseline_metrics: dict = {}
    combined_metrics: dict = {}
    if qtx_reg:
        baseline_metrics.update({"rmse_mean": qtx_reg["rmse_mean"], "r2_mean": qtx_reg["r2_mean"]})
    if comb_reg:
        combined_metrics.update({"rmse_mean": comb_reg["rmse_mean"], "r2_mean": comb_reg["r2_mean"]})
    if auc_qtx is not None and auc_comb is not None:
        baseline_metrics["auc_roc_mean"] = auc_qtx
        combined_metrics["auc_roc_mean"] = auc_comb

    save = should_save_models(baseline_metrics, combined_metrics) if baseline_metrics else False

    if save:
        print("Combined metrics are >= QTX-only — saving augmented models ...")
        # Train final models on combined data and save
        _save_augmented_regression(combined)
        _save_augmented_fall_risk(combined)
    else:
        print("Combined metrics did not improve — not saving models.")

    _print_report(
        shift_auc, shift_passes, confound_pct, shap_passes,
        qtx_reg=qtx_reg, comb_reg=comb_reg,
        qtx_fr=qtx_fr, comb_fr=comb_fr,
        models_saved=save,
    )
```

- [ ] **Step 3: Add the model-saving helpers after `main`**

Add before `if __name__ == "__main__":`:

```python
def _save_augmented_regression(df: pd.DataFrame) -> None:
    """Train XGBRegressor on combined data and save as regression_xgb_raise_augmented.joblib."""
    df_model = df[df["composite_improvement"].notna()].copy()
    feature_cols = [c for c in SHIFT_FEATURES if c in df_model.columns]
    df_enc = _label_encode_cats(df_model[feature_cols])
    X = df_enc.values.astype(float)
    y = df_model["composite_improvement"].astype(float).values
    model = XGBRegressor(
        n_estimators=300, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=42, n_jobs=-1, verbosity=0,
    )
    model.fit(X, y)
    out_path = MODELS_DIR / "regression_xgb_raise_augmented.joblib"
    joblib.dump(model, out_path)
    print(f"  Saved: {out_path}")


def _save_augmented_fall_risk(df: pd.DataFrame) -> None:
    """Train XGBClassifier on combined data (proxy label) and save as fall_risk_xgb_raise_augmented.joblib."""
    label, labellable = _make_fall_risk_label(df)
    df_model = df[labellable].copy()
    df_model["_fall_label"] = label[labellable].values

    if df_model["_fall_label"].nunique() < 2:
        print("  WARNING: Only one class — not saving augmented fall risk model.")
        return

    df_feat = df_model.copy()
    if "gender_M" not in df_feat.columns:
        gender_upper = df_feat["gender"].astype(str).str.upper()
        df_feat["gender_M"] = gender_upper.map({"M": 1.0, "F": 0.0})

    feature_cols = [c for c in FALL_RISK_FEATURES if c in df_feat.columns]
    X = df_feat[feature_cols].astype(float).values
    y = df_feat["_fall_label"].astype(int).values

    medians = pd.DataFrame(X, columns=feature_cols).median().to_dict()
    X_filled = pd.DataFrame(X, columns=feature_cols).fillna(medians).values

    model = XGBClassifier(
        n_estimators=300, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=42, n_jobs=-1, verbosity=0,
    )
    model.fit(X_filled, y)
    out_path = MODELS_DIR / "fall_risk_xgb_raise_augmented.joblib"
    out_medians_path = MODELS_DIR / "fall_risk_medians_raise_augmented.joblib"
    joblib.dump(model, out_path)
    joblib.dump(medians, out_medians_path)
    print(f"  Saved: {out_path}")
    print(f"  Saved: {out_medians_path}")
```

- [ ] **Step 4: Run full end-to-end test**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/python3.14 scripts/17_raise_model_evaluation.py
```

Expected: Script runs to completion, prints a full report. If AUC gate fails (likely given METTA heterogeneity), it prints the skip reason and exits cleanly — that is correct and expected behavior. The key is: no Python errors, complete output with all metrics shown.

- [ ] **Step 5: Run all tests**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/test_raise_evaluation.py -v
```

Expected: 17 PASSED, 0 failed.

- [ ] **Step 6: Run broader test suite for regressions**

```bash
PYTHONPATH=src:api .venv/bin/pytest tests/ -v --ignore=tests/test_raise_evaluation.py -x 2>&1 | tail -20
```

Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/17_raise_model_evaluation.py
git commit -m "feat: implement main, report, and model saving for raise evaluation"
```

---

## Task 6: Final Verification + Push

- [ ] **Step 1: Run the complete test suite**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src:api .venv/bin/pytest tests/ -v 2>&1 | tail -30
```

Expected: All tests pass including the 17 new raise evaluation tests.

- [ ] **Step 2: Run the script one final time and capture output**

```bash
PYTHONPATH=src:api .venv/bin/python3.14 scripts/17_raise_model_evaluation.py 2>&1
```

Verify: Script completes, prints `=== Covariate Shift Report ===` block, no tracebacks.

- [ ] **Step 3: Push**

```bash
git push
```
