"""Cohort Analysis page — research view for comparing patient cohorts side-by-side."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # dashboard/ for _utils

import plotly.graph_objects as go
import pandas as pd
import streamlit as st

from _utils import apply_chart_style, cohort_color, inject_css, load_data

st.set_page_config(page_title="Cohort Analysis", layout="wide", initial_sidebar_state="expanded")
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

df_full = load_data()

# ---------------------------------------------------------------------------
# Page header
# ---------------------------------------------------------------------------

st.markdown("""
<div style="margin-bottom:24px;">
  <div style="font-size:20px;font-weight:700;color:#0f2744;line-height:1.2;">Cohort Analysis</div>
  <div style="font-size:12px;color:#94a3b8;margin-top:3px;">Compare programme outcomes across patient cohorts</div>
</div>
""", unsafe_allow_html=True)

_EXCLUDE = {"Unclassified"}
all_cohorts = sorted(c for c in df_full["cohort"].dropna().unique() if c not in _EXCLUDE)

selected = st.multiselect("Select cohorts to compare", options=all_cohorts, default=all_cohorts)

if len(selected) < 2:
    st.info("Select at least 2 cohorts to compare.")
    st.stop()

df = df_full[df_full["cohort"].isin(selected)].copy()

_POST_COLS = ["post_vas", "post_tug_s", "post_5xsst_s", "post_normal_gs_ms", "post_sppb"]


def _followup_subset(sub: pd.DataFrame) -> pd.DataFrame:
    existing = [c for c in _POST_COLS if c in sub.columns]
    return sub[sub[existing].notna().any(axis=1)] if existing else pd.DataFrame()


# ---------------------------------------------------------------------------
# Summary table (styled HTML — not st.dataframe)
# ---------------------------------------------------------------------------

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Summary</div>', unsafe_allow_html=True)

summary_rows = []
for cohort in selected:
    sub = df[df["cohort"] == cohort]
    sub_fu = _followup_subset(sub)
    summary_rows.append({
        "Cohort": cohort,
        "N": len(sub),
        "Follow-up": f"{100 * len(sub_fu) / len(sub):.1f}%" if len(sub) > 0 else "N/A",
        "Responders": (
            f"{100 * sub_fu['overall_responder'].mean():.1f}%"
            if len(sub_fu) > 0 and "overall_responder" in sub_fu.columns and not sub_fu["overall_responder"].isna().all()
            else "N/A"
        ),
        "Dropout": (
            f"{100 * sub['is_dropout'].mean():.1f}%"
            if "is_dropout" in sub.columns and not sub["is_dropout"].isna().all()
            else "N/A"
        ),
        "Mean Improvement": (
            f"{sub_fu['composite_improvement'].mean():.2f}"
            if len(sub_fu) > 0 and "composite_improvement" in sub_fu.columns and not sub_fu["composite_improvement"].isna().all()
            else "N/A"
        ),
    })

_TH = "padding:11px 16px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid #e2e8f0;"
_TD = "padding:12px 16px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9;"
_TD_COHORT = "padding:12px 16px;font-size:13px;font-weight:600;color:#0f2744;border-bottom:1px solid #f1f5f9;"

headers = ["Cohort", "N", "Follow-up", "Responders", "Dropout", "Mean Improvement"]
header_html = "".join(f"<th style='{_TH}'>{h}</th>" for h in headers)

rows_html = ""
for i, r in enumerate(summary_rows):
    bg = "background:#f8fafc;" if i % 2 == 0 else ""
    rows_html += f"""<tr style="{bg}">
  <td style="{_TD_COHORT}">{r['Cohort']}</td>
  <td style="{_TD}">{r['N']:,}</td>
  <td style="{_TD}">{r['Follow-up']}</td>
  <td style="{_TD}">{r['Responders']}</td>
  <td style="{_TD}">{r['Dropout']}</td>
  <td style="{_TD}">{r['Mean Improvement']}</td>
