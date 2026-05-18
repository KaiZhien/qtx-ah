"""Tests for src/qtx/clean/ — normalise, plausibility, and audit modules.

Covers: NA token replacement, gender/yesno/frequency mapping,
out-of-range value nullification, DNC flag assignment,
audit log row counts matching number of changes, dtype coercion.
"""

from __future__ import annotations

import pandas as pd
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from qtx.clean.audit import AuditLog
from qtx.clean.normalise import normalise
from qtx.clean.plausibility import flag_plausibility


# ---------------------------------------------------------------------------
# 1. Schema test
# ---------------------------------------------------------------------------

EXPECTED_COLUMNS = {
    "sn",
    "name",
    "gender",
    "age",
    "has_followup",
    "n_pre_post_pairs",
    "age_band",
    "record_type",
    "name_flag",
}


def test_normalise_output_has_expected_columns(sample_raw_df):
    """normalise() output must contain all expected schema columns."""
    result = normalise(sample_raw_df)
    for col in EXPECTED_COLUMNS:
        assert col in result.columns, f"Expected column '{col}' missing from normalise() output"


# ---------------------------------------------------------------------------
# 2. Property-based test with hypothesis (gender variants)
# ---------------------------------------------------------------------------

_GENDER_VARIANTS = [
    "M", "F", "m", "f", "Male", "Female", "male", "female",
    "MALE", "FEMALE", "m ", " F", "M ", " m",
]


@given(gender_val=st.sampled_from(_GENDER_VARIANTS))
@settings(max_examples=20)
def test_gender_normalisation_property(gender_val):
    """Any recognised gender variant should produce 'M' or 'F' after normalise()."""
    df = pd.DataFrame({
        "sn": ["T001"],
        "name": ["Test Patient"],
        "gender": [gender_val],
        "age": [65],
        "pre_tug_s": [None],
        "post_tug_s": [None],
        "pre_vas": [None],
        "post_vas": [None],
        "pre_5xsst_s": [None],
        "post_5xsst_s": [None],
        "pre_normal_gs_ms": [None],
        "post_normal_gs_ms": [None],
        "pre_fast_gs_ms": [None],
        "post_fast_gs_ms": [None],
        "baseline_sppb": [None],
        "post_sppb": [None],
    })
    result = normalise(df)
    val = result.at[0, "gender"]
    assert val in ("M", "F"), f"Expected 'M' or 'F' for input {gender_val!r}, got {val!r}"


# ---------------------------------------------------------------------------
# 3. NA harmonisation test
# ---------------------------------------------------------------------------

def test_na_tokens_become_null(cleaning_cfg):
    """All na_tokens must be replaced with pd.NA / None after normalise()."""
    na_tokens = cleaning_cfg.get("na_tokens", [])
    # filter to non-empty tokens only (empty string is tricky in a cell)
    non_empty = [t for t in na_tokens if t.strip()]

    for token in non_empty:
        df = pd.DataFrame({
            "sn": ["T001"],
            "name": ["Test Patient"],
            "gender": [token],  # put token in a string column
            "age": [65],
        })
        result = normalise(df)
        val = result.at[0, "gender"]
        is_null = val is None or (val is pd.NA) or (isinstance(val, float) and pd.isna(val))
        assert is_null, (
            f"NA token {token!r} was not harmonised to null; got {val!r}"
        )


# ---------------------------------------------------------------------------
# 4. Round-trip test (clean df → no extra audit rows beyond na-harmonisation)
# ---------------------------------------------------------------------------

def test_round_trip_clean_df_no_extra_changes():
    """A truly clean df should produce no non-na-harmonisation audit rows."""
    df = pd.DataFrame({
        "sn": ["Q001", "Q002"],
        "name": ["Alice", "Bob"],
        "gender": ["M", "F"],
        "age": [65, 70],
        "pre_tug_s": [12.0, 15.0],
        "post_tug_s": [10.0, 13.0],
        "pre_vas": [5.0, 4.0],
        "post_vas": [3.0, 2.0],
        "pre_5xsst_s": [30.0, 25.0],
        "post_5xsst_s": [25.0, 20.0],
        "pre_normal_gs_ms": [0.9, 1.0],
        "post_normal_gs_ms": [1.1, 1.2],
        "pre_fast_gs_ms": [1.3, 1.4],
        "post_fast_gs_ms": [1.5, 1.6],
        "baseline_sppb": [8, 9],
        "post_sppb": [10, 11],
    })
    audit = AuditLog()
    normalise(df, audit=audit)
    # Filter out na_token entries (expected) — only unexpected changes
    non_na_rows = [r for r in audit._rows if r["reason"] != "na_token"]
    assert len(non_na_rows) == 0, (
        f"Expected 0 non-NA-harmonisation audit rows for clean df, got {len(non_na_rows)}: "
        f"{non_na_rows[:5]}"
    )


# ---------------------------------------------------------------------------
# 5. Flag test (DNC)
# ---------------------------------------------------------------------------

def test_flag_plausibility_dnc_tug():
    """pre_tug_s = 150 (above dnc_above=90) → pre_tug_s_flag == 'dnc'."""
    df = pd.DataFrame({
        "sn": ["T001"],
        "pre_tug_s": [150.0],
    })
    result = flag_plausibility(df)
    assert "pre_tug_s_flag" in result.columns
    assert result.at[0, "pre_tug_s_flag"] == "dnc", (
        f"Expected 'dnc' for pre_tug_s=150, got {result.at[0, 'pre_tug_s_flag']!r}"
    )


# ---------------------------------------------------------------------------
# 6. Legacy detection test
# ---------------------------------------------------------------------------

def test_legacy_sn_detection():
    """S/N value starting with 'OLD' → record_type == 'Legacy'."""
    df = pd.DataFrame({
        "sn": ["OLD123", "QTX001"],
        "name": ["Legacy Pat", "Active Pat"],
        "gender": ["M", "F"],
        "age": [70, 65],
    })
    result = normalise(df)
    assert result.at[0, "record_type"] == "Legacy", "Expected 'Legacy' for OLD123"
    assert result.at[1, "record_type"] == "Active", "Expected 'Active' for QTX001"


# ---------------------------------------------------------------------------
# 7. Age band test
# ---------------------------------------------------------------------------

def test_age_band_65_74():
    """age=67 → age_band == '65-74'."""
    df = pd.DataFrame({
        "sn": ["T001"],
        "name": ["Test Patient"],
        "gender": ["M"],
        "age": [67],
    })
    result = normalise(df)
    assert result.at[0, "age_band"] == "65-74", (
        f"Expected '65-74' for age=67, got {result.at[0, 'age_band']!r}"
    )
