"""Script 17 — RAISE covariate shift analysis and conditional retraining.

Tests whether RAISE and QTX populations are safe to merge using two gates:
  1. XGBoost shift classifier AUC < 0.70  (populations indistinguishable)
  2. primary_indication SHAP < 15%  (separation not driven by clinical classification)

If both gates pass, retrains outcome regression and fall risk models on combined
data and saves augmented models if combined metrics >= QTX-only metrics.

Usage:
    PYTHONPATH=src:api python scripts/17_raise_model_evaluation.py
"""
from __future__ import annotations
import os

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

DB_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah")
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
    "has_oa", "has_diabetes", "has_stroke", "has_parkinsons",
    "has_sarcopenia", "has_post_surgery", "has_balance_issue", "has_chronic_pain",
    "pre_vas", "pre_fast_gs_ms", "n_flags", "n_regions", "n_groups", "has_hypertension",
    "has_frailty", "has_fall_risk", "has_neurological", "has_metabolic", "has_knee_issue",
    "has_spinal_issue", "grp_joint_disease", "grp_spine_back", "grp_neurological",
    "grp_post_surgical", "grp_frailty_sarcopenia", "grp_balance_falls", "grp_metabolic",
    "grp_softtissue_injury", "grp_osteoporosis", "rgn_spine", "rgn_knee", "rgn_ankle_foot",
    "rgn_hip", "rgn_lower_limb", "rgn_shoulder", "rgn_upper_limb", "rgn_trunk",
    "primary_indication",
]
CAT_COLS = ["gender", "primary_indication"]

# Serving feature contract — must stay in sync with REGRESSION_FEATURES in scripts/18_scheduled_retrain.py
# and with _build_feature_vector_from_orm() in api/services/prediction.py.
_SERVING_REGRESSION_FEATURES = [
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
    "session_number",
    "prior_avg_composite_improvement",
    "trend_tug_magnitude",
]
_SERVING_CAT_COLS = ["cohort", "usage_frequency", "gender"]

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
    confound_cols are prefix-matched (post-dummies names like 'primary_indication_Pain').
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
    df = pd.read_parquet(parquet_path)
    df["dataset"] = 0
    return df


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
            WHERE s.ingested_from ILIKE '%raise%'
        """)).fetchall()
    finally:
        db.close()

    if not rows:
        return pd.DataFrame()

    records = []
    for r in rows:
        row_dict = dict(r._mapping)
        s_sppb = row_dict.pop("session_baseline_sppb", None)
        p_sppb = row_dict.pop("patient_baseline_sppb", None)
        row_dict["baseline_sppb"] = s_sppb if s_sppb is not None else p_sppb
        counts = _compute_flag_counts(row_dict)
        row_dict.update(counts)
        row_dict["dataset"] = 1
        records.append(row_dict)

    df = pd.DataFrame(records)
    df = compute_change_scores(df)
    if "fast_gs_improvement" not in df.columns:
        df["fast_gs_improvement"] = float("nan")
    df = compute_composite(df)
    return df


def assemble_combined(qtx_df: pd.DataFrame, raise_df: pd.DataFrame) -> pd.DataFrame:
    """Concatenate QTX + RAISE dataframes, ensuring consistent columns."""
    for col in qtx_df.columns:
        if col not in raise_df.columns:
            raise_df = raise_df.copy()
            raise_df[col] = float("nan")
    for col in raise_df.columns:
        if col not in qtx_df.columns:
            qtx_df = qtx_df.copy()
            qtx_df[col] = float("nan")
    combined = pd.concat([qtx_df, raise_df], ignore_index=True)
    return combined


def _label_encode_cats(df: pd.DataFrame, cat_cols: list[str] = CAT_COLS) -> pd.DataFrame:
    """Label-encode categorical columns in-place (NaN → -1, XGBoost handles as missing)."""
    df = df.copy()
    for col in cat_cols:
        if col not in df.columns:
            df[col] = float("nan")
            continue
        cat = pd.Categorical(df[col].astype(str).where(df[col].notna(), other=None))
        df[col] = cat.codes.astype(float)
        df[col] = df[col].replace(-1, float("nan"))
    return df


def run_shift_test(df: pd.DataFrame) -> tuple[float, pd.DataFrame]:
    """Train XGBoost binary classifier to predict dataset (0=QTX, 1=RAISE).

    Returns (mean_auc_roc, shap_df) from 5-fold stratified CV.
    shap_df has columns: feature, mean_abs_shap.
    """
    import shap as _shap
    feature_cols = [c for c in SHIFT_FEATURES if c in df.columns]
    df_enc = _label_encode_cats(df[feature_cols + ["dataset"]].copy())
    X = df_enc[feature_cols]
    y = df["dataset"].astype(int)

    mask = y.notna()
    X, y = X[mask], y[mask]

    X_arr = X.to_numpy(dtype=float, na_value=float("nan"))
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

    clf.fit(X_arr, y_arr)
    X_sample = X if len(X) <= 300 else X.sample(300, random_state=42)
    explainer = _shap.TreeExplainer(clf)
    shap_vals = explainer.shap_values(X_sample.to_numpy(dtype=float, na_value=float("nan")))
    if isinstance(shap_vals, list):
        shap_vals = shap_vals[1]
    mean_abs = np.abs(shap_vals).mean(axis=0)
    shap_df = pd.DataFrame({"feature": X_sample.columns.tolist(), "mean_abs_shap": mean_abs})
    shap_df = shap_df.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)

    return mean_auc, shap_df


def _make_fall_risk_label(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Derive proxy fall-risk label. Returns (label, labellable_mask)."""
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


