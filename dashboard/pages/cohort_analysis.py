"""Cohort Analysis page — research view for comparing patient cohorts side-by-side."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # dashboard/ for _utils

import plotly.graph_objects as go
import pandas as pd
import streamlit as st

from _utils import load_data

st.set_page_config(page_title="Cohort Analysis", layout="wide", initial_sidebar_state="expanded")

st.sidebar.title("Navigation")
st.sidebar.page_link("app.py", label="Overview")
st.sidebar.page_link("pages/cohort_analysis.py", label="Cohort Analysis")
st.sidebar.page_link("pages/clinical_tools.py", label="Clinical Tools")

df_full = load_data()

st.title("Cohort Analysis")

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
# Summary table
# ---------------------------------------------------------------------------

st.subheader("Summary")

summary_rows = []
for cohort in selected:
    sub = df[df["cohort"] == cohort]
    sub_fu = _followup_subset(sub)
    summary_rows.append({
        "Cohort": cohort,
        "N": len(sub),
        "% Follow-up": f"{100 * len(sub_fu) / len(sub):.1f}%" if len(sub) > 0 else "N/A",
        "% Responders": (
            f"{100 * sub_fu['overall_responder'].mean():.1f}%"
            if len(sub_fu) > 0 and "overall_responder" in sub_fu.columns and not sub_fu["overall_responder"].isna().all()
            else "N/A"
        ),
        "% Dropout": (
            f"{100 * sub['is_dropout'].mean():.1f}%"
            if "is_dropout" in sub.columns and not sub["is_dropout"].isna().all()
            else "N/A"
        ),
        "Mean Composite Improvement": (
            f"{sub_fu['composite_improvement'].mean():.2f}"
            if len(sub_fu) > 0 and "composite_improvement" in sub_fu.columns and not sub_fu["composite_improvement"].isna().all()
            else "N/A"
        ),
    })

st.dataframe(pd.DataFrame(summary_rows), use_container_width=True, hide_index=True)
st.divider()

# ---------------------------------------------------------------------------
# Responder and dropout rates (grouped bar)
# ---------------------------------------------------------------------------

st.subheader("Responder and Dropout Rates")

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
fig_rates.add_trace(go.Bar(name="Responder Rate %", x=cohort_labels, y=responder_rates, marker_color="#54A24B"))
fig_rates.add_trace(go.Bar(name="Dropout Rate %", x=cohort_labels, y=dropout_rates, marker_color="#E45756"))
fig_rates.update_layout(barmode="group", yaxis_title="%", height=400)
st.plotly_chart(fig_rates, use_container_width=True)
st.divider()

# ---------------------------------------------------------------------------
# Composite improvement distribution
# ---------------------------------------------------------------------------

st.subheader("Composite Improvement Distribution")

if "composite_improvement" in df.columns:
    fig_box = go.Figure()
    for cohort in selected:
        vals = df[df["cohort"] == cohort]["composite_improvement"].dropna()
        fig_box.add_trace(go.Box(y=vals.values, name=cohort, boxmean=True))
    fig_box.update_layout(yaxis_title="Composite Improvement", height=400)
    st.plotly_chart(fig_box, use_container_width=True)
else:
    st.info("Composite improvement data not available.")

st.divider()

# ---------------------------------------------------------------------------
# Demographics
# ---------------------------------------------------------------------------

st.subheader("Demographics")

demo_c1, demo_c2 = st.columns(2)

with demo_c1:
    st.markdown("**Age Band Distribution**")
    if "age_band" in df.columns:
        age_pivot = df.groupby(["cohort", "age_band"]).size().reset_index(name="count")
        fig_age = go.Figure()
        for cohort in selected:
            sub = age_pivot[age_pivot["cohort"] == cohort]
            fig_age.add_trace(go.Bar(name=cohort, x=sub["age_band"], y=sub["count"]))
        fig_age.update_layout(barmode="group", xaxis_title="Age Band", yaxis_title="Count", height=350)
        st.plotly_chart(fig_age, use_container_width=True)

with demo_c2:
    st.markdown("**Gender Split**")
    if "gender" in df.columns:
        gender_pivot = df.groupby(["cohort", "gender"]).size().reset_index(name="count")
        fig_gender = go.Figure()
        for cohort in selected:
            sub = gender_pivot[gender_pivot["cohort"] == cohort]
            fig_gender.add_trace(go.Bar(name=cohort, x=sub["gender"], y=sub["count"]))
        fig_gender.update_layout(barmode="group", xaxis_title="Gender", yaxis_title="Count", height=350)
        st.plotly_chart(fig_gender, use_container_width=True)
