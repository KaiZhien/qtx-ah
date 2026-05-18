"""Fit gradient-boosting regression model to predict composite_improvement.

Uses the feature set and CV strategy from config/models.yaml regression_composite
block. Persists the trained model to models/ as a joblib file and returns
cross-validated metric results (RMSE, MAE, R2).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import LinearRegression

from qtx.missing.impute import FeatureImputer
from qtx.models.evaluate import (
    cross_validate_regression,
    sensitivity_card,
    shap_importances,
)
from qtx.utils.config import get_models_config, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)

# Categorical columns to encode
_CAT_COLS = ["cohort", "usage_frequency", "gender"]


def _get_feature_cols() -> list[str]:
    cfg = get_models_config()
    return cfg["regression_composite"]["features"]


def _get_cv_config() -> dict:
    cfg = get_models_config()
    return cfg["regression_composite"].get("cv", {"kind": "kfold", "k": 5})


def _encode_categoricals(df: pd.DataFrame, cat_cols: list[str]) -> tuple[pd.DataFrame, list[str]]:
    """One-hot encode categorical columns; return (df_encoded, dummy_col_names)."""
    present = [c for c in cat_cols if c in df.columns]
    df_enc = pd.get_dummies(df, columns=present, drop_first=True, dtype=float)
    dummy_cols = [c for c in df_enc.columns if any(c.startswith(base + "_") for base in present)]
    return df_enc, dummy_cols


def train_regression(df: pd.DataFrame, imputation_strategy: str = "complete_case") -> dict:
    """Train composite_improvement regression model.

    Steps:
    1. Get feature list from models.yaml regression_composite.features
    2. Apply FeatureImputer with imputation_strategy
    3. Encode categoricals with pd.get_dummies
    4. Filter to rows where composite_improvement is not NaN
    5. Split X / y
    6. Train GradientBoostingRegressor
    7. Also train LinearRegression as baseline
    8. Run cross_validate_regression
    9. Compute SHAP importances
    10. Return dict of results
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    cv_config = _get_cv_config()

    log.info("train_regression: strategy=%s, features=%d", imputation_strategy, len(feature_cols))

    # Apply imputer
    imputer = FeatureImputer(feature_cols=feature_cols, strategy_override=imputation_strategy)
    df_imp = imputer.fit_transform(df)

    # Filter to rows with outcome
    df_imp = df_imp[df_imp["composite_improvement"].notna()].copy()
    log.info("train_regression: %d rows with composite_improvement after imputation", len(df_imp))

    # Encode categoricals
    cols_to_use = [c for c in feature_cols if c in df_imp.columns]
    df_model = df_imp[cols_to_use + ["composite_improvement"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    # Build final feature list (replace cat cols with dummies)
    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    # Drop remaining NaNs in features
    df_model = df_model.dropna(subset=final_feature_cols + ["composite_improvement"])

    X = df_model[final_feature_cols].astype(float)
    y = df_model["composite_improvement"].astype(float)

    n_samples = len(X)
    log.info("train_regression: final n=%d for training", n_samples)

    if n_samples < 10:
        log.error("train_regression: too few samples (%d); skipping", n_samples)
        return {}

    # Train GradientBoostingRegressor
    model = GradientBoostingRegressor(
        n_estimators=200,
        learning_rate=0.05,
        max_depth=3,
        random_state=seed,
    )
    model.fit(X, y)

    # Train LinearRegression baseline
    linear_model = LinearRegression()
    linear_model.fit(X, y)

    # Cross-validate
    cv_metrics = cross_validate_regression(model, X, y, cv_config)
    cv_metrics["n"] = n_samples

    # SHAP importances
    try:
        shap_df = shap_importances(model, X)
    except Exception as e:
        log.warning("SHAP failed for regression: %s", e)
        shap_df = pd.DataFrame({"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)})

    return {
        "model": model,
        "linear_model": linear_model,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
    }


def run_regression_sensitivity(df: pd.DataFrame) -> pd.DataFrame:
    """Run train_regression for each imputation_variant in models.yaml.

    Returns sensitivity_card DataFrame.
    """
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
