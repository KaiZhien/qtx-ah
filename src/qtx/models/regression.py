"""Fit gradient-boosting regression model to predict composite_improvement.

Uses config/models.yaml regression_composite block. Reported metrics come from
a nested, patient-grouped cross-validation with per-fold target normalisation
(the composite z-score statistics are refit on each training fold only). The
deployed artifact is fit with a hyperparameter search on the full data.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.pipeline import Pipeline
from sklearn.model_selection import RandomizedSearchCV

from qtx.models.evaluate import (
    _build_sklearn_imputer,
    cross_validate_regression,
    make_group_kfold,
    sensitivity_card,
    shap_importances,
)
from qtx.models.preprocessing import CAT_COLS, encode_categoricals
from qtx.outcomes.composite import (
    IMPROVEMENT_COLS,
    apply_composite_normalizer,
    fit_composite_normalizer,
)
from qtx.utils.config import get_models_config, get_outcomes_config, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def _get_feature_cols() -> list[str]:
    cfg = get_models_config()
    return cfg["regression_composite"]["features"]


def _get_cv_config() -> dict:
    cfg = get_models_config()
    return cfg["regression_composite"].get("cv", {"kind": "grouped_kfold", "k": 5})


def train_regression(df: pd.DataFrame, imputation_strategy: str = "iterative", estimator_type: str = "gbm") -> dict:
    """Train composite_improvement regression model.

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
        "train_regression: strategy=%s, estimator=%s, features=%d",
        imputation_strategy, estimator_type, len(feature_cols),
    )

    df_out = df[df["composite_improvement"].notna()].copy()
    log.info("train_regression: %d rows with composite_improvement", len(df_out))

    cols_to_use = [c for c in feature_cols if c in df_out.columns]
    df_model = df_out[cols_to_use + ["composite_improvement"]].copy()
    df_model, dummy_cols = encode_categoricals(df_model, CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=["composite_improvement"])

    X_raw = df_model[final_feature_cols].astype(float)
    y = df_model["composite_improvement"].astype(float)

    n_samples = len(X_raw)
    log.info("train_regression: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_regression: too few samples (%d); skipping", n_samples)
        return {}

    if imputation_strategy == "complete_case":
        mask = ~X_raw.isna().any(axis=1)
        X_raw = X_raw[mask]
        y = y[mask]
        n_samples = len(X_raw)
        log.info("train_regression: complete_case n=%d after NaN drop", n_samples)
        if n_samples < 10:
            log.error("train_regression: complete_case yielded too few samples (%d); skipping", n_samples)
            return {}

    # ------------------------------------------------------------------
    # Auxiliary data (aligned to the surviving X_raw rows, in row order):
    #   - df_components: raw per-test change scores + cohort, for per-fold
    #     target normalisation (composite refit on training-fold rows only)
    #   - groups: patient identifier for grouped CV splits
    # ------------------------------------------------------------------
    idx = X_raw.index
    comp_cols = [c for c in IMPROVEMENT_COLS if c in df_out.columns]
    if group_col in df_out.columns:
        groups = df_out.loc[idx, group_col].to_numpy()
    else:
        log.warning("train_regression: group_col %r absent; using one group per row", group_col)
        groups = None

    min_tests = get_outcomes_config().get("composite", {}).get("min_tests_required", 1)

    target_builder = None
    if comp_cols:
        df_components = df_out.loc[idx, comp_cols + ["cohort"]].reset_index(drop=True)

        def target_builder(train_idx, val_idx):  # noqa: F811
            """Recompute the composite target with normalisation fit on train rows only."""
            norm = fit_composite_normalizer(df_components.iloc[train_idx])
            y_tr = apply_composite_normalizer(df_components.iloc[train_idx], norm, min_tests).to_numpy()
            y_val = apply_composite_normalizer(df_components.iloc[val_idx], norm, min_tests).to_numpy()
            return y_tr, y_val
    else:
        # No raw per-test component columns available (e.g. a matrix that only
        # carries the precomputed composite). Fall back to the deployed composite
        # target; per-fold renormalisation is not possible without the components.
        log.warning(
            "train_regression: per-test component columns absent; CV uses the "
            "precomputed composite target without per-fold renormalisation"
        )

    if estimator_type == "xgb":
        from xgboost import XGBRegressor
        base_model = XGBRegressor(random_state=seed, n_jobs=-1, verbosity=0, tree_method="hist")
        pipeline = Pipeline([("model", base_model)])
    else:
        sklearn_imputer = _build_sklearn_imputer(imputation_strategy, seed)
        base_model = GradientBoostingRegressor(random_state=seed)
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
            cv=make_group_kfold(inner_cv_k, seed),
            scoring="neg_root_mean_squared_error",
            random_state=seed,
            n_jobs=-1,
            refit=True,
        )

    # Reported metrics: nested grouped CV with leak-free per-fold target
    # (or the deployed composite when component columns are unavailable).
    if target_builder is not None:
        cv_metrics = cross_validate_regression(
            make_search, X_raw, groups, cv_config, seed=seed, target_builder=target_builder
        )
    else:
        cv_metrics = cross_validate_regression(
            make_search, X_raw, groups, cv_config, seed=seed, y=y
        )
    cv_metrics["n"] = n_samples

    # Deployed artifact: search on the full data (deployed composite target).
    groups_arr = groups if groups is not None else np.arange(len(X_raw))
    final_search = make_search()
    final_search.fit(X_raw, y, groups=groups_arr)
    best_pipeline = final_search.best_estimator_
    best_params = {k.replace("model__", ""): v for k, v in final_search.best_params_.items()}
    log.info("train_regression: best_params=%s", best_params)

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
        log.warning("SHAP failed for regression: %s", e)
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


def run_regression_sensitivity(df: pd.DataFrame) -> pd.DataFrame:
    """Run train_regression for each imputation_variant in models.yaml."""
    cfg = get_models_config()
    variants = cfg.get("sensitivity", {}).get("imputation_variants", ["complete_case", "median"])

    results_by_strategy: dict[str, dict] = {}
    for strategy in variants:
        log.info("run_regression_sensitivity: strategy=%s", strategy)
        try:
            result = train_regression(df, imputation_strategy=strategy)
            if result:
                metrics = result["cv_metrics"].copy()
                metrics["n"] = result.get("n", 0)
                results_by_strategy[strategy] = metrics
        except Exception as e:
            log.warning("Regression sensitivity failed for strategy %s: %s", strategy, e)

    return sensitivity_card(results_by_strategy)
