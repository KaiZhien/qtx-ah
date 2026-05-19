# tests/test_dosage.py
"""Tests for src/qtx/dosage/ — prepare, train, evaluate, predict modules."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qtx.dosage.prepare import build_dosage_matrix


def _raw_supplement_df() -> pd.DataFrame:
    """Minimal synthetic supplement DataFrame matching cleaned_data.xlsx structure."""
    return pd.DataFrame({
        "S/N": [1, 2, 3, 4, 5, 6],
        "Age": [72.0, 68.0, 75.0, 55.0, 80.0, 65.0],
        "Gender": ["F", "M", "F", "M", "F", "M"],
        "Joined_with_pain": ["Y", "N", "Y", "Y", "N", "Y"],
        "frequency": ["once", "twice", "l + r 10", "once", "once", float("nan")],
        "knee_issue":           [1, 0, 0, 1, 0, 1],
        "leg_issue":            [0, 1, 0, 0, 1, 0],
        "back_spine_issue":     [0, 0, 1, 0, 0, 0],
        "balance_issue":        [0, 0, 0, 0, 1, 0],
        "upper_body_issue":     [0, 0, 0, 0, 0, 0],
        "foot_ankle_issue":     [0, 0, 0, 0, 0, 0],
        "neuro_issue":          [0, 0, 1, 0, 0, 0],
        "frailty_issue":        [0, 0, 0, 0, 1, 0],
        "metabolic_issue":      [0, 0, 0, 0, 0, 0],
        "injury_surgery_issue": [0, 1, 0, 0, 0, 0],
        "general_pain_issue":   [1, 0, 0, 1, 0, 0],
    })


def test_build_dosage_matrix_drops_nan_frequency():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    assert len(result) == 5  # row 6 (NaN frequency) is dropped


def test_build_dosage_matrix_label_values():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    assert set(result["frequency_label"].unique()).issubset({0, 1, 2})
    # once→0, twice→1, l+r10→2
    assert result[result["frequency_raw"] == "once"]["frequency_label"].iloc[0] == 0
    assert result[result["frequency_raw"] == "twice"]["frequency_label"].iloc[0] == 1
    assert result[result["frequency_raw"] == "l + r 10"]["frequency_label"].iloc[0] == 2


def test_build_dosage_matrix_encoded_columns():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    from qtx.utils.config import get_dosage_config
    cfg = get_dosage_config()
    for col in cfg["intake_features_encoded"]:
        assert col in result.columns, f"Missing encoded column: {col}"


def test_build_dosage_matrix_no_nans_in_features():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    from qtx.utils.config import get_dosage_config
    cfg = get_dosage_config()
    feature_cols = cfg["intake_features_encoded"]
    assert result[feature_cols].isna().sum().sum() == 0


def test_build_dosage_matrix_gender_encoding():
    df_raw = _raw_supplement_df()
    result = build_dosage_matrix(df_raw)
    # Gender "M" → gender_M = 1; "F" → gender_M = 0
    assert result[result["Gender_orig"] == "M"]["gender_M"].eq(1).all()
    assert result[result["Gender_orig"] == "F"]["gender_M"].eq(0).all()


from qtx.dosage.evaluate import evaluate_multiclass_cv, dosage_shap_importances


def _make_Xy(n: int = 90) -> tuple:
    """Synthetic balanced 3-class data for evaluation tests (30 per class)."""
    rng = np.random.default_rng(42)
    X = pd.DataFrame(
        rng.integers(0, 2, size=(n, 14)).astype(float),
        columns=[
            "age", "gender_M", "joined_with_pain_Y",
            "hl_knee_issue", "hl_leg_issue", "hl_back_spine_issue",
            "hl_balance_issue", "hl_upper_body_issue", "hl_foot_ankle_issue",
            "hl_neuro_issue", "hl_frailty_issue", "hl_metabolic_issue",
            "hl_injury_surgery_issue", "hl_general_pain_issue",
        ],
    )
    X["age"] = rng.integers(50, 90, size=n).astype(float)
    y = pd.Series(np.repeat([0, 1, 2], n // 3))
    sw = np.ones(n)
    return X, y, sw


def test_evaluate_multiclass_cv_keys():
    from sklearn.ensemble import GradientBoostingClassifier
    X, y, sw = _make_Xy()
    model = GradientBoostingClassifier(n_estimators=10, random_state=42)
    metrics = evaluate_multiclass_cv(model, X, y, sw, k=3)
    for key in ["macro_f1_mean", "macro_f1_std", "macro_auc_roc_mean", "macro_auc_roc_std",
                "per_class_f1", "n_folds"]:
        assert key in metrics, f"Missing key: {key}"


def test_evaluate_multiclass_cv_macro_f1_range():
    from sklearn.ensemble import GradientBoostingClassifier
    X, y, sw = _make_Xy()
    model = GradientBoostingClassifier(n_estimators=10, random_state=42)
    metrics = evaluate_multiclass_cv(model, X, y, sw, k=3)
    assert 0.0 <= metrics["macro_f1_mean"] <= 1.0
    assert 0.0 <= metrics["macro_auc_roc_mean"] <= 1.0


def test_dosage_shap_importances_shape():
    from sklearn.ensemble import GradientBoostingClassifier
    X, y, sw = _make_Xy()
    model = GradientBoostingClassifier(n_estimators=10, random_state=42)
    model.fit(X, y, sample_weight=sw)
    shap_df = dosage_shap_importances(model, X)
    assert list(shap_df.columns) == ["feature", "mean_abs_shap"]
    assert len(shap_df) == X.shape[1]
    assert shap_df["mean_abs_shap"].notna().all()


from qtx.dosage.train import train_dosage_model


def _make_dosage_df(n_once: int = 40, n_twice: int = 10, n_lr10: int = 20) -> pd.DataFrame:
    """Synthetic dosage matrix matching build_dosage_matrix() output structure."""
    rng = np.random.default_rng(0)
    feature_cols = [
        "age", "gender_M", "joined_with_pain_Y",
        "hl_knee_issue", "hl_leg_issue", "hl_back_spine_issue",
        "hl_balance_issue", "hl_upper_body_issue", "hl_foot_ankle_issue",
        "hl_neuro_issue", "hl_frailty_issue", "hl_metabolic_issue",
        "hl_injury_surgery_issue", "hl_general_pain_issue",
    ]
    n = n_once + n_twice + n_lr10
    X = pd.DataFrame(rng.integers(0, 2, size=(n, len(feature_cols))).astype(float), columns=feature_cols)
    X["age"] = rng.integers(50, 90, size=n).astype(float)
    labels = [0] * n_once + [1] * n_twice + [2] * n_lr10
    X["frequency_label"] = labels
    X["frequency_raw"] = ["once"] * n_once + ["twice"] * n_twice + ["l + r 10"] * n_lr10
    X["Gender_orig"] = "F"
    return X


def test_train_dosage_model_returns_required_keys():
    df = _make_dosage_df()
    result = train_dosage_model(df)
    for key in ["model", "cv_metrics", "shap_df", "feature_names", "label_names", "n"]:
        assert key in result, f"Missing key: {key}"


def test_train_dosage_model_n_matches_input():
    df = _make_dosage_df(40, 10, 20)
    result = train_dosage_model(df)
    assert result["n"] == 70


def test_train_dosage_model_predict_proba_sums_to_one():
    df = _make_dosage_df()
    result = train_dosage_model(df)
    model = result["model"]
    feature_names = result["feature_names"]
    X_test = df[feature_names].head(5).astype(float)
    proba = model.predict_proba(X_test)
    np.testing.assert_allclose(proba.sum(axis=1), 1.0, atol=1e-6)


def test_train_dosage_model_proba_n_classes():
    df = _make_dosage_df()
    result = train_dosage_model(df)
    model = result["model"]
    feature_names = result["feature_names"]
    X_test = df[feature_names].head(3).astype(float)
    proba = model.predict_proba(X_test)
    assert proba.shape[1] == 3
