# scripts/18_scheduled_retrain.py
"""Script 18 — Scheduled retraining job.

Retrains the outcome regression model on current QTX data.
Saves the new model only if CV metrics hold or improve versus last_metrics.
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
from xgboost import XGBRegressor
from sklearn.model_selection import KFold
from sklearn.metrics import mean_squared_error, r2_score

from qtx.outcomes.change_scores import compute_change_scores
from qtx.outcomes.composite import compute_composite

DB_URL = "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah"
MODELS_DIR = ROOT / "models"
STATE_PATH = ROOT / "retrain_state.json"
RELOAD_URL = "http://localhost:8000/api/admin/reload-models"

REGRESSION_FEATURES = [
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
                s.baseline_sppb AS session_sppb, s.post_sppb,
                s.session_number,
                AVG(s.composite_improvement) OVER (
                    PARTITION BY s.patient_id
                    ORDER BY s.session_number
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS prior_avg_composite_improvement,
                pt.magnitude AS trend_tug_magnitude
            FROM patients p
            JOIN sessions s ON s.patient_id = p.id
            LEFT JOIN (
                SELECT DISTINCT ON (patient_id) patient_id, magnitude
                FROM patient_trends
                WHERE metric ILIKE '%tug%'
                ORDER BY patient_id, computed_at DESC
            ) pt ON pt.patient_id = p.id
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
        d["n_flags"] = sum(1 for k in d if k.startswith("has_") and d.get(k))
        d["n_groups"] = sum(1 for k in d if k.startswith("grp_") and d.get(k))
        d["n_regions"] = sum(1 for k in d if k.startswith("rgn_") and d.get(k))
        d["session_number"] = float(d["session_number"] if d.get("session_number") is not None else 1)
        d["prior_avg_composite_improvement"] = float(d.get("prior_avg_composite_improvement") or 0.0)
        d["trend_tug_magnitude"] = float(d.get("trend_tug_magnitude") or 0.0)
        records.append(d)
    df = pd.DataFrame(records)
    df = compute_change_scores(df)
    df = compute_composite(df)
    return df


def _build_training_matrix(df: pd.DataFrame, feature_names: list) -> np.ndarray:
    """Build a numeric training matrix matching feature_names.

    Handles prefix-encoded categoricals (cohort_, gender_, usage_frequency_).
    Missing features filled with 0.0.
    """
    cat_cols = ["cohort", "usage_frequency", "gender"]
    present = [c for c in cat_cols if c in df.columns]
    if present:
        df_enc = pd.get_dummies(df, columns=present, dtype=float)
    else:
        df_enc = df.copy()

    rows = []
    for feat in feature_names:
        if feat in df_enc.columns:
            rows.append(df_enc[feat].astype(float).fillna(0.0))
        else:
            rows.append(pd.Series([0.0] * len(df_enc), index=df_enc.index))

    return pd.DataFrame(dict(zip(feature_names, rows))).values


def _retrain_regression(df: pd.DataFrame):
    df_m = df[df["composite_improvement"].notna()].copy()
    if len(df_m) < 20:
        print(f"  WARNING: only {len(df_m)} rows — skipping regression retrain")
        return None
    cols = [c for c in REGRESSION_FEATURES if c in df_m.columns]
    X = df_m[cols].astype(float).values
    y = df_m["composite_improvement"].astype(float).values
    model = XGBRegressor(n_estimators=300, max_depth=4, learning_rate=0.05,
                         subsample=0.8, tree_method="hist", random_state=42, n_jobs=-1, verbosity=0)
    from sklearn.base import clone
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    rmse_scores, r2_scores = [], []
    for tr, val in kf.split(X):
        m = clone(model); m.fit(X[tr], y[tr]); preds = m.predict(X[val])
        rmse_scores.append(math.sqrt(mean_squared_error(y[val], preds)))
        r2_scores.append(r2_score(y[val], preds))
    model.fit(X, y)
    return {"rmse_mean": float(np.mean(rmse_scores)), "r2_mean": float(np.mean(r2_scores)), "n": len(df_m)}, model



def _retrain_classifier(df: pd.DataFrame, existing_model):
    """Retrain the responder classifier.

    Uses existing_model.feature_names_in_ to determine feature set.
    Returns (metrics, model) or None if insufficient data.
    """
    from sklearn.model_selection import StratifiedKFold
    from sklearn.metrics import roc_auc_score
    from sklearn.base import clone
    from xgboost import XGBClassifier

    df_m = df[df["overall_responder"].notna()].copy()
    if len(df_m) < 20:
        print(f"  WARNING: only {len(df_m)} rows with overall_responder — skipping classifier retrain")
        return None

    feature_names = list(existing_model.feature_names_in_)
    X = _build_training_matrix(df_m, feature_names)
    y = df_m["overall_responder"].astype(int).values

    model = XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05,
                          subsample=0.8, tree_method="hist", random_state=42,
                          n_jobs=-1, verbosity=0)

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = []
    for tr, val in skf.split(X, y):
        m = clone(model)
        m.fit(X[tr], y[tr])
        auc_scores.append(roc_auc_score(y[val], m.predict_proba(X[val])[:, 1]))

    model.fit(X, y)
    return {"auc_mean": float(np.mean(auc_scores)), "n": len(df_m)}, model


def _retrain_dropout(df: pd.DataFrame, existing_model):
    """Retrain the dropout classifier.

    Uses existing_model.feature_names_in_ to determine feature set.
    Returns (metrics, model) or None if insufficient data.
    """
    from sklearn.model_selection import StratifiedKFold
    from sklearn.metrics import roc_auc_score
    from sklearn.base import clone
    from xgboost import XGBClassifier

    df_m = df[df["is_dropout"].notna()].copy()
    if len(df_m) < 20:
        print(f"  WARNING: only {len(df_m)} rows with is_dropout — skipping dropout retrain")
        return None

    feature_names = list(existing_model.feature_names_in_)
    X = _build_training_matrix(df_m, feature_names)
    y = df_m["is_dropout"].astype(int).values

    model = XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05,
                          subsample=0.8, tree_method="hist", random_state=42,
                          n_jobs=-1, verbosity=0)

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = []
    for tr, val in skf.split(X, y):
        m = clone(model)
        m.fit(X[tr], y[tr])
        auc_scores.append(roc_auc_score(y[val], m.predict_proba(X[val])[:, 1]))

    model.fit(X, y)
    return {"auc_mean": float(np.mean(auc_scores)), "n": len(df_m)}, model


def _read_state() -> dict:
    if not STATE_PATH.exists():
        return {"last_retrain_session_count": 0, "last_metrics": {}}
    return json.loads(STATE_PATH.read_text())


def _write_state(session_count: int, metrics: dict) -> None:
    state = _read_state()  # read existing (preserves calibration_baseline and other keys)
    state["last_retrain_session_count"] = session_count
    state["last_retrain_at"] = datetime.now(timezone.utc).isoformat()
    state["last_metrics"] = metrics
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def _compute_calibration_baseline() -> dict[str, float]:
    """Query per-cohort MAE of current predictions vs actuals.

    Returns a {cohort: mae} dict for cohorts with >= 20 matched sessions.
    Returns an empty dict on any error — caller should not abort on failure.
    """
    try:
        engine = create_engine(DB_URL)
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    p.cohort,
                    COUNT(*) as n,
                    AVG(ABS(sp.predicted_composite_improvement - s.composite_improvement)) as mae
                FROM (
                    SELECT DISTINCT ON (session_id)
                           session_id, patient_id, predicted_composite_improvement
                    FROM   session_predictions
                    WHERE  predicted_composite_improvement IS NOT NULL
                    ORDER  BY session_id, predicted_at DESC
                ) sp
                JOIN sessions s ON s.id = sp.session_id
                JOIN patients p ON p.id = sp.patient_id
                WHERE  s.composite_improvement IS NOT NULL
                  AND  (s.ingested_from NOT ILIKE '%raise%' OR s.ingested_from IS NULL)
                GROUP BY p.cohort
                HAVING COUNT(*) >= 20
            """)).fetchall()
        return {str(r._mapping["cohort"]): float(r._mapping["mae"]) for r in rows}
    except Exception as exc:
        print(f"  WARNING: _compute_calibration_baseline failed: {exc}")
        return {}


