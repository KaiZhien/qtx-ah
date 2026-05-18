"""Produce stratified EDA breakdowns by cohort, age_band, gender, and dosing frequency.

Generates responder rate tables, outcome distribution plots, and
missingness comparison tables across strata. Used to identify
subgroup-level signal before modelling.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

# The 6 outcome tests with their pre/post column pairs and display labels
TESTS = [
    ("pre_vas", "post_vas", "VAS Pain"),
    ("pre_tug_s", "post_tug_s", "TUG (s)"),
    ("pre_5xsst_s", "post_5xsst_s", "5xSST (s)"),
    ("pre_normal_gs_ms", "post_normal_gs_ms", "Normal GS (ms)"),
    ("pre_fast_gs_ms", "post_fast_gs_ms", "Fast GS (ms)"),
    ("baseline_sppb", "post_sppb", "SPPB"),
]

IMPROVEMENT_COLS = [
    "vas_improvement",
    "tug_improvement",
    "sst_improvement",
    "normal_gs_improvement",
    "fast_gs_improvement",
    "sppb_improvement",
]

IMPROVEMENT_LABELS = [
    "VAS Improvement",
    "TUG Improvement",
    "SST Improvement",
    "Normal GS Improvement",
    "Fast GS Improvement",
    "SPPB Improvement",
]

MODEL_FEATURE_COLS = [
    "age",
    "gender",
    "baseline_sppb",
    "pre_normal_gs_ms",
    "pre_tug_s",
    "pre_5xsst_s",
    "usage_frequency",
    "cohort",
    "has_oa",
    "has_diabetes",
    "has_stroke",
    "has_parkinsons",
    "has_sarcopenia",
    "has_post_surgery",
    "has_balance_issue",
    "has_chronic_pain",
]


def pre_post_boxplots(df: pd.DataFrame) -> go.Figure:
    """
    For each of the 6 tests, show side-by-side pre/post boxplots.
    Only include patients where BOTH pre and post are available.
    Returns one figure with 6 subplots (2 rows x 3 cols).
    """
    fig = make_subplots(
        rows=2, cols=3,
        subplot_titles=[t[2] for t in TESTS],
        vertical_spacing=0.15,
        horizontal_spacing=0.1,
    )

    colors = {"Pre": "#4C72B0", "Post": "#DD8452"}

    for idx, (pre_col, post_col, label) in enumerate(TESTS):
        row = idx // 3 + 1
        col = idx % 3 + 1

        # Only rows with both pre and post
        mask = df[pre_col].notna() & df[post_col].notna()
        sub = df[mask]

        if len(sub) == 0:
            continue

        pre_vals = sub[pre_col].values
        post_vals = sub[post_col].values

        show_legend = idx == 0

        fig.add_trace(
            go.Box(
                y=pre_vals,
                name="Pre",
                marker_color=colors["Pre"],
                boxmean=True,
                showlegend=show_legend,
                legendgroup="Pre",
            ),
            row=row, col=col,
        )
        fig.add_trace(
            go.Box(
                y=post_vals,
                name="Post",
                marker_color=colors["Post"],
                boxmean=True,
                showlegend=show_legend,
                legendgroup="Post",
            ),
            row=row, col=col,
        )

    fig.update_layout(
        title_text="Pre vs Post Outcome Distributions (paired completers only)",
        height=600,
        boxmode="group",
        template="plotly_white",
    )
    return fig


def improvement_histograms(df: pd.DataFrame) -> go.Figure:
    """
    For each of the 6 improvement columns, show a histogram.
    Color/facet by cohort. Returns one figure with 6 subplots.
    """
    fig = make_subplots(
        rows=2, cols=3,
        subplot_titles=IMPROVEMENT_LABELS,
        vertical_spacing=0.15,
        horizontal_spacing=0.1,
    )

    cohorts = sorted(df["cohort"].dropna().unique())
    palette = [
        "#4C72B0", "#DD8452", "#55A868", "#C44E52",
        "#8172B2", "#937860", "#DA8BC3", "#8C8C8C",
    ]
    color_map = {c: palette[i % len(palette)] for i, c in enumerate(cohorts)}

    for idx, (col_name, label) in enumerate(zip(IMPROVEMENT_COLS, IMPROVEMENT_LABELS)):
        row = idx // 3 + 1
        col = idx % 3 + 1

        if col_name not in df.columns:
            continue

        show_legend = idx == 0

        for cohort in cohorts:
            sub = df[df["cohort"] == cohort][col_name].dropna()
            if len(sub) == 0:
                continue
            fig.add_trace(
                go.Histogram(
                    x=sub,
                    name=cohort,
                    marker_color=color_map[cohort],
                    opacity=0.65,
                    showlegend=show_legend,
                    legendgroup=cohort,
                    nbinsx=20,
                ),
                row=row, col=col,
            )

    fig.update_layout(
        title_text="Improvement Score Distributions by Cohort",
        height=600,
        barmode="overlay",
        template="plotly_white",
    )
    return fig


def phenotype_sankey(df: pd.DataFrame) -> go.Figure:
    """
    Sankey diagram: primary_indication (nodes) -> cohort (nodes) with flow counts.
    """
    if "primary_indication" not in df.columns:
        # Fallback: empty figure
        return go.Figure(layout=go.Layout(title="primary_indication column not available"))

    flow = (
        df.groupby(["primary_indication", "cohort"], observed=True)
        .size()
        .reset_index(name="count")
    )

    indications = sorted(flow["primary_indication"].unique())
    cohorts = sorted(flow["cohort"].unique())

    # Nodes: indications first, then cohorts
    all_nodes = list(indications) + list(cohorts)
    node_idx = {n: i for i, n in enumerate(all_nodes)}

    source = [node_idx[r["primary_indication"]] for _, r in flow.iterrows()]
    target = [node_idx[r["cohort"]] for _, r in flow.iterrows()]
    value = [r["count"] for _, r in flow.iterrows()]

    # Colors for node groups
    n_ind = len(indications)
    n_coh = len(cohorts)
    palette_ind = ["#4C72B0"] * n_ind
    palette_coh = ["#DD8452"] * n_coh
    node_colors = palette_ind + palette_coh

    fig = go.Figure(go.Sankey(
        node=dict(
            pad=15,
            thickness=20,
            line=dict(color="black", width=0.5),
            label=all_nodes,
            color=node_colors,
        ),
        link=dict(
            source=source,
            target=target,
            value=value,
        ),
    ))
    fig.update_layout(
        title_text="Patient Flow: Primary Indication → Cohort",
        height=500,
        template="plotly_white",
    )
    return fig


def missingness_heatmap(df: pd.DataFrame) -> go.Figure:
    """
    Heatmap of missingness across the 16 model feature columns.
    X-axis: feature name, Y-axis: cohort. Color = % missing.
    """
    # Only keep model feature columns that exist
    features = [c for c in MODEL_FEATURE_COLS if c in df.columns]
    cohorts = sorted(df["cohort"].dropna().unique())

    z = []
    for cohort in cohorts:
        sub = df[df["cohort"] == cohort]
        row_vals = []
        for feat in features:
            col_data = sub[feat]
            # For string columns, treat "__missing__" as missing too
            if col_data.dtype == object:
                n_missing = (col_data.isna() | (col_data == "__missing__")).sum()
            else:
                n_missing = col_data.isna().sum()
            pct = n_missing / len(sub) * 100 if len(sub) > 0 else 0.0
            row_vals.append(round(pct, 1))
        z.append(row_vals)

    fig = go.Figure(go.Heatmap(
        z=z,
        x=features,
        y=cohorts,
        colorscale="Reds",
        zmin=0,
        zmax=100,
        text=[[f"{v:.1f}%" for v in row] for row in z],
        texttemplate="%{text}",
        colorbar=dict(title="% Missing"),
    ))
    fig.update_layout(
        title_text="Missingness Heatmap: Model Features by Cohort",
        xaxis_title="Feature",
        yaxis_title="Cohort",
        height=400,
        template="plotly_white",
    )
    return fig


def composite_by_cohort(df: pd.DataFrame) -> go.Figure:
    """
    Box + strip plot of composite_improvement by cohort.
    Only patients with composite_improvement not NaN.
    """
    sub = df[df["composite_improvement"].notna()].copy()
    cohorts = sorted(sub["cohort"].dropna().unique())

    palette = [
        "#4C72B0", "#DD8452", "#55A868", "#C44E52",
        "#8172B2", "#937860", "#DA8BC3", "#8C8C8C",
    ]
    color_map = {c: palette[i % len(palette)] for i, c in enumerate(cohorts)}

    fig = go.Figure()

    for cohort in cohorts:
        vals = sub[sub["cohort"] == cohort]["composite_improvement"]
        color = color_map[cohort]

        fig.add_trace(go.Box(
            y=vals,
            name=cohort,
            marker_color=color,
            boxmean=True,
            boxpoints="outliers",
            jitter=0.3,
            pointpos=0,
        ))

    # Add zero reference line
    fig.add_hline(y=0, line_dash="dash", line_color="gray", annotation_text="No change")

    fig.update_layout(
        title_text="Composite Improvement Score by Cohort",
        yaxis_title="Composite Improvement (z-score units)",
        xaxis_title="Cohort",
        height=500,
        template="plotly_white",
        showlegend=False,
    )
    return fig
