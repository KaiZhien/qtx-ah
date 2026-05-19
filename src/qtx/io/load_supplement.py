"""Load the hand-cleaned supplement workbook (cleaned_data.xlsx).

Provides tags_clean (lowercased, pre-cleaned tags text) and 11 hand-labeled
binary condition flags (hl_*) keyed on patient S/N.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import pandas as pd

from qtx.utils.config import get_path, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)

# Mapping from source column names → canonical hl_* names
_FLAG_MAP = {
    "knee_issue":          "hl_knee_issue",
    "leg_issue":           "hl_leg_issue",
    "back_spine_issue":    "hl_back_spine_issue",
    "balance_issue":       "hl_balance_issue",
    "upper_body_issue":    "hl_upper_body_issue",
    "foot_ankle_issue":    "hl_foot_ankle_issue",
    "neuro_issue":         "hl_neuro_issue",
    "frailty_issue":       "hl_frailty_issue",
    "metabolic_issue":     "hl_metabolic_issue",
    "injury_surgery_issue":"hl_injury_surgery_issue",
    "general_pain_issue":  "hl_general_pain_issue",
}


@lru_cache(maxsize=1)
def load_supplement(path: str | Path | None = None) -> pd.DataFrame:
    """Load cleaned_data.xlsx and return a DataFrame with sn, tags_clean, and hl_* flags.

    Columns returned:
    - sn (float): patient S/N, used as join key
    - tags_clean (str): lowercased, pre-cleaned tags text
    - hl_knee_issue … hl_general_pain_issue (Int64): 11 hand-labeled binary flags

    Returns an empty DataFrame with the correct schema if the file is not found.
    """
    if path is None:
        path = get_path("supplement_excel")

    path = Path(path)
    if not path.exists():
        log.warning("Supplement file not found: %s — skipping hand-labeled flags", path)
        return pd.DataFrame(columns=["sn", "tags_clean"] + list(_FLAG_MAP.values()))

    log.info("Loading supplement: %s", path)
    df = pd.read_excel(path, sheet_name="Sheet1")

    # Normalise S/N → string "1.0", "2.0" … to match the sn column in cleaned/phenotyped DataFrames
    df["sn"] = pd.to_numeric(df["S/N"], errors="coerce").astype("float64").astype(str)

    # tags_clean: lowercase strip, treat empty string as NA
    df["tags_clean"] = (
        df["Tags_clean"]
        .astype(str)
        .str.strip()
        .replace({"nan": pd.NA, "": pd.NA})
    )

    # Rename flag columns
    df = df.rename(columns=_FLAG_MAP)

    # Coerce flags to nullable integer (0/1/NA)
    for col in _FLAG_MAP.values():
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    keep = ["sn", "tags_clean"] + list(_FLAG_MAP.values())
    result = df[keep].drop_duplicates(subset="sn")

    n_with_flags = result[list(_FLAG_MAP.values())].eq(1).any(axis=1).sum()
    log.info(
        "Supplement loaded: %d rows, %d with ≥1 hand-labeled flag, %d with tags_clean",
        len(result),
        n_with_flags,
        result["tags_clean"].notna().sum(),
    )
    return result