def cv_metrics_regression(df: pd.DataFrame) -> dict:
    """5-fold CV RMSE and R2 for composite_improvement prediction."""
    df_model = df[df["composite_improvement"].notna()].copy()
    if len(df_model) < 20:
        print(f"  WARNING: only {len(df_model)} rows with composite_improvement — skipping regression CV")
        return {}

    feature_cols = [c for c in SHIFT_FEATURES if c in df_model.columns]
    df_enc = _label_encode_cats(df_model[feature_cols])
    X = df_enc.to_numpy(dtype=float, na_value=float("nan"))
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


def cv_metrics_fall_risk(df: pd.DataFrame) -> dict:
    """5-fold CV AUC-ROC for fall risk proxy label prediction."""
    label, labellable = _make_fall_risk_label(df)
    df_model = df[labellable].copy()
    df_model["_fall_label"] = label[labellable].values

    if len(df_model) < 20:
        print(f"  WARNING: only {len(df_model)} labellable rows — skipping fall risk CV")
        return {}

    if df_model["_fall_label"].nunique() < 2:
        print(f"  WARNING: only one class for fall risk in this dataset — skipping CV")
        return {"auc_roc_mean": None, "n": len(df_model)}

    df_feat = df_model.copy()
    if "gender_M" not in df_feat.columns:
        gender_upper = df_feat["gender"].astype(str).str.upper()
        df_feat["gender_M"] = gender_upper.map({"M": 1.0, "F": 0.0})

    feature_cols = [c for c in FALL_RISK_FEATURES if c in df_feat.columns]
    X = df_feat[feature_cols].to_numpy(dtype=float, na_value=float("nan"))
    y = df_feat["_fall_label"].astype(int).values

    model = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=42, n_jobs=-1, verbosity=0,
    )
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(model, X, y, cv=skf, scoring="roc_auc", n_jobs=-1)
    return {"auc_roc_mean": float(np.mean(auc_scores)), "n": len(df_model)}


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
    print("=" * 54)
    print("=== Covariate Shift Report ===")
    print(f"Shift classifier AUC : {shift_auc:.3f}  → {'PASS' if shift_passes else 'FAIL'} (threshold < 0.70)")
    print(f"Confound SHAP        : {confound_pct*100:.1f}%  → {'PASS' if shap_passes else 'FAIL'} (threshold < 15%)")
    print()

    if skip_reason:
        print(f"Retraining skipped: {skip_reason}")
        print("=" * 54)
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
                print(f"{label:<22} {b:>10.4f} {c:>10.4f} {delta:>+10.4f}")
    else:
        print(f"{'Outcome metrics':<22} {'N/A':>10} {'N/A':>10}")

    if qtx_fr and comb_fr:
        b = qtx_fr.get("auc_roc_mean")
        c = comb_fr.get("auc_roc_mean")
        if b is not None and c is not None:
            delta = c - b
            print(f"{'Fall Risk AUC':<22} {b:>10.4f} {c:>10.4f} {delta:>+10.4f}")
        else:
            b_str = f"{b:.4f}" if b is not None else "N/A"
            c_str = f"{c:.4f}" if c is not None else "N/A"
            print(f"{'Fall Risk AUC':<22} {b_str:>10} {c_str:>10} {'N/A':>10}")
    else:
        print(f"{'Fall Risk AUC':<22} {'N/A':>10} {'N/A':>10}")

    print("-" * 54)
    print(f"Models saved: {'YES' if models_saved else 'NO'}")
    print("=" * 54)
    print()


