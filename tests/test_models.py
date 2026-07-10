"""Tests for model training contracts after Approach-A optimisation.

Verifies:
- Config has 49 features per model and a tuning block
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
    """Synthetic featured.parquet-like DataFrame with all 49 feature columns,
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
        # raw per-test change scores (drive per-fold composite renormalisation);
        # populated for all rows so every modelling row has >= 1 available test
        "vas_improvement": rng.uniform(-3, 3, n),
        "tug_improvement": rng.uniform(-5, 5, n),
        "sst_improvement": rng.uniform(-8, 8, n),
        "normal_gs_improvement": rng.uniform(-0.3, 0.3, n),
        "fast_gs_improvement": rng.uniform(-0.4, 0.4, n),
        "sppb_improvement": rng.uniform(-3, 3, n),
        # outcome columns (first 60 rows have outcomes, rest are dropout)
        "overall_responder": [float(i % 2) for i in range(60)] + [np.nan] * (n - 60),
        "composite_improvement": np.where(np.arange(n) < 60, rng.uniform(-1, 1, n), np.nan),
        "is_dropout": np.where(np.arange(n) >= 60, 1, 0).astype(int),
        "has_followup": np.where(np.arange(n) < 60, "Y", "N"),
        # longitudinal session features (default values matching build_feature_matrix placeholders)
        "session_number": np.ones(n, dtype=float),
        "prior_avg_composite_improvement": np.zeros(n, dtype=float),
        "trend_tug_magnitude": np.zeros(n, dtype=float),
    })
    return df


@pytest.fixture
def featured_df() -> pd.DataFrame:
    return _make_featured_df(n=80)


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------

def test_config_classifier_has_49_features():
    cfg = get_models_config()
    assert len(cfg["classifier_responder"]["features"]) == 49


def test_config_regression_has_49_features():
    cfg = get_models_config()
    assert len(cfg["regression_composite"]["features"]) == 49


def test_config_dropout_has_49_features():
    cfg = get_models_config()
    assert len(cfg["dropout"]["features"]) == 49


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


def test_fixture_covers_all_config_features(featured_df):
    cfg = get_models_config()
    missing = set(cfg["classifier_responder"]["features"]) - set(featured_df.columns)
    assert not missing, f"Fixture missing feature columns: {missing}"


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
    assert imp.strategy == "median"


# ---------------------------------------------------------------------------
# train_classifier contract
# ---------------------------------------------------------------------------

def test_train_classifier_returns_best_params(featured_df):
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, imputation_strategy="median")
    assert result, "train_classifier returned empty dict"
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
    assert result, "train_regression returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_regression_model_is_pipeline(featured_df):
    from sklearn.pipeline import Pipeline
    from qtx.models.regression import train_regression
    result = train_regression(featured_df, imputation_strategy="median")
    assert isinstance(result["model"], Pipeline)
    assert result["n"] == 60


# ---------------------------------------------------------------------------
# train_dropout contract
# ---------------------------------------------------------------------------

def test_train_dropout_returns_best_params(featured_df):
    from qtx.models.dropout import train_dropout
    result = train_dropout(featured_df, imputation_strategy="median")
    assert result, "train_dropout returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_dropout_uses_all_rows(featured_df):
    from qtx.models.dropout import train_dropout
    result = train_dropout(featured_df, imputation_strategy="median")
    # all 80 rows have is_dropout defined
    assert result["n"] == 80


# ---------------------------------------------------------------------------
# Nested / grouped CV helpers (used by the CV methodology tests below)
# ---------------------------------------------------------------------------


class _SpySearch:
    """Minimal search-like object recording every (X, y, groups) it was fit on.

    Lets tests assert that a fresh search is fit once per OUTER fold and only
    ever on an outer-train subset (never on the full dataset).
    """

    def __init__(self, estimator, log: list):
        self.estimator = estimator
        self._log = log

    def fit(self, X, y, groups=None):
        import numpy as _np

        self._log.append(
            {
                "n_rows": len(X),
                "groups": None if groups is None else _np.asarray(groups).copy(),
            }
        )
        self.estimator.fit(X, y)
        self.best_estimator_ = self.estimator
        self.best_params_ = {"model__n_estimators": 5}
        return self

    def predict(self, X):
        return self.estimator.predict(X)

    def predict_proba(self, X):
        return self.estimator.predict_proba(X)


def _spy_classifier_factory(log: list):
    from sklearn.ensemble import GradientBoostingClassifier

    def make_search():
        return _SpySearch(GradientBoostingClassifier(n_estimators=5, random_state=0), log)

    return make_search


def _spy_regressor_factory(log: list):
    from sklearn.linear_model import LinearRegression

    def make_search():
        return _SpySearch(LinearRegression(), log)

    return make_search


