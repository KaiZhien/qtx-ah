"""Script 21 — On-demand calibration metrics: session_predictions vs actual outcomes.

Queries session_predictions against measured sessions.composite_improvement,
computes MAE, RMSE, and bias (mean_error) per cohort and per month, and prints
two formatted tables to stdout.

Useful for detecting prediction drift and model recalibration needs.

Usage:
    PYTHONPATH=src:api python scripts/21_calibration_report.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "api"))

import os
import numpy as np
import pandas as pd
from sqlalchemy import create_engine, text

DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg2://qtx:secret@localhost:5432/qtxah"
)


def compute_cohort_metrics(df: pd.DataFrame) -> pd.DataFrame:
    """Given df with columns [cohort, predicted, actual], return per-cohort MAE/RMSE/bias.

    Returns sorted by MAE descending. Returns empty DataFrame if input is empty.
    """
    if df.empty:
        return pd.DataFrame()

    metrics = []
    for cohort in df["cohort"].dropna().unique():
        cohort_data = df[df["cohort"] == cohort]
        if cohort_data.empty:
            continue

        predicted = cohort_data["predicted"].values
        actual = cohort_data["actual"].values

        mae = np.mean(np.abs(predicted - actual))
        rmse = np.sqrt(np.mean((predicted - actual) ** 2))
        bias = np.mean(predicted - actual)

        metrics.append({
            "cohort": cohort,
            "n": len(cohort_data),
            "mae": mae,
            "rmse": rmse,
            "bias": bias,
        })

    result_df = pd.DataFrame(metrics)
    if not result_df.empty:
        result_df = result_df.sort_values("mae", ascending=False).reset_index(drop=True)
    return result_df


def compute_monthly_trend(df: pd.DataFrame) -> pd.DataFrame:
    """Given df with columns [predicted, actual, predicted_at], return per-month MAE/RMSE.

    predicted_at is a datetime. Returns empty DataFrame if input is empty.
    """
    if df.empty:
        return pd.DataFrame()

    # Extract year-month from predicted_at
    df = df.copy()
    df["predicted_at"] = pd.to_datetime(df["predicted_at"], errors="coerce")
    df = df.dropna(subset=["predicted_at"])
    df["month"] = df["predicted_at"].dt.to_period("M")

    metrics = []
    for month in sorted(df["month"].dropna().unique()):
        month_data = df[df["month"] == month]
        if month_data.empty:
            continue

        predicted = month_data["predicted"].values
        actual = month_data["actual"].values

        mae = np.mean(np.abs(predicted - actual))
        rmse = np.sqrt(np.mean((predicted - actual) ** 2))

        metrics.append({
            "month": str(month),
            "n": len(month_data),
            "mae": mae,
            "rmse": rmse,
        })

    result_df = pd.DataFrame(metrics)
    return result_df


def main() -> None:
    """Fetch predictions, compute metrics, print two formatted tables."""
    engine = create_engine(DB_URL)

    # Single unified query with proper filters
    query = text("""
        SELECT
            p.cohort,
            sp.predicted_composite_improvement AS predicted,
            s.composite_improvement AS actual,
            sp.predicted_at
        FROM session_predictions sp
        JOIN sessions s ON s.id = sp.session_id
        JOIN patients p ON p.id = sp.patient_id
        WHERE sp.predicted_composite_improvement IS NOT NULL
          AND s.composite_improvement IS NOT NULL
          AND (s.ingested_from NOT ILIKE '%raise%' OR s.ingested_from IS NULL)
    """)

    print("Querying session_predictions ...")
    with engine.connect() as conn:
        rows = conn.execute(query).fetchall()

    if not rows:
        print("No matching predictions found. Exiting.")
        return

    # Convert to DataFrame
    records = [dict(r._mapping) for r in rows]
    df = pd.DataFrame(records)
    total_n = len(df)

    print(f"Found {total_n} matching prediction rows.\n")

    # Compute per-cohort metrics
    cohort_metrics = compute_cohort_metrics(df)

    # Print per-cohort table
    print("=" * 70)
    print(f"=== Per-Cohort Calibration (n={total_n}) ===")
    if cohort_metrics.empty:
        print("No cohort data available.")
    else:
        print(f"{'Cohort':<30} {'n':>6} {'MAE':>8} {'RMSE':>8} {'Bias':>8}")
        print("-" * 70)
        for _, row in cohort_metrics.iterrows():
            cohort_name = str(row["cohort"])[:29]
            print(
                f"{cohort_name:<30} {row['n']:>6.0f} {row['mae']:>8.3f} "
                f"{row['rmse']:>8.3f} {row['bias']:>+8.3f}"
            )
    print("=" * 70)
    print()

    # Compute monthly trend
    monthly_metrics = compute_monthly_trend(df)

    # Print monthly trend table
    print("=" * 70)
    print("=== Monthly Prediction Drift ===")
    if monthly_metrics.empty:
        print("No monthly data available.")
    else:
        print(f"{'Month':<12} {'n':>6} {'MAE':>8} {'RMSE':>8}")
        print("-" * 70)
        for _, row in monthly_metrics.iterrows():
            print(
                f"{row['month']:<12} {row['n']:>6.0f} {row['mae']:>8.3f} "
                f"{row['rmse']:>8.3f}"
            )
    print("=" * 70)

    engine.dispose()


if __name__ == "__main__":
    main()
