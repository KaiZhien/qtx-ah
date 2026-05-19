# Dashboard UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise the Streamlit dashboard from one cluttered page into three focused pages (Overview, Cohort Analysis, Clinical Tools) serving management, research, and clinical staff audiences respectively.

**Architecture:** Extract shared data/model loading into `dashboard/_utils.py`; refactor `app.py` to Overview; add `pages/cohort_analysis.py` (new) and `pages/clinical_tools.py` (new, merges Intake Estimator + Patient Lookup + Dosage Recommender); delete `pages/dosage_recommender.py`. No pipeline or library code changes.

**Tech Stack:** Python 3.11+, Streamlit, Plotly, pandas, joblib. All dashboard files use `PYTHONPATH` set via `sys.path.insert` at the top of each file (existing project convention).

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `dashboard/_utils.py` | `load_data()`, `load_models()`, `_unique_sorted()`, `apply_filters()`, `render_sidebar_filters()` |
| Modify | `dashboard/app.py` | Overview page — KPIs, cohort donut, pre/post plots, comorbidity chart; uses `_utils` |
| Create | `dashboard/pages/cohort_analysis.py` | Cohort comparison — summary table, rate charts, improvement distribution, demographics |
| Create | `dashboard/pages/clinical_tools.py` | Patient Lookup + Intake Estimator + Dosage Recommender on one page |
| Delete | `dashboard/pages/dosage_recommender.py` | Content moved into `clinical_tools.py` |
| Create | `tests/test_dashboard_utils.py` | Unit tests for pure functions in `_utils.py` |

---

## Task 1: Create `dashboard/_utils.py` and its tests

**Files:**
- Create: `dashboard/_utils.py`
- Create: `tests/test_dashboard_utils.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_dashboard_utils.py`:

```python
"""Unit tests for dashboard/_utils.py pure helper functions."""
import sys
import unittest.mock as mock
from pathlib import Path

# Mock streamlit before importing _utils so cache decorators don't require a live app
sys.modules.setdefault("streamlit", mock.MagicMock())

_dashboard = Path(__file__).resolve().parent.parent / "dashboard"
if str(_dashboard) not in sys.path:
    sys.path.insert(0, str(_dashboard))

import pandas as pd
import pytest

from _utils import _unique_sorted, apply_filters


def test_unique_sorted_basic():
    s = pd.Series([3, 1, 2, 1])
    assert _unique_sorted(s) == [1, 2, 3]


def test_unique_sorted_includes_missing_sentinel():
    s = pd.Series([1.0, None, 2.0])
    result = _unique_sorted(s)
    assert "__missing__" in result
    assert 1.0 in result


def test_unique_sorted_no_duplicate_missing():
    s = pd.Series(["a", None, "__missing__"])
    result = _unique_sorted(s)
    assert result.count("__missing__") == 1


def test_apply_filters_cohort():
    df = pd.DataFrame({
        "cohort": ["A", "B", "A"],
        "usage_frequency": ["once", "once", "twice"],
        "age_band": ["60-70", "60-70", "70-80"],
        "gender": ["M", "F", "M"],
    })
    result = apply_filters(df, {"cohort": ["A"], "usage_frequency": [], "age_band": [], "gender": []})
    assert list(result["cohort"]) == ["A", "A"]


def test_apply_filters_multiple_dims():
    df = pd.DataFrame({
        "cohort": ["A", "A", "B"],
        "usage_frequency": ["once", "twice", "once"],
        "age_band": ["60-70", "60-70", "70-80"],
        "gender": ["M", "F", "M"],
    })
    result = apply_filters(df, {
        "cohort": ["A"],
        "usage_frequency": ["once"],
        "age_band": [],
        "gender": [],
    })
    assert len(result) == 1
    assert result.iloc[0]["usage_frequency"] == "once"


def test_apply_filters_empty_selection_passes_all():
    df = pd.DataFrame({
        "cohort": ["A", "B"],
        "usage_frequency": ["once", "twice"],
        "age_band": ["60-70", "70-80"],
        "gender": ["M", "F"],
    })
    result = apply_filters(df, {"cohort": [], "usage_frequency": [], "age_band": [], "gender": []})
    assert len(result) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src .venv/bin/pytest tests/test_dashboard_utils.py -v
```