# ---------------------------------------------------------------------------
# F1 score in cross_validate_classifier (nested-CV signature)
# ---------------------------------------------------------------------------

def test_cross_validate_classifier_returns_f1():
    from qtx.models.evaluate import cross_validate_classifier

    X = pd.DataFrame({"a": [1.0] * 40 + [0.0] * 40, "b": np.arange(80.0)})
    y = pd.Series([1] * 40 + [0] * 40)
    log: list = []
    result = cross_validate_classifier(
        _spy_classifier_factory(log), X, y, None, {"k": 2}, seed=0
    )
    assert "f1_mean" in result
    assert "f1_std" in result
    assert 0.0 <= result["f1_mean"] <= 1.0
    assert result["n_folds"] == 2


# ---------------------------------------------------------------------------
# P2 — patient-grouped splits: no patient in both train and validation
# ---------------------------------------------------------------------------

def test_grouped_splits_keep_patients_out_of_both_sides():
    from qtx.models.evaluate import make_group_kfold, make_stratified_group_kfold

    n_patients = 30
    groups = np.repeat(np.arange(n_patients), 2)  # 2 sessions per patient
    X = np.random.default_rng(0).normal(size=(len(groups), 3))
    # class is constant within a patient (realistic longitudinal label)
    y = np.repeat(np.arange(n_patients) % 2, 2)

    for splitter in (make_group_kfold(5, 0), make_stratified_group_kfold(5, 0)):
        for train_idx, val_idx in splitter.split(X, y, groups=groups):
            train_patients = set(groups[train_idx])
            val_patients = set(groups[val_idx])
            assert train_patients.isdisjoint(val_patients), (
                f"patient leaked across the split for {type(splitter).__name__}"
            )


# ---------------------------------------------------------------------------
# P3 — nested CV: the search is fit once per outer fold, on outer-train only
# ---------------------------------------------------------------------------

