"""Apply plausibility range checks and flag out-of-range values per config/cleaning.yaml.

Values outside hard min/max are nullified and recorded in the audit log.
Values above dnc_above thresholds are flagged as 'did not complete' (DNC)
but retained with an indicator column.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from qtx.clean.audit import AuditLog
from qtx.utils.config import get_cleaning_config
from qtx.utils.logging import get_logger

log = get_logger(__name__)


def flag_plausibility(df: pd.DataFrame, audit: AuditLog | None = None) -> pd.DataFrame:
    """Add {field}_flag columns for out-of-range plausibility checks.

    For each numeric field in cleaning.yaml plausibility_ranges:
    - Add a sibling column {field}_flag with values: None (OK), "low", "high", "dnc"
    - "dnc" if value > dnc_above (only for fields that define dnc_above)
    - "low" if value < min
    - "high" if value > max (and not already "dnc")
    - Does NOT modify original values — only adds flag columns
    - Logs each flagged cell to audit

    Returns df with added *_flag columns.
    """
    cfg = get_cleaning_config()
    plausibility: dict[str, dict] = cfg.get("plausibility_ranges", {})
    df = df.copy()

    for field, rules in plausibility.items():
        if field not in df.columns:
            log.debug("Plausibility field %r not in DataFrame, skipping", field)
            flag_col = f"{field}_flag"
            df[flag_col] = pd.NA
            continue

        flag_col = f"{field}_flag"
        min_val: float | None = rules.get("min")
        max_val: float | None = rules.get("max")
        dnc_above: float | None = rules.get("dnc_above")

        flags = []
        for idx in df.index:
            val = df.at[idx, field]
            flag = _evaluate_flag(val, min_val, max_val, dnc_above)
            flags.append(flag)
            if flag is not None:
                record_id = _get_record_id(df, idx)
                _audit_log(
                    audit,
                    record_id,
                    "plausibility",
                    field,
                    val,
                    flag,
                    f"plausibility_{flag}",
                )

        df[flag_col] = flags

    log.info("flag_plausibility() complete: %d flag columns added", len(plausibility))
    return df


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _evaluate_flag(
    val: Any,
    min_val: float | None,
    max_val: float | None,
    dnc_above: float | None,
) -> str | None:
    """Return flag string or None for a single value."""
    if _is_null(val):
        return None

    try:
        numeric = float(val)
    except (TypeError, ValueError):
        return None

    # DNC check first (takes priority over "high")
    if dnc_above is not None and numeric > dnc_above:
        return "dnc"

    if min_val is not None and numeric < min_val:
        return "low"

    if max_val is not None and numeric > max_val:
        return "high"

    return None


def _is_null(val: Any) -> bool:
    if val is None:
        return True
    try:
        return pd.isna(val)
    except (TypeError, ValueError):
        return False


def _get_record_id(df: pd.DataFrame, idx: int) -> str:
    if "sn" in df.columns:
        sn_val = df.at[idx, "sn"]
        if not _is_null(sn_val):
            return str(sn_val)
    return str(idx)


def _audit_log(
    audit: AuditLog | None,
    record_id: str,
    module: str,
    field: str,
    before: Any,
    after: Any,
    reason: str,
) -> None:
    if audit is not None:
        audit.log(record_id, module, field, before, after, reason)
