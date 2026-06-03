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
    # confound_pct: fraction of total absolute SHAP attributable to confounders
    pct = float(confound_shap / total)
    return bool(pct < threshold), pct


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


def _save_augmented_regression(df: pd.DataFrame) -> None:
    """Train XGBRegressor on combined data and save as regression_xgb_raise_augmented.joblib."""
    raise NotImplementedError


def _save_augmented_fall_risk(df: pd.DataFrame) -> None:
    """Train XGBClassifier on combined data (proxy label) and save as fall_risk_xgb_raise_augmented.joblib."""
    raise NotImplementedError


def main() -> None:
    raise NotImplementedError


if __name__ == "__main__":
    main()
