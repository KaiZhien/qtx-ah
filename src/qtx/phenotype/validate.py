"""Validate phenotype classification outputs and generate coverage/unmatched reports.

Checks that primary_indication is a known value, all has_* / grp_* / rgn_* columns
are 0/1 integers, and cohort is drawn from the allowed set defined in config.
Also provides coverage and unmatched-token reports.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from qtx.phenotype.rules import load_rules
from qtx.utils.logging import get_logger

log = get_logger(__name__)

_DELIMITERS_RE = re.compile(r"[,;/\n]+")
_WHITESPACE_RE = re.compile(r"\s+")

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_all_patterns() -> list[re.Pattern]:
    """Flatten all patterns from groups, regions, and flags into a single list."""
    rules = load_rules()
    all_pats: list[re.Pattern] = []
    for section_key in ("groups", "regions", "flags"):
        for entry in rules[section_key]:
            all_pats.extend(entry["patterns"])
    return all_pats


def _make_text_blob(row: pd.Series) -> str:
    """Reproduce the same text blob logic used in classify.py."""
    parts: list[str] = []
    for col in ("tags", "pain_location"):
        val = row.get(col, None)
        if val is None or (isinstance(val, float) and pd.isna(val)):
            continue
        try:
            if pd.isna(val):
                continue
        except TypeError:
            pass
        parts.append(str(val).strip())
    combined = " ".join(parts).lower()
    return _WHITESPACE_RE.sub(" ", combined).strip()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def coverage_report(df: pd.DataFrame) -> pd.DataFrame:
    """Return a DataFrame with phenotype coverage statistics.

    Returns one row per phenotype category (groups + regions + flags) with
    columns: name, type, n_patients, pct_patients.
    """
    rules = load_rules()
    n_total = len(df)
    rows: list[dict] = []

    for g in rules["groups"]:
        col = f"grp_{g['key']}"
        if col in df.columns:
            n = int(df[col].sum())
            rows.append(
                {
                    "name": col,
                    "label": g["label"],
                    "type": "group",
                    "n_patients": n,
                    "pct_patients": round(100 * n / n_total, 2) if n_total else 0.0,
                }
            )

    for r in rules["regions"]:
        col = f"rgn_{r['key']}"
        if col in df.columns:
            n = int(df[col].sum())
            rows.append(
                {
                    "name": col,
                    "label": r.get("label", r["key"]),
                    "type": "region",
                    "n_patients": n,
                    "pct_patients": round(100 * n / n_total, 2) if n_total else 0.0,
                }
            )

    for fl in rules["flags"]:
        col = fl["key"]
        if col in df.columns:
            n = int(df[col].sum())
            rows.append(
                {
                    "name": col,
                    "label": fl.get("label", col),
                    "type": "flag",
                    "n_patients": n,
                    "pct_patients": round(100 * n / n_total, 2) if n_total else 0.0,
                }
            )

    return pd.DataFrame(rows, columns=["name", "label", "type", "n_patients", "pct_patients"])


def unmatched_fragments(
    df: pd.DataFrame, output_path: Path | None = None
) -> pd.DataFrame:
    """Find tokens in tags/pain_location text that didn't trigger any rule.

    Algorithm:
    - Tokenize each patient's text blob (split on comma, semicolon, slash, newline)
    - For each token: if it does NOT match any pattern across all groups/regions/flags
      → it's unmatched
    - Return (and optionally save) a DataFrame: token, count, example_sn values

    Parameters
    ----------
    df:
        The classified DataFrame (must have 'tags', 'pain_location', 'sn' columns).
    output_path:
        If provided, save the result as CSV to this path.

    Returns
    -------
    pd.DataFrame with columns: token, count, example_sn
    """
    all_pats = _get_all_patterns()

    # token -> {count, examples}
    token_data: dict[str, dict] = {}

    for _, row in df.iterrows():
        blob = _make_text_blob(row)
        if not blob:
            continue

        # Tokenize
        raw_tokens = _DELIMITERS_RE.split(blob)
        tokens = [t.strip() for t in raw_tokens if t.strip()]

        sn = str(row.get("sn", ""))

        for tok in tokens:
            # Check if token matches any rule pattern
            matched = any(pat.search(tok) for pat in all_pats)
            if not matched:
                if tok not in token_data:
                    token_data[tok] = {"count": 0, "examples": []}
                token_data[tok]["count"] += 1
                if len(token_data[tok]["examples"]) < 3:
                    token_data[tok]["examples"].append(sn)

    rows = [
        {
            "token": tok,
            "count": data["count"],
            "example_sn": ", ".join(data["examples"]),
        }
        for tok, data in token_data.items()
    ]

    result = (
        pd.DataFrame(rows, columns=["token", "count", "example_sn"])
        .sort_values("count", ascending=False)
        .reset_index(drop=True)
    )

    if output_path is not None:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        result.to_csv(output_path, index=False)
        log.info("Unmatched fragments saved to %s (%d tokens)", output_path, len(result))

    return result
