"""Fit dropout-prediction model to identify patients at risk of non-completion.

Uses config/models.yaml dropout block. Trained on baseline features only
(no post-test data). AUC-ROC and AUC-PR reported. All 1716 rows usable.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier

from qtx.missing.impute import FeatureImputer
from qtx.models.evaluate import (
    cross_validate_classifier,
    sensitivity_card,
    shap_importances,
)
from qtx.utils.config import get_models_config, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)

_CAT_COLS = ["cohort", "usage_frequency", "gender"]


def _get_feature_cols() -> list[str]:
    cfg = get_models_config()
    return cfg["dropout"]["features"]


def _encode_categoricals(df: pd.DataFrame, cat_cols: list[str]) -> tuple[pd.DataFrame, list[str]]:
    present = [c for c in cat_cols if c in df.columns]
    df_enc = pd.get_dummies(df, columns=present, drop_first=True, dtype=float)
    dummy_cols = [c for c in df_enc.columns if any(c.startswith(base + "_") for base in present)]
    return df_enc, dummy_cols


def train_dropout(df: pd.DataFrame, imputation_strategy: str = "complete_case") -> dict:
    """Train dropout classifier: predict is_dropout from baseline features only.

    All rows are usable (dropout status known for all 1716).
    Returns: {model, cv_metrics, shap_df, feature_names, n, strategy}
    """
    seed = int(get_settings().get("random_seed", 42))
    feature_cols = _get_feature_cols()
    cv_config = {"kind": "stratified_kfold", "k": 5}

    log.info("train_dropout: strategy=%s, features=%d", imputation_strategy, len(feature_cols))

    # Impute using all rows (is_dropout is known for all)
    imputer = FeatureImputer(feature_cols=feature_cols, strategy_override=imputation_strategy)
    df_imp = imputer.fit_transform(df)

    # Filter to rows with is_dropout defined
    df_imp = df_imp[df_imp["is_dropout"].notna()].copy()
    log.info("train_dropout: %d rows with is_dropout", len(df_imp))

    # Encode categoricals
    cols_to_use = [c for c in feature_cols if c in df_imp.columns]
    df_model = df_imp[cols_to_use + ["is_dropout"]].copy()
    df_model, dummy_cols = _encode_categoricals(df_model, _CAT_COLS)

    non_cat_cols = [c for c in cols_to_use if c not in _CAT_COLS]
    final_feature_cols = non_cat_cols + dummy_cols

    df_model = df_model.dropna(subset=final_feature_cols + ["is_dropout"])

    X = df_model[final_feature_cols].astype(float)
    y = df_model["is_dropout"].astype(int)

    n_samples = len(X)
    log.info("train_dropout: final n=%d", n_samples)

    if n_samples < 10:
        log.error("train_dropout: too few samples (%d); skipping", n_samples)
        return {}

    model = GradientBoostingClassifier(
        n_estimators=200,
        learning_rate=0.05,
        max_depth=3,
        random_state=seed,
    )
    model.fit(X, y)

    cv_metrics = cross_validate_classifier(model, X, y, cv_config)
    cv_metrics["n"] = n_samples

    try:
        shap_df = shap_importances(model, X)
    except Exception as e:
        log.warning("SHAP failed for dropout: %s", e)
        shap_df = pd.DataFrame({"feature": final_feature_cols, "mean_abs_shap": [float("nan")] * len(final_feature_cols)})

    return {
        "model": model,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": final_feature_cols,
        "n": n_samples,
        "strategy": imputation_strategy,
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
