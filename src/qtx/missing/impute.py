"""Impute missing predictor values per strategy defined in config/missingness.yaml.

Supported strategies: iterative (sklearn IterativeImputer + RandomForest), knn5,
median, fill_zero, missing_indicator, and category_missing. Outcome columns are
never imputed. Returns a df with imputed columns for use by the feature builder.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np
import pandas as pd
from sklearn.experimental import enable_iterative_imputer  # noqa: F401
from sklearn.impute import IterativeImputer, KNNImputer, SimpleImputer
from sklearn.ensemble import RandomForestRegressor

from qtx.utils.config import get_cleaning_config, get_missingness_config, get_settings
from qtx.utils.logging import get_logger

log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Outcome column exclusion patterns
# ---------------------------------------------------------------------------

_OUTCOME_PATTERNS = [
    re.compile(r"^post_"),
    re.compile(r"_improvement$"),
    re.compile(r"_responder$"),
    re.compile(r"^composite$"),
    re.compile(r"^composite_improvement$"),
    re.compile(r"^overall_responder$"),
]


def _is_outcome_col(col: str) -> bool:
    return any(p.search(col) for p in _OUTCOME_PATTERNS)


# ---------------------------------------------------------------------------
# Plausibility clip ranges from cleaning.yaml
# ---------------------------------------------------------------------------

def _get_plausibility_ranges() -> dict[str, dict[str, float]]:
    """Return {col: {min: ..., max: ...}} from cleaning.yaml plausibility_ranges."""
    cfg = get_cleaning_config()
    ranges: dict[str, dict[str, float]] = {}
    for col, bounds in cfg.get("plausibility_ranges", {}).items():
        entry: dict[str, float] = {}
        if "min" in bounds:
            entry["min"] = float(bounds["min"])
        if "max" in bounds:
            entry["max"] = float(bounds["max"])
        if entry:
            ranges[col] = entry
    return ranges


def _clip_to_plausible(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Clip numeric columns to plausibility ranges from cleaning.yaml."""
    ranges = _get_plausibility_ranges()
    df = df.copy()
    for col in cols:
        if col in ranges and col in df.columns and pd.api.types.is_numeric_dtype(df[col]):
            lo = ranges[col].get("min")
            hi = ranges[col].get("max")
            df[col] = df[col].clip(lower=lo, upper=hi)
    return df


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _random_seed() -> int:
    return int(get_settings().get("random_seed", 42))


def run_complete_case(df: pd.DataFrame, feature_cols: list[str]) -> pd.DataFrame:
    """Drop rows with any NA in feature_cols. Returns filtered df."""
    before = len(df)
    mask = df[feature_cols].isna().any(axis=1)
    df_out = df[~mask].copy()
    log.info("complete_case: dropped %d/%d rows with missing features", mask.sum(), before)
    return df_out


# ---------------------------------------------------------------------------
# FeatureImputer
# ---------------------------------------------------------------------------

