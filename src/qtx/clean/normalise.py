"""Normalise raw column values to canonical form per config/schema.yaml and config/cleaning.yaml.

Handles NA token replacement, gender/yesno/frequency harmonisation,
column renaming to snake_case canonical names, dtype coercion, and
derivation of record_type, name_flag, and age_band columns.
"""

from __future__ import annotations

import re
from typing import Any

import pandas as pd

from qtx.clean.audit import AuditLog
from qtx.utils.config import get_cleaning_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)

# Numeric columns (excluding phone) — these will be cast to float64
_NUMERIC_COLS = [
    "age",
    "pre_vas",
    "post_vas",
    "pre_tug_s",
    "post_tug_s",
    "pre_5xsst_s",
    "post_5xsst_s",
    "pre_normal_gs_ms",
    "post_normal_gs_ms",
    "pre_fast_gs_ms",
    "post_fast_gs_ms",
    "baseline_sppb",
    "post_sppb",
    "vas_change",
    "tug_change_s",
    "tug_change_pct",
    "sst_change_s",
    "sst_change_pct",
    "pre_normal_time_s",
    "post_normal_time_s",
    "normal_gs_change_ms",
    "normal_gs_change_pct",
    "pre_fast_time_s",
    "post_fast_time_s",
    "fast_gs_change_ms",
    "fast_gs_change_pct",
    "sppb_change",
]

# Integer columns (age and SPPB scores → Int64)
_INT64_COLS = ["age", "baseline_sppb", "post_sppb", "sppb_change"]


