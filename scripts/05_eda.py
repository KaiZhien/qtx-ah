"""Script 05 — Run exploratory data analysis and generate the EDA report.

Loads featured.parquet, runs descriptives and stratified analyses,
renders the Jinja2 HTML report, and saves all figures to reports/.

Usage:
    PYTHONPATH=src python scripts/05_eda.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure src/ is on the path when run as a script
_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from qtx.io.persist import load_parquet
from qtx.eda.report import render_eda_report
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def main() -> None:
    # 1. Load featured.parquet
    log.info("Loading featured.parquet ...")
    df = load_parquet("featured")
    log.info("Loaded %d rows, %d columns", len(df), df.shape[1])

    # 2. Render EDA report
    log.info("Rendering EDA report ...")
    output_path = render_eda_report(df)

    # 3. Confirm
    size_kb = output_path.stat().st_size / 1024
    print(f"EDA report saved to {output_path}")
    log.info("Report size: %.1f KB", size_kb)


if __name__ == "__main__":
    main()
