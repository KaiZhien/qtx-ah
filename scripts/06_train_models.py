"""Script 06 — Train all predictive models and run sensitivity analyses.

Loads the feature matrix from data/processed/featured.parquet, trains
regression, classifier, and dropout models per config/models.yaml,
saves models to models/, and writes an HTML report to reports/modelling.html.

Usage:
    PYTHONPATH=src python scripts/06_train_models.py
"""

from __future__ import annotations

import base64
import io
import sys
from datetime import datetime
from pathlib import Path

import joblib
import matplotlib
matplotlib.use("Agg")  # non-interactive backend
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from qtx.models.classifier import run_classifier_sensitivity, train_classifier
from qtx.models.dropout import run_dropout_sensitivity, train_dropout
from qtx.models.evaluate import stratified_performance
from qtx.models.regression import run_regression_sensitivity, train_regression
from qtx.utils.config import get_path, get_project_root
from qtx.utils.logging import get_logger

log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def fig_to_base64(fig: plt.Figure) -> str:
    """Encode matplotlib figure to base64 PNG string."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=100)
    buf.seek(0)
    encoded = base64.b64encode(buf.read()).decode("utf-8")
    plt.close(fig)
    return encoded


def df_to_html_table(df: pd.DataFrame, float_fmt: str = "{:.4f}") -> str:
    """Render DataFrame as an HTML table with basic styling."""
    rows_html = []
    rows_html.append("<thead><tr>")
    for col in df.columns:
        rows_html.append(f"<th>{col}</th>")
    rows_html.append("</tr></thead><tbody>")
    for _, row in df.iterrows():
        rows_html.append("<tr>")
        for val in row:
            if isinstance(val, float):
                rows_html.append(f"<td>{float_fmt.format(val)}</td>")
            else:
                rows_html.append(f"<td>{val}</td>")
        rows_html.append("</tr>")
    rows_html.append("</tbody>")
    return f'<table class="metrics-table">{"".join(rows_html)}</table>'


def shap_bar_plot(shap_df: pd.DataFrame, title: str, top_n: int = 10) -> str:
    """Create horizontal bar chart of top-N SHAP importances and return base64 PNG."""
    top = shap_df.head(top_n).copy()
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.barh(top["feature"][::-1], top["mean_abs_shap"][::-1], color="#4C72B0")
    ax.set_xlabel("Mean |SHAP value|")
    ax.set_title(title)
    ax.tick_params(axis="y", labelsize=9)
    plt.tight_layout()
    return fig_to_base64(fig)


def calibration_plot(cal_data: tuple, title: str) -> str:
    """Create calibration plot and return base64 PNG."""
    fraction_of_positives, mean_predicted_value = cal_data
    fig, ax = plt.subplots(figsize=(5, 4))
    if len(fraction_of_positives) > 0:
        ax.plot(mean_predicted_value, fraction_of_positives, "s-", label="Model")
    ax.plot([0, 1], [0, 1], "k--", label="Perfect calibration")
    ax.set_xlabel("Mean predicted probability")
    ax.set_ylabel("Fraction of positives")
    ax.set_title(title)
    ax.legend(fontsize=8)
    plt.tight_layout()
    return fig_to_base64(fig)


# ---------------------------------------------------------------------------
# HTML report builder
# ---------------------------------------------------------------------------

_HTML_STYLE = """
<style>
  body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
  h2 { color: #34495e; margin-top: 30px; }
  h3 { color: #555; }
  .metrics-table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  .metrics-table th, .metrics-table td {
    border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 13px;
  }
  .metrics-table th { background-color: #3498db; color: white; }
  .metrics-table tr:nth-child(even) { background-color: #f9f9f9; }
  .section { background: #fff; border: 1px solid #e0e0e0; border-radius: 6px;
             padding: 20px; margin-bottom: 24px; }
  .metric-highlight { font-size: 16px; font-weight: bold; color: #2980b9; }
  .fig-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .fig-box { flex: 1; min-width: 300px; }
  img { max-width: 100%; border: 1px solid #eee; border-radius: 4px; }
</style>
"""


def _render_model_subsection(result: dict, label: str, task: str) -> list[str]:
    """Render one estimator result (GBM or XGBoost) as a list of HTML strings."""
    parts = []
    parts.append(f"<h3>{label}</h3>")
    cv = result.get("cv_metrics", {})
    if task == "regression":
        parts.append(
            f'<p><span class="metric-highlight">N = {cv.get("n", "?")} | '
            f'RMSE = {cv.get("rmse_mean", float("nan")):.4f} ± {cv.get("rmse_std", float("nan")):.4f} | '
            f'MAE = {cv.get("mae_mean", float("nan")):.4f} | '
            f'R² = {cv.get("r2_mean", float("nan")):.4f}</span></p>'
        )
    else:
        parts.append(
            f'<p><span class="metric-highlight">N = {cv.get("n", "?")} | '
            f'AUC-ROC = {cv.get("auc_roc_mean", float("nan")):.4f} ± {cv.get("auc_roc_std", float("nan")):.4f} | '
            f'AUC-PR = {cv.get("auc_pr_mean", float("nan")):.4f} | '
            f'Brier = {cv.get("brier_mean", float("nan")):.4f} | '
            f'F1 = {cv.get("f1_mean", float("nan")):.4f}</span></p>'
        )
    bp = result.get("best_params", {})
    if bp:
        params_str = " | ".join(f"{k}={v}" for k, v in sorted(bp.items()))
        parts.append(f"<p><strong>Best hyperparameters:</strong> {params_str}</p>")
    shap_df = result.get("shap_df", pd.DataFrame())
    if not shap_df.empty:
        img_b64 = shap_bar_plot(shap_df, f"Top-10 SHAP Features ({label})")
        parts.append(f'<div class="fig-box"><img src="data:image/png;base64,{img_b64}"></div>')
        parts.append("<h4>Top-10 SHAP Features</h4>")
        parts.append(df_to_html_table(shap_df.head(10)))
    return parts


def build_report(
    reg_result_xgb: dict,
    clf_result_xgb: dict,
    drop_result_xgb: dict,
    reg_sensitivity: pd.DataFrame,
    clf_sensitivity: pd.DataFrame,
    drop_sensitivity: pd.DataFrame,
    strat_perf: pd.DataFrame,
) -> str:
    """Build full HTML report string.

    Only the served XGBoost family is trained/reported. The imputation-strategy
    sensitivity tables still use the GBM+imputer pipeline (train_* default),
    since XGBoost handles missing values natively and has no imputer step.
    """
    sections = []
    sections.append(f"<html><head><title>QTX Model Report</title>{_HTML_STYLE}</head><body>")
    sections.append("<h1>QuantumTX — Model Training Report</h1>")
    sections.append(
        f"<p>Generated on <strong>{datetime.now().strftime('%Y-%m-%d')}</strong></p>"
    )
    sections.append(
        "<p>Reported metrics are from nested, patient-grouped cross-validation "
        "(hyperparameters selected inside each outer fold; regression target "
        "normalisation refit per fold).</p>"
    )

    # --- Regression ---
    sections.append('<div class="section">')
    sections.append("<h2>1. Composite Improvement Regression</h2>")
    sections.extend(_render_model_subsection(reg_result_xgb, "XGBoost", "regression"))
    sections.append("<h3>Sensitivity Analysis (Imputation Strategies, GBM pipeline)</h3>")
    if not reg_sensitivity.empty:
        sections.append(df_to_html_table(reg_sensitivity))
    sections.append("</div>")

    # --- Classifier ---
    sections.append('<div class="section">')
    sections.append("<h2>2. Overall Responder Classifier</h2>")
    sections.extend(_render_model_subsection(clf_result_xgb, "XGBoost", "classifier"))
    cal_data_xgb = clf_result_xgb.get("calibration", (np.array([]), np.array([])))
    if len(cal_data_xgb[0]) > 0:
        cal_b64 = calibration_plot(cal_data_xgb, "Calibration Curve (XGBoost)")
        sections.append(f'<div class="fig-box"><img src="data:image/png;base64,{cal_b64}"></div>')
    sections.append("<h3>Sensitivity Analysis (Imputation Strategies, GBM pipeline)</h3>")
    if not clf_sensitivity.empty:
        sections.append(df_to_html_table(clf_sensitivity))
    if not strat_perf.empty:
        sections.append("<h3>Stratified Performance by Cohort</h3>")
        sections.append(df_to_html_table(strat_perf))
    sections.append("</div>")

    # --- Dropout ---
    sections.append('<div class="section">')
    sections.append("<h2>3. Dropout Prediction</h2>")
    sections.extend(_render_model_subsection(drop_result_xgb, "XGBoost", "classifier"))
    sections.append("<h3>Sensitivity Analysis (Imputation Strategies, GBM pipeline)</h3>")
    if not drop_sensitivity.empty:
        sections.append(df_to_html_table(drop_sensitivity))
    sections.append("</div>")

    sections.append("</body></html>")
    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    root = get_project_root()

    # Load featured.parquet
    parquet_path = root / "data" / "processed" / "featured.parquet"
    log.info("Loading %s", parquet_path)
    df = pd.read_parquet(parquet_path)
    log.info("Loaded %d rows × %d columns", *df.shape)

    models_dir = root / "models"
    reports_dir = root / "reports"
    models_dir.mkdir(exist_ok=True)
    reports_dir.mkdir(exist_ok=True)

    # -------------------------------------------------------------------------
    # Train served models (XGBoost only — GBM artefacts were never served and
    # weighed 130-155 MB each; the imputation sensitivity tables below still
    # exercise the GBM+imputer pipeline).
    # -------------------------------------------------------------------------
    log.info("=== Training Regression XGBoost ===")
    reg_result_xgb = train_regression(df, imputation_strategy="iterative", estimator_type="xgb")

    log.info("=== Training Classifier XGBoost ===")
    clf_result_xgb = train_classifier(df, imputation_strategy="iterative", estimator_type="xgb")

    log.info("=== Training Dropout XGBoost ===")
    drop_result_xgb = train_dropout(df, imputation_strategy="iterative", estimator_type="xgb")

    # -------------------------------------------------------------------------
    # Save model artefacts
    # -------------------------------------------------------------------------
    for label, result, fname in [
        ("regression_xgb", reg_result_xgb, "regression_xgb.joblib"),
        ("classifier_xgb", clf_result_xgb, "classifier_xgb.joblib"),
        ("dropout_xgb", drop_result_xgb, "dropout_xgb.joblib"),
    ]:
        if result.get("model"):
            joblib.dump(result["model"], models_dir / fname)
            log.info("Saved models/%s", fname)

    # -------------------------------------------------------------------------
    # Sensitivity analyses
    # -------------------------------------------------------------------------
    log.info("=== Running Regression Sensitivity ===")
    reg_sensitivity = run_regression_sensitivity(df)

    log.info("=== Running Classifier Sensitivity ===")
    clf_sensitivity = run_classifier_sensitivity(df)

    log.info("=== Running Dropout Sensitivity ===")
    drop_sensitivity = run_dropout_sensitivity(df)

    # -------------------------------------------------------------------------
    # Stratified performance by cohort (classifier)
    # -------------------------------------------------------------------------
    strat_perf = pd.DataFrame()
    if clf_result_xgb.get("model") and "X" in clf_result_xgb and "y" in clf_result_xgb:
        try:
            X_clf = clf_result_xgb["X"]
            y_clf = clf_result_xgb["y"]
            df_full_aligned = df.loc[X_clf.index] if X_clf.index.isin(df.index).all() else df.iloc[:len(X_clf)]
            strat_perf = stratified_performance(clf_result_xgb["model"], X_clf, y_clf, df_full_aligned, "cohort")
            log.info("Stratified performance:\n%s", strat_perf.to_string())
        except Exception as e:
            log.warning("Stratified performance failed: %s", e)

    # -------------------------------------------------------------------------
    # Build HTML report
    # -------------------------------------------------------------------------
    log.info("Building HTML report...")
    html_content = build_report(
        reg_result_xgb,
        clf_result_xgb,
        drop_result_xgb,
        reg_sensitivity,
        clf_sensitivity,
        drop_sensitivity,
        strat_perf,
    )

    report_path = reports_dir / "modelling.html"
    report_path.write_text(html_content, encoding="utf-8")
    log.info("Saved reports/modelling.html (%d bytes)", len(html_content))

    # -------------------------------------------------------------------------
    # Print summary
    # -------------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("QTX MODEL TRAINING SUMMARY")
    print("=" * 60)

    for label, result, cv_keys in [
        ("[REGRESSION XGB]  composite_improvement", reg_result_xgb,
         [("RMSE", "rmse_mean", "rmse_std"), ("MAE", "mae_mean", "mae_std"), ("R²", "r2_mean", "r2_std")]),
        ("[CLASSIFIER XGB]  overall_responder", clf_result_xgb,
         [("AUC-ROC", "auc_roc_mean", "auc_roc_std"), ("AUC-PR", "auc_pr_mean", "auc_pr_std"), ("Brier", "brier_mean", "brier_std"), ("F1", "f1_mean", "f1_std")]),
        ("[DROPOUT XGB]     is_dropout", drop_result_xgb,
         [("AUC-ROC", "auc_roc_mean", "auc_roc_std"), ("AUC-PR", "auc_pr_mean", "auc_pr_std"), ("F1", "f1_mean", "f1_std")]),
    ]:
        cv = result.get("cv_metrics", {})
        print(f"\n{label}")
        print(f"  N = {cv.get('n', '?')}")
        for metric_label, mean_key, std_key in cv_keys:
            print(f"  {metric_label:<8} = {cv.get(mean_key, float('nan')):.4f} ± {cv.get(std_key, float('nan')):.4f}")
        if result.get("best_params"):
            print(f"  Best params: {result['best_params']}")

    print(f"\n[OUTPUT] models/regression_xgb.joblib")
    print(f"[OUTPUT] models/classifier_xgb.joblib")
    print(f"[OUTPUT] models/dropout_xgb.joblib")
    print(f"[OUTPUT] reports/modelling.html")
    print("=" * 60)


if __name__ == "__main__":
    main()
