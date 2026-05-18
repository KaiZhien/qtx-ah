"""Profile missingness patterns across the cleaned analytic dataset.

Computes per-column missing counts and percentages broken down by followup
vs dropout patients. Writes an HTML report to reports/missingness_profile.html.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from qtx.utils.config import get_path
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def build_missingness_profile(df: pd.DataFrame) -> pd.DataFrame:
    """Build a missingness profile for each feature.

    Returns a DataFrame with columns:
    - feature: column name
    - n_total: total rows
    - n_missing: count of missing values
    - pct_missing: percentage missing (0-100)
    - n_missing_followup: missing count among rows where has_followup == "Y"
    - pct_missing_followup: pct missing among followup patients
    - n_missing_dropout: missing count among rows where has_followup == "N" (or is_dropout == 1)
    - pct_missing_dropout: pct missing among dropout patients
    - missing_diff: pct_missing_dropout - pct_missing_followup (positive = more missing in dropouts)

    Sort by pct_missing descending.
    """
    n_total = len(df)

    # Identify followup and dropout subsets
    if "has_followup" in df.columns:
        mask_followup = df["has_followup"] == "Y"
        mask_dropout = df["has_followup"] == "N"
    elif "is_dropout" in df.columns:
        mask_followup = df["is_dropout"] == 0
        mask_dropout = df["is_dropout"] == 1
    else:
        # Fallback: treat all rows as followup
        log.warning("Neither has_followup nor is_dropout found; dropout stats will be zero.")
        mask_followup = pd.Series([True] * n_total, index=df.index)
        mask_dropout = pd.Series([False] * n_total, index=df.index)

    df_followup = df[mask_followup]
    df_dropout = df[mask_dropout]
    n_followup = len(df_followup)
    n_dropout = len(df_dropout)

    rows = []
    for col in df.columns:
        n_missing = int(df[col].isna().sum())
        pct_missing = round(100.0 * n_missing / n_total, 2) if n_total > 0 else 0.0

        n_miss_fu = int(df_followup[col].isna().sum())
        pct_miss_fu = round(100.0 * n_miss_fu / n_followup, 2) if n_followup > 0 else 0.0

        n_miss_do = int(df_dropout[col].isna().sum())
        pct_miss_do = round(100.0 * n_miss_do / n_dropout, 2) if n_dropout > 0 else 0.0

        missing_diff = round(pct_miss_do - pct_miss_fu, 2)

        rows.append({
            "feature": col,
            "n_total": n_total,
            "n_missing": n_missing,
            "pct_missing": pct_missing,
            "n_missing_followup": n_miss_fu,
            "pct_missing_followup": pct_miss_fu,
            "n_missing_dropout": n_miss_do,
            "pct_missing_dropout": pct_miss_do,
            "missing_diff": missing_diff,
        })

    profile_df = pd.DataFrame(rows)
    profile_df = profile_df.sort_values("pct_missing", ascending=False).reset_index(drop=True)
    log.info("Built missingness profile for %d features (n=%d rows)", len(profile_df), n_total)
    return profile_df


def save_missingness_report(
    profile_df: pd.DataFrame,
    output_path: Path | None = None,
) -> Path:
    """Render the missingness profile as an HTML report.

    Uses a styled pandas table. Default output: reports/missingness_profile.html.
    Returns the output path.
    """
    if output_path is None:
        reports_dir = get_path("reports")
        reports_dir.mkdir(parents=True, exist_ok=True)
        output_path = reports_dir / "missingness_profile.html"

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def _row_style(row: pd.Series) -> str:
        """Return inline style for a table row based on pct_missing."""
        pct = row.get("pct_missing", 0.0)
        if pct >= 50:
            return "background-color: #f8d7da;"
        if pct >= 20:
            return "background-color: #fff3cd;"
        return ""

    # Build HTML table manually to avoid jinja2 dependency
    pct_cols = {"pct_missing", "pct_missing_followup", "pct_missing_dropout"}
    diff_cols = {"missing_diff"}

    def _fmt_cell(col: str, val: object) -> str:
        if col in pct_cols:
            return f"{val:.1f}%"
        if col in diff_cols:
            return f"{val:+.1f}pp"
        return str(val)

    header_html = "".join(f"<th>{c}</th>" for c in profile_df.columns)
    rows_html_parts = []
    for _, row in profile_df.iterrows():
        style = _row_style(row)
        style_attr = f' style="{style}"' if style else ""
        cells = "".join(f"<td>{_fmt_cell(c, row[c])}</td>" for c in profile_df.columns)
        rows_html_parts.append(f"<tr{style_attr}>{cells}</tr>")
    rows_html = "\n".join(rows_html_parts)

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Missingness Profile</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 20px; }}
    table {{ border-collapse: collapse; width: 100%; font-size: 0.9em; }}
    caption {{ font-size: 1.2em; font-weight: bold; padding: 8px; }}
    th {{ background-color: #2c3e50; color: white; padding: 6px 10px; text-align: left; }}
    td {{ border: 1px solid #ddd; padding: 4px 8px; text-align: right; }}
    th {{ border: 1px solid #1a252f; }}
    tr:nth-child(even) td {{ background-color: #f8f9fa; }}
  </style>
</head>
<body>
<table>
  <caption>Missingness Profile — QuantumTX AH Dataset</caption>
  <thead><tr>{header_html}</tr></thead>
  <tbody>
{rows_html}
  </tbody>
</table>
</body>
</html>"""

    output_path.write_text(html_content, encoding="utf-8")
    log.info("Missingness report saved to %s", output_path)
    return output_path
