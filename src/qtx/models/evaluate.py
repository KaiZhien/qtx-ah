"""Unified model evaluation and SHAP explanation utilities.

Provides cross_validate_regression(), cross_validate_classifier(), shap_importances(),
calibration_data(), sensitivity_card(), and stratified_performance() helpers
used by regression.py, classifier.py, and dropout.py.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    auc,
    brier_score_loss,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_recall_curve,
    r2_score,
    roc_auc_score,
)
from sklearn.experimental import enable_iterative_imputer  # noqa: F401
from sklearn.impute import IterativeImputer, KNNImputer, SimpleImputer
from sklearn.model_selection import GroupKFold, StratifiedGroupKFold

from qtx.utils.config import get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def _resolve_seed(seed: int | None) -> int:
    """Return *seed* if given, else config/settings.yaml random_seed (fallback 42)."""
    if seed is not None:
        return int(seed)
    return int(get_settings().get("random_seed", 42))


def make_group_kfold(n_splits: int, seed: int | None = None) -> GroupKFold:
    """Patient-grouped K-fold splitter (regression / any continuous target)."""
    return GroupKFold(n_splits=n_splits, shuffle=True, random_state=_resolve_seed(seed))


def make_stratified_group_kfold(
    n_splits: int, seed: int | None = None
) -> StratifiedGroupKFold:
    """Patient-grouped, label-stratified K-fold splitter (classification)."""
    return StratifiedGroupKFold(
        n_splits=n_splits, shuffle=True, random_state=_resolve_seed(seed)
    )


def _resolve_groups(groups, n: int):
    """Return a 1-D group array of length *n*.

    If *groups* is None every row becomes its own group, so a grouped splitter
    degrades gracefully to a (deterministic) row-level split. This keeps the
    grouped code path exercised even on one-row-per-patient data.
    """
    if groups is None:
        return np.arange(n)
    return np.asarray(groups)


def _build_sklearn_imputer(strategy: str, seed: int):
    """Return an unfitted sklearn imputer for use inside a Pipeline.

    For complete_case, returns SimpleImputer(median) — the caller is expected
    to have already dropped NaN rows before building X.
    """
    from sklearn.ensemble import RandomForestRegressor

    if strategy == "iterative":
        return IterativeImputer(
            estimator=RandomForestRegressor(n_estimators=50, random_state=seed, n_jobs=-1),
            max_iter=10,
            random_state=seed,
            skip_complete=True,
        )
    if strategy == "knn5":
        return KNNImputer(n_neighbors=5)
    return SimpleImputer(strategy="median")


# ---------------------------------------------------------------------------
# CV helpers
# ---------------------------------------------------------------------------


def cross_validate_regression(
    make_search,
    X: pd.DataFrame,
    groups=None,
    cv_config: dict | None = None,
    *,
    seed: int | None = None,
    y: pd.Series | None = None,
    target_builder=None,
) -> dict:
    """Nested, patient-grouped CV for regression — honest generalisation metrics.

    An OUTER GroupKFold loop holds out whole patients. Inside each outer-train
    split ``make_search()`` returns a *fresh* search object whose ``.fit`` runs
    an inner (grouped) hyperparameter search; metrics are computed on the
    held-out outer fold only. No hyperparameter, imputation statistic, or
    target-normalisation constant is ever fit on validation-fold rows.

    Parameters
    ----------
    make_search:
        Zero-arg callable returning an unfitted estimator/search. Called once
        per outer fold so hyperparameters are re-selected on outer-train only.
    X:
        Feature matrix (row order aligned with *groups*, *y* and *target_builder*).
    groups:
        Patient identifiers; None means one group per row.
    y:
        Fixed target. Mutually exclusive with *target_builder*.
    target_builder:
        Callable ``(train_idx, val_idx) -> (y_train, y_val)`` that recomputes the
        target per fold with normalisation fit on outer-train rows only
        (leak-free target normalisation). Mutually exclusive with *y*.

    Returns dict with rmse/mae/r2 mean+std and n_folds.
    """
    cv_config = cv_config or {}
    if (y is None) == (target_builder is None):
        raise ValueError("Provide exactly one of y or target_builder")

    k = cv_config.get("k", 5)
    seed = _resolve_seed(seed)
    X_arr = np.asarray(X)
    groups_arr = _resolve_groups(groups, len(X_arr))
    splitter = make_group_kfold(k, seed)

    rmse_scores, mae_scores, r2_scores = [], [], []
    # Splitter only uses the shape of y here; the real target comes per-fold.
    y_split = np.asarray(y) if y is not None else np.zeros(len(X_arr))

    for train_idx, val_idx in splitter.split(X_arr, y_split, groups=groups_arr):
        if target_builder is not None:
            y_train, y_val = target_builder(train_idx, val_idx)
        else:
            y_arr = np.asarray(y)
            y_train, y_val = y_arr[train_idx], y_arr[val_idx]

        search = make_search()
        search.fit(X_arr[train_idx], np.asarray(y_train), groups=groups_arr[train_idx])
        preds = search.predict(X_arr[val_idx])

        rmse_scores.append(np.sqrt(mean_squared_error(y_val, preds)))
        mae_scores.append(mean_absolute_error(y_val, preds))
        r2_scores.append(r2_score(y_val, preds))

    return {
        "rmse_mean": float(np.mean(rmse_scores)),
        "rmse_std": float(np.std(rmse_scores)),
        "mae_mean": float(np.mean(mae_scores)),
        "mae_std": float(np.std(mae_scores)),
        "r2_mean": float(np.mean(r2_scores)),
        "r2_std": float(np.std(r2_scores)),
        "n_folds": k,
    }


def cross_validate_classifier(
    make_search,
    X: pd.DataFrame,
    y: pd.Series,
    groups=None,
    cv_config: dict | None = None,
    *,
    seed: int | None = None,
) -> dict:
    """Nested, patient-grouped, label-stratified CV for classification.

    OUTER StratifiedGroupKFold holds out whole patients while keeping class
    balance; ``make_search()`` runs an inner grouped hyperparameter search on
    each outer-train split; metrics are computed on the held-out fold only.

    Returns dict with auc_roc/auc_pr/brier/f1 mean+std and n_folds.
    """
    cv_config = cv_config or {}
    k = cv_config.get("k", 5)
    seed = _resolve_seed(seed)
    X_arr = np.asarray(X)
    y_arr = np.asarray(y)
    groups_arr = _resolve_groups(groups, len(X_arr))
    splitter = make_stratified_group_kfold(k, seed)

    auc_roc_scores, auc_pr_scores, brier_scores, f1_scores = [], [], [], []

    for train_idx, val_idx in splitter.split(X_arr, y_arr, groups=groups_arr):
        y_train, y_val = y_arr[train_idx], y_arr[val_idx]

        search = make_search()
        search.fit(X_arr[train_idx], y_train, groups=groups_arr[train_idx])
        proba = search.predict_proba(X_arr[val_idx])[:, 1]

        auc_roc_scores.append(roc_auc_score(y_val, proba))
        precision, recall, _ = precision_recall_curve(y_val, proba)
        auc_pr_scores.append(auc(recall, precision))
        brier_scores.append(brier_score_loss(y_val, proba))
        f1_scores.append(f1_score(y_val, (proba >= 0.5).astype(int), average="weighted"))

    return {
        "auc_roc_mean": float(np.mean(auc_roc_scores)),
        "auc_roc_std": float(np.std(auc_roc_scores)),
        "auc_pr_mean": float(np.mean(auc_pr_scores)),
        "auc_pr_std": float(np.std(auc_pr_scores)),
        "brier_mean": float(np.mean(brier_scores)),
        "brier_std": float(np.std(brier_scores)),
        "f1_mean": float(np.mean(f1_scores)),
        "f1_std": float(np.std(f1_scores)),
        "n_folds": k,
    }


# ---------------------------------------------------------------------------
# SHAP
# ---------------------------------------------------------------------------


def shap_importances(model, X: pd.DataFrame) -> pd.DataFrame:
    """Compute SHAP feature importances.

    Returns DataFrame with columns: feature, mean_abs_shap.
    """
    import shap

    X_sample = X
    if len(X) > 200:
        X_sample = X.sample(200, random_state=42)

    try:
        explainer = shap.TreeExplainer(model)
        shap_values = explainer.shap_values(X_sample)
    except Exception:
        log.warning("TreeExplainer failed; falling back to shap.Explainer")
        explainer = shap.Explainer(model, X_sample)
        sv = explainer(X_sample)
        shap_values = sv.values

    # For multi-output (classifier with 2 classes), shap_values may be a list
    if isinstance(shap_values, list):
        # Use class-1 shap values
        shap_values = shap_values[1]

    mean_abs = np.abs(shap_values).mean(axis=0)
    df_shap = pd.DataFrame({"feature": X_sample.columns.tolist(), "mean_abs_shap": mean_abs})
    return df_shap.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------


def calibration_data(model, X: pd.DataFrame, y: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """Return (fraction_of_positives, mean_predicted_value) for calibration plot."""
    proba = model.predict_proba(np.array(X))[:, 1]
    fraction_of_positives, mean_predicted_value = calibration_curve(
        y, proba, n_bins=10, strategy="quantile"
    )
    return fraction_of_positives, mean_predicted_value


# ---------------------------------------------------------------------------
# Sensitivity card
# ---------------------------------------------------------------------------


def sensitivity_card(results_by_strategy: dict[str, dict]) -> pd.DataFrame:
    """Given {strategy_name: metrics_dict}, return a DataFrame comparing metrics."""
    rows = []
    for strategy, metrics in results_by_strategy.items():
        row = {"strategy": strategy}
        row.update(metrics)
        rows.append(row)
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Stratified performance
# ---------------------------------------------------------------------------


def stratified_performance(
    model, X: pd.DataFrame, y: pd.Series, df_full: pd.DataFrame, group_col: str
) -> pd.DataFrame:
    """Compute AUC-ROC (or RMSE for regression) stratified by group_col values.

    Returns DataFrame: group_value, n, metric_value.
    """
    rows = []
    groups = df_full[group_col].dropna().unique()

    # Detect task type
    is_classifier = hasattr(model, "predict_proba")

    for grp in sorted(groups):
        mask = df_full[group_col] == grp
        X_grp = X[mask]
        y_grp = y[mask]

        if len(y_grp) < 5:
            continue

        if is_classifier:
            try:
                proba = model.predict_proba(np.array(X_grp))[:, 1]
                if len(y_grp.unique()) < 2:
                    metric_val = float("nan")
                else:
                    metric_val = roc_auc_score(y_grp, proba)
                metric_name = "auc_roc"
            except Exception as e:
                log.warning("stratified_performance AUC-ROC failed for group %s: %s", grp, e)
                metric_val = float("nan")
                metric_name = "auc_roc"
        else:
            preds = model.predict(np.array(X_grp))
            metric_val = np.sqrt(mean_squared_error(y_grp, preds))
            metric_name = "rmse"

        rows.append({"group_value": grp, "n": int(len(y_grp)), metric_name: metric_val})

    return pd.DataFrame(rows)