class FeatureImputer:
    """Apply per-feature imputation strategies from missingness.yaml.

    Strategies
    ----------
    complete_case     : drop rows with ANY NA in the feature set.
    iterative         : sklearn IterativeImputer (RandomForestRegressor estimator).
    knn5              : sklearn KNNImputer(n_neighbors=5).
    median            : SimpleImputer(strategy="median").
    fill_zero         : fill NaN with 0 (for has_* binary flags).
    category_missing  : fill NaN with "__missing__" (for categorical columns).
    missing_indicator : add a binary {col}_missing column alongside the original.

    Outcome columns (post_*, *_improvement, *_responder, composite,
    overall_responder) are NEVER imputed.

    Usage
    -----
    imputer = FeatureImputer(feature_cols=["age", "gender", "baseline_sppb", ...])
    df_imputed = imputer.fit_transform(df)
    """

    def __init__(
        self,
        feature_cols: list[str],
        strategy_override: str | None = None,
    ) -> None:
        """
        Parameters
        ----------
        feature_cols:
            Columns to impute (subset of the full dataframe). Outcome columns
            are automatically excluded even if listed here.
        strategy_override:
            If set, apply this single strategy to ALL feature_cols. Used for
            sensitivity analysis variants: "complete_case", "iterative", "knn5",
            "median".
        """
        # Filter out outcome columns
        self._all_feature_cols = [c for c in feature_cols if not _is_outcome_col(c)]
        excluded = [c for c in feature_cols if _is_outcome_col(c)]
        if excluded:
            log.warning("FeatureImputer: excluded %d outcome columns: %s", len(excluded), excluded)

        self.strategy_override = strategy_override

        # Per-feature policy from config
        miss_cfg = get_missingness_config()
        self._per_feature_policy: dict[str, dict[str, Any]] = miss_cfg.get("per_feature_policy", {})

        # Fitted state
        self._fitted_iterative: IterativeImputer | None = None
        self._fitted_knn: KNNImputer | None = None
        self._fitted_median: dict[str, SimpleImputer] = {}
        self._iterative_cols: list[str] = []
        self._knn_cols: list[str] = []
        self._median_cols: list[str] = []
        self._fill_zero_cols: list[str] = []
        self._category_cols: list[str] = []
        self._indicator_cols: list[str] = []
        self._is_fitted = False

    # ------------------------------------------------------------------
    # Strategy resolution
    # ------------------------------------------------------------------

    def _resolve_strategy(self, col: str) -> str:
        """Return the imputation strategy for a single column."""
        if self.strategy_override:
            # For non-numeric columns with numeric override strategies, fall back
            return self.strategy_override
        policy = self._per_feature_policy.get(col, {})
        return policy.get("strategy", "median")  # default: median if not configured

    def _categorise_columns(self, df: pd.DataFrame) -> None:
        """Partition self._all_feature_cols into strategy buckets."""
        self._iterative_cols = []
        self._knn_cols = []
        self._median_cols = []
        self._fill_zero_cols = []
        self._category_cols = []
        self._indicator_cols = []

        for col in self._all_feature_cols:
            if col not in df.columns:
                log.warning("FeatureImputer: column %r not in df — skipping", col)
                continue

            strategy = self._resolve_strategy(col)
            is_numeric = pd.api.types.is_numeric_dtype(df[col])

            if strategy == "complete_case":
                # handled at the df level, not per column
                pass
            elif strategy == "iterative":
                if is_numeric:
                    self._iterative_cols.append(col)
                else:
                    log.warning("iterative strategy requested for non-numeric %r; using category_missing", col)
                    self._category_cols.append(col)
            elif strategy == "knn5":
                if is_numeric:
                    self._knn_cols.append(col)
                else:
                    log.warning("knn5 strategy requested for non-numeric %r; using category_missing", col)
                    self._category_cols.append(col)
            elif strategy == "median":
                if is_numeric:
                    self._median_cols.append(col)
                else:
                    log.warning("median strategy requested for non-numeric %r; using category_missing", col)
                    self._category_cols.append(col)
            elif strategy == "fill_zero":
                self._fill_zero_cols.append(col)
            elif strategy == "category_missing":
                self._category_cols.append(col)
            elif strategy == "missing_indicator":
                self._indicator_cols.append(col)
            else:
                log.warning("Unknown strategy %r for column %r; defaulting to median/category_missing", strategy, col)
                if is_numeric:
                    self._median_cols.append(col)
                else:
                    self._category_cols.append(col)

    # ------------------------------------------------------------------
    # Fit / Transform
    # ------------------------------------------------------------------

    def fit(self, df: pd.DataFrame) -> "FeatureImputer":
        """Fit imputer parameters on df."""
        if self.strategy_override == "complete_case":
            self._is_fitted = True
            return self

        self._categorise_columns(df)
        seed = _random_seed()

        # Iterative imputer
        if self._iterative_cols:
            log.info("Fitting IterativeImputer on %d columns", len(self._iterative_cols))
            est = RandomForestRegressor(n_estimators=50, random_state=seed, n_jobs=-1)
            self._fitted_iterative = IterativeImputer(
                estimator=est,
                max_iter=10,
                random_state=seed,
                skip_complete=True,
            )
            self._fitted_iterative.fit(df[self._iterative_cols])

        # KNN imputer
        if self._knn_cols:
            log.info("Fitting KNNImputer on %d columns", len(self._knn_cols))
            self._fitted_knn = KNNImputer(n_neighbors=5)
            self._fitted_knn.fit(df[self._knn_cols])

        # Median imputers (per-column to allow partial missing)
        for col in self._median_cols:
            imp = SimpleImputer(strategy="median")
            imp.fit(df[[col]])
            self._fitted_median[col] = imp

        self._is_fitted = True
        return self

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """Apply fitted imputation to df. Returns df with imputed values."""
        if not self._is_fitted:
            raise RuntimeError("FeatureImputer must be fitted before calling transform().")

        df = df.copy()

        if self.strategy_override == "complete_case":
            return run_complete_case(df, self._all_feature_cols)

        # Iterative
        if self._iterative_cols and self._fitted_iterative is not None:
            imputed = self._fitted_iterative.transform(df[self._iterative_cols])
            df[self._iterative_cols] = imputed
            df = _clip_to_plausible(df, self._iterative_cols)

        # KNN
        if self._knn_cols and self._fitted_knn is not None:
            imputed = self._fitted_knn.transform(df[self._knn_cols])
            df[self._knn_cols] = imputed
            df = _clip_to_plausible(df, self._knn_cols)

        # Median
        for col, imp in self._fitted_median.items():
            if col in df.columns:
                imputed = imp.transform(df[[col]])
                df[col] = imputed.ravel()
                df = _clip_to_plausible(df, [col])

        # Fill zero
        for col in self._fill_zero_cols:
            if col in df.columns:
                df[col] = df[col].fillna(0)

        # Category missing
        for col in self._category_cols:
            if col in df.columns:
                df[col] = df[col].fillna("__missing__")

        # Missing indicator: add {col}_missing and leave original untouched
        for col in self._indicator_cols:
            if col in df.columns:
                indicator_col = f"{col}_missing"
                df[indicator_col] = df[col].isna().astype(int)

        return df

    def fit_transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """Fit and apply imputation to df in one step."""
        return self.fit(df).transform(df)
