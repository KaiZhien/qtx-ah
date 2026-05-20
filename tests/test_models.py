"""Tests for model training contracts after Approach-A optimisation.

Verifies:
- Config has 46 features per model and a tuning block
- _build_sklearn_imputer returns correct sklearn types
- train_classifier / train_regression / train_dropout return expected keys
  including best_params, and n reflects expanded dataset
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from sklearn.experimental import enable_iterative_imputer  # noqa: F401
from sklearn.impute import IterativeImputer, KNNImputer, SimpleImputer

from qtx.utils.config import get_models_config


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_featured_df(n: int = 80, seed: int = 0) -> pd.DataFrame:
    """Synthetic featured.parquet-like DataFrame with all 46 feature columns,
    two outcome columns, and realistic NaN patterns in pre_vas / pre_fast_gs_ms."""
    rng = np.random.default_rng(seed)

    df = pd.DataFrame({
        # demographics
        "age": rng.integers(50, 85, n).astype(float),
        "gender": rng.choice(["M", "F", "__missing__"], n),
        "usage_frequency": rng.choice(["Low", "Medium", "High"], n),
        "cohort": rng.choice(["Pain & MSK", "Neurological", "Post-Surgical", "Frailty", "Wellness"], n),
        "primary_indication": rng.choice(["Joint disease", "Frailty/Sarcopenia", "Neurological",
                                           "Post-Surgical/Rehab", "Unclassified"], n),
        # baseline scores (some NaN in pre_vas and pre_fast_gs_ms)
        "baseline_sppb": rng.integers(4, 12, n).astype(float),
        "pre_normal_gs_ms": rng.uniform(0.5, 1.4, n),
        "pre_tug_s": rng.uniform(8, 35, n),
        "pre_5xsst_s": rng.uniform(15, 55, n),
        "pre_vas": np.where(rng.random(n) < 0.15, np.nan, rng.uniform(0, 10, n)),
        "pre_fast_gs_ms": np.where(rng.random(n) < 0.35, np.nan, rng.uniform(0.4, 2.0, n)),
        # complexity
        "n_flags": rng.integers(0, 5, n).astype(float),
        "n_regions": rng.integers(0, 4, n).astype(float),
        "n_groups": rng.integers(0, 3, n).astype(float),
        # has_* flags
        "has_oa": rng.integers(0, 2, n).astype(float),
        "has_diabetes": rng.integers(0, 2, n).astype(float),
        "has_stroke": rng.integers(0, 2, n).astype(float),
        "has_parkinsons": rng.integers(0, 2, n).astype(float),
        "has_sarcopenia": rng.integers(0, 2, n).astype(float),
        "has_post_surgery": rng.integers(0, 2, n).astype(float),
        "has_balance_issue": rng.integers(0, 2, n).astype(float),
        "has_chronic_pain": rng.integers(0, 2, n).astype(float),
        "has_hypertension": rng.integers(0, 2, n).astype(float),
        "has_frailty": rng.integers(0, 2, n).astype(float),
        "has_fall_risk": rng.integers(0, 2, n).astype(float),
        "has_neurological": rng.integers(0, 2, n).astype(float),
        "has_metabolic": rng.integers(0, 2, n).astype(float),
        "has_knee_issue": rng.integers(0, 2, n).astype(float),
        "has_spinal_issue": rng.integers(0, 2, n).astype(float),
        # grp_* flags
        "grp_joint_disease": rng.integers(0, 2, n).astype(float),
        "grp_spine_back": rng.integers(0, 2, n).astype(float),
        "grp_neurological": rng.integers(0, 2, n).astype(float),
        "grp_post_surgical": rng.integers(0, 2, n).astype(float),
        "grp_frailty_sarcopenia": rng.integers(0, 2, n).astype(float),
        "grp_balance_falls": rng.integers(0, 2, n).astype(float),
        "grp_metabolic": rng.integers(0, 2, n).astype(float),
        "grp_softtissue_injury": rng.integers(0, 2, n).astype(float),
        "grp_osteoporosis": rng.integers(0, 2, n).astype(float),
        # rgn_* flags
        "rgn_spine": rng.integers(0, 2, n).astype(float),
        "rgn_knee": rng.integers(0, 2, n).astype(float),
        "rgn_ankle_foot": rng.integers(0, 2, n).astype(float),
        "rgn_hip": rng.integers(0, 2, n).astype(float),
        "rgn_lower_limb": rng.integers(0, 2, n).astype(float),
        "rgn_shoulder": rng.integers(0, 2, n).astype(float),
        "rgn_upper_limb": rng.integers(0, 2, n).astype(float),
        "rgn_trunk": rng.integers(0, 2, n).astype(float),
        # outcome columns (first 60 rows have outcomes, rest are dropout)
        "overall_responder": np.where(np.arange(n) < 60, rng.integers(0, 2, n).astype(float), np.nan),
        "composite_improvement": np.where(np.arange(n) < 60, rng.uniform(-1, 1, n), np.nan),
        "is_dropout": np.where(np.arange(n) >= 60, 1, 0).astype(int),
        "has_followup": np.where(np.arange(n) < 60, "Y", "N"),
    })
    return df


@pytest.fixture
def featured_df() -> pd.DataFrame:
    return _make_featured_df(n=80)


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------

def test_config_classifier_has_46_features():
    cfg = get_models_config()
    assert len(cfg["classifier_responder"]["features"]) == 46


def test_config_regression_has_46_features():
    cfg = get_models_config()
    assert len(cfg["regression_composite"]["features"]) == 46


def test_config_dropout_has_46_features():
    cfg = get_models_config()
    assert len(cfg["dropout"]["features"]) == 46


def test_config_has_tuning_block():
    cfg = get_models_config()
    assert "tuning" in cfg
    assert cfg["tuning"]["n_iter"] == 30
    assert "n_estimators" in cfg["tuning"]["param_distributions"]


def test_config_primary_indication_in_features():
    cfg = get_models_config()
    assert "primary_indication" in cfg["classifier_responder"]["features"]
    assert "primary_indication" in cfg["regression_composite"]["features"]
    assert "primary_indication" in cfg["dropout"]["features"]


# ---------------------------------------------------------------------------
# _build_sklearn_imputer tests
# ---------------------------------------------------------------------------

def test_build_sklearn_imputer_iterative():
    from qtx.models.evaluate import _build_sklearn_imputer
    imp = _build_sklearn_imputer("iterative", seed=42)
    assert isinstance(imp, IterativeImputer)


def test_build_sklearn_imputer_knn5():
    from qtx.models.evaluate import _build_sklearn_imputer
    imp = _build_sklearn_imputer("knn5", seed=42)
    assert isinstance(imp, KNNImputer)
    assert imp.n_neighbors == 5


def test_build_sklearn_imputer_median():
    from qtx.models.evaluate import _build_sklearn_imputer
    imp = _build_sklearn_imputer("median", seed=42)
    assert isinstance(imp, SimpleImputer)
    assert imp.strategy == "median"


def test_build_sklearn_imputer_complete_case_returns_median():
    from qtx.models.evaluate import _build_sklearn_imputer
    imp = _build_sklearn_imputer("complete_case", seed=42)
    assert isinstance(imp, SimpleImputer)


# ---------------------------------------------------------------------------
# train_classifier contract
# ---------------------------------------------------------------------------

def test_train_classifier_returns_best_params(featured_df):
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, imputation_strategy="median")
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_classifier_n_reflects_outcome_rows(featured_df):
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, imputation_strategy="median")
    # 60 rows have overall_responder set in the fixture
    assert result["n"] == 60


def test_train_classifier_feature_names_excludes_primary_indication_raw(featured_df):
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, imputation_strategy="median")
    # primary_indication is encoded; raw string column name should not appear
    assert "primary_indication" not in result["feature_names"]


def test_train_classifier_model_is_pipeline(featured_df):
    from sklearn.pipeline import Pipeline
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, imputation_strategy="median")
    assert isinstance(result["model"], Pipeline)


# ---------------------------------------------------------------------------
# train_regression contract
# ---------------------------------------------------------------------------

def test_train_regression_returns_best_params(featured_df):
    from qtx.models.regression import train_regression
    result = train_regression(featured_df, imputation_strategy="median")
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_regression_model_is_pipeline(featured_df):
    from sklearn.pipeline import Pipeline
    from qtx.models.regression import train_regression
    result = train_regression(featured_df, imputation_strategy="median")
    assert isinstance(result["model"], Pipeline)


# ---------------------------------------------------------------------------
# train_dropout contract
# ---------------------------------------------------------------------------

def test_train_dropout_returns_best_params(featured_df):
    from qtx.models.dropout import train_dropout
    result = train_dropout(featured_df, imputation_strategy="median")
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_dropout_uses_all_rows(featured_df):
    from qtx.models.dropout import train_dropout
    result = train_dropout(featured_df, imputation_strategy="median")
    # all 80 rows have is_dropout defined
    assert result["n"] == 80
