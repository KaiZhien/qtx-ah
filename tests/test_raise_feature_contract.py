"""Augmented model must share feature_names_in_ with baseline serving contract."""
import pytest
import joblib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "models"


def test_augmented_model_feature_names_match_baseline():
    """regression_xgb_raise_augmented.joblib and regression_xgb.joblib must have identical feature_names_in_."""
    baseline_path = MODELS_DIR / "regression_xgb.joblib"
    augmented_path = MODELS_DIR / "regression_xgb_raise_augmented.joblib"

    if not augmented_path.exists():
        pytest.skip("regression_xgb_raise_augmented.joblib not yet trained")
    if not baseline_path.exists():
        pytest.skip("regression_xgb.joblib not present")

    baseline = joblib.load(baseline_path)  # safe: local models/ written by our own scripts
    augmented = joblib.load(augmented_path)  # safe: same

    baseline_feats = set(baseline.feature_names_in_)
    augmented_feats = set(augmented.feature_names_in_)

    only_in_baseline = baseline_feats - augmented_feats
    only_in_augmented = augmented_feats - baseline_feats

    assert not only_in_baseline, f"Features in baseline but not augmented: {only_in_baseline}"
    assert not only_in_augmented, f"Features in augmented but not baseline: {only_in_augmented}"
