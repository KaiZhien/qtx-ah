"""Fit dropout-prediction model to identify patients at risk of non-completion.

Uses config/models.yaml dropout block. Trained on baseline features only.
Reported metrics come from a nested, patient-grouped, label-stratified
cross-validation; the deployed artifact is fit with a search on the full data.
All rows are usable (dropout status known for all).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline
from sklearn.model_selection import RandomizedSearchCV

from qtx.models.evaluate import (
    _build_sklearn_imputer,
    cross_validate_classifier,
    make_stratified_group_kfold,
    sensitivity_card,
    shap_importances,
)
from qtx.models.preprocessing import CAT_COLS, encode_categoricals
from qtx.utils.config import get_models_config, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def _get_feature_cols() -> list[str]:
    cfg = get_models_config()
    return cfg["dropout"]["features"]


def _get_cv_config() -> dict:
    cfg = get_models_config()
    return cfg["dropout"].get("cv", {"kind": "stratified_grouped_kfold", "k": 5})


def train_dropout(df: pd.DataFrame, imputation_strategy: str = "iterative", estimator_type: str = "gbm") -> dict:
    """Train dropout classifier: predict is_dropout from baseline features only.

    All rows are usable (dropout status known for all 1716).
    Returns: {model, cv_metrics, shap_df, feature_names, n, strategy, best_params}
    model is a fitted sklearn Pipeline. estimator_type: "gbm" (default) or "xgb".
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    cv_config = _get_cv_config()
    group_col = cv_config.get("group_col", "sn")
    tuning_key = "tuning_xgb" if estimator_type == "xgb" else "tuning"
    tuning_cfg = get_models_config()[tuning_key]

    log.info(
        "train_dropout: strategy=%s, estimator=%s, features=%d",
        imputation_strategy, estimator_type, len(feature_cols),
    )

    df_out = df[df["is_dropout"].notna()].copy()
    log.info("train_dropout: %d rows with is_dropout", len(df_out))

    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["is_dropout"]].copy()
    df_model, dummy_cols = encode_categoricals(df_model, CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in CAT_COLS]
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

    if group_col in df_out.columns:
        groups = df_out.loc[X_raw.index, group_col].to_numpy()
    else:
        log.warning("train_dropout: group_col %r absent; using one group per row", group_col)
        groups = None

    if estimator_type == "xgb":
        from xgboost import XGBClassifier
        base_model = XGBClassifier(random_state=seed, n_jobs=-1, verbosity=0, tree_method="hist")
        pipeline = Pipeline([("model", base_model)])
    else:
        sklearn_imputer = _build_sklearn_imputer(imputation_strategy, seed)
        base_model = GradientBoostingClassifier(random_state=seed)
        pipeline = Pipeline([("imputer", sklearn_imputer), ("model", base_model)])

    param_distributions = {
        "model__" + k: v for k, v in tuning_cfg["param_distributions"].items()
    }
    inner_cv_k = tuning_cfg.get("cv", 5)
    n_iter = tuning_cfg.get("n_iter", 30)

    def make_search() -> RandomizedSearchCV:
        return RandomizedSearchCV(
            pipeline,
            param_distributions,
            n_iter=n_iter,
            cv=make_stratified_group_kfold(inner_cv_k, seed),
            scoring="roc_auc",
            random_state=seed,
            n_jobs=-1,
            refit=True,
        )

    # Reported metrics: nested grouped, stratified CV.
    cv_metrics = cross_validate_classifier(
        make_search, X_raw, y, groups, cv_config, seed=seed
    )
    cv_metrics["n"] = n_samples

    # Deployed artifact: search on the full data.
    groups_arr = groups if groups is not None else np.arange(len(X_raw))
    final_search = make_search()
    final_search.fit(X_raw, y, groups=groups_arr)
    best_pipeline = final_search.best_estimator_
    best_params = {k.replace("model__", ""): v for k, v in final_search.best_params_.items()}
    log.info("train_dropout: best_params=%s", best_params)

    if estimator_type == "xgb":
        X_for_shap = X_raw
    else:
        X_for_shap = pd.DataFrame(
            best_pipeline.named_steps["imputer"].transform(X_raw.values),
            columns=final_feature_cols,
        )

    try:
        shap_df = shap_importances(best_pipeline.named_steps["model"], X_for_shap)
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
