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


def _add_engineered_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add clinically-grounded composite features to the encoded dosage DataFrame.

    All features derived from base intake columns that must already be present.
    Scientific rationale in config/dosage.yaml comments.
    """
    df = df.copy()
    df["age_above_65"] = (df["age"] >= 65).astype(float)
    df["age_above_75"] = (df["age"] >= 75).astype(float)
    df["bilateral_lower_limb_load"] = (
        df["hl_knee_issue"] + df["hl_leg_issue"]
        + df["hl_foot_ankle_issue"] + df["hl_balance_issue"]
    ).clip(upper=4).astype(float)
    df["inflammatory_burden"] = (
        df["hl_knee_issue"] + df["hl_back_spine_issue"]
        + df["hl_general_pain_issue"] + df["hl_injury_surgery_issue"]
    ).astype(float)
    df["elderly_frailty"] = (df["age_above_65"] * df["hl_frailty_issue"]).astype(float)
    df["muscle_atrophy_risk"] = (
        df["age_above_65"] * (df["hl_frailty_issue"] + df["hl_neuro_issue"] + df["hl_leg_issue"])
    ).clip(upper=3).astype(float)
    df["pain_with_knee"] = (df["hl_knee_issue"] * df["joined_with_pain_Y"]).astype(float)
    return df


def derive_features_for_prediction(patient: dict) -> dict:
    """Compute clinically-engineered features from a base intake feature dict.

    Call this before predict_frequency() when the patient dict was assembled from
    raw UI inputs (age, gender_M, joined_with_pain_Y, hl_* flags only).
    Returns a new dict with all base features plus the seven engineered ones.
    """
    age = float(patient.get("age", 0))
    age_above_65 = float(age >= 65)
    age_above_75 = float(age >= 75)

    knee   = float(patient.get("hl_knee_issue", 0))
    leg    = float(patient.get("hl_leg_issue", 0))
    foot   = float(patient.get("hl_foot_ankle_issue", 0))
    bal    = float(patient.get("hl_balance_issue", 0))
    back   = float(patient.get("hl_back_spine_issue", 0))
    gp     = float(patient.get("hl_general_pain_issue", 0))
    inj    = float(patient.get("hl_injury_surgery_issue", 0))
    frail  = float(patient.get("hl_frailty_issue", 0))
    neuro  = float(patient.get("hl_neuro_issue", 0))
    pain_y = float(patient.get("joined_with_pain_Y", 0))

    return {
        **patient,
        "age_above_65": age_above_65,
        "age_above_75": age_above_75,
        "bilateral_lower_limb_load": min(knee + leg + foot + bal, 4.0),
        "inflammatory_burden": knee + back + gp + inj,
        "elderly_frailty": age_above_65 * frail,
        "muscle_atrophy_risk": min(age_above_65 * (frail + neuro + leg), 3.0),
        "pain_with_knee": knee * pain_y,
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
    age_numeric = pd.to_numeric(df["Age"], errors="coerce")
    df["age"] = age_numeric.fillna(age_numeric.median())

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

    df = _add_engineered_features(df)

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