def _save_augmented_regression(df: pd.DataFrame) -> None:
    """Train augmented regression on combined data using the serving feature contract.

    Uses the same feature list and OHE encoding as scripts/18_scheduled_retrain.py
    so the model can be slot-swapped at serving time without feature mismatch.
    """
    df_model = df[df["composite_improvement"].notna()].copy()
    if len(df_model) < 20:
        print(f"  WARNING: only {len(df_model)} rows — skipping augmented regression")
        return

    # OHE categoricals — matches _build_training_matrix() in script 18
    present_cats = [c for c in _SERVING_CAT_COLS if c in df_model.columns]
    df_enc = pd.get_dummies(df_model, columns=present_cats, dtype=float) if present_cats else df_model.copy()

    # Derive longitudinal placeholders — RAISE rows have no prior sessions
    for col, default in [
        ("session_number", 1.0),
        ("prior_avg_composite_improvement", 0.0),
        ("trend_tug_magnitude", 0.0),
    ]:
        if col not in df_enc.columns:
            df_enc[col] = default
        else:
            df_enc[col] = df_enc[col].fillna(default).astype(float)

    # Build feature matrix aligned to serving contract
    feature_cols = [c for c in _SERVING_REGRESSION_FEATURES if c in df_enc.columns]
    X = df_enc[feature_cols].astype(float).fillna(0.0)
    y = df_model["composite_improvement"].astype(float).values

    model = XGBRegressor(
        n_estimators=300, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, tree_method="hist",
        random_state=42, n_jobs=-1, verbosity=0,
    )
    model.fit(X, y)
    out_path = MODELS_DIR / "regression_xgb_raise_augmented.joblib"
    joblib.dump(model, out_path)
    print(f"  Saved: {out_path} ({len(feature_cols)} features, {len(df_model)} rows)")


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
    X = df_feat[feature_cols].to_numpy(dtype=float, na_value=float("nan"))
    y = df_feat["_fall_label"].astype(int).values

    medians = pd.DataFrame(X, columns=feature_cols).median().to_dict()
    X_filled = pd.DataFrame(X, columns=feature_cols).fillna(medians).to_numpy(dtype=float)

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
    shap_passes, confound_pct = shap_gate(shap_df, ["primary_indication"])

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
    if qtx_reg:
        print(f"    RMSE={qtx_reg['rmse_mean']:.4f}, R²={qtx_reg['r2_mean']:.4f}")

    print("  Combined regression CV ...")
    comb_reg = cv_metrics_regression(combined)
    if comb_reg:
        print(f"    RMSE={comb_reg['rmse_mean']:.4f}, R²={comb_reg['r2_mean']:.4f}")

    print("  QTX-only fall risk CV ...")
    qtx_fr = cv_metrics_fall_risk(qtx_df)
    auc_qtx = qtx_fr.get("auc_roc_mean")
    print(f"    AUC={auc_qtx:.4f}" if auc_qtx is not None else "    AUC=N/A (single class)")

    print("  Combined fall risk CV ...")
    comb_fr = cv_metrics_fall_risk(combined)
    auc_comb = comb_fr.get("auc_roc_mean")
    print(f"    AUC={auc_comb:.4f}" if auc_comb is not None else "    AUC=N/A (single class)")

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


if __name__ == "__main__":
    main()
