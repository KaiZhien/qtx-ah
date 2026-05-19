"""Load and transform the supplement workbook into the dosage model's feature matrix.

Public API:
  build_dosage_matrix(df_raw) -> pd.DataFrame   # transform raw supplement rows
  load_dosage_data()           -> pd.DataFrame   # read file + transform
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from qtx.utils.config import get_dosage_config, get_path
from qtx.utils.logging import get_logger

log = get_logger(__name__)

_FLAG_MAP = {
    "knee_issue":           "hl_knee_issue",
    "leg_issue":            "hl_leg_issue",
    "back_spine_issue":     "hl_back_spine_issue",
    "balance_issue":        "hl_balance_issue",
    "upper_body_issue":     "hl_upper_body_issue",
    "foot_ankle_issue":     "hl_foot_ankle_issue",
    "neuro_issue":          "hl_neuro_issue",
    "frailty_issue":        "hl_frailty_issue",
    "metabolic_issue":      "hl_metabolic_issue",
    "injury_surgery_issue": "hl_injury_surgery_issue",
    "general_pain_issue":   "hl_general_pain_issue",
}


def build_dosage_matrix(df_raw: pd.DataFrame) -> pd.DataFrame:
    """Transform a raw supplement DataFrame into a modelling-ready feature matrix.

    Args:
        df_raw: DataFrame with columns matching cleaned_data.xlsx Sheet1
                (S/N, Age, Gender, Joined_with_pain, frequency, knee_issue, ...).

    Returns:
        DataFrame containing intake_features_encoded + frequency_label (int) +
        frequency_raw (str) + Gender_orig (str, for test inspection).
        Rows with NaN frequency are dropped.
    """
    cfg = get_dosage_config()
    label_map: dict[str, int] = cfg["label_map"]

    df = df_raw.copy()

    # Drop rows without a frequency label
    df = df[df["frequency"].notna()].copy()
    df["frequency_raw"] = df["frequency"].astype(str).str.strip().str.lower()
    df = df[df["frequency_raw"].isin(label_map)].copy()
    n_dropped = len(df_raw) - len(df)
    if n_dropped > 0:
        log.info("build_dosage_matrix: dropped %d rows with unknown/missing frequency", n_dropped)

    # Label
    df["frequency_label"] = df["frequency_raw"].map(label_map).astype(int)

    # Age
    df["age"] = pd.to_numeric(df["Age"], errors="coerce").fillna(df["Age"].median())

    # Gender: preserve original for tests, encode M→1 F→0
    df["Gender_orig"] = df["Gender"].astype(str).str.strip().str.upper()
    df["gender_M"] = (df["Gender_orig"] == "M").astype(int)

    # Joined with pain: Y→1 else 0
    jf = df["Joined_with_pain"].astype(str).str.strip().str.upper()
    df["joined_with_pain_Y"] = (jf == "Y").astype(int)

    # Condition flags: rename + fill NaN with 0
    df = df.rename(columns=_FLAG_MAP)
    for col in _FLAG_MAP.values():
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)

    feature_cols = cfg["intake_features_encoded"]
    missing = [c for c in feature_cols if c not in df.columns]
    if missing:
        raise KeyError(f"build_dosage_matrix: missing expected columns after encoding: {missing}")

    log.info(
        "build_dosage_matrix: %d rows, label distribution: %s",
        len(df),
        df["frequency_label"].value_counts().to_dict(),
    )
    return df.reset_index(drop=True)


def load_dosage_data(path: str | Path | None = None) -> pd.DataFrame:
    """Load cleaned_data.xlsx and return the dosage feature matrix.

    Args:
        path: Optional override for the supplement Excel path.
              Defaults to settings.yaml paths.supplement_excel.

    Returns:
        Output of build_dosage_matrix() on the loaded file.
    """
    if path is None:
        path = get_path("supplement_excel")
    path = Path(path)
    log.info("load_dosage_data: reading %s", path)
    df_raw = pd.read_excel(path, sheet_name="Sheet1")
    log.info("load_dosage_data: raw shape %s", df_raw.shape)
    return build_dosage_matrix(df_raw)
