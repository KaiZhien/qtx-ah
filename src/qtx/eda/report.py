"""Render the EDA outputs into a structured HTML/PDF report using Jinja2 templates.

Reads tables and figures produced by descriptives.py and stratified.py,
fills a Jinja2 template, and writes the final report to reports/eda_report.html.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import plotly
import plotly.offline

from jinja2 import Template

from qtx.eda.descriptives import age_distribution, cohort_counts, summary_table
from qtx.eda.stratified import (
    composite_by_cohort,
    improvement_histograms,
    missingness_heatmap,
    phenotype_sankey,
    pre_post_boxplots,
)

_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QuantumTX AH – EDA Report</title>
  <script type="text/javascript">
  {{ plotly_js }}
  </script>
  <style>
    body {
      font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
      background: #f8f9fa;
      color: #212529;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
    }
    h1 {
      font-size: 2rem;
      color: #1a3a5c;
      border-bottom: 3px solid #4C72B0;
      padding-bottom: 10px;
      margin-bottom: 8px;
    }
    h2 {
      font-size: 1.4rem;
      color: #2c5282;
      margin-top: 40px;
      margin-bottom: 12px;
      border-left: 4px solid #4C72B0;
      padding-left: 10px;
    }
    h3 {
      font-size: 1.1rem;
      color: #2d3748;
      margin-top: 24px;
    }
    .subtitle {
      color: #6c757d;
      font-size: 0.95rem;
      margin-bottom: 32px;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      text-align: center;
    }
    .stat-card .value {
      font-size: 2rem;
      font-weight: 700;
      color: #4C72B0;
    }
    .stat-card .label {
      font-size: 0.85rem;
      color: #6c757d;
      margin-top: 4px;
    }
    .section {
      background: white;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      margin-bottom: 28px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    th {
      background: #4C72B0;
      color: white;
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
    }
    tr:nth-child(even) { background: #f7f9fc; }
    tr:nth-child(odd) { background: white; }
    tr.overall-row { background: #e8f0fe !important; font-weight: bold; }
    td { padding: 8px 12px; border-bottom: 1px solid #e9ecef; }
    .figure-container {
      margin-top: 12px;
    }
    .age-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
    }
    .age-stat {
      background: #f0f4ff;
      border-radius: 6px;
      padding: 12px 16px;
    }
    .age-stat .val { font-size: 1.3rem; font-weight: 700; color: #2c5282; }
    .age-stat .lbl { font-size: 0.8rem; color: #6c757d; }
    footer {
      text-align: center;
      color: #adb5bd;
      font-size: 0.8rem;
      margin-top: 48px;
      padding-bottom: 24px;
    }
  </style>
</head>
<body>
<div class="container">

  <h1>QuantumTX AH — EDA Report</h1>
  <p class="subtitle">Generated automatically. Dataset: featured.parquet</p>

  <!-- 1. Dataset Overview -->
  <h2>1. Dataset Overview</h2>
  <div class="section">
    <div class="overview-grid">
      <div class="stat-card">
        <div class="value">{{ overview.total_n }}</div>
        <div class="label">Total Patients</div>
      </div>
      <div class="stat-card">
        <div class="value">{{ overview.n_followup }}</div>
        <div class="label">With Follow-up</div>
      </div>
      <div class="stat-card">
        <div class="value">{{ overview.pct_followup }}%</div>
        <div class="label">Follow-up Rate</div>
      </div>
      <div class="stat-card">
        <div class="value">{{ overview.n_cohorts }}</div>
        <div class="label">Cohorts</div>
      </div>
      <div class="stat-card">
        <div class="value">{{ overview.n_responders }}</div>
        <div class="label">Overall Responders</div>
      </div>
      <div class="stat-card">
        <div class="value">{{ overview.pct_responders }}%</div>
        <div class="label">Responder Rate</div>
      </div>
    </div>
  </div>

  <!-- 2. Age Distribution -->
  <h2>2. Age Distribution</h2>
  <div class="section">
    <div class="age-stats">
      <div class="age-stat">
        <div class="val">{{ age_stats.mean }}</div>
        <div class="lbl">Mean Age</div>
      </div>
      <div class="age-stat">
        <div class="val">{{ age_stats.median }}</div>
        <div class="lbl">Median Age</div>
      </div>
      <div class="age-stat">
        <div class="val">{{ age_stats.std }}</div>
        <div class="lbl">Std Dev</div>
      </div>
      <div class="age-stat">
        <div class="val">{{ age_stats.min }}</div>
        <div class="lbl">Min Age</div>
      </div>
      <div class="age-stat">
        <div class="val">{{ age_stats.max }}</div>
        <div class="lbl">Max Age</div>
      </div>
      <div class="age-stat">
        <div class="val">{{ age_stats.n_missing }}</div>
        <div class="lbl">Missing</div>
      </div>
    </div>
  </div>

  <!-- 3. Cohort Distribution -->
  <h2>3. Cohort Distribution</h2>
  <div class="section">
    <table>
      <thead>
        <tr>
          <th>Cohort</th>
          <th>N</th>
          <th>%</th>
        </tr>
      </thead>
      <tbody>
        {% for row in cohort_table %}
        <tr>
          <td>{{ row.cohort }}</td>
          <td>{{ row.n }}</td>
          <td>{{ row.pct }}%</td>
        </tr>
        {% endfor %}
      </tbody>
    </table>
  </div>

  <!-- 4. Grouped Descriptives (summary_table) -->
  <h2>4. Descriptive Statistics by Cohort × Usage × Age Band</h2>
  <div class="section">
    <p style="font-size:0.85rem;color:#6c757d;margin-bottom:12px;">
      Overall row shown first in blue. Grouped by cohort, usage frequency, and age band.
    </p>
    <table>
      <thead>
        <tr>
          <th>Cohort</th>
          <th>Usage Frequency</th>
          <th>Age Band</th>
          <th>N</th>
          <th>N Followup</th>
          <th>% Followup</th>
          <th>Mean Age</th>
          <th>Median Age</th>
          <th>% Female</th>
          <th>% Male</th>
          <th>Mean Composite</th>
          <th>% Responder</th>
        </tr>
      </thead>
      <tbody>
        {% for row in summary_rows %}
        <tr class="{{ 'overall-row' if row.cohort == 'OVERALL' else '' }}">
          <td>{{ row.cohort }}</td>
          <td>{{ row.usage_frequency }}</td>
          <td>{{ row.age_band }}</td>
          <td>{{ row.n }}</td>
          <td>{{ row.n_followup }}</td>
          <td>{{ row.pct_followup }}</td>
          <td>{{ row.mean_age }}</td>
          <td>{{ row.median_age }}</td>
          <td>{{ row.pct_female }}</td>
          <td>{{ row.pct_male }}</td>
          <td>{{ row.mean_composite }}</td>
          <td>{{ row.pct_overall_responder }}</td>
        </tr>
        {% endfor %}
      </tbody>
    </table>
  </div>

  <!-- 5. Pre/Post Boxplots -->
  <h2>5. Pre vs Post Outcome Distributions</h2>
  <div class="section">
    <div class="figure-container">
      {{ fig_pre_post }}
    </div>
  </div>

  <!-- 6. Improvement Histograms -->
  <h2>6. Improvement Score Distributions</h2>
  <div class="section">
    <div class="figure-container">
      {{ fig_improvement }}
    </div>
  </div>

  <!-- 7. Composite by Cohort -->
  <h2>7. Composite Improvement by Cohort</h2>
  <div class="section">
    <div class="figure-container">
      {{ fig_composite }}
    </div>
  </div>

  <!-- 8. Phenotype Sankey -->
  <h2>8. Patient Flow: Primary Indication → Cohort</h2>
  <div class="section">
    <div class="figure-container">
      {{ fig_sankey }}
    </div>
  </div>

  <!-- 9. Missingness Heatmap -->
  <h2>9. Missingness Heatmap</h2>
  <div class="section">
    <div class="figure-container">
      {{ fig_missingness }}
    </div>
  </div>

  <footer>
    QuantumTX AH EDA Report &mdash; Auto-generated by qtx pipeline
  </footer>

</div>
</body>
</html>
"""