</tr>"""

st.markdown(f"""
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:24px;">
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>{header_html}</tr></thead>
    <tbody>{rows_html}</tbody>
  </table>
</div>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Responder and dropout rates (grouped bar)
# ---------------------------------------------------------------------------

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Responder and Dropout Rates</div>', unsafe_allow_html=True)

cohort_labels, responder_rates, dropout_rates = [], [], []
for cohort in selected:
    sub = df[df["cohort"] == cohort]
    sub_fu = _followup_subset(sub)
    cohort_labels.append(cohort)
    responder_rates.append(
        sub_fu["overall_responder"].mean() * 100
        if len(sub_fu) > 0 and "overall_responder" in sub_fu.columns
        else 0.0
    )
    dropout_rates.append(
        sub["is_dropout"].mean() * 100
        if "is_dropout" in sub.columns
        else 0.0
    )

fig_rates = go.Figure()
fig_rates.add_trace(go.Bar(name="Responder Rate %", x=cohort_labels, y=responder_rates, marker_color="#2b6cb0"))
fig_rates.add_trace(go.Bar(name="Dropout Rate %", x=cohort_labels, y=dropout_rates, marker_color="#e53e3e"))
fig_rates.update_layout(barmode="group", yaxis_title="%", height=400)
apply_chart_style(fig_rates)
st.plotly_chart(fig_rates, use_container_width=True)
st.divider()

# ---------------------------------------------------------------------------
# Composite improvement distribution
# ---------------------------------------------------------------------------

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Composite Improvement Distribution</div>', unsafe_allow_html=True)

if "composite_improvement" in df.columns:
    fig_box = go.Figure()
    for i, cohort in enumerate(selected):
        vals = df[df["cohort"] == cohort]["composite_improvement"].dropna()
        fig_box.add_trace(go.Box(
            y=vals.values,
            name=cohort,
            boxmean=True,
            marker_color=cohort_color(cohort, i),
        ))
    fig_box.update_layout(yaxis_title="Composite Improvement", height=400)
    apply_chart_style(fig_box)
    st.plotly_chart(fig_box, use_container_width=True)
else:
    st.info("Composite improvement data not available.")

st.divider()

# ---------------------------------------------------------------------------
# Demographics
# ---------------------------------------------------------------------------

st.markdown('<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px;">Demographics</div>', unsafe_allow_html=True)

demo_c1, demo_c2 = st.columns(2)

with demo_c1:
    st.markdown('<div style="font-size:13px;font-weight:600;color:#0f2744;margin-bottom:8px;">Age Band Distribution</div>', unsafe_allow_html=True)
    if "age_band" in df.columns:
        age_pivot = df.groupby(["cohort", "age_band"]).size().reset_index(name="count")
        fig_age = go.Figure()
        for i, cohort in enumerate(selected):
            sub = age_pivot[age_pivot["cohort"] == cohort]
            fig_age.add_trace(go.Bar(name=cohort, x=sub["age_band"], y=sub["count"], marker_color=cohort_color(cohort, i)))
        fig_age.update_layout(barmode="group", xaxis_title="Age Band", yaxis_title="Count", height=350)
        apply_chart_style(fig_age)
        st.plotly_chart(fig_age, use_container_width=True)

with demo_c2:
    st.markdown('<div style="font-size:13px;font-weight:600;color:#0f2744;margin-bottom:8px;">Gender Split</div>', unsafe_allow_html=True)
    if "gender" in df.columns:
        gender_pivot = df.groupby(["cohort", "gender"]).size().reset_index(name="count")
        fig_gender = go.Figure()
        for i, cohort in enumerate(selected):
            sub = gender_pivot[gender_pivot["cohort"] == cohort]
            fig_gender.add_trace(go.Bar(name=cohort, x=sub["gender"], y=sub["count"], marker_color=cohort_color(cohort, i)))
        fig_gender.update_layout(barmode="group", xaxis_title="Gender", yaxis_title="Count", height=350)
        apply_chart_style(fig_gender)
        st.plotly_chart(fig_gender, use_container_width=True)
