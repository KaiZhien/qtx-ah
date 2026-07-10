# scripts/18_scheduled_retrain.py
"""Script 18 — Scheduled retraining job.

Retrains the outcome regression, responder classifier, and dropout models on
current QTX data, then decides whether to promote each candidate over the
currently-served ("incumbent") model.

Feature schema (F1)
--------------------
All three models read their feature lists from ``config/models.yaml`` via the
qtx config loader (``get_models_config``) — there is no hardcoded feature list.
Categorical columns (``cohort``, ``usage_frequency``, ``gender``,
``primary_indication``) are one-hot encoded with ``drop_first=True`` exactly the
way ``scripts/06_train_models.py`` / ``qtx.models.*`` do, so the resulting
``feature_names_in_`` are byte-compatible with the serving path
(``api/services/prediction.py::_build_feature_vector_from_orm``), which
reconstructs the same dummy columns from ORM objects.

Promotion gate (F2)
-------------------
Comparing a candidate's freshly-computed CV metrics against stored numbers from a
previous run is invalid: the regression target (``composite_improvement``) is
z-scored *within the current population*, so its scale drifts between runs, and
the classifier/dropout baselines used to default to 0.0 (auto-accepting anything
on the first run). Instead:

  * A **fixed, patient-grouped ~20% held-out evaluation set** is created on the
    first run and frozen to ``models/eval_set.parquet`` + ``models/eval_manifest.json``
    (a session-id manifest). The eval rows are **excluded from candidate training**.
  * On every run BOTH the incumbent (loaded live, never trusting stale stored
    numbers) and the candidate are scored on that same fixed set.
  * A candidate is promoted only if it is **>= the incumbent** on the eval set
    (regression: RMSE no worse within an epsilon; classifier/dropout: AUC no
    worse within an epsilon). If there is no comparable incumbent score we do
    **not** auto-accept.

Operational hardening (F3)
--------------------------
  * Artifacts are written atomically (temp file + ``os.replace``) with a JSON
    metadata sidecar (feature list, gate metrics, row counts, timestamp, git SHA).
  * An exclusive ``fcntl`` lock (``models/.retrain.lock``) makes overlapping
    spawns from RetrainService / CalibrationService exit cleanly.
  * ``DATABASE_URL`` and ``QTX_RELOAD_URL`` are env-configurable; a missing
    ``QTX_ADMIN_KEY`` logs a visible warning rather than silently skipping the
    hot-reload.

Trend feature (F4)
------------------
``patient_trends`` stores only the latest snapshot per (patient, metric), so a
row's trend state *as-of that session* is not reconstructable for historical
sessions. To avoid training-time leakage (a trend that summarizes sessions AFTER
the training row), ``trend_tug_magnitude`` is attached only to each patient's
most-recent session and set to NaN for earlier sessions (XGBoost handles NaN
natively). At inference the latest trend is correct (it summarizes the past), so
the serving path is unchanged.

Usage (called automatically by RetrainService.check_and_trigger):
    PYTHONPATH=src:api python scripts/18_scheduled_retrain.py
"""
from __future__ import annotations

import fcntl
import json
import math
import os
import subprocess
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
from sklearn.metrics import mean_squared_error, r2_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit
from xgboost import XGBClassifier, XGBRegressor

from qtx.models.preprocessing import CAT_COLS, encode_categoricals
from qtx.outcomes.change_scores import compute_change_scores
from qtx.outcomes.composite import compute_composite
from qtx.utils.config import get_models_config

DB_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah")
RELOAD_URL = os.environ.get("QTX_RELOAD_URL", "http://localhost:8000/api/admin/reload-models")
MODELS_DIR = ROOT / "models"
STATE_PATH = ROOT / "retrain_state.json"

# Categorical columns encoded exactly like the batch trainers (qtx.models.*).
_CAT_COLS = CAT_COLS  # shared contract from qtx.models.preprocessing

_MIN_ROWS = 20
_EVAL_FRACTION = 0.20
_EVAL_SEED = 42
_GATE_EPS = 1e-4

_XGB_PARAMS = dict(
    n_estimators=300, max_depth=4, learning_rate=0.05, subsample=0.8,
    tree_method="hist", random_state=42, n_jobs=-1, verbosity=0,
)

