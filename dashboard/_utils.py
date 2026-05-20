"""Shared dashboard utilities: data loading, model loading, filter rendering, CSS."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import joblib
import pandas as pd
import streamlit as st

from qtx.utils.config import get_project_root

if TYPE_CHECKING:
    import plotly.graph_objects as go

PROJECT_ROOT = get_project_root()
DATA_PATH = PROJECT_ROOT / "data" / "processed" / "dashboard_data.parquet"
MODELS_DIR = PROJECT_ROOT / "models"

# Fixed colour palette per cohort (order matches spec)
COHORT_COLORS: dict[str, str] = {
    "Pain & Musculoskeletal": "#2b6cb0",
    "Frailty/Sarcopenia": "#4fd1c7",
    "Neurological": "#b794f4",
    "Post-Surgical/Rehab": "#68d391",
    "Other-Mixed": "#f6ad55",
    "Wellness": "#fc8181",
}

_FALLBACK_COLORS = list(COHORT_COLORS.values())

# Applied to every Plotly figure via apply_chart_style()
CHART_LAYOUT = dict(
    paper_bgcolor="rgba(0,0,0,0)",
    plot_bgcolor="rgba(0,0,0,0)",
    font=dict(
        family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color="#64748b",
        size=12,
    ),
    margin=dict(l=0, r=0, t=40, b=0),
    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    xaxis=dict(gridcolor="#f1f5f9", linecolor="#e2e8f0", zeroline=False),
    yaxis=dict(gridcolor="#f1f5f9", linecolor="#e2e8f0", zeroline=False),
)


def apply_chart_style(fig: "go.Figure") -> "go.Figure":
    """Apply the standard chart theme to any Plotly figure. Returns the same figure."""
    fig.update_layout(**CHART_LAYOUT)
    return fig


def cohort_color(name: str, index: int = 0) -> str:
    """Return the design-system colour for a cohort name, falling back by index."""
    return COHORT_COLORS.get(name, _FALLBACK_COLORS[index % len(_FALLBACK_COLORS)])


def inject_css() -> None:
    """Inject global CSS overrides. Call once per page after st.set_page_config()."""
    st.markdown("""<style>
/* Hide Streamlit's auto-generated sidebar page nav (we use our own) */
[data-testid="stSidebarNav"] { display: none !important; }

/* Sidebar background */
section[data-testid="stSidebar"] { background-color: #0f2744 !important; }
[data-testid="stSidebar"] > div:first-child { background-color: #0f2744 !important; }

/* Sidebar text */
[data-testid="stSidebar"] .stMarkdown p,
[data-testid="stSidebar"] .stMarkdown h1,
[data-testid="stSidebar"] .stMarkdown h2,
[data-testid="stSidebar"] .stMarkdown h3 { color: rgba(255,255,255,0.85) !important; }

/* Sidebar page links */
[data-testid="stSidebar"] [data-testid="stPageLink"] a {
    color: rgba(255,255,255,0.6) !important;
    text-decoration: none !important;
    border-radius: 8px !important;
    padding: 0.45rem 0.75rem !important;
    display: block !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    transition: background 0.15s, color 0.15s !important;
}
[data-testid="stSidebar"] [data-testid="stPageLink"] a:hover {
    background: rgba(255,255,255,0.06) !important;
    color: #ffffff !important;
}
[data-testid="stSidebar"] [data-testid="stPageLink"]:has(a[aria-current="page"]) a {
    background: rgba(99,179,237,0.15) !important;
    color: #63b3ed !important;
}

/* Sidebar divider */
[data-testid="stSidebar"] hr { border-color: rgba(255,255,255,0.1) !important; }

/* Sidebar multiselect pills */
[data-testid="stSidebar"] span[data-baseweb="tag"] {
    background-color: rgba(99,179,237,0.15) !important;
    color: #63b3ed !important;
    border-radius: 4px !important;
}

/* Main area background */
.stApp { background-color: #f0f4f8 !important; }

/* Block container top padding */
[data-testid="block-container"] { padding-top: 1.5rem !important; }

/* Metric cards */
[data-testid="stMetric"] {
    background: #ffffff !important;
    border: 1px solid #e2e8f0 !important;
    border-radius: 12px !important;
    padding: 1.25rem 1.5rem !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04) !important;
}
[data-testid="stMetricValue"] {
    color: #0f2744 !important;
    font-size: 2rem !important;
    font-weight: 700 !important;
}
[data-testid="stMetricLabel"] {
    color: #64748b !important;
    font-size: 0.7rem !important;
    font-weight: 600 !important;
    letter-spacing: 0.06em !important;
    text-transform: uppercase !important;
}

/* Primary buttons */
.stButton > button[kind="primary"] {
    background-color: #0f2744 !important;
    color: #ffffff !important;
    border: none !important;
    border-radius: 8px !important;
    font-weight: 600 !important;
    padding: 0.5rem 1.5rem !important;
}
.stButton > button[kind="primary"]:hover { background-color: #1a3a5c !important; }
.stButton > button { border-radius: 8px !important; }

/* Input fields */
[data-testid="stTextInput"] input,
[data-testid="stNumberInput"] input {
    border-radius: 8px !important;
    border: 1px solid #e2e8f0 !important;
    background: #ffffff !important;
}

/* Progress bars */
[data-testid="stProgress"] > div > div { background-color: #2b6cb0 !important; }

/* Multiselect selected value tags (main area) */
span[data-baseweb="tag"] {
    background-color: rgba(43,108,176,0.1) !important;
    color: #2b6cb0 !important;
    border-radius: 4px !important;
}

/* Horizontal rules */
hr { border-color: #e2e8f0 !important; }

/* Success alerts */
[data-testid="stAlert"] { border-radius: 8px !important; }
</style>""", unsafe_allow_html=True)


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
