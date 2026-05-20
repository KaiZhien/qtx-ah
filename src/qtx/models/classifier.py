"""Fit gradient-boosting classifier to predict overall_responder.

Uses config/models.yaml classifier_responder block. Evaluates with AUC-ROC,
AUC-PR, Brier score, and calibration curve. Returns cross-validated metric dict.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline
from sklearn.model_selection import RandomizedSearchCV

from qtx.models.evaluate import (
    _build_sklearn_imputer,
    calibration_data,
    cross_validate_classifier,
    sensitivity_card,
    shap_importances,
)
from qtx.utils.config import get_models_config, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)

_CAT_COLS = ["cohort", "usage_frequency", "gender", "primary_indication"]

_DEFAULT_PARAM_GRID = {
    "n_estimators": [100, 200, 300, 500],
    "learning_rate": [0.01, 0.05, 0.1, 0.2],
    "max_depth": [2, 3, 4, 5],
    "subsample": [0.7, 0.8, 1.0],
    "min_samples_leaf": [1, 5, 10, 20],
}


def _get_feature_cols() -> list[str]:
    cfg = get_models_config()
    return cfg["classifier_responder"]["features"]


def _get_tuning_cfg() -> dict:
    cfg = get_models_config()
    return cfg.get("tuning", {})


def _encode_categoricals(df: pd.DataFrame, cat_cols: list[str]) -> tuple[pd.DataFrame, list[str]]:
    present = [c for c in cat_cols if c in df.columns]
    df_enc = pd.get_dummies(df, columns=present, drop_first=True, dtype=float)
    dummy_cols = [c for c in df_enc.columns if any(c.startswith(base + "_") for base in present)]
    return df_enc, dummy_cols


def train_classifier(df: pd.DataFrame, imputation_strategy: str = "iterative") -> dict:
    """Train overall_responder binary classifier.

    Returns: {model, cv_metrics, shap_df, calibration, feature_names, n,
              strategy, best_params, X, y}
    model is a fitted sklearn Pipeline(imputer, GradientBoostingClassifier).
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    tuning_cfg = _get_tuning_cfg()
    cv_config = {"kind": "stratified_kfold", "k": 5}

    log.info("train_classifier: strategy=%s, features=%d", imputation_strategy, len(feature_cols))

    # Filter to rows with outcome
    df_out = df[df["overall_responder"].notna()].copy()
    log.info("train_classifier: %d rows with overall_responder", len(df_out))

    # Encode categoricals (on full outcome-subset for consistent dummy columns)
    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["overall_responder"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=["overall_responder"])

    # X_raw may contain NaN in features — Pipeline handles imputation per fold
    X_raw = df_model[final_feature_cols].astype(float)
    y = df_model["overall_responder"].astype(int)

    n_samples = len(X_raw)
    log.info("train_classifier: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_classifier: too few samples (%d); skipping", n_samples)
        return {}

    # For complete_case: drop NaN rows up front; pipeline imputer becomes a no-op
    if imputation_strategy == "complete_case":
        mask = ~X_raw.isna().any(axis=1)
        X_raw = X_raw[mask]
        y = y[mask]
        n_samples = len(X_raw)
        log.info("train_classifier: complete_case n=%d after NaN drop", n_samples)

    sklearn_imputer = _build_sklearn_imputer(imputation_strategy, seed)

    base_model = GradientBoostingClassifier(random_state=seed)
    pipeline = Pipeline([("imputer", sklearn_imputer), ("model", base_model)])

    param_distributions = {
        "model__" + k: v
        for k, v in tuning_cfg.get("param_distributions", _DEFAULT_PARAM_GRID).items()
    }

    search = RandomizedSearchCV(
        pipeline,
        param_distributions,
        n_iter=tuning_cfg.get("n_iter", 30),
        cv=tuning_cfg.get("cv", 5),
        scoring="roc_auc",
        random_state=seed,
        n_jobs=-1,
        refit=True,
    )
    search.fit(X_raw, y)

    best_pipeline = search.best_estimator_
    best_params = {k.replace("model__", ""): v for k, v in search.best_params_.items()}
    log.info("train_classifier: best_params=%s", best_params)

    cv_metrics = cross_validate_classifier(best_pipeline, X_raw, y, cv_config)
    cv_metrics["n"] = n_samples

    # SHAP uses the fitted GBM step and imputed X
    X_imputed = pd.DataFrame(
        best_pipeline.named_steps["imputer"].transform(X_raw.values),
        columns=final_feature_cols,
    )
    try:
        shap_df = shap_importances(best_pipeline.named_steps["model"], X_imputed)
    except Exception as e:
        log.warning("SHAP failed for classifier: %s", e)
        shap_df = pd.DataFrame(
            {"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)}
        )

    try:
        cal_data = calibration_data(best_pipeline, X_raw, y)
    except Exception as e:
        log.warning("Calibration data failed: %s", e)
        cal_data = (np.array([]), np.array([]))

    return {
        "model": best_pipeline,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "calibration": cal_data,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
        "best_params": best_params,
        "X": X_raw,
        "y": y,
    }


def run_classifier_sensitivity(df: pd.DataFrame) -> pd.DataFrame:
    """Run train_classifier across imputation_variants. Returns sensitivity_card."""
    cfg = get_models_config()
    variants = cfg.get("sensitivity", {}).get("imputation_variants", ["complete_case", "median"])

    results_by_strategy: dict[str, dict] = {}
    for strategy in variants:
        log.info("run_classifier_sensitivity: strategy=%s", strategy)
        try:
            result = train_classifier(df, imputation_strategy=strategy)
            if result:
                metrics = result["cv_metrics"].copy()
                metrics["n"] = result.get("n", 0)
                results_by_strategy[strategy] = metrics
        except Exception as e:
            log.warning("Classifier sensitivity failed for strategy %s: %s", strategy, e)

    return sensitivity_card(results_by_strategy)