def test_nested_cv_search_fits_only_outer_train_subsets():
    from qtx.models.evaluate import cross_validate_classifier

    n = 80
    X = pd.DataFrame({"a": np.linspace(0, 1, n), "b": np.arange(float(n))})
    y = pd.Series(([0, 1] * (n // 2)))
    groups = np.arange(n)  # one patient per row
    log: list = []
    k = 5
    cross_validate_classifier(_spy_classifier_factory(log), X, y, groups, {"k": k}, seed=0)

    # exactly one fresh search per outer fold ...
    assert len(log) == k
    # ... and each search saw strictly fewer than all rows (outer-train subset),
    # so hyperparameters are never selected on the full dataset.
    assert all(call["n_rows"] < n for call in log)
    assert all(call["n_rows"] >= n - (n // k) - 1 for call in log)


def test_nested_cv_regression_search_fits_only_outer_train():
    from qtx.models.evaluate import cross_validate_regression

    n = 60
    X = pd.DataFrame({"a": np.linspace(0, 1, n), "b": np.arange(float(n))})
    y = pd.Series(np.linspace(-1, 1, n))
    log: list = []
    k = 5
    cross_validate_regression(
        _spy_regressor_factory(log), X, np.arange(n), {"k": k}, seed=0, y=y
    )
    assert len(log) == k
    assert all(call["n_rows"] < n for call in log)


# ---------------------------------------------------------------------------
# P1 — per-fold target normalization uses TRAIN-fold statistics only
# ---------------------------------------------------------------------------

def test_perfold_target_normalization_uses_train_stats_only():
    """The validation-fold composite must be z-scored with train-fold stats.

    Data is engineered so global stats differ measurably from train-fold stats:
    if the val target were normalized with global (leaky) stats it would take a
    different value, so we assert it matches the train-only normalization.
    """
    from qtx.outcomes.composite import (
        apply_composite_normalizer,
        fit_composite_normalizer,
    )

    # Single small cohort (< 30) → normalizer falls back to global-of-train stats.
    train_vals = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    val_vals = [100.0, 200.0]  # far from the train distribution
    df = pd.DataFrame(
        {
            "tug_improvement": train_vals + val_vals,
            "cohort": ["A"] * (len(train_vals) + len(val_vals)),
        }
    )
    train_idx = np.arange(len(train_vals))
    val_idx = np.arange(len(train_vals), len(train_vals) + len(val_vals))

    norm = fit_composite_normalizer(df.iloc[train_idx])
    y_val = apply_composite_normalizer(df.iloc[val_idx], norm).to_numpy()

    tr = pd.Series(train_vals)
    expected_train_norm = ((pd.Series(val_vals) - tr.mean()) / tr.std(ddof=1)).to_numpy()
    np.testing.assert_allclose(y_val, expected_train_norm)

    # And it must NOT match the leaky global-over-everything normalization.
    allv = df["tug_improvement"]
    leaky = ((pd.Series(val_vals) - allv.mean()) / allv.std(ddof=1)).to_numpy()
    assert not np.allclose(y_val, leaky)


def test_train_classifier_threads_patient_groups(monkeypatch):
    """train_classifier must pass the `sn` patient key as CV groups.

    Captures the `groups` argument handed to cross_validate_classifier and
    asserts it equals the modelling rows' `sn` in order. Tuning is shrunk so the
    final artifact search stays cheap.
    """
    from qtx.models import classifier as clf_mod
    from qtx.utils import config as cfg_mod
    from qtx.models.classifier import train_classifier

    models_cfg = cfg_mod.get_models_config()
    monkeypatch.setitem(
        models_cfg,
        "tuning",
        {"n_iter": 1, "cv": 2, "param_distributions": {"n_estimators": [5], "max_depth": [2]}},
    )

    captured: dict = {}

    def _spy_cv(make_search, X, y, groups, cv_config, *, seed=None):
        captured["groups"] = None if groups is None else np.asarray(groups).copy()
        return {
            "auc_roc_mean": 0.5, "auc_roc_std": 0.0, "auc_pr_mean": 0.5, "auc_pr_std": 0.0,
            "brier_mean": 0.25, "brier_std": 0.0, "f1_mean": 0.5, "f1_std": 0.0,
            "n_folds": cv_config.get("k", 5),
        }

    monkeypatch.setattr(clf_mod, "cross_validate_classifier", _spy_cv)

    df = _make_featured_df(n=80)
    df["sn"] = np.repeat(np.arange(40), 2).astype(str)  # 2 sessions per patient
    result = train_classifier(df, imputation_strategy="median")

    assert result
    expected = np.repeat(np.arange(40), 2).astype(str)[:60]  # 60 modelling rows
    assert captured["groups"] is not None
    np.testing.assert_array_equal(captured["groups"], expected)


def test_cross_validate_regression_recomputes_target_each_fold():
    """cross_validate_regression drives target_builder per outer fold.

    A target_builder that records its calls should be invoked once per fold with
    disjoint validation indices — proving the target is rebuilt per split rather
    than shared globally.
    """
    from qtx.models.evaluate import cross_validate_regression

    n = 50
    X = pd.DataFrame({"a": np.linspace(0, 1, n)})
    base_y = np.linspace(-2, 2, n)
    seen_val_idx: list = []

    def target_builder(train_idx, val_idx):
        seen_val_idx.append(tuple(val_idx))
        return base_y[train_idx], base_y[val_idx]

    log: list = []
    cross_validate_regression(
        _spy_regressor_factory(log), X, np.arange(n), {"k": 5}, seed=0,
        target_builder=target_builder,
    )
    assert len(seen_val_idx) == 5
    flat = [i for tup in seen_val_idx for i in tup]
    assert len(flat) == len(set(flat)) == n  # each row validated exactly once


# ---------------------------------------------------------------------------
# tuning_xgb config test
# ---------------------------------------------------------------------------

def test_config_has_tuning_xgb_block():
    cfg = get_models_config()
    assert "tuning_xgb" in cfg, "Expected tuning_xgb block in models.yaml"
    assert "colsample_bytree" in cfg["tuning_xgb"]["param_distributions"]
    assert cfg["tuning_xgb"]["n_iter"] == 30


# ---------------------------------------------------------------------------
# train_classifier XGB contract
# ---------------------------------------------------------------------------

def test_train_classifier_xgb_returns_best_params(featured_df):
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, estimator_type="xgb")
    assert result, "train_classifier(xgb) returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


def test_train_classifier_xgb_model_is_pipeline(featured_df):
    from sklearn.pipeline import Pipeline
    from qtx.models.classifier import train_classifier
    result = train_classifier(featured_df, estimator_type="xgb")
    assert isinstance(result["model"], Pipeline)


# ---------------------------------------------------------------------------
# train_regression XGB contract
# ---------------------------------------------------------------------------

def test_train_regression_xgb_returns_best_params(featured_df):
    from qtx.models.regression import train_regression
    result = train_regression(featured_df, estimator_type="xgb")
    assert result, "train_regression(xgb) returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]


# ---------------------------------------------------------------------------
# train_dropout XGB contract
# ---------------------------------------------------------------------------

def test_train_dropout_xgb_returns_best_params(featured_df):
    from qtx.models.dropout import train_dropout
    result = train_dropout(featured_df, estimator_type="xgb")
    assert result, "train_dropout(xgb) returned empty dict"
    assert "best_params" in result
    assert "n_estimators" in result["best_params"]