def _metrics_improved_or_equal(old: dict, new_reg: dict) -> bool:
    checks = []
    if "rmse_mean" in old and "rmse_mean" in new_reg:
        checks.append(new_reg["rmse_mean"] <= old["rmse_mean"] + 1e-6)
    if "r2_mean" in old and "r2_mean" in new_reg:
        checks.append(new_reg["r2_mean"] >= old["r2_mean"] - 1e-6)
    return all(checks) if checks else True


def main() -> None:
    print("=== Scheduled Retrain Job ===")
    print("Loading QTX sessions from DB ...")
    df = _load_qtx_sessions()
    session_count = len(df)
    print(f"  Loaded {session_count} QTX sessions")
    state = _read_state()
    old_metrics = state.get("last_metrics", {})

    # --- Regression ---
    print("Retraining regression model ...")
    reg_result = _retrain_regression(df)

    # --- Classifier ---
    print("Retraining classifier model ...")
    try:
        # Safe: loads our own model files written by previous retrain runs in MODELS_DIR,
        # never from user input or network sources.
        clf_existing = joblib.load(MODELS_DIR / "classifier_xgb.joblib")
        clf_result = _retrain_classifier(df, clf_existing)
    except Exception as exc:
        print(f"  WARNING: could not load classifier_xgb.joblib: {exc} — skipping classifier retrain")
        clf_result = None

    # --- Dropout ---
    print("Retraining dropout model ...")
    try:
        # Safe: same rationale as above — local models/ directory, written by this script.
        drop_existing = joblib.load(MODELS_DIR / "dropout_xgb.joblib")
        drop_result = _retrain_dropout(df, drop_existing)
    except Exception as exc:
        print(f"  WARNING: could not load dropout_xgb.joblib: {exc} — skipping dropout retrain")
        drop_result = None

    # --- Gate and save ---
    all_metrics: dict = {}

    if reg_result is None:
        print("  Regression retrain returned no result — insufficient data.")
    else:
        new_reg_metrics, reg_model = reg_result
        print(f"  Regression: RMSE={new_reg_metrics['rmse_mean']:.4f}, R²={new_reg_metrics['r2_mean']:.4f}")
        if _metrics_improved_or_equal(old_metrics, new_reg_metrics):
            print("  Metrics held or improved — saving regression model ...")
            joblib.dump(reg_model, MODELS_DIR / "regression_xgb.joblib")
            print("  Saved: regression_xgb.joblib")
            all_metrics.update(new_reg_metrics)
            calibration_baseline = _compute_calibration_baseline()
            if calibration_baseline:
                state = _read_state()
                state["calibration_baseline"] = calibration_baseline
                with open(STATE_PATH, "w") as f:
                    json.dump(state, f, indent=2)
                print(f"  Calibration baseline updated: {len(calibration_baseline)} cohorts")
            try:
                import os as _os
                import urllib.request
                admin_key = _os.environ.get("QTX_ADMIN_KEY", "")
                if not admin_key:
                    print("  WARNING: QTX_ADMIN_KEY is not set — skipping hot-reload")
                else:
                    req = urllib.request.Request(RELOAD_URL, method="POST",
                                                 headers={"X-Admin-Key": admin_key})
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        print(f"  Hot-reload: {resp.read().decode()}")
            except Exception as exc:
                print(f"  WARNING: hot-reload call failed: {exc} — API still using old models")
        else:
            print("  Regression metrics did not improve — not saving.")
            all_metrics.update(old_metrics)

    if clf_result is not None:
        auc = clf_result[0]["auc_mean"]
        old_auc = old_metrics.get("classifier_auc_mean", 0.0)
        print(f"  Classifier AUC={auc:.4f} (baseline={old_auc:.4f})")
        if auc >= old_auc - 1e-6:
            print("  Classifier AUC held or improved — saving ...")
            joblib.dump(clf_result[1], MODELS_DIR / "classifier_xgb.joblib")
            print("  Saved: classifier_xgb.joblib")
        else:
            print(f"  Classifier AUC={auc:.4f} < baseline {old_auc:.4f} — not saving")
        all_metrics["classifier_auc_mean"] = auc

    if drop_result is not None:
        auc = drop_result[0]["auc_mean"]
        old_auc = old_metrics.get("dropout_auc_mean", 0.0)
        print(f"  Dropout AUC={auc:.4f} (baseline={old_auc:.4f})")
        if auc >= old_auc - 1e-6:
            print("  Dropout AUC held or improved — saving ...")
            joblib.dump(drop_result[1], MODELS_DIR / "dropout_xgb.joblib")
            print("  Saved: dropout_xgb.joblib")
        else:
            print(f"  Dropout AUC={auc:.4f} < baseline {old_auc:.4f} — not saving")
        all_metrics["dropout_auc_mean"] = auc

    _write_state(session_count, all_metrics)
    print("=== Retrain complete ===")


if __name__ == "__main__":
    main()
