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
        d["n_flags"] = sum(1 for k in d if k.startswith("has_") and d.get(k))
        d["n_groups"] = sum(1 for k in d if k.startswith("grp_") and d.get(k))
        d["n_regions"] = sum(1 for k in d if k.startswith("rgn_") and d.get(k))
        records.append(d)
    df = pd.DataFrame(records)
    df = compute_change_scores(df)
    df = compute_composite(df)
    return df


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

    print("Retraining regression model ...")
    reg_result = _retrain_regression(df)

    if reg_result is None:
        print("Retrain aborted — insufficient data.")
        return

    new_reg_metrics, reg_model = reg_result
    print(f"  Regression: RMSE={new_reg_metrics['rmse_mean']:.4f}, R²={new_reg_metrics['r2_mean']:.4f}")

    if _metrics_improved_or_equal(old_metrics, new_reg_metrics):
        print("Metrics held or improved — saving model ...")
        joblib.dump(reg_model, MODELS_DIR / "regression_xgb.joblib")
        print("  Saved: regression_xgb.joblib")
        _write_state(session_count, new_reg_metrics)
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
        print("Metrics did not improve — not saving model.")
        _write_state(session_count, old_metrics)

    print("=== Retrain complete ===")


if __name__ == "__main__":
    main()
