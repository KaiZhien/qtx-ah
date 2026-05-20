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

from _utils import apply_chart_style, apply_filters, inject_css, load_data, render_sidebar_filters

st.set_page_config(
    page_title="QuantumTX AH — Clinical Analytics",
    layout="wide",
    initial_sidebar_state="expanded",
)
inject_css()

# ---------------------------------------------------------------------------
# Styled sidebar header
# ---------------------------------------------------------------------------

st.sidebar.markdown("""
<div style="padding:20px 16px 16px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:8px;">
  <div style="color:rgba(255,255,255,0.4);font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">QuantumTX</div>
  <div style="color:#ffffff;font-size:15px;font-weight:600;line-height:1.3;">Alexandra Hospital</div>
  <div style="color:rgba(255,255,255,0.45);font-size:11px;margin-top:2px;">2024 Clinical Analytics</div>
</div>
""", unsafe_allow_html=True)

st.sidebar.markdown('<div style="color:rgba(255,255,255,0.35);font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:12px 16px 4px;">Pages</div>', unsafe_allow_html=True)
st.sidebar.page_link("app.py", label="Overview")
st.sidebar.page_link("pages/cohort_analysis.py", label="Cohort Analysis")
st.sidebar.page_link("pages/clinical_tools.py", label="Clinical Tools")
st.sidebar.divider()
st.sidebar.markdown('<div style="color:rgba(255,255,255,0.35);font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 16px 8px;">Filters</div>', unsafe_allow_html=True)

df_full = load_data()
filters = render_sidebar_filters(df_full)
df = apply_filters(df_full, filters)

# ---------------------------------------------------------------------------
# Page header
# ---------------------------------------------------------------------------

st.markdown(f"""
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
  <div>
    <div style="font-size:20px;font-weight:700;color:#0f2744;line-height:1.2;">QuantumTX AH — Clinical Analytics</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:3px;">Alexandra Hospital 2024 · {len(df_full):,} patients total</div>
  </div>
  <div style="background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8;border-radius:20px;padding:5px 14px;font-size:11px;font-weight:600;white-space:nowrap;">Last updated: 2026-05-20</div>
</div>
""", unsafe_allow_html=True)

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

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Programme Summary</div>', unsafe_allow_html=True)

def _kpi_card(label: str, value: str, sub: str, grad: str) -> str:
    return f"""
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
  <div style="height:3px;background:{grad};"></div>
  <div style="padding:18px 22px;">
    <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;margin-bottom:10px;">{label}</div>
    <div style="font-size:30px;font-weight:700;color:#0f2744;line-height:1;letter-spacing:-0.02em;">{value}</div>
    <div style="font-size:11px;color:#a0aec0;margin-top:6px;">{sub}</div>
  </div>
</div>"""

k1, k2, k3, k4 = st.columns(4)
with k1:
    st.markdown(_kpi_card(
        "Total Patients", f"{n_patients:,}", "Filtered records",
        "linear-gradient(90deg,#2b6cb0,#63b3ed)"
    ), unsafe_allow_html=True)
with k2:
    st.markdown(_kpi_card(
        "Follow-up Rate", f"{pct_followup:.1f}%", f"{len(df_followup):,} patients with post-assessment",
        "linear-gradient(90deg,#2c7a7b,#4fd1c7)"
    ), unsafe_allow_html=True)
with k3:
    imp_val = f"{mean_improvement:.2f}" if mean_improvement is not None else "N/A"
    st.markdown(_kpi_card(
        "Mean Improvement", imp_val, "Composite z-score, follow-up patients",
        "linear-gradient(90deg,#276749,#68d391)"
    ), unsafe_allow_html=True)
with k4:
    resp_val = f"{pct_responders:.1f}%" if pct_responders is not None else "N/A"
    st.markdown(_kpi_card(
        "Responder Rate", resp_val, "Overall responders with follow-up",
        "linear-gradient(90deg,#553c9a,#b794f4)"
    ), unsafe_allow_html=True)

st.markdown("<div style='margin-top:24px;'></div>", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Cohort distribution donut
# ---------------------------------------------------------------------------

if "cohort" in df.columns:
    st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Cohort Breakdown</div>', unsafe_allow_html=True)

    cohort_counts = df["cohort"].value_counts().reset_index()
    cohort_counts.columns = ["cohort", "count"]

    fig_donut = px.pie(
        cohort_counts,
        values="count",
        names="cohort",
        hole=0.55,
        color_discrete_sequence=["#2b6cb0", "#cbd5e0", "#4fd1c7", "#b794f4", "#68d391", "#f6ad55", "#fc8181"],
    )
    fig_donut.update_traces(
        textposition="inside",
        textinfo="percent",
        hovertemplate="<b>%{label}</b><br>%{value:,} patients (%{percent})<extra></extra>",
    )
    fig_donut.add_annotation(
        text=f"<b>{n_patients:,}</b><br><span style='font-size:11px'>patients</span>",
        x=0.5, y=0.5, showarrow=False,
        font=dict(size=20, color="#0f2744"),
        xref="paper", yref="paper",
    )
    fig_donut.update_layout(height=380, title_text="")
    apply_chart_style(fig_donut)
    st.plotly_chart(fig_donut, use_container_width=True)

st.divider()

# ---------------------------------------------------------------------------
# Pre vs Post by test
# ---------------------------------------------------------------------------

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Pre vs Post by Test</div>', unsafe_allow_html=True)

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
    COLORS = {"Pre": "#2b6cb0", "Post": "#63b3ed"}
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
        boxmode="group",
    )
    apply_chart_style(fig_prepost)
    st.plotly_chart(fig_prepost, use_container_width=True)
else:
    st.info("No pre/post test columns found in the filtered data.")

st.divider()

# ---------------------------------------------------------------------------
# Mean composite improvement by comorbidity flag
# ---------------------------------------------------------------------------

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Mean Composite Improvement by Comorbidity Flag</div>', unsafe_allow_html=True)

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
        bar_colors = ["#e53e3e" if v < 0 else "#2b6cb0" for v in flag_df["mean_improvement"]]
        fig_flags = go.Figure(go.Bar(
            x=flag_df["mean_improvement"],
            y=flag_df["flag"],
            orientation="h",
            marker_color=bar_colors,
            text=[f"n={r['n']}" for _, r in flag_df.iterrows()],
            textposition="outside",
        ))
        fig_flags.update_layout(
            xaxis_title="Mean Composite Improvement",
            height=max(400, 40 * len(flag_df)),
            margin=dict(l=180, r=0, t=40, b=0),
        )
        apply_chart_style(fig_flags)
        st.plotly_chart(fig_flags, use_container_width=True)
    else:
        st.info("No comorbidity flags have >= 10 patients with composite improvement data.")
else:
    st.info("Comorbidity flag or composite_improvement data not available.")