Expected: `ModuleNotFoundError: No module named '_utils'`

- [ ] **Step 3: Create `dashboard/_utils.py`**

```python
"""Shared dashboard utilities: data loading, model loading, filter rendering."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import joblib
import pandas as pd
import streamlit as st

from qtx.utils.config import get_project_root

PROJECT_ROOT = get_project_root()
DATA_PATH = PROJECT_ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = PROJECT_ROOT / "models"


@st.cache_data
def load_data() -> pd.DataFrame:
    return pd.read_parquet(DATA_PATH)


@st.cache_resource
def load_models() -> dict:
    paths = {
        "regression": MODELS_DIR / "regression.joblib",
        "classifier": MODELS_DIR / "classifier.joblib",
        "dropout": MODELS_DIR / "dropout.joblib",
        "dosage": MODELS_DIR / "dosage_frequency.joblib",
    }
    return {name: joblib.load(p) for name, p in paths.items() if p.exists()}


def _unique_sorted(series: pd.Series) -> list:
    vals = sorted(series.dropna().unique().tolist())
    if series.isna().any() and "__missing__" not in vals:
        vals.append("__missing__")
    return vals


def apply_filters(df: pd.DataFrame, filters: dict) -> pd.DataFrame:
    result = df.copy()
    for col, sel in [
        ("cohort", filters.get("cohort")),
        ("usage_frequency", filters.get("usage_frequency")),
        ("age_band", filters.get("age_band")),
        ("gender", filters.get("gender")),
    ]:
        if sel and col in result.columns:
            result = result[result[col].isin(sel)]
    return result


def render_sidebar_filters(df: pd.DataFrame) -> dict:
    sel_cohort = st.sidebar.multiselect(
        "Cohort", _unique_sorted(df["cohort"]), default=_unique_sorted(df["cohort"])
    )
    sel_usage = st.sidebar.multiselect(
        "Usage Frequency", _unique_sorted(df["usage_frequency"]), default=_unique_sorted(df["usage_frequency"])
    )
    sel_age_band = st.sidebar.multiselect(
        "Age Band", _unique_sorted(df["age_band"]), default=_unique_sorted(df["age_band"])
    )
    sel_gender = st.sidebar.multiselect(
        "Gender", _unique_sorted(df["gender"]), default=_unique_sorted(df["gender"])
    )
    if st.sidebar.button("Reset Filters"):
        st.rerun()
    return {
        "cohort": sel_cohort,
        "usage_frequency": sel_usage,
        "age_band": sel_age_band,
        "gender": sel_gender,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
PYTHONPATH=src .venv/bin/pytest tests/test_dashboard_utils.py -v
```

Expected: `6 passed`

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -v
```

Expected: `69 passed` (63 existing + 6 new)

- [ ] **Step 6: Commit**

```bash
git add dashboard/_utils.py tests/test_dashboard_utils.py
git commit -m "feat(dashboard): add shared _utils module with loaders and filter helpers"
```

---

## Task 2: Refactor `dashboard/app.py` into the Overview page

**Files:**
- Modify: `dashboard/app.py`

Changes: import from `_utils`, remove Intake Estimator expander, add cohort donut chart, update sidebar nav to 3 pages (no emojis).

- [ ] **Step 1: Replace `dashboard/app.py` entirely**

```python
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
```

- [ ] **Step 2: Verify the page runs without error**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
PYTHONPATH=src .venv/bin/streamlit run dashboard/app.py
```

Open http://localhost:8501. Verify:
- Sidebar shows "Overview", "Cohort Analysis", "Clinical Tools" — no emojis
- 4 KPI metrics appear
- Cohort donut chart appears between KPIs and the pre/post plots
- No Intake Estimator expander at the bottom
- Stop server with Ctrl+C

