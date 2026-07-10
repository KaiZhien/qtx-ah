"""Shared feature-preprocessing helpers for the model trainers.

Extracted from regression.py / classifier.py / dropout.py so the categorical
encoding logic lives in exactly one place.
"""

from __future__ import annotations

import pandas as pd

# Categorical columns that get one-hot encoded before fitting any model.
CAT_COLS = ["cohort", "usage_frequency", "gender", "primary_indication"]


def encode_categoricals(
    df: pd.DataFrame, cat_cols: list[str] | None = None
) -> tuple[pd.DataFrame, list[str]]:
    """One-hot encode the categorical columns present in *df*.

    Returns the encoded frame and the list of generated dummy column names.
    Uses drop_first=True to avoid the dummy-variable trap.
    """
    if cat_cols is None:
        cat_cols = CAT_COLS
    present = [c for c in cat_cols if c in df.columns]
    df_enc = pd.get_dummies(df, columns=present, drop_first=True, dtype=float)
    dummy_cols = [
        c for c in df_enc.columns if any(c.startswith(base + "_") for base in present)
    ]
    return df_enc, dummy_cols
