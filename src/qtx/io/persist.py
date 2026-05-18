"""Persist DataFrames to Parquet snapshots and CSV audit outputs.

Provides save/load helpers that write to data/processed/ and
data/processed/snapshots/ using paths from config/settings.yaml.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd

from qtx.utils.config import get_path
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def _coerce_object_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy of *df* with object columns that contain mixed types
    coerced to a consistent dtype so pyarrow can serialise them.

    - All-None object columns become ``pd.NA`` (nullable string).
    - Object columns with mixed numeric/string values are cast to string,
      with Python ``None`` preserved as ``pd.NA``.
    """
    df = df.copy()
    for col in df.columns:
        if df[col].dtype != object:
            continue
        # Check for mixed types (non-null values with differing Python types)
        non_null = df[col].dropna()
        if non_null.empty:
            # All-null: cast to nullable string to satisfy pyarrow
            df[col] = pd.array([pd.NA] * len(df), dtype="string")
            continue
        unique_types = {type(v) for v in non_null}
        if len(unique_types) > 1:
            # Mixed types: stringify everything, keeping None as pd.NA
            df[col] = df[col].apply(
                lambda x: str(x) if x is not None else pd.NA
            ).astype("string")
    return df


def _safe_to_parquet(df: pd.DataFrame, path: Path) -> None:
    """Write *df* to *path* as Parquet, coercing problematic object columns."""
    df_out = _coerce_object_columns(df)
    df_out.to_parquet(path, index=False)


def save_parquet(
    df: pd.DataFrame,
    name: str,
    versioned: bool = True,
) -> Path:
    """Save DataFrame to data/processed/{name}.parquet.

    Parameters
    ----------
    df:
        DataFrame to persist.
    name:
        Base name for the file (no extension).
    versioned:
        When *True* (default), also save a dated copy to
        ``data/processed/snapshots/{name}_YYYYMMDD.parquet``.

    Returns
    -------
    Path
        Absolute path to the primary (unversioned) file.
    """
    processed_dir = get_path("processed")
    processed_dir.mkdir(parents=True, exist_ok=True)

    primary_path = processed_dir / f"{name}.parquet"
    _safe_to_parquet(df, primary_path)
    log.info("Saved %d rows to %s", len(df), primary_path)

    if versioned:
        snapshots_dir = get_path("snapshots")
        snapshots_dir.mkdir(parents=True, exist_ok=True)
        today = date.today().strftime("%Y%m%d")
        snapshot_path = snapshots_dir / f"{name}_{today}.parquet"
        _safe_to_parquet(df, snapshot_path)
        log.info("Snapshot saved to %s", snapshot_path)

    return primary_path


def load_parquet(name: str) -> pd.DataFrame:
    """Load data/processed/{name}.parquet.

    Parameters
    ----------
    name:
        Base name of the file to load (no extension).

    Returns
    -------
    pd.DataFrame
    """
    path = get_path("processed") / f"{name}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"Parquet file not found: {path}")
    log.info("Loading parquet from %s", path)
    return pd.read_parquet(path)
