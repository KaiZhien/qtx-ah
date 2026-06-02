"""Script 14 — EDA for RAISE combined dataset (4 eldercare centres).

Usage:
    .venv/bin/python3.14 scripts/14_eda_raise_data.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

EXCEL_PATH = Path("/Users/reetmitra/Downloads/Raise combined data (4 centres).xlsx")
SHEET = "All Combined 21Aug23"


def _load() -> pd.DataFrame:
    df = pd.read_excel(EXCEL_PATH, sheet_name=SHEET, skiprows=3, header=0)
    df = df.dropna(subset=["Name"])
    df["Gender"] = df["Gender"].astype(str).str.strip().str[:1].str.upper()
    df["Centre"] = df["S/N"].astype(str).str.extract(r"^([A-Z]+)")[0]
    df["Age_clean"] = pd.to_numeric(df["Age"], errors="coerce")
    return df


def _section(title: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


def _outcome_stats(df: pd.DataFrame, pre_col: str, post_col: str, label: str) -> None:
    pre = pd.to_numeric(df[pre_col], errors="coerce") if pre_col in df.columns else pd.Series(dtype=float)
    post = pd.to_numeric(df[post_col], errors="coerce") if post_col in df.columns else pd.Series(dtype=float)
    paired = pre.notna() & post.notna()
    n = paired.sum()
    if n == 0:
        print(f"  {label}: no paired data")
        return
    delta = post[paired] - pre[paired]
    print(f"  {label}:")
    print(f"    n paired       = {n}")
    print(f"    pre  mean±sd   = {pre[paired].mean():.2f} ± {pre[paired].std():.2f}  [{pre[paired].min():.1f}–{pre[paired].max():.1f}]")
    print(f"    post mean±sd   = {post[paired].mean():.2f} ± {post[paired].std():.2f}  [{post[paired].min():.1f}–{post[paired].max():.1f}]")
    print(f"    delta mean±sd  = {delta.mean():.2f} ± {delta.std():.2f}")


def main() -> None:
    df = _load()

    _section("OVERVIEW")
    print(f"  Total patient rows : {len(df)}")
    print(f"  Columns            : {len(df.columns)}")
    print()
    print("  Patients per centre:")
    for centre, cnt in df["Centre"].value_counts().items():
        print(f"    {centre}: {cnt}")
    print()
    print(f"  Age: {df['Age_clean'].min():.0f}–{df['Age_clean'].max():.0f}, mean {df['Age_clean'].mean():.1f}, median {df['Age_clean'].median():.0f}")
    print(f"  Gender: {df['Gender'].value_counts().to_dict()}")

    _section("DATA QUALITY")
    key_cols = {
        "Pre Tandem result (s)": "Pre Tandem (s)",
        "Post Tandem result (s)": "Post Tandem (s)",
        "Pre Normal Gait Speed (m/s)": "Pre NGS (m/s)",
        "Post Normal Gait Speed (m/s)": "Post NGS (m/s)",
        "Pre TUG result (s)": "Pre TUG (s)",
        "Post TUG result (s)": "Post TUG (s)",
        "Pre 5XSST result (s)": "Pre 5XSST (s)",
        "Post 5XSST result (s)": "Post 5XSST (s)",
        "Pre Bixeps VAS": "Pre VAS",
        "Post BIXEPS VAS": "Post VAS",
        "SPPB OVERALL SCORE": "Pre SPPB",
        "SPPB OVERALL SCORE.1": "Post SPPB",
    }
    for col, label in key_cols.items():
        if col not in df.columns:
            print(f"  ⚠  MISSING COLUMN: {col!r}")
            continue
        numeric = pd.to_numeric(df[col], errors="coerce")
        n_valid = numeric.notna().sum()
        n_total = len(df)
        print(f"  {label:<20}: {n_valid:3d}/{n_total} valid  ({100*n_valid/n_total:.0f}%)")

    _section("OUTCOME DISTRIBUTIONS")
    _outcome_stats(df, "Pre Tandem result (s)", "Post Tandem result (s)", "Tandem stand (s, higher=better)")
    _outcome_stats(df, "Pre Normal Gait Speed (m/s)", "Post Normal Gait Speed (m/s)", "Normal gait speed (m/s, higher=better)")
    _outcome_stats(df, "Pre TUG result (s)", "Post TUG result (s)", "TUG (s, lower=better)")
    _outcome_stats(df, "Pre 5XSST result (s)", "Post 5XSST result (s)", "5xSST (s, lower=better)")
    _outcome_stats(df, "Pre Bixeps VAS", "Post BIXEPS VAS", "Overall VAS (lower=better)")
    _outcome_stats(df, "SPPB OVERALL SCORE", "SPPB OVERALL SCORE.1", "SPPB total (higher=better)")

    _section("CENTRE COMPARISON — mean pre TUG (s)")
    for centre, grp in df.groupby("Centre"):
        tug = pd.to_numeric(grp["Pre TUG result (s)"], errors="coerce") if "Pre TUG result (s)" in df.columns else pd.Series(dtype=float)
        print(f"  {centre}: n={tug.notna().sum()}  mean={tug.mean():.2f}s  median={tug.median():.2f}s")

    _section("CENTRE COMPARISON — mean pre SPPB")
    for centre, grp in df.groupby("Centre"):
        sppb = pd.to_numeric(grp["SPPB OVERALL SCORE"], errors="coerce") if "SPPB OVERALL SCORE" in df.columns else pd.Series(dtype=float)
        print(f"  {centre}: n={sppb.notna().sum()}  mean={sppb.mean():.2f}  median={sppb.median():.2f}")

    _section("TAG / CONDITION FREQUENCY")
    tags_all = df["Tags"].dropna().str.lower()
    conditions = {
        "Stroke": "stroke",
        "Diabetes": "diabetes",
        "OA / osteoarthritis": "oa",
        "Hypertension": "hypertension",
        "Parkinson": "parkinson",
        "Dementia": "dementia",
        "Back/Spine": "back pain|spine|spinal",
        "Knee pain": "knee",
        "Shoulder pain": "shoulder",
        "Numbness": "numbness",
        "Cramps": "cramps",
        "Cancer": "cancer",
        "Cholesterol": "cholesterol",
        "Wheelchair": "wheelchair",
        "Frailty": "frail",
    }
    for label, kw in conditions.items():
        n = tags_all.str.contains(kw, regex=True, na=False).sum()
        print(f"  {label:<25}: {n:3d}  ({100*n/len(df):.0f}%)")

    _section("MISSING / EDGE CASES")
    missing_age = df["Age_clean"].isna().sum()
    missing_name = df["Name"].isna().sum()
    bad_gender = (~df["Gender"].isin(["M", "F"])).sum()
    print(f"  Missing Age        : {missing_age}")
    print(f"  Missing Name       : {missing_name}")
    print(f"  Non M/F gender     : {bad_gender}")
    dup_sn = df["S/N"].duplicated().sum()
    print(f"  Duplicate S/N      : {dup_sn}")
    print()


if __name__ == "__main__":
    main()