- [ ] **Step 3: Commit**

```bash
git add dashboard/app.py
git commit -m "feat(dashboard): refactor app.py into Overview page, add cohort donut, remove intake estimator"
```

---

## Task 3: Create `dashboard/pages/cohort_analysis.py`

**Files:**
- Create: `dashboard/pages/cohort_analysis.py`

- [ ] **Step 1: Create the file**

```python
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
```

- [ ] **Step 2: Verify the page renders**

```bash
PYTHONPATH=src .venv/bin/streamlit run dashboard/app.py
```

Navigate to the "Cohort Analysis" link in the sidebar. Verify:
- Page title is "Cohort Analysis" (no emoji)
- Cohort multiselect defaults to all non-Unclassified cohorts
- Summary table appears with N, %, rates per cohort
- Grouped bar chart appears
- Box plot and demographic charts appear
- Stop server with Ctrl+C

- [ ] **Step 3: Commit**

```bash
git add dashboard/pages/cohort_analysis.py
git commit -m "feat(dashboard): add Cohort Analysis page with summary table, rate charts, demographics"
```

---

## Task 4: Create `dashboard/pages/clinical_tools.py`

**Files:**
- Create: `dashboard/pages/clinical_tools.py`

This page has three sections: Patient Lookup, Intake Estimator, Dosage Recommender.

- [ ] **Step 1: Create the file**