# model_name -> (config key, target column, kind, served artifact filename)
_MODEL_SPECS: dict[str, dict] = {
    "regression": {
        "config_key": "regression_composite",
        "target": "composite_improvement",
        "kind": "regression",
        "artifact": "regression_xgb.joblib",
    },
    "classifier": {
        "config_key": "classifier_responder",
        "target": "overall_responder",
        "kind": "binary",
        "artifact": "classifier_xgb.joblib",
    },
    "dropout": {
        "config_key": "dropout",
        "target": "is_dropout",
        "kind": "binary",
        "artifact": "dropout_xgb.joblib",
    },
}


# ---------------------------------------------------------------------------
# Feature resolution (F1)
# ---------------------------------------------------------------------------

def _config_feature_list(config_key: str) -> list[str]:
    """Raw feature list for a model, read straight from config/models.yaml."""
    return list(get_models_config()[config_key]["features"])


def _retrain_feature_list(model_name: str) -> list[str]:
    """Raw config feature list the retrain uses for *model_name*."""
    return _config_feature_list(_MODEL_SPECS[model_name]["config_key"])


# Single source of truth for the encoding contract shared with the batch trainers.
_encode_categoricals = encode_categoricals


def _build_design_matrix(df: pd.DataFrame, config_key: str) -> tuple[pd.DataFrame, list[str]]:
    """Build the candidate training design matrix from config features.

    Returns (X DataFrame, final encoded feature columns). NaNs are preserved so
    XGBoost can use its native missing-value handling (consistent with the xgb
    path in qtx.models.regression).
    """
    feature_cols = _config_feature_list(config_key)
    cols_to_use = [c for c in feature_cols if c in df.columns]
    df_enc, dummy_cols = _encode_categoricals(df[cols_to_use].copy(), _CAT_COLS)
    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols
    X = df_enc.reindex(columns=final_feature_cols, fill_value=0.0).astype(float)
    return X, final_feature_cols


def _build_training_matrix(df: pd.DataFrame, feature_names: list) -> np.ndarray:
    """Align a raw frame to an existing model's ``feature_names_in_``.

    Used to score an arbitrary already-fitted model (incumbent or candidate) on a
    frame: prefix-encoded categoricals (cohort_/usage_frequency_/gender_/
    primary_indication_) are produced via get_dummies and the columns the model
    expects are selected in order. The dropped reference category maps to
    all-zeros, matching drop_first training. Missing features filled with 0.0.
    """
    cat_cols = _CAT_COLS
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


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_qtx_sessions() -> pd.DataFrame:
    engine = create_engine(DB_URL)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT
                s.id AS session_id, p.id AS patient_id,
                p.age, p.gender, p.cohort, p.primary_indication,
                p.baseline_sppb AS patient_sppb,
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
                s.session_number, s.overall_responder, s.is_dropout,
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
        d["session_id"] = str(d["session_id"])
        d["patient_id"] = str(d["patient_id"])
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
        mag = d.get("trend_tug_magnitude")
        d["trend_tug_magnitude"] = float(mag) if mag is not None else np.nan
        records.append(d)
    df = pd.DataFrame(records)
    df = compute_change_scores(df)
    df = compute_composite(df)

    # F4: keep the latest-trend value only on each patient's most-recent session.
    if not df.empty and {"patient_id", "session_number", "trend_tug_magnitude"} <= set(df.columns):
        latest = df.groupby("patient_id")["session_number"].transform("max")
        df.loc[df["session_number"] < latest, "trend_tug_magnitude"] = np.nan
    return df


# ---------------------------------------------------------------------------
# Fixed held-out evaluation set (F2)
# ---------------------------------------------------------------------------

def _eval_parquet_path() -> Path:
    return MODELS_DIR / "eval_set.parquet"


def _eval_manifest_path() -> Path:
    return MODELS_DIR / "eval_manifest.json"