def render_eda_report(df: pd.DataFrame, output_path: Path | None = None) -> Path:
    """
    Render a self-contained HTML report to reports/eda.html.

    Must include:
    1. Dataset overview table (total N, N with followup, %, cohort counts)
    2. Age distribution stats
    3. Cohort distribution table
    4. summary_table() result (grouped descriptives)
    5. pre_post_boxplots figure (embedded as Plotly HTML)
    6. improvement_histograms figure
    7. composite_by_cohort figure
    8. phenotype_sankey figure
    9. missingness_heatmap figure

    Use Jinja2 template + plotly.offline.plot(..., output_type='div') to embed figures.
    The output HTML must be fully self-contained (no external CDN dependencies for core content).
    Returns the output path.
    """
    # Resolve output path
    if output_path is None:
        # Derive project root from this file: src/qtx/eda/report.py → root
        project_root = Path(__file__).resolve().parents[3]
        output_path = project_root / "reports" / "eda.html"

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ---- Compute overview stats ----
    total_n = len(df)
    n_followup = int((df["has_followup"] == "Y").sum())
    pct_followup = round(n_followup / total_n * 100, 1) if total_n > 0 else 0.0
    n_cohorts = df["cohort"].nunique()
    followup_df = df[df["has_followup"] == "Y"]
    n_responders = int((followup_df["overall_responder"] == 1).sum()) if "overall_responder" in df.columns else 0
    pct_responders = round(n_responders / n_followup * 100, 1) if n_followup > 0 else 0.0

    overview = {
        "total_n": total_n,
        "n_followup": n_followup,
        "pct_followup": pct_followup,
        "n_cohorts": n_cohorts,
        "n_responders": n_responders,
        "pct_responders": pct_responders,
    }

    # ---- Descriptive tables ----
    age_stats = age_distribution(df)
    cohort_df = cohort_counts(df)
    cohort_table = cohort_df.to_dict(orient="records")

    summ_df = summary_table(df)
    # Replace NaN with "-" for display
    summ_display = summ_df.fillna("-")
    summary_rows = summ_display.to_dict(orient="records")

    # ---- Figures ----
    fig_pre_post = pre_post_boxplots(df)
    fig_improvement = improvement_histograms(df)
    fig_composite = composite_by_cohort(df)
    fig_sankey = phenotype_sankey(df)
    fig_missingness = missingness_heatmap(df)

    def _embed(fig: plotly.graph_objs.Figure) -> str:
        return plotly.offline.plot(fig, output_type="div", include_plotlyjs=False)

    # ---- Render template ----
    template = Template(_TEMPLATE)
    html = template.render(
        plotly_js=plotly.offline.get_plotlyjs(),
        overview=overview,
        age_stats=age_stats,
        cohort_table=cohort_table,
        summary_rows=summary_rows,
        fig_pre_post=_embed(fig_pre_post),
        fig_improvement=_embed(fig_improvement),
        fig_composite=_embed(fig_composite),
        fig_sankey=_embed(fig_sankey),
        fig_missingness=_embed(fig_missingness),
    )

    output_path.write_text(html, encoding="utf-8")
    return output_path