```python
"""Clinical Tools page — Patient Lookup, Intake Estimator, Dosage Recommender."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # dashboard/ for _utils

import pandas as pd
import streamlit as st

from _utils import load_data, load_models
from qtx.dosage.predict import predict_frequency
from qtx.dosage.prepare import derive_features_for_prediction
from qtx.phenotype.classify import classify
from qtx.utils.config import get_dosage_config

cfg = get_dosage_config()

LABEL_DISPLAY = {
    "once": "Once per week (one leg)",
    "twice": "Twice per week (one leg per session)",
    "lr10": "L+R 10 (20-min, 10 min each leg)",
}
CONFIDENCE_THRESHOLD = 0.50

st.set_page_config(page_title="Clinical Tools", layout="wide", initial_sidebar_state="expanded")

st.sidebar.title("Navigation")
st.sidebar.page_link("app.py", label="Overview")
st.sidebar.page_link("pages/cohort_analysis.py", label="Cohort Analysis")
st.sidebar.page_link("pages/clinical_tools.py", label="Clinical Tools")

df_full = load_data()
models = load_models()

st.title("Clinical Tools")

# ===========================================================================
# Section 1: Patient Lookup
# ===========================================================================

st.subheader("Patient Lookup")

sn_query = st.text_input("Patient S/N", placeholder="e.g. 1.0")

if sn_query.strip():
    match = df_full[df_full["sn"].astype(str) == sn_query.strip()]

    if match.empty:
        st.warning(f"Patient not found: {sn_query.strip()!r}")
    else:
        row = match.iloc[0]
        st.markdown(f"**Record for S/N: {sn_query.strip()}**")
        c1, c2, c3, c4 = st.columns(4)

        with c1:
            st.markdown("**Demographics**")
            st.write(f"Age: {row.get('age', 'N/A')}")
            st.write(f"Gender: {row.get('gender', 'N/A')}")
            st.write(f"Cohort: {row.get('cohort', 'N/A')}")
            st.write(f"Usage Frequency: {row.get('usage_frequency', 'N/A')}")

        with c2:
            st.markdown("**Baseline Scores**")
            st.write(f"VAS Pain: {row.get('pre_vas', 'N/A')}")
            st.write(f"TUG (s): {row.get('pre_tug_s', 'N/A')}")
            st.write(f"5xSST (s): {row.get('pre_5xsst_s', 'N/A')}")
            st.write(f"Normal Gait (m/s): {row.get('pre_normal_gs_ms', 'N/A')}")
            st.write(f"SPPB: {row.get('baseline_sppb', 'N/A')}")

        with c3:
            st.markdown("**Conditions**")
            has_cols = [c for c in df_full.columns if c.startswith("has_") and c != "has_followup"]
            active = [c.replace("has_", "").replace("_", " ").title() for c in has_cols if row.get(c, 0) == 1]
            if active:
                for flag in active:
                    st.write(f"- {flag}")
            else:
                st.write("None recorded")

        with c4:
            st.markdown("**Outcomes**")
            st.write(f"Post VAS: {row.get('post_vas', 'N/A')}")
            st.write(f"Post TUG (s): {row.get('post_tug_s', 'N/A')}")
            ci = row.get("composite_improvement", None)
            st.write(f"Composite Improvement: {f'{ci:.2f}' if ci is not None and not (isinstance(ci, float) and pd.isna(ci)) else 'N/A'}")
            resp = row.get("overall_responder", None)
            st.write(f"Overall Responder: {'Yes' if resp == 1 else 'No' if resp == 0 else 'N/A'}")
            drop = row.get("is_dropout", None)
            st.write(f"Dropout: {'Yes' if drop == 1 else 'No' if drop == 0 else 'N/A'}")

st.divider()

# ===========================================================================
# Section 2: Intake Estimator
# ===========================================================================

st.subheader("Intake Estimator")
st.caption("Enter patient details to get model-predicted outcomes.")

COHORT_OPTIONS = [
    "Pain & Musculoskeletal", "Neurological", "Frailty/Sarcopenia",
    "Post-Surgical/Rehab", "Wellness", "Other-Mixed", "Unclassified",
]
USAGE_OPTIONS = [
    "L+R 10 (20-min session, 10 min each leg)",
    "Once (1x/week, one leg)",
    "Twice (2x/week, one leg per session)",
]

if "regression" in models:
    FEATURE_NAMES: list[str] = list(models["regression"].feature_names_in_)
    COHORT_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("cohort_")]
    USAGE_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("usage_frequency_")]
    GENDER_DUMMIES = [f for f in FEATURE_NAMES if f.startswith("gender_")]

    def _build_input_row(
        age: float, baseline_sppb: int, pre_tug: float, pre_5xsst: float,
        pre_normal_gs: float, usage: str, cohort: str, gender: str,
        has_flags: dict[str, int],
    ) -> pd.DataFrame:
        row: dict[str, float] = {
            "age": age,
            "baseline_sppb": float(baseline_sppb),
            "pre_normal_gs_ms": pre_normal_gs,
            "pre_tug_s": pre_tug,
            "pre_5xsst_s": pre_5xsst,
        }
        for feat in FEATURE_NAMES:
            if feat.startswith("has_"):
                row[feat] = float(has_flags.get(feat, 0))
        for col in COHORT_DUMMIES:
            row[col] = 1.0 if cohort == col.replace("cohort_", "") else 0.0
        for col in USAGE_DUMMIES:
            row[col] = 1.0 if usage == col.replace("usage_frequency_", "") else 0.0
        for col in GENDER_DUMMIES:
            row[col] = 1.0 if gender == col.replace("gender_", "") else 0.0
        for feat in FEATURE_NAMES:
            if feat not in row:
                row[feat] = 0.0
        return pd.DataFrame([row])[FEATURE_NAMES]

    ie_c1, ie_c2 = st.columns(2)
    with ie_c1:
        inp_age = st.number_input("Age", min_value=10, max_value=110, value=65, step=1, key="ie_age")
        inp_sppb = st.slider("Baseline SPPB", min_value=0, max_value=12, value=6, key="ie_sppb")
        inp_tug = st.number_input("Baseline TUG (seconds)", min_value=0.0, value=15.0, step=0.5, key="ie_tug")
        inp_5xsst = st.number_input("Baseline 5xSST (seconds)", min_value=0.0, value=20.0, step=0.5, key="ie_5xsst")
        inp_gs = st.number_input("Baseline Normal Gait Speed (m/s)", min_value=0.0, value=0.8, step=0.05, format="%.2f", key="ie_gs")
    with ie_c2:
        inp_usage = st.selectbox("Usage Frequency", USAGE_OPTIONS, key="ie_usage")
        inp_cohort = st.selectbox("Cohort", COHORT_OPTIONS, key="ie_cohort")
        inp_gender = st.selectbox("Gender", ["M", "F", "Unknown"], key="ie_gender")
        inp_tags = st.text_input(
            "Comorbidity Tags (free text)",
            placeholder="e.g. knee osteoarthritis, diabetes",
            key="ie_tags",
        )

    if st.button("Predict", type="primary", key="ie_predict"):
        try:
            classified = classify(pd.DataFrame([{"tags": inp_tags, "pain_location": ""}]))
            has_flags_derived = {col: int(classified[col].iloc[0]) for col in classified.columns if col.startswith("has_")}
        except Exception:
            has_flags_derived = {}

        X_pred = _build_input_row(
            age=float(inp_age), baseline_sppb=inp_sppb, pre_tug=inp_tug,
            pre_5xsst=inp_5xsst, pre_normal_gs=inp_gs, usage=inp_usage,
            cohort=inp_cohort,
            gender=inp_gender if inp_gender != "Unknown" else "__missing__",
            has_flags=has_flags_derived,
        )
        try:
            pred_improvement = float(models["regression"].predict(X_pred)[0])
            pred_responder = float(models["classifier"].predict_proba(X_pred)[0][1])
            pred_dropout = float(models["dropout"].predict_proba(X_pred)[0][1])
            r1, r2, r3 = st.columns(3)
            r1.metric("Predicted Composite Improvement", f"{pred_improvement:.2f}")
            r2.metric("P(Responder)", f"{pred_responder:.1%}")
            r3.metric("P(Dropout)", f"{pred_dropout:.1%}")
            st.caption("Model predictions based on similar patients. Not a clinical guarantee.")
        except Exception as e:
            st.error(f"Prediction failed: {e}")
else:
    st.info("Clinical outcome models not found. Run `make model` first.")

st.divider()

# ===========================================================================
# Section 3: Dosage Recommender
# ===========================================================================

st.subheader("Dosage Recommender")
st.caption("Predicts the recommended treatment frequency based on intake information.")

dosage_model = models.get("dosage")

if dosage_model is None:
    st.error("Dosage model not found at `models/dosage_frequency.joblib`. Run `make dosage` to train it first.")
else:
    dr_c1, dr_c2 = st.columns(2)
    with dr_c1:
        dr_age = st.number_input("Age", min_value=18, max_value=110, value=70, step=1, key="dr_age")
        dr_gender = st.selectbox("Gender", ["F", "M"], key="dr_gender")
    with dr_c2:
        dr_pain = st.selectbox("Joined with pain?", ["Y", "N"], key="dr_pain")

    st.markdown("**Reported Conditions**")
    cond_cols = st.columns(3)
    conditions = {
        "hl_knee_issue": "Knee issue",
        "hl_leg_issue": "Leg weakness",
        "hl_back_spine_issue": "Back/spine issue",
        "hl_balance_issue": "Balance issue",
        "hl_upper_body_issue": "Upper body issue",
        "hl_foot_ankle_issue": "Foot/ankle issue",
        "hl_neuro_issue": "Neurological",
        "hl_frailty_issue": "Frailty",
        "hl_metabolic_issue": "Metabolic (e.g. diabetes)",
        "hl_injury_surgery_issue": "Injury/surgery",
        "hl_general_pain_issue": "General pain",
    }
    condition_values: dict[str, int] = {}
    for i, (key, label) in enumerate(conditions.items()):
        with cond_cols[i % 3]:
            condition_values[key] = int(st.checkbox(label, key=f"dr_{key}"))

    st.markdown("---")

    if st.button("Get Recommendation", type="primary", key="dr_predict"):
        patient_base = {
            "age": float(dr_age),
            "gender_M": 1 if dr_gender == "M" else 0,
            "joined_with_pain_Y": 1 if dr_pain == "Y" else 0,
            **{k: float(v) for k, v in condition_values.items()},
        }
        patient = derive_features_for_prediction(patient_base)
        result = predict_frequency(
            patient, dosage_model, cfg["intake_features_encoded"], cfg["label_names"]
        )
        rec, conf, probs = result["recommendation"], result["confidence"], result["probabilities"]

        st.markdown("**Recommendation**")
        st.success(f"**{LABEL_DISPLAY.get(rec, rec)}**")
        st.metric("Model confidence", f"{int(conf * 100)}%")

        if conf < CONFIDENCE_THRESHOLD:
            st.warning(
                f"Confidence is below {int(CONFIDENCE_THRESHOLD * 100)}%. "
                "The patient profile is atypical — clinician judgement should take precedence."
            )

        st.markdown("**Probability breakdown**")
        for name, prob in sorted(probs.items(), key=lambda x: -x[1]):
            st.progress(prob, text=f"{LABEL_DISPLAY.get(name, name)}: {prob:.0%}")

        st.caption(
            "This recommendation is based on intake features only. "
            "Always use clinical judgement alongside this tool."
        )
```

