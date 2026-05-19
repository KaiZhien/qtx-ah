"""Train the dosage frequency recommender.

Public API:
  train_dosage_model(df) -> dict
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.utils.class_weight import compute_class_weight

from qtx.dosage.evaluate import dosage_shap_importances, evaluate_multiclass_cv
from qtx.utils.config import get_dosage_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def train_dosage_model(df: pd.DataFrame) -> dict:
    """Fit a calibrated 3-class frequency recommender on the dosage feature matrix.

    Args:
        df: Output of build_dosage_matrix() — must contain intake_features_encoded
            columns and a 'frequency_label' column.

    Returns dict with:
        model         — CalibratedClassifierCV fitted on full data (save this)
        cv_metrics    — dict from evaluate_multiclass_cv (macro F1, AUC-ROC, per-class F1)
        shap_df       — pd.DataFrame of feature importances from a bare fitted GBM
        feature_names — list[str] of encoded feature column names
        label_names   — list[str] indexed by integer label
        n             — number of training rows
    """
    cfg = get_dosage_config()
    feature_names: list[str] = cfg["intake_features_encoded"]
    label_names: list[str] = cfg["label_names"]
    model_cfg = cfg["model"]
    cal_cfg = cfg["calibration"]
    k = cfg["cv"]["k"]

    X = df[feature_names].astype(float)
    y = df["frequency_label"].astype(int)
    n = len(X)

    log.info("train_dosage_model: n=%d, label dist=%s", n, y.value_counts().to_dict())

    # Balanced sample weights to counteract class imbalance
    classes = np.unique(y)
    weights = compute_class_weight("balanced", classes=classes, y=np.array(y))
    sample_weight = np.array([weights[yi] for yi in y])

    # Base estimator
    base = GradientBoostingClassifier(
        n_estimators=model_cfg["n_estimators"],
        learning_rate=model_cfg["learning_rate"],
        max_depth=model_cfg["max_depth"],
        random_state=model_cfg["random_state"],
    )

    # CV evaluation metrics (on un-calibrated GBM clone)
    log.info("train_dosage_model: running %d-fold CV for metrics", k)
    cv_metrics = evaluate_multiclass_cv(base, X, y, sample_weight, k=k)
    cv_metrics["n"] = n
    log.info(
        "train_dosage_model: macro_F1=%.3f ± %.3f, macro_AUC=%.3f",
        cv_metrics["macro_f1_mean"],
        cv_metrics["macro_f1_std"],
        cv_metrics.get("macro_auc_roc_mean", float("nan")),
    )

    # Final calibrated model fitted on full data
    cal_model = CalibratedClassifierCV(
        estimator=clone(base),
        method=cal_cfg["method"],
        cv=cal_cfg["cv"],
    )
    cal_model.fit(X, y, sample_weight=sample_weight)
    log.info("train_dosage_model: calibrated model fitted")

    # SHAP importances from a bare fitted GBM (TreeExplainer doesn't work on CalibratedCV)
    bare = clone(base)
    bare.fit(X, y, sample_weight=sample_weight)
    shap_df = dosage_shap_importances(bare, X)

    return {
        "model": cal_model,
        "cv_metrics": cv_metrics,
        "shap_df": shap_df,
        "feature_names": feature_names,
        "label_names": label_names,
        "n": n,
    }
