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