def _split_eval_session_ids(df: pd.DataFrame, seed: int, fraction: float = _EVAL_FRACTION) -> set[str]:
    """Patient-grouped split — returns the set of session_ids held out for eval."""
    ids = df["session_id"].astype(str).reset_index(drop=True)
    groups = df["patient_id"].astype(str).values
    gss = GroupShuffleSplit(n_splits=1, test_size=fraction, random_state=seed)
    _, eval_idx = next(gss.split(df, groups=groups))
    return set(ids.iloc[eval_idx])


def _ensure_eval_set(df: pd.DataFrame, seed: int = _EVAL_SEED) -> pd.DataFrame:
    """Load the frozen eval set, creating it (patient-grouped ~20%) on first run."""
    pq, mf = _eval_parquet_path(), _eval_manifest_path()
    if pq.exists() and mf.exists():
        return pd.read_parquet(pq)

    if not {"session_id", "patient_id"} <= set(df.columns):
        raise KeyError("Building the eval set requires session_id and patient_id columns")

    eval_ids = _split_eval_session_ids(df, seed)
    eval_df = df[df["session_id"].astype(str).isin(eval_ids)].copy()
    _atomic_write_parquet(eval_df, pq)
    manifest = {
        "session_ids": sorted(eval_ids),
        "n_rows": int(len(eval_df)),
        "n_patients": int(eval_df["patient_id"].nunique()),
        "fraction": _EVAL_FRACTION,
        "seed": int(seed),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write_json(manifest, mf)
    print(f"  Created fixed eval set: {manifest['n_rows']} rows / {manifest['n_patients']} patients")
    return eval_df


def _load_eval_manifest_ids() -> set[str]:
    mf = _eval_manifest_path()
    if not mf.exists():
        return set()
    return set(json.loads(mf.read_text()).get("session_ids", []))


def _training_frame(df: pd.DataFrame, eval_ids: set[str]) -> pd.DataFrame:
    """Return training rows: everything not in the frozen eval set."""
    if not eval_ids or "session_id" not in df.columns:
        return df
    return df[~df["session_id"].astype(str).isin(eval_ids)].copy()


# ---------------------------------------------------------------------------
# Fit / score / gate
# ---------------------------------------------------------------------------

def _fit_model(train_df: pd.DataFrame, model_name: str):
    """Fit a candidate model for *model_name*. Returns (model, feature_cols) or None."""
    spec = _MODEL_SPECS[model_name]
    target = spec["target"]
    if target not in train_df.columns:
        print(f"  WARNING: target {target!r} missing — skipping {model_name}")
        return None
    df_m = train_df[train_df[target].notna()].copy()
    if len(df_m) < _MIN_ROWS:
        print(f"  WARNING: only {len(df_m)} rows for {model_name} — skipping")
        return None

    X, feat_cols = _build_design_matrix(df_m, spec["config_key"])
    if not feat_cols:
        print(f"  WARNING: no usable features for {model_name} — skipping")
        return None

    if spec["kind"] == "regression":
        y = df_m[target].astype(float).values
        model = XGBRegressor(**_XGB_PARAMS)
    else:
        y = df_m[target].astype(int).values
        if len(np.unique(y)) < 2:
            print(f"  WARNING: only one class present for {model_name} — skipping")
            return None
        model = XGBClassifier(eval_metric="logloss", **_XGB_PARAMS)

    # Fit on a DataFrame so feature_names_in_ is recorded (serving path relies on it).
    model.fit(X, y)
    return model, feat_cols


def _score_model(model, eval_df: pd.DataFrame, model_name: str) -> dict | None:
    """Score an already-fitted model on the eval set. Returns metrics dict or None."""
    if model is None:
        return None
    spec = _MODEL_SPECS[model_name]
    target = spec["target"]
    if target not in eval_df.columns:
        return None
    df_e = eval_df[eval_df[target].notna()].copy()
    if len(df_e) < 1:
        return None
    try:
        feats = list(model.feature_names_in_)
    except AttributeError:
        return None

    X = _build_training_matrix(df_e, feats)
    try:
        if spec["kind"] == "regression":
            y = df_e[target].astype(float).values
            preds = model.predict(X)
            return {
                "rmse": float(math.sqrt(mean_squared_error(y, preds))),
                "r2": float(r2_score(y, preds)),
                "n": int(len(df_e)),
            }
        y = df_e[target].astype(int).values
        if len(np.unique(y)) < 2:
            return None
        proba = model.predict_proba(X)[:, 1]
        return {"auc": float(roc_auc_score(y, proba)), "n": int(len(df_e))}
    except Exception as exc:
        print(f"  WARNING: scoring {model_name} failed: {exc}")
        return None


def _promotion_decision(model_name: str, cand: dict | None, inc: dict | None, eps: float = _GATE_EPS) -> bool:
    """Promote candidate only if it is >= incumbent on the fixed eval set.

    Never auto-accepts: a missing candidate score, or a missing/unscoreable
    incumbent, both yield False (we require a real head-to-head comparison).
    """
    if cand is None or inc is None:
        return False
    if _MODEL_SPECS[model_name]["kind"] == "regression":
        return cand["rmse"] <= inc["rmse"] + eps
    return cand["auc"] >= inc["auc"] - eps


def _load_incumbent(artifact: str):
    """Load the currently-served model artifact, or None if absent/unreadable."""
    path = MODELS_DIR / artifact
    if not path.exists():
        return None
    try:
        # Trusted first-party artifact written by this script / scripts/06.
        return joblib.load(path)
    except Exception as exc:
        print(f"  WARNING: could not load incumbent {artifact}: {exc}")
        return None


# ---------------------------------------------------------------------------
# Atomic IO + metadata sidecar (F3)
# ---------------------------------------------------------------------------

def _atomic_write_json(obj: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(obj, indent=2, default=str))
    os.replace(tmp, path)


def _atomic_write_parquet(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def _atomic_dump_joblib(obj, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    joblib.dump(obj, tmp)
    os.replace(tmp, path)


def _git_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(ROOT),
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def _write_artifact_sidecar(
    artifact_path: Path, model_name: str, feature_names: list[str],
    cand_metrics: dict | None, inc_metrics: dict | None,
    n_train: int, n_eval: int, git_sha: str | None,
) -> None:
    meta = {
        "model": model_name,
        "artifact": artifact_path.name,
        "features": list(feature_names),
        "gate": {
            "candidate": cand_metrics,
            "incumbent": inc_metrics,
            "epsilon": _GATE_EPS,
            "promoted": True,
        },
        "n_train_rows": int(n_train),
        "n_eval_rows": int(n_eval),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "git_sha": git_sha,
    }
    _atomic_write_json(meta, artifact_path.with_name(f"{artifact_path.name}.meta.json"))


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def _read_state() -> dict:
    if not STATE_PATH.exists():
        return {"last_retrain_session_count": 0, "last_metrics": {}}
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {"last_retrain_session_count": 0, "last_metrics": {}}


def _write_state(session_count: int, metrics: dict) -> None:
    state = _read_state()  # preserve calibration_baseline / *_auc_baseline / etc.
    state["last_retrain_session_count"] = session_count
    state["last_retrain_at"] = datetime.now(timezone.utc).isoformat()
    state["last_metrics"] = metrics
    _atomic_write_json(state, STATE_PATH)


def _set_state_key(key: str, value) -> None:
    state = _read_state()
    state[key] = value
    _atomic_write_json(state, STATE_PATH)


def _update_baselines_on_promote(model_name: str, cand_metrics: dict | None) -> None:
    """Refresh the drift-reference baselines CalibrationService reads.

    These root-level keys are the *only* stored numbers consumed downstream; the
    promotion gate itself never reads them (it evaluates the incumbent live).
    """
    if model_name == "regression":
        cal = _compute_calibration_baseline()
        if cal:
            _set_state_key("calibration_baseline", cal)
            print(f"  Calibration baseline updated: {len(cal)} cohorts")
    elif model_name == "classifier" and cand_metrics and "auc" in cand_metrics:
        _set_state_key("classifier_auc_baseline", float(cand_metrics["auc"]))
    elif model_name == "dropout" and cand_metrics and "auc" in cand_metrics:
        _set_state_key("dropout_auc_baseline", float(cand_metrics["auc"]))


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


# ---------------------------------------------------------------------------
# Concurrency lock (F3)
# ---------------------------------------------------------------------------

def _lock_path() -> Path:
    return MODELS_DIR / ".retrain.lock"


def _acquire_lock():
    """Try to acquire the exclusive retrain lock.

    Returns an open file object holding the lock, or None if another retrain
    already holds it (caller should exit cleanly).
    """
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    fd = open(_lock_path(), "w")
    try:
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (BlockingIOError, OSError):
        fd.close()
        return None


def _release_lock(fd) -> None:
    if fd is None:
        return
    try:
        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
    finally:
        fd.close()


# ---------------------------------------------------------------------------
# Post-promotion side effects (F3)
# ---------------------------------------------------------------------------

def _hot_reload() -> None:
    try:
        import urllib.request
        admin_key = os.environ.get("QTX_ADMIN_KEY", "")
        if not admin_key:
            print("  WARNING: QTX_ADMIN_KEY is not set — hot-reload skipped; "
                  "the API keeps serving the OLD models until it is restarted.")
            return
        req = urllib.request.Request(RELOAD_URL, method="POST", headers={"X-Admin-Key": admin_key})
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"  Hot-reload ({RELOAD_URL}): {resp.read().decode()}")
    except Exception as exc:
        print(f"  WARNING: hot-reload call failed: {exc} — API still using old models")


def _recompute_cohort_curves() -> None:
    try:
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "25_compute_cohort_response_curves.py")],
            cwd=str(ROOT), check=True,
        )
        print("  Cohort response curves recomputed.")
    except Exception as exc:
        print(f"  WARNING: cohort response curve compute failed: {exc}")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _run_retrain(df: pd.DataFrame | None = None, run_side_effects: bool = True) -> dict:
    """Retrain + gate all three models. Returns a per-model summary dict.

    df may be injected (tests / offline use); otherwise it is loaded from the DB.
    """
    if df is None:
        print("Loading QTX sessions from DB ...")
        df = _load_qtx_sessions()
    session_count = len(df)
    print(f"  Loaded {session_count} QTX sessions")

    eval_df = _ensure_eval_set(df, _EVAL_SEED)
    eval_ids = _load_eval_manifest_ids()
    train_df = _training_frame(df, eval_ids)
    print(f"  Train rows: {len(train_df)} | Eval rows: {len(eval_df)}")

    git_sha = _git_sha()
    summary: dict = {}
    all_metrics: dict = {}
    any_saved = False

    for model_name in ("regression", "classifier", "dropout"):
        spec = _MODEL_SPECS[model_name]
        print(f"Retraining {model_name} model ...")
        fit = _fit_model(train_df, model_name)
        if fit is None:
            summary[model_name] = {"promoted": False, "reason": "insufficient_data_or_skipped"}
            all_metrics[model_name] = summary[model_name]
            continue

        candidate, _feat_cols = fit
        incumbent = _load_incumbent(spec["artifact"])
        cand_metrics = _score_model(candidate, eval_df, model_name)
        inc_metrics = _score_model(incumbent, eval_df, model_name)
        promote = _promotion_decision(model_name, cand_metrics, inc_metrics)

        summary[model_name] = {
            "promoted": promote,
            "candidate": cand_metrics,
            "incumbent": inc_metrics,
        }
        all_metrics[model_name] = summary[model_name]
        print(f"  {model_name}: candidate={cand_metrics} incumbent={inc_metrics} -> promote={promote}")

        if promote:
            artifact_path = MODELS_DIR / spec["artifact"]
            _atomic_dump_joblib(candidate, artifact_path)
            _write_artifact_sidecar(
                artifact_path, model_name, list(candidate.feature_names_in_),
                cand_metrics, inc_metrics, len(train_df), len(eval_df), git_sha,
            )
            any_saved = True
            print(f"  Promoted & saved {spec['artifact']}")
            _update_baselines_on_promote(model_name, cand_metrics)

    _write_state(session_count, all_metrics)

    if any_saved and run_side_effects:
        _hot_reload()
        _recompute_cohort_curves()

    return summary


def main() -> None:
    print("=== Scheduled Retrain Job ===")
    lock_fd = _acquire_lock()
    if lock_fd is None:
        print("  Another retrain job holds the lock — exiting cleanly.")
        return
    try:
        _run_retrain()
    finally:
        _release_lock(lock_fd)
    print("=== Retrain complete ===")


if __name__ == "__main__":
    main()
