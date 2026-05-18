"""Compute descriptive statistics tables for the full cohort and by subgroup.

Produces Table 1-style summaries (mean ± SD for continuous, n (%) for
categorical), paired pre/post comparison tables with Wilcoxon p-values,
and effect size (Cohen's d) per outcome test. Outputs saved to reports/.
"""

from __future__ import annotations

import pandas as pd
import numpy as np


def summary_table(df: pd.DataFrame) -> pd.DataFrame:
    """
    Return a descriptive summary table grouped by cohort x usage_frequency x age_band.

    Columns:
    - cohort, usage_frequency, age_band
    - n: count of patients
    - n_followup: count with has_followup == "Y"
    - pct_followup: n_followup / n * 100
    - mean_age, median_age
    - pct_female: % of gender == "F" (excluding __missing__)
    - pct_male: % of gender == "M"
    - mean_composite: mean(composite_improvement) where not NaN
    - pct_overall_responder: % with overall_responder == 1 (of those with followup)

    Also produce an overall row (all patients).
    """
    group_cols = ["cohort", "usage_frequency", "age_band"]

    def compute_stats(sub: pd.DataFrame) -> pd.Series:
        n = len(sub)
        n_followup = (sub["has_followup"] == "Y").sum()
        pct_followup = n_followup / n * 100 if n > 0 else np.nan

        gender_known = sub[sub["gender"] != "__missing__"]
        n_gender_known = len(gender_known)
        pct_female = (gender_known["gender"] == "F").sum() / n_gender_known * 100 if n_gender_known > 0 else np.nan
        pct_male = (gender_known["gender"] == "M").sum() / n_gender_known * 100 if n_gender_known > 0 else np.nan

        age_vals = sub["age"].dropna()
        mean_age = age_vals.mean() if len(age_vals) > 0 else np.nan
        median_age = age_vals.median() if len(age_vals) > 0 else np.nan

        comp_vals = sub["composite_improvement"].dropna()
        mean_composite = comp_vals.mean() if len(comp_vals) > 0 else np.nan

        followup_sub = sub[sub["has_followup"] == "Y"]
        n_resp = len(followup_sub)
        if n_resp > 0:
            pct_overall_responder = (followup_sub["overall_responder"] == 1).sum() / n_resp * 100
        else:
            pct_overall_responder = np.nan

        return pd.Series({
            "n": n,
            "n_followup": int(n_followup),
            "pct_followup": round(pct_followup, 1),
            "mean_age": round(mean_age, 1) if not np.isnan(mean_age) else np.nan,
            "median_age": round(median_age, 1) if not np.isnan(median_age) else np.nan,
            "pct_female": round(pct_female, 1) if not np.isnan(pct_female) else np.nan,
            "pct_male": round(pct_male, 1) if not np.isnan(pct_male) else np.nan,
            "mean_composite": round(mean_composite, 3) if not np.isnan(mean_composite) else np.nan,
            "pct_overall_responder": round(pct_overall_responder, 1) if not np.isnan(pct_overall_responder) else np.nan,
        })

    # Grouped rows
    grouped = df.groupby(group_cols, observed=True).apply(compute_stats).reset_index()

    # Overall row
    overall_stats = compute_stats(df)
    overall_row = pd.DataFrame([{
        "cohort": "OVERALL",
        "usage_frequency": "OVERALL",
        "age_band": "OVERALL",
        **overall_stats.to_dict(),
    }])

    result = pd.concat([overall_row, grouped], ignore_index=True)
    return result


def cohort_counts(df: pd.DataFrame) -> pd.DataFrame:
    """Return simple cohort distribution: cohort, n, pct."""
    counts = df["cohort"].value_counts().reset_index()
    counts.columns = ["cohort", "n"]
    counts["pct"] = (counts["n"] / counts["n"].sum() * 100).round(1)
    return counts.sort_values("n", ascending=False).reset_index(drop=True)


def age_distribution(df: pd.DataFrame) -> dict:
    """Return {mean, median, std, min, max, n_missing} for age."""
    age = df["age"]
    n_missing = int(age.isna().sum())
    valid = age.dropna()
    return {
        "mean": round(float(valid.mean()), 2) if len(valid) > 0 else None,
        "median": round(float(valid.median()), 2) if len(valid) > 0 else None,
        "std": round(float(valid.std()), 2) if len(valid) > 0 else None,
        "min": round(float(valid.min()), 2) if len(valid) > 0 else None,
        "max": round(float(valid.max()), 2) if len(valid) > 0 else None,
        "n_missing": n_missing,
    }
