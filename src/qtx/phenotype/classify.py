"""Assign phenotype groups, anatomical regions, and binary flags to each patient row.

Uses the compiled rules from rules.py to apply priority-ordered group
assignment (primary_indication), multi-label region tagging, and 25+ binary
has_* flag columns derived from the tags and pain_location free-text fields.
Also applies the cohort_rollup mapping to produce the cohort column.
"""

from __future__ import annotations

import re

import pandas as pd

from qtx.io.load_supplement import load_supplement
from qtx.phenotype.rules import load_rules

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_WHITESPACE_RE = re.compile(r"\s+")


def _val_is_na(val) -> bool:
    if val is None:
        return True
    if isinstance(val, float) and pd.isna(val):
        return True
    try:
        return bool(pd.isna(val))
    except TypeError:
        return False


def _make_text_blob(row: pd.Series) -> str:
    """Combine text sources into a single normalised string for regex matching.

    Priority:
    1. tags_clean (hand-cleaned, already lowercase) — preferred when available
    2. tags (raw free-text)
    Combined with pain_location in both cases.
    Returns lowercase, stripped, space-collapsed string.
    """
    parts: list[str] = []

    # Prefer tags_clean over raw tags
    tags_val = row.get("tags_clean", None)
    if _val_is_na(tags_val):
        tags_val = row.get("tags", None)
    if not _val_is_na(tags_val):
        parts.append(str(tags_val).strip())

    loc_val = row.get("pain_location", None)
    if not _val_is_na(loc_val):
        parts.append(str(loc_val).strip())

    combined = " ".join(parts).lower()
    return _WHITESPACE_RE.sub(" ", combined).strip()


def _any_match(patterns: list[re.Pattern], text: str) -> int:
    """Return 1 if any pattern matches text, else 0."""
    for pat in patterns:
        if pat.search(text):
            return 1
    return 0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def classify(df: pd.DataFrame) -> pd.DataFrame:
    """Multi-label phenotype classification for each patient.

    Algorithm:
    1. Combine `tags` + `pain_location` columns into a single normalised string
       per patient (lowercase, stripped, space-collapsed). Handles pd.NA gracefully
       (treat as "").
    2. For each group pattern set: if ANY pattern matches → group flag = 1, else 0
    3. For each region pattern set: same → region flag = 1/0
    4. For each condition flag pattern set: same → flag = 1/0
    5. Derive `primary_indication`: the first group in the priority list that has
       flag=1. If no group matches → "Unclassified".
    6. Derive `cohort`: look up primary_indication in cohort_rollup.
       If not found → "Unclassified".

    Returns the input df with 48 new columns added:
    - 14 group columns (grp_*)
    - 9 region columns (rgn_*)
    - 24 flag columns (has_*)
    - primary_indication (str)
    - cohort (str)
    - n_groups (int)
    - n_regions (int)
    - n_flags (int)
    """
    rules = load_rules()
    groups = rules["groups"]
    regions = rules["regions"]
    flags = rules["flags"]
    priority = rules["priority"]
    cohort_rollup = rules["cohort_rollup"]

    # Build inverted cohort_rollup: group_key -> cohort_label
    group_to_cohort: dict[str, str] = {}
    for cohort_label, group_keys in cohort_rollup.items():
        for gk in group_keys:
            group_to_cohort[gk] = cohort_label

    df = df.copy()

    # Step 1: build text blob per patient
    text_blobs: list[str] = [_make_text_blob(row) for _, row in df.iterrows()]

    # Step 2: group flags
    grp_cols: list[str] = []
    for g in groups:
        col = f"grp_{g['key']}"
        grp_cols.append(col)
        df[col] = [_any_match(g["patterns"], blob) for blob in text_blobs]

    # Step 3: region flags
    rgn_cols: list[str] = []
    for r in regions:
        col = f"rgn_{r['key']}"
        rgn_cols.append(col)
        df[col] = [_any_match(r["patterns"], blob) for blob in text_blobs]

    # Step 4: condition flags
    flag_cols: list[str] = []
    for fl in flags:
        col = fl["key"]  # already has has_ prefix in YAML keys
        flag_cols.append(col)
        df[col] = [_any_match(fl["patterns"], blob) for blob in text_blobs]

    # Step 5: primary_indication — first matching group in priority order
    # Build a map from group key to the grp_ column name
    key_to_grp_col: dict[str, str] = {g["key"]: f"grp_{g['key']}" for g in groups}

    primary_indications: list[str] = []
    for idx in range(len(df)):
        indication = "Unclassified"
        for gkey in priority:
            col = key_to_grp_col.get(gkey)
            if col and df[col].iloc[idx] == 1:
                # Use the label from the groups dict
                indication = gkey  # store key; convert to label below
                break
        primary_indications.append(indication)

    # Convert priority keys to their human-readable labels for primary_indication
    key_to_label: dict[str, str] = {g["key"]: g["label"] for g in groups}
    df["primary_indication"] = [
        key_to_label.get(k, k) if k != "Unclassified" else "Unclassified"
        for k in primary_indications
    ]

    # Step 6: cohort
    df["cohort"] = [
        group_to_cohort.get(k, "Unclassified") if k != "Unclassified" else "Unclassified"
        for k in primary_indications
    ]

    # Count columns
    df["n_groups"] = df[grp_cols].sum(axis=1).astype(int)
    df["n_regions"] = df[rgn_cols].sum(axis=1).astype(int)
    df["n_flags"] = df[flag_cols].sum(axis=1).astype(int)

    # ------------------------------------------------------------------
    # Merge hand-labeled flags (hl_*) from supplement (skipped if sn absent)
    # ------------------------------------------------------------------
    supp = load_supplement()
    hl_cols = [c for c in supp.columns if c.startswith("hl_")]
    if "sn" not in df.columns:
        hl_cols = []  # no join key — skip silently (e.g. in unit tests)
    if not supp.empty and hl_cols:
        df = df.merge(supp[["sn"] + hl_cols], on="sn", how="left")
        # Ensure integer dtype with NA for unmatched rows
        for col in hl_cols:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

        # ------------------------------------------------------------------
        # final_* merged flags: hand-label where available, else automated
        # Maps hl_* → closest automated has_* or grp_* column
        # ------------------------------------------------------------------
        _HL_TO_AUTO = {
            "hl_knee_issue":          "has_knee_issue",
            "hl_leg_issue":           "rgn_lower_limb",
            "hl_back_spine_issue":    "has_spinal_issue",
            "hl_balance_issue":       "has_balance_issue",
            "hl_upper_body_issue":    "has_shoulder_issue",
            "hl_foot_ankle_issue":    "rgn_ankle_foot",
            "hl_neuro_issue":         "has_neurological",
            "hl_frailty_issue":       "has_frailty",
            "hl_metabolic_issue":     "has_metabolic",
            "hl_injury_surgery_issue":"has_post_surgery",
            "hl_general_pain_issue":  "has_chronic_pain",
        }
        for hl_col, auto_col in _HL_TO_AUTO.items():
            final_col = hl_col.replace("hl_", "final_")
            if auto_col in df.columns:
                # Use hand label when it exists (non-NA), else fall back to automated
                df[final_col] = df[hl_col].combine_first(
                    df[auto_col].astype("Int64")
                ).astype("Int64")
            else:
                df[final_col] = df[hl_col]

    return df
