"""Fit dropout-prediction model to identify patients at risk of non-completion.

Uses config/models.yaml dropout block. Trained on baseline features only.
All 1716 rows are usable (dropout status known for all).
"""

from __future__ import annotations

import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline
from sklearn.model_selection import RandomizedSearchCV

from qtx.models.evaluate import (
    _build_sklearn_imputer,
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
    return cfg["dropout"]["features"]


def _get_tuning_cfg() -> dict:
    return get_models_config().get("tuning", {})


def _encode_categoricals(df: pd.DataFrame, cat_cols: list[str]) -> tuple[pd.DataFrame, list[str]]:
    present = [c for c in cat_cols if c in df.columns]
    df_enc = pd.get_dummies(df, columns=present, drop_first=True, dtype=float)
    dummy_cols = [c for c in df_enc.columns if any(c.startswith(base + "_") for base in present)]
    return df_enc, dummy_cols


def train_dropout(df: pd.DataFrame, imputation_strategy: str = "iterative") -> dict:
    """Train dropout classifier: predict is_dropout from baseline features only.

    All rows are usable (dropout status known for all 1716).
    Returns: {model, cv_metrics, shap_df, feature_names, n, strategy, best_params}
    model is a fitted sklearn Pipeline(imputer, GradientBoostingClassifier).
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    tuning_cfg = _get_tuning_cfg()
    cv_config = {"kind": "stratified_kfold", "k": 5}

    log.info("train_dropout: strategy=%s, features=%d", imputation_strategy, len(feature_cols))

    df_out = df[df["is_dropout"].notna()].copy()
    log.info("train_dropout: %d rows with is_dropout", len(df_out))

    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["is_dropout"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=["is_dropout"])

    X_raw = df_model[final_feature_cols].astype(float)
    y = df_model["is_dropout"].astype(int)

    n_samples = len(X_raw)
    log.info("train_dropout: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_dropout: too few samples (%d); skipping", n_samples)
        return {}

    if imputation_strategy == "complete_case":
        mask = ~X_raw.isna().any(axis=1)
        X_raw = X_raw[mask]
        y = y[mask]
        n_samples = len(X_raw)
        log.info("train_dropout: complete_case n=%d after NaN drop", n_samples)

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
    log.info("train_dropout: best_params=%s", best_params)

    cv_metrics = cross_validate_classifier(best_pipeline, X_raw, y, cv_config)
    cv_metrics["n"] = n_samples

    X_imputed = pd.DataFrame(
        best_pipeline.named_steps["imputer"].transform(X_raw.values),
        columns=final_feature_cols,
    )
    try:
        shap_df = shap_importances(best_pipeline.named_steps["model"], X_imputed)
    except Exception as e:
        log.warning("SHAP failed for dropout: %s", e)
        shap_df = pd.DataFrame(
            {"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)}
        )

    return {
        "model": best_pipeline,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
        "best_params": best_params,
    }


def run_dropout_sensitivity(df: pd.DataFrame) -> pd.DataFrame:
    """Run train_dropout across imputation_variants. Returns sensitivity_card."""
    cfg = get_models_config()
    variants = cfg.get("sensitivity", {}).get("imputation_variants", ["complete_case", "median"])

    results_by_strategy: dict[str, dict] = {}
    for strategy in variants:
        log.info("run_dropout_sensitivity: strategy=%s", strategy)
        try:
            result = train_dropout(df, imputation_strategy=strategy)
            if result:
                metrics = result["cv_metrics"].copy()
                metrics["n"] = result.get("n", 0)
                results_by_strategy[strategy] = metrics
        except Exception as e:
            log.warning("Dropout sensitivity failed for strategy %s: %s", strategy, e)

    return sensitivity_card(results_by_strategy)
