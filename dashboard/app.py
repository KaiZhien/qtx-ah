"""Overview page — management view showing programme-level KPIs and distributions."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # dashboard/ for _utils

import plotly.express as px
import plotly.graph_objects as go
import pandas as pd
import streamlit as st
from plotly.subplots import make_subplots

from _utils import apply_filters, load_data, render_sidebar_filters

st.set_page_config(
    page_title="QuantumTX AH — Clinical Analytics",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.sidebar.title("Navigation")
st.sidebar.page_link("app.py", label="Overview")
st.sidebar.page_link("pages/cohort_analysis.py", label="Cohort Analysis")
st.sidebar.page_link("pages/clinical_tools.py", label="Clinical Tools")
st.sidebar.divider()
st.sidebar.title("Filters")

df_full = load_data()
filters = render_sidebar_filters(df_full)
df = apply_filters(df_full, filters)

st.title("QuantumTX AH — Clinical Analytics")

if df.empty:
    st.warning("No data matches the current filters.")
    st.stop()

# ---------------------------------------------------------------------------
# KPI strip
# ---------------------------------------------------------------------------

post_cols = ["post_vas", "post_tug_s", "post_5xsst_s", "post_normal_gs_ms", "post_sppb"]
existing_post = [c for c in post_cols if c in df.columns]
df_followup = df[df[existing_post].notna().any(axis=1)] if existing_post else pd.DataFrame()

n_patients = len(df)
pct_followup = 100 * len(df_followup) / n_patients if n_patients > 0 else 0.0
mean_improvement = (
    df_followup["composite_improvement"].mean()
    if not df_followup.empty and "composite_improvement" in df_followup.columns
    else None
)
pct_responders = (
    100 * df_followup["overall_responder"].mean()
    if not df_followup.empty and "overall_responder" in df_followup.columns
    else None
)

col1, col2, col3, col4 = st.columns(4)
col1.metric("N Patients", f"{n_patients:,}")
col2.metric("% with Follow-up", f"{pct_followup:.1f}%")
col3.metric(
    "Mean Composite Improvement",
    f"{mean_improvement:.2f}" if mean_improvement is not None else "N/A",
    help="Of patients with follow-up data",
)
col4.metric(
    "% Overall Responders",
    f"{pct_responders:.1f}%" if pct_responders is not None else "N/A",
    help="Of patients with follow-up data",
)

st.divider()

# ---------------------------------------------------------------------------
# Cohort distribution donut
# ---------------------------------------------------------------------------

if "cohort" in df.columns:
    cohort_counts = df["cohort"].value_counts().reset_index()
    cohort_counts.columns = ["cohort", "count"]
    fig_donut = px.pie(
        cohort_counts,
        values="count",
        names="cohort",
        hole=0.4,
        title="Cohort Distribution",
    )
    fig_donut.update_traces(textposition="inside", textinfo="percent+label")
    fig_donut.update_layout(showlegend=True, height=350)
    st.plotly_chart(fig_donut, use_container_width=True)
    st.divider()

# ---------------------------------------------------------------------------
# Pre vs Post by test
# ---------------------------------------------------------------------------

st.subheader("Pre vs Post by Test")

TEST_PAIRS = [
    ("VAS (Pain)", "pre_vas", "post_vas"),
    ("TUG (s)", "pre_tug_s", "post_tug_s"),
    ("5xSST (s)", "pre_5xsst_s", "post_5xsst_s"),
    ("Normal Gait Speed (m/s)", "pre_normal_gs_ms", "post_normal_gs_ms"),
    ("Fast Gait Speed (m/s)", "pre_fast_gs_ms", "post_fast_gs_ms"),
    ("SPPB", "baseline_sppb", "post_sppb"),
]
TEST_PAIRS = [
    (label, pre, post)
    for label, pre, post in TEST_PAIRS
    if pre in df.columns and post in df.columns
]

if TEST_PAIRS:
    n_cols = 3
    n_rows = (len(TEST_PAIRS) + n_cols - 1) // n_cols
    fig_prepost = make_subplots(
        rows=n_rows,
        cols=n_cols,
        subplot_titles=[t[0] for t in TEST_PAIRS],
        vertical_spacing=0.15,
        horizontal_spacing=0.08,
    )
    COLORS = {"Pre": "#4C78A8", "Post": "#F58518"}
    for idx, (label, pre_col, post_col) in enumerate(TEST_PAIRS):
        row, col = idx // n_cols + 1, idx % n_cols + 1
        paired = df[[pre_col, post_col]].dropna()
        for phase, col_name, color in [
            ("Pre", pre_col, COLORS["Pre"]),
            ("Post", post_col, COLORS["Post"]),
        ]:
            fig_prepost.add_trace(
                go.Box(
                    y=paired[col_name],
                    name=phase,
                    marker_color=color,
                    showlegend=(idx == 0),
                    legendgroup=phase,
                    boxmean=True,
                ),
                row=row,
                col=col,
            )
    fig_prepost.update_layout(
        height=420 * n_rows,
        title_text="Pre vs Post Comparison (Paired Observations)",
        boxmode="group",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    )
    st.plotly_chart(fig_prepost, use_container_width=True)
else:
    st.info("No pre/post test columns found in the filtered data.")

st.divider()

# ---------------------------------------------------------------------------
# Mean composite improvement by comorbidity flag
# ---------------------------------------------------------------------------

st.subheader("Mean Composite Improvement by Comorbidity Flag")

has_cols = [c for c in df.columns if c.startswith("has_") and c != "has_followup"]
if has_cols and "composite_improvement" in df.columns:
    rows = []
    for col in has_cols:
        sub = df[df[col] == 1]["composite_improvement"].dropna()
        if len(sub) >= 10:
            rows.append({
                "flag": col.replace("has_", "").replace("_", " ").title(),
                "mean_improvement": sub.mean(),
                "n": len(sub),
            })
    if rows:
        flag_df = pd.DataFrame(rows).sort_values("mean_improvement", ascending=True)
        fig_flags = go.Figure(go.Bar(
            x=flag_df["mean_improvement"],
            y=flag_df["flag"],
            orientation="h",
            marker_color="#54A24B",
            text=[f"n={r['n']}" for _, r in flag_df.iterrows()],
            textposition="outside",
        ))
        fig_flags.update_layout(
            title="Mean Composite Improvement by Comorbidity Flag",
            xaxis_title="Mean Composite Improvement",
            height=max(400, 40 * len(flag_df)),
            margin=dict(l=200),
        )
        st.plotly_chart(fig_flags, use_container_width=True)
    else:
        st.info("No comorbidity flags have >= 10 patients with composite improvement data.")
else:
    st.info("Comorbidity flag or composite_improvement data not available.")