- [ ] **Step 2: Verify the page renders**

```bash
PYTHONPATH=src .venv/bin/streamlit run dashboard/app.py
```

Navigate to "Clinical Tools" in the sidebar. Verify:
- "Patient Lookup" section appears at top — enter a valid S/N (e.g. `1.0`) and confirm a 4-column record card appears
- "Intake Estimator" section is fully visible with no expander needed — fill in values and click "Predict", confirm 3 metric cards appear
- "Dosage Recommender" section appears at the bottom — fill in and click "Get Recommendation", confirm output appears
- No emojis anywhere on the page
- Stop server with Ctrl+C

- [ ] **Step 3: Commit**

```bash
git add dashboard/pages/clinical_tools.py
git commit -m "feat(dashboard): add Clinical Tools page with Patient Lookup, Intake Estimator, Dosage Recommender"
```

---

## Task 5: Delete `dosage_recommender.py` and run full smoke test

**Files:**
- Delete: `dashboard/pages/dosage_recommender.py`

- [ ] **Step 1: Delete the old dosage recommender page**

```bash
git rm dashboard/pages/dosage_recommender.py
git commit -m "feat(dashboard): remove standalone dosage_recommender page (merged into clinical_tools)"
```

- [ ] **Step 2: Run the full test suite**

```bash
PYTHONPATH=src .venv/bin/pytest tests/ -v
```

