"""Pytest configuration and shared fixtures for the QTX test suite.

Provides:
  - sample_raw_df: 10-row synthetic DataFrame mimicking raw.parquet structure
  - cleaning_cfg: the cleaning config dict
  - outcomes_cfg: the outcomes config dict
"""

from __future__ import annotations

import pandas as pd
import pytest

from qtx.utils.config import get_cleaning_config, get_outcomes_config


@pytest.fixture
def sample_raw_df() -> pd.DataFrame:
    """10-row synthetic DataFrame mimicking raw.parquet structure.

    Includes a mix of:
      - valid values
      - NA tokens ("NA", "-", "none")
      - string numbers ("25.0")
      - ** name prefix (starred patient)
      - OLD S/N prefix (legacy record)
      - mixed-case gender ("Male", "female", "m ", " F")
    """
    data = {
        "sn": [
            "QTX001",
            "QTX002",
            "OLD123",
            "QTX004",
            "QTX005",
            "QTX006",
            "QTX007",
            "QTX008",
            "QTX009",
            "QTX010",
        ],
        "name": [
            "**Alice Tan",
            "Bob Lim",
            "Charlie Wong",
            "Diana Ng",
            "Edward Koh",
            "Fiona Yeo",
            "George Lim",
            "Hannah Teo",
            "Ivan Chan",
            "Jenny Lee",
        ],
        "gender": [
            "M",
            "Male",
            "female",
            "m ",
            " F",
            "NA",
            "F",
            "M",
            "-",
            "none",
        ],
        "age": [
            "67",   # string number → should become 67
            "55",
            "NA",   # NA token
            "72",
            "45",
            "80",
            "none", # NA token
            "62",
            "88",
            "70",
        ],
        "pre_vas": [5.0, 3.0, None, 7.0, 2.0, 6.0, 4.0, 8.0, "-", 5.0],
        "post_vas": [3.0, 1.0, None, 4.0, None, 3.0, 2.0, 6.0, 3.0, 3.0],
        "pre_tug_s": [12.0, 15.0, 20.0, 150.0, 10.0, 18.0, 25.0, 14.0, 30.0, 16.0],
        "post_tug_s": [10.0, 12.0, 15.0, None, None, 14.0, 20.0, 11.0, 25.0, 13.0],
        "pre_5xsst_s": [30.0, 25.0, None, 35.0, 20.0, 40.0, 28.0, 22.0, 50.0, 33.0],
        "post_5xsst_s": [25.0, 20.0, None, None, None, 35.0, 22.0, 18.0, 45.0, 28.0],
        "pre_normal_gs_ms": [0.8, 1.0, None, 0.9, 1.1, 0.7, 0.85, 1.05, 0.6, 0.95],
        "post_normal_gs_ms": [1.0, 1.2, None, None, None, 0.9, 1.0, 1.2, 0.8, 1.1],
        "pre_fast_gs_ms": [1.2, 1.5, None, 1.3, 1.6, 1.1, 1.25, 1.55, 0.9, 1.4],
        "post_fast_gs_ms": [1.5, 1.8, None, None, None, 1.4, 1.5, 1.8, 1.2, 1.6],
        "baseline_sppb": [7, 9, None, 8, 10, 6, 8, 11, 5, 9],
        "post_sppb": [9, 11, None, None, None, 8, 10, 12, 7, 11],
        "tags": [
            "knee pain, OA",
            "general fitness",
            "stroke",
            "frailty",
            "wellness",
            "diabetes",
            "TKR surgery",
            "balance issues",
            "Parkinson disease",
            "back pain",
        ],
        "pain_location": [
            "knee",
            None,
            None,
            None,
            None,
            None,
            "knee",
            None,
            None,
            "lumbar",
        ],
    }
    return pd.DataFrame(data)


@pytest.fixture
def cleaning_cfg() -> dict:
    """Return the cleaning config dict."""
    return get_cleaning_config()


@pytest.fixture
def outcomes_cfg() -> dict:
    """Return the outcomes config dict."""
    return get_outcomes_config()
