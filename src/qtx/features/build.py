"""Assemble the final analytic feature matrix for modelling.

Joins cleaned + phenotyped + outcomes data into a modelling-ready matrix.
Applies missingness policies from config/missingness.yaml, validates the
schema with pandera, and writes the featured snapshot to data/processed/.
"""

from __future__ import annotations

import warnings

import pandas as pd
import pandera as pa

from qtx.io.persist import load_parquet, save_parquet
from qtx.utils.config import get_missingness_config, get_models_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def build_feature_matrix(df: pd.DataFrame | None = None) -> pd.DataFrame:
    """
    Join cleaned + phenotyped + outcomes data into a modelling-ready matrix.

    If df is None, loads data/processed/outcomes.parquet (which already has all
    cleaned + phenotyped + outcomes columns joined).

    Steps:
    1. Load outcomes.parquet if df is None
    2. Derive is_dropout = 1 if has_followup == "N" else 0 (if not already present)
    3. Ensure has_followup is present
    4. Apply missingness.yaml fill_zero policy to all has_* columns (fill NaN with 0)
    5. Apply missingness.yaml category_missing to gender and usage_frequency
       (fill NaN with "__missing__")
    6. Ensure all expected feature columns from models.yaml are present;
       warn if any are missing
    7. Validate schema with pandera (basic check: expected columns exist,
       is_dropout is 0/1 integer, has_followup is "Y"/"N" string)
    8. Save as data/processed/featured.parquet (versioned)
    9. Return the featured DataFrame
    """
    # ------------------------------------------------------------------
    # Step 1: Load data
    # ------------------------------------------------------------------
    if df is None:
        log.info("Loading outcomes.parquet as feature matrix base")
        df = load_parquet("outcomes")

    df = df.copy()
    log.info("Feature matrix base: %d rows, %d columns", *df.shape)

    # ------------------------------------------------------------------
    # Step 2: Derive is_dropout if not already present
    # ------------------------------------------------------------------
    if "is_dropout" not in df.columns:
        if "has_followup" in df.columns:
            df["is_dropout"] = (df["has_followup"] == "N").astype(int)
            log.info("Derived is_dropout from has_followup")
        else:
            raise KeyError(
                "Cannot derive is_dropout: 'has_followup' column is missing from the DataFrame."
            )
    else:
        log.info("is_dropout already present — skipping derivation")

    # ------------------------------------------------------------------
    # Step 3: Ensure has_followup is present
    # ------------------------------------------------------------------
    if "has_followup" not in df.columns:
        raise KeyError("'has_followup' column is required but missing from the DataFrame.")

    # ------------------------------------------------------------------
    # Step 4: Apply fill_zero policy to all has_* flag columns
    # ------------------------------------------------------------------
    missingness_cfg = get_missingness_config()
    per_feature = missingness_cfg.get("per_feature_policy", {})

    fill_zero_cols = [
        col
        for col, policy in per_feature.items()
        if policy.get("strategy") == "fill_zero" and col in df.columns
    ]
    # Also fill any has_* columns present in df that are not in the config
    all_has_cols = [c for c in df.columns if c.startswith("has_") and c != "has_followup"]
    extra_has_cols = [c for c in all_has_cols if c not in fill_zero_cols]
    if extra_has_cols:
        log.debug("Applying fill_zero to extra has_* columns not in missingness.yaml: %s", extra_has_cols)
    all_fill_zero = list(dict.fromkeys(fill_zero_cols + extra_has_cols))  # preserve order, no dups

    for col in all_fill_zero:
        n_nan = df[col].isna().sum()
        if n_nan > 0:
            df[col] = df[col].fillna(0)
            log.debug("fill_zero: filled %d NaN in %s", n_nan, col)

    log.info("Applied fill_zero policy to %d has_* columns", len(all_fill_zero))

    # ------------------------------------------------------------------
    # Step 5: Apply category_missing to gender and usage_frequency
    # ------------------------------------------------------------------
    category_missing_cols = [
        col
        for col, policy in per_feature.items()
        if policy.get("strategy") == "category_missing" and col in df.columns
    ]

    for col in category_missing_cols:
        n_nan = df[col].isna().sum()
        if n_nan > 0:
            df[col] = df[col].fillna("__missing__")
            log.info("category_missing: filled %d NaN in %s with '__missing__'", n_nan, col)

    # ------------------------------------------------------------------
    # Step 6: Ensure all expected feature columns from models.yaml are present
    # ------------------------------------------------------------------
    models_cfg = get_models_config()
    all_expected_features: set[str] = set()
    for model_name, model_spec in models_cfg.items():
        if isinstance(model_spec, dict) and "features" in model_spec:
            all_expected_features.update(model_spec["features"])

    missing_features = [f for f in sorted(all_expected_features) if f not in df.columns]
    if missing_features:
        warnings.warn(
            f"The following expected feature columns are missing from the matrix: "
            f"{missing_features}",
            UserWarning,
            stacklevel=2,
        )
        log.warning("Missing expected feature columns: %s", missing_features)
    else:
        log.info("All %d expected feature columns are present", len(all_expected_features))

    # ------------------------------------------------------------------
    # Step 7: Validate schema with pandera
    # ------------------------------------------------------------------
    schema = pa.DataFrameSchema(
        {
            "sn": pa.Column(nullable=True),
            "has_followup": pa.Column(str, pa.Check.isin(["Y", "N"])),
            "is_dropout": pa.Column(int, pa.Check.isin([0, 1])),
            "cohort": pa.Column(str, nullable=False),
        },
        coerce=False,
    )

    try:
        schema.validate(df, lazy=True)
        log.info("Pandera schema validation passed")
    except pa.errors.SchemaErrors as exc:
        log.error("Pandera schema validation failed:\n%s", exc.failure_cases)
        raise

    # ------------------------------------------------------------------
    # Step 8: Save as featured.parquet
    # ------------------------------------------------------------------
    save_parquet(df, "featured", versioned=True)
    log.info("Featured matrix saved: %d rows, %d columns", *df.shape)

    # ------------------------------------------------------------------
    # Step 9: Return
    # ------------------------------------------------------------------
    return df