Expected: `69 passed, 0 failed`

- [ ] **Step 3: Full smoke test — all three pages**

```bash
PYTHONPATH=src .venv/bin/streamlit run dashboard/app.py
```

Walk through all three pages and verify the following checklist:

**Overview:**
- [ ] Sidebar shows exactly: "Overview", "Cohort Analysis", "Clinical Tools" — no emojis
- [ ] 4 KPI metrics render correctly
- [ ] Cohort donut chart appears
- [ ] Pre/post boxplots appear (6 tests)
- [ ] Comorbidity bar chart appears
- [ ] Sidebar filters work — deselect a cohort, charts update

**Cohort Analysis:**
- [ ] Page loads without error
- [ ] Multiselect defaults to all non-Unclassified cohorts
- [ ] Deselecting to 1 cohort shows "Select at least 2" message
- [ ] Summary table renders with correct columns
- [ ] Grouped bar chart and box plots render
- [ ] Demographics charts render

**Clinical Tools:**
- [ ] Patient Lookup with a valid S/N returns a 4-column record card
- [ ] Patient Lookup with an invalid S/N shows "Patient not found"
- [ ] Intake Estimator inputs are immediately visible (no expander)
- [ ] Clicking "Predict" returns 3 metric cards
- [ ] Dosage Recommender form renders and "Get Recommendation" returns output
- [ ] No emojis anywhere on the page

Stop server with Ctrl+C.

- [ ] **Step 4: Final commit if any fixes were needed during smoke test**

```bash
git add -p  # stage only what changed
git commit -m "fix(dashboard): address issues found during smoke test"
```
