"""Script 08 — Train the dosage frequency recommender and write report.

Loads cleaned_data.xlsx supplement, builds the intake feature matrix,
trains a calibrated 3-class GBM, saves the model artefact, and writes
an HTML report to reports/dosage_model.html.

Usage:
    PYTHONPATH=src python scripts/08_train_dosage_model.py
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from qtx.dosage.prepare import load_dosage_data
from qtx.dosage.train import train_dosage_model
from qtx.utils.config import get_dosage_config, get_path, get_project_root
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def fig_to_base64(fig: plt.Figure) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=100)
    buf.seek(0)
    encoded = base64.b64encode(buf.read()).decode("utf-8")
    plt.close(fig)
    return encoded


def shap_bar_plot(shap_df: pd.DataFrame, top_n: int = 10) -> str:
    top = shap_df.head(top_n).copy()
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.barh(top["feature"][::-1], top["mean_abs_shap"][::-1], color="#4C72B0")
    ax.set_xlabel("Mean |SHAP value| (averaged across classes)")
    ax.set_title("Top Feature Importances — Dosage Frequency Recommender")
    ax.tick_params(axis="y", labelsize=9)
    plt.tight_layout()
    return fig_to_base64(fig)


def build_report(result: dict, label_dist: dict) -> str:
    cfg = get_dosage_config()
    label_names = cfg["label_names"]
    cv = result["cv_metrics"]
    per_class = cv.get("per_class_f1", [])

    style = """<style>
      body{font-family:Arial,sans-serif;max-width:1000px;margin:0 auto;padding:20px}
      h1{color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px}
      h2{color:#34495e;margin-top:30px}
      .section{background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:24px}
      table{border-collapse:collapse;width:100%;margin:10px 0}
      th,td{border:1px solid #ddd;padding:8px 12px;text-align:left;font-size:13px}
      th{background:#3498db;color:white}
      tr:nth-child(even){background:#f9f9f9}
      .metric{font-size:16px;font-weight:bold;color:#2980b9}
      img{max-width:100%;border:1px solid #eee;border-radius:4px}
      .note{background:#fff9e6;border-left:4px solid #f0c040;padding:10px;margin:10px 0;font-size:13px}
    </style>"""

    lines = [f"<html><head><title>QTX Dosage Model</title>{style}</head><body>"]
    lines.append("<h1>QuantumTX — Dosage Frequency Recommender Report</h1>")
    lines.append('<div class="note"><strong>Confounder note:</strong> Physical activity outside treatment is an unmeasured confounder. See <code>config/dosage.yaml</code> future_features for planned intake fields that will improve this model.</div>')

    lines.append('<div class="section"><h2>Training Data</h2>')
    lines.append(f"<p>Total labelled patients: <strong>{result['n']}</strong></p>")
    lines.append("<table><thead><tr><th>Frequency</th><th>N</th></tr></thead><tbody>")
    for lbl, count in label_dist.items():
        lines.append(f"<tr><td>{lbl}</td><td>{count}</td></tr>")
    lines.append("</tbody></table></div>")

    lines.append('<div class="section"><h2>Cross-Validation Metrics (5-fold, un-calibrated GBM)</h2>')
    lines.append(f'<p class="metric">Macro F1 = {cv["macro_f1_mean"]:.3f} ± {cv["macro_f1_std"]:.3f}</p>')
    auc = cv.get("macro_auc_roc_mean", float("nan"))
    lines.append(f'<p class="metric">Macro AUC-ROC (OVR) = {auc:.3f}</p>')
    if per_class:
        lines.append("<table><thead><tr><th>Class</th><th>Mean F1</th></tr></thead><tbody>")
        for name, f1 in zip(label_names, per_class):
            lines.append(f"<tr><td>{name}</td><td>{f1:.3f}</td></tr>")
        lines.append("</tbody></table>")
    lines.append("</div>")

    shap_df = result.get("shap_df", pd.DataFrame())
    if not shap_df.empty:
        lines.append('<div class="section"><h2>Feature Importances (SHAP)</h2>')
        img = shap_bar_plot(shap_df)
        lines.append(f'<img src="data:image/png;base64,{img}"><br>')
        lines.append("<table><thead><tr><th>Feature</th><th>Mean |SHAP|</th></tr></thead><tbody>")
        for _, row in shap_df.head(14).iterrows():
            lines.append(f'<tr><td>{row["feature"]}</td><td>{row["mean_abs_shap"]:.4f}</td></tr>')
        lines.append("</tbody></table></div>")

    lines.append("</body></html>")
    return "\n".join(lines)


def main() -> None:
    root = get_project_root()
    models_dir = root / "models"
    reports_dir = root / "reports"
    models_dir.mkdir(exist_ok=True)
    reports_dir.mkdir(exist_ok=True)

    cfg = get_dosage_config()

    log.info("Loading dosage feature matrix from supplement...")
    df = load_dosage_data()
    log.info("Loaded %d frequency-labelled rows", len(df))

    label_dist = df["frequency_raw"].value_counts().to_dict()

    log.info("Training dosage frequency recommender...")
    result = train_dosage_model(df)

    model_path = root / cfg["model_path"]
    joblib.dump(result["model"], model_path)
    log.info("Saved %s", model_path)

    report_html = build_report(result, label_dist)
    report_path = reports_dir / "dosage_model.html"
    report_path.write_text(report_html, encoding="utf-8")
    log.info("Saved reports/dosage_model.html")

    cv = result["cv_metrics"]
    print("\n" + "=" * 60)
    print("DOSAGE FREQUENCY RECOMMENDER — TRAINING SUMMARY")
    print("=" * 60)
    print(f"  N labelled patients : {result['n']}")
    print(f"  Label distribution  : {label_dist}")
    print(f"  Macro F1 (5-fold)   : {cv['macro_f1_mean']:.3f} ± {cv['macro_f1_std']:.3f}")
    print(f"  Macro AUC-ROC (OVR) : {cv.get('macro_auc_roc_mean', float('nan')):.3f}")
    print(f"  Per-class F1        : {[f'{v:.3f}' for v in cv.get('per_class_f1', [])]}")
    print(f"  Model saved to      : {model_path}")
    print(f"  Report saved to     : {report_path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