def normalise(df: pd.DataFrame, audit: AuditLog | None = None) -> pd.DataFrame:
    """Apply cleaning rules driven by config/cleaning.yaml.

    Steps:
    1. NA harmonisation
    2. String trim + collapse whitespace
    3. Case standardisation (gender_map, yesno_map, frequency_map)
    4. Type coercion
    5. Identity column transforms (name_flag, record_type)
    6. Derived columns (age_band, n_pre_post_pairs, has_followup)

    Every value change logs to audit.
    Returns cleaned DataFrame.
    """
    cfg = get_cleaning_config()
    # Work on a plain object-dtype copy so we can freely mutate values
    df = df.copy()
    # Convert all columns to plain Python object dtype for flexible mutation
    for col in df.columns:
        if str(df[col].dtype) in ("string", "str"):
            df[col] = df[col].astype(object)

    na_tokens: list[str] = cfg.get("na_tokens", [])
    gender_map: dict[str, str] = cfg.get("gender_map", {})
    yesno_map: dict[str, str] = cfg.get("yesno_map", {})
    frequency_map: dict[str, str] = cfg.get("frequency_map", {})
    age_bands: list[dict] = cfg.get("age_bands", [])
    star_prefix: str = cfg.get("strip_name_flag_prefix", "**")
    legacy_prefix: str = cfg.get("legacy_sn_prefix", "OLD")

    column_roles: dict = cfg.get("column_roles", {})
    gender_cols: list[str] = column_roles.get("gender_cols", [])
    yesno_cols: list[str] = column_roles.get("yesno_cols", [])
    frequency_cols: list[str] = column_roles.get("frequency_cols", [])

    pre_post_pairs: list[tuple[str, str]] = [
        (pair[0], pair[1]) for pair in cfg.get("pre_post_pairs", [])
    ]
    followup_post_cols: list[str] = cfg.get("followup_post_cols", [])

    # -------------------------------------------------------------------
    # Step 1: NA harmonisation
    # -------------------------------------------------------------------
    log.info("Step 1: NA harmonisation (%d tokens)", len(na_tokens))
    na_set = set(na_tokens)

    for col in df.columns:
        for idx in df.index:
            val = df.at[idx, col]
            if isinstance(val, str) and val in na_set:
                _audit_log(audit, _record_id(df, idx), "normalise", col, val, pd.NA, "na_token")
                df.at[idx, col] = None  # use None for object dtype

    # -------------------------------------------------------------------
    # Step 2: String trim + collapse whitespace on string columns
    # -------------------------------------------------------------------
    log.info("Step 2: String trim + whitespace collapse")
    for col in df.columns:
        for idx in df.index:
            val = df.at[idx, col]
            if isinstance(val, str):
                cleaned = re.sub(r"\s+", " ", val).strip()
                if cleaned != val:
                    _audit_log(audit, _record_id(df, idx), "normalise", col, val, cleaned, "whitespace_trim")
                    df.at[idx, col] = cleaned

    # -------------------------------------------------------------------
    # Step 3: Case standardisation
    # -------------------------------------------------------------------
    log.info("Step 3: Case standardisation")

    def _apply_map(col: str, mapping: dict[str, str], reason: str) -> None:
        if col not in df.columns:
            return
        for idx in df.index:
            val = df.at[idx, col]
            if isinstance(val, str):
                mapped = mapping.get(val.lower().strip())
                if mapped is not None and mapped != val:
                    _audit_log(audit, _record_id(df, idx), "normalise", col, val, mapped, reason)
                    df.at[idx, col] = mapped

    for col in gender_cols:
        _apply_map(col, gender_map, "gender_map")
    for col in yesno_cols:
        _apply_map(col, yesno_map, "yesno_map")
    for col in frequency_cols:
        _apply_map(col, frequency_map, "frequency_map")

    # -------------------------------------------------------------------
    # Step 4: Type coercion (vectorized — avoids Arrow dtype issues)
    # -------------------------------------------------------------------
    log.info("Step 4: Type coercion")

    for col in _NUMERIC_COLS:
        if col not in df.columns:
            continue

        before_series = df[col].copy()
        numeric_series = pd.to_numeric(df[col], errors="coerce")

        # Log cells that had a value but failed coercion (became NaN)
        failed_mask = df[col].notna() & numeric_series.isna()
        for idx in df.index[failed_mask]:
            _audit_log(
                audit,
                _record_id(df, idx),
                "normalise",
                col,
                before_series.at[idx],
                pd.NA,
                "numeric_coerce_failed",
            )

        df[col] = numeric_series

    # Int64 cols — round-trip through float then Int64 nullable int
    for col in _INT64_COLS:
        if col not in df.columns:
            continue
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    # phone_number stays str
    if "phone_number" in df.columns:
        # Already object dtype; ensure it stays as string
        df["phone_number"] = df["phone_number"].where(df["phone_number"].notna(), other=None)

    # -------------------------------------------------------------------
    # Step 5: Identity column transforms
    # -------------------------------------------------------------------
    log.info("Step 5: Identity transforms (name_flag, record_type)")

    # 5a. name_flag from "**" prefix
    if "name" not in df.columns:
        df["name_flag"] = None
    else:
        name_flags: list[Any] = []
        for idx in df.index:
            val = df.at[idx, "name"]
            if isinstance(val, str) and val.startswith(star_prefix):
                stripped = val[len(star_prefix):]
                _audit_log(audit, _record_id(df, idx), "normalise", "name", val, stripped, "strip_star_prefix")
                df.at[idx, "name"] = stripped
                name_flags.append("starred")
            else:
                name_flags.append(None)
        df["name_flag"] = name_flags

    # 5b. record_type from OLD prefix in sn
    if "sn" not in df.columns:
        df["record_type"] = "Active"
    else:
        record_types: list[str] = []
        for idx in df.index:
            val = df.at[idx, "sn"]
            if isinstance(val, str) and val.upper().startswith(legacy_prefix.upper()):
                record_types.append("Legacy")
            else:
                record_types.append("Active")
        df["record_type"] = record_types

    # -------------------------------------------------------------------
    # Step 6: Derived columns
    # -------------------------------------------------------------------
    log.info("Step 6: Derived columns (age_band, n_pre_post_pairs, has_followup)")

    # 6a. age_band
    def _age_band(age_val: Any) -> Any:
        if _is_null(age_val):
            return None
        try:
            age_int = int(float(age_val))
        except (TypeError, ValueError):
            return None
        for band in age_bands:
            if band["min"] <= age_int <= band["max"]:
                return band["label"]
        return None

    age_col_data = df["age"] if "age" in df.columns else None
    if age_col_data is not None:
        df["age_band"] = age_col_data.apply(_age_band)
    else:
        df["age_band"] = None

    # 6b. n_pre_post_pairs
    def _n_pairs(row: pd.Series) -> int:
        count = 0
        for pre, post in pre_post_pairs:
            pre_val = row.get(pre, None)
            post_val = row.get(post, None)
            if not _is_null(pre_val) and not _is_null(post_val):
                count += 1
        return count

    df["n_pre_post_pairs"] = df.apply(_n_pairs, axis=1)

    # 6c. has_followup
    def _has_followup(row: pd.Series) -> str:
        for post_col in followup_post_cols:
            val = row.get(post_col, None)
            if not _is_null(val):
                return "Y"
        return "N"

    df["has_followup"] = df.apply(_has_followup, axis=1)

    log.info("normalise() complete: %d rows, %d columns", len(df), len(df.columns))
    return df


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_null(val: Any) -> bool:
    """Return True if val is None or pd.NA or float nan."""
    if val is None:
        return True
    try:
        return pd.isna(val)
    except (TypeError, ValueError):
        return False


def _record_id(df: pd.DataFrame, idx: int) -> str:
    """Return a string record identifier for audit logging."""
    if "sn" not in df.columns:
        return str(idx)
    sn_val = df.at[idx, "sn"]
    if _is_null(sn_val):
        return str(idx)
    return str(sn_val)


def _audit_log(
    audit: AuditLog | None,
    record_id: str,
    module: str,
    field: str,
    before: Any,
    after: Any,
    reason: str,
) -> None:
    """Log to audit if audit object is provided."""
    if audit is not None:
        audit.log(record_id, module, field, before, after, reason)
