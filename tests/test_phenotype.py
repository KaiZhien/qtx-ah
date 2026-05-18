"""Tests for src/qtx/phenotype/ — classify and rules modules.

Covers: cohort assignment accuracy, unclassified handling,
multi-label detection, and absence-is-zero guarantee.
"""

from __future__ import annotations

import pandas as pd
import pytest

from qtx.phenotype.classify import classify


# ---------------------------------------------------------------------------
# Fixture: hand-labelled (tags, expected_cohort) pairs
# ---------------------------------------------------------------------------

LABELLED_EXAMPLES = [
    # Pain & Musculoskeletal
    ("Knee pain, OA", "Pain & Musculoskeletal"),
    ("Lumbar spondylosis, back pain", "Pain & Musculoskeletal"),
    ("Rheumatoid arthritis, joint pain", "Pain & Musculoskeletal"),
    ("Generalised pain, fibromyalgia", "Pain & Musculoskeletal"),
    ("Osteoporosis, bone density low", "Pain & Musculoskeletal"),
    # Neurological
    ("Stroke, left hemiplegia", "Neurological"),
    ("Parkinson disease", "Neurological"),
    ("Peripheral neuropathy, numbness", "Neurological"),
    # Post-Surgical/Rehab
    ("TKR surgery", "Post-Surgical/Rehab"),
    ("Post-op hip replacement", "Post-Surgical/Rehab"),
    ("Fracture rehabilitation", "Post-Surgical/Rehab"),
    # Frailty/Sarcopenia
    ("Frailty, muscle weakness", "Frailty/Sarcopenia"),
    ("Balance issues, fall risk", "Frailty/Sarcopenia"),
    ("Sarcopenia", "Frailty/Sarcopenia"),
    # Wellness
    ("General fitness, wellness", "Wellness"),
    ("Healthy aging, preventive", "Wellness"),
    # Other-Mixed
    ("Diabetes, hypertension", "Other-Mixed"),
    ("Cancer recovery, fatigue", "Other-Mixed"),
    ("Cardiovascular disease, heart failure", "Other-Mixed"),
    ("Obesity, metabolic syndrome", "Other-Mixed"),
]


@pytest.fixture
def labelled_df() -> pd.DataFrame:
    tags_list = [ex[0] for ex in LABELLED_EXAMPLES]
    return pd.DataFrame({"tags": tags_list, "pain_location": [None] * len(tags_list)})


# ---------------------------------------------------------------------------
# 1. Fixture of 20 hand-labelled examples
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tags, expected_cohort", LABELLED_EXAMPLES)
def test_phenotype_cohort_assignment(tags, expected_cohort):
    """Each hand-labelled tag string maps to the expected cohort."""
    df = pd.DataFrame({"tags": [tags], "pain_location": [None]})
    result = classify(df)
    assert result.at[0, "cohort"] == expected_cohort, (
        f"Tags {tags!r}: expected cohort {expected_cohort!r}, "
        f"got {result.at[0, 'cohort']!r} "
        f"(primary_indication={result.at[0, 'primary_indication']!r})"
    )


# ---------------------------------------------------------------------------
# 2. Unclassified test
# ---------------------------------------------------------------------------

def test_empty_tags_unclassified():
    """Empty tag string → cohort == 'Unclassified'."""
    df = pd.DataFrame({"tags": [""], "pain_location": [None]})
    result = classify(df)
    assert result.at[0, "cohort"] == "Unclassified", (
        f"Expected 'Unclassified' for empty tags, got {result.at[0, 'cohort']!r}"
    )


# ---------------------------------------------------------------------------
# 3. Multi-label test
# ---------------------------------------------------------------------------

def test_multi_label_oa_stroke():
    """'OA knee, stroke' → grp_joint_disease == 1 AND grp_neurological == 1."""
    df = pd.DataFrame({"tags": ["OA knee, stroke"], "pain_location": [None]})
    result = classify(df)
    assert result.at[0, "grp_joint_disease"] == 1, "Expected grp_joint_disease=1 for 'OA knee'"
    assert result.at[0, "grp_neurological"] == 1, "Expected grp_neurological=1 for 'stroke'"


# ---------------------------------------------------------------------------
# 4. Absence is zero test
# ---------------------------------------------------------------------------

def test_absence_produces_zero_not_nan():
    """A patient with no tags → all grp_*/has_* columns == 0 (not NaN)."""
    df = pd.DataFrame({"tags": [None], "pain_location": [None]})
    result = classify(df)
    # Check all grp_ and has_ columns
    group_flag_cols = [c for c in result.columns if c.startswith("grp_") or c.startswith("has_")]
    for col in group_flag_cols:
        val = result.at[0, col]
        assert val == 0, f"Expected 0 for {col!r} with no tags, got {val!r}"
        assert not pd.isna(val), f"Expected 0 (not NaN) for {col!r} with no tags"
