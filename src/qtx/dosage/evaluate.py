"""Evaluation utilities for the dosage frequency recommender.

Public API:
  evaluate_multiclass_cv(model, X, y, sample_weight, k) -> dict
  dosage_shap_importances(model, X)                      -> pd.DataFrame
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold

from qtx.utils.logging import get_logger

log = get_logger(__name__)


def evaluate_multiclass_cv(
    model,
    X: pd.DataFrame,
    y: pd.Series,
    sample_weight: np.ndarray,
    k: int = 5,
) -> dict:
    """Run stratified k-fold CV for a 3-class classifier.

    Returns dict with macro_f1_mean, macro_f1_std, macro_auc_roc_mean,
    macro_auc_roc_std, per_class_f1 (list of per-class mean F1), n_folds.
    """
    skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
    X_arr = np.array(X)
    y_arr = np.array(y)

    f1_scores, auc_scores = [], []
    per_class_f1_folds: list[list[float]] = []

    for train_idx, val_idx in skf.split(X_arr, y_arr):
        X_train, X_val = X_arr[train_idx], X_arr[val_idx]
        y_train, y_val = y_arr[train_idx], y_arr[val_idx]
        sw_train = sample_weight[train_idx]

        m = clone(model)
        m.fit(X_train, y_train, sample_weight=sw_train)

        y_pred = m.predict(X_val)
        f1 = f1_score(y_val, y_pred, average="macro", zero_division=0)
        f1_scores.append(f1)

        per_class = f1_score(y_val, y_pred, average=None, zero_division=0)
        per_class_f1_folds.append(per_class.tolist())

        try:
            proba = m.predict_proba(X_val)
            n_classes = proba.shape[1]
            if len(np.unique(y_val)) >= 2:
                labels = list(range(n_classes))
                auc = roc_auc_score(
                    y_val, proba, multi_class="ovr", average="macro", labels=labels
                )
                auc_scores.append(auc)
        except Exception as e:
            log.warning("AUC-ROC computation failed in fold: %s", e)

    per_class_means = np.mean(per_class_f1_folds, axis=0).tolist() if per_class_f1_folds else []

    return {
        "macro_f1_mean": float(np.mean(f1_scores)),
        "macro_f1_std": float(np.std(f1_scores)),
        "macro_auc_roc_mean": float(np.mean(auc_scores)) if auc_scores else float("nan"),
        "macro_auc_roc_std": float(np.std(auc_scores)) if auc_scores else float("nan"),
        "per_class_f1": per_class_means,
        "n_folds": k,
    }


def dosage_shap_importances(model, X: pd.DataFrame) -> pd.DataFrame:
    """Compute SHAP feature importances for a multi-class GBM.

    For 3-class GBM, TreeExplainer returns a list of 3 SHAP arrays (one per
    class). We take the mean absolute value across all classes so importance
    is class-agnostic and easy to display.

    Returns DataFrame with columns: feature, mean_abs_shap (sorted descending).
    """
    import shap

    X_sample = X if len(X) <= 200 else X.sample(200, random_state=42)

    shap_values = None
    try:
        explainer = shap.TreeExplainer(model)
        shap_values = explainer.shap_values(X_sample)
    except Exception as e:
        log.warning("TreeExplainer failed (%s); falling back to shap.Explainer with predict_proba", e)

    if shap_values is None:
        try:
            masker = shap.maskers.Independent(np.array(X_sample), max_samples=min(100, len(X_sample)))
            explainer = shap.Explainer(model.predict_proba, masker)
            sv = explainer(X_sample)
            shap_values = sv.values
        except Exception as e2:
            log.warning("shap.Explainer with predict_proba failed (%s); using feature importances fallback", e2)
            importances = model.feature_importances_
            df_shap = pd.DataFrame({
                "feature": X_sample.columns.tolist(),
                "mean_abs_shap": importances,
            })
            return df_shap.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)

    if isinstance(shap_values, list):
        stacked = np.stack([np.abs(sv) for sv in shap_values], axis=0)
        mean_abs = stacked.mean(axis=(0, 1))
    elif shap_values.ndim == 3:
        # shape (n_samples, n_features, n_classes) from shap.Explainer
        mean_abs = np.abs(shap_values).mean(axis=(0, 2))
    else:
        mean_abs = np.abs(shap_values).mean(axis=0)

    df_shap = pd.DataFrame({
        "feature": X_sample.columns.tolist(),
        "mean_abs_shap": mean_abs,
    })
    return df_shap.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)
