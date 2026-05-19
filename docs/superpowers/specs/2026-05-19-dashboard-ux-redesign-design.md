# Dashboard UX Redesign — Design Spec

**Date:** 2026-05-19  
**Status:** Approved  
**Scope:** Streamlit dashboard only — no pipeline changes, no model retraining

---

## 1. Problem

The current dashboard (`dashboard/app.py` + `pages/dosage_recommender.py`) has four UX gaps:

1. The Intake Estimator is buried in a collapsed expander at the bottom of the main page — the most clinically useful feature is the least discoverable.
2. There is no way to compare cohorts side-by-side (e.g., Frailty vs Pain & MSK vs Neurological).
3. There is no individual patient lookup — no way to pull up a single patient's full record.
4. The dashboard serves three distinct audiences (management, research, clinical staff) from a single undifferentiated page.

---

## 2. Solution: Grouped Pages (3 pages)

Reorganise the dashboard into three purposeful pages, each serving a clear audience. No emojis anywhere in the UI.

### File structure (after)

```
dashboard/
├── app.py                    # Page 1: Overview (refactored from current app.py)
├── _utils.py                 # Shared: load_data(), load_models(), sidebar filter logic
└── pages/
    ├── cohort_analysis.py    # Page 2: Cohort Analysis (new)
    └── clinical_tools.py     # Page 3: Clinical Tools (new — replaces dosage_recommender.py)
```

`pages/dosage_recommender.py` is deleted. Its content moves into `clinical_tools.py`.

### Sidebar navigation (all pages)

```
Overview
Cohort Analysis
Clinical Tools
```

No emojis in sidebar labels, page titles, section headers, or any UI text.

---

## 3. Page Designs

### 3.1 Overview (`app.py`) — Management view

Audience: management, anyone wanting a high-level summary.

**Removes:** Intake Estimator expander (moves to Clinical Tools).  
**Adds:** Cohort distribution donut chart (new, placed between KPIs and pre/post plots).  
**Keeps:** everything else from the current app.py.

Layout (top to bottom):
1. Page title: "QuantumTX AH — Clinical Analytics"
2. KPI strip — N Patients, % Follow-up, Mean Composite Improvement, % Overall Responders
3. Sidebar filters — Cohort (multiselect), Usage Frequency, Age Band, Gender (apply to all charts on this page)
4. Cohort distribution donut chart — 7 cohorts, labelled with count and %
5. Pre vs Post boxplots — 6 functional tests, 2-row x 3-col grid, paired observations only
6. Mean composite improvement by comorbidity flag — horizontal bar chart, n labelled

### 3.2 Cohort Analysis (`pages/cohort_analysis.py`) — Research view

Audience: researchers, clinical leads comparing programme segments.

**All new.** No sidebar filters — the on-page cohort selector is the primary control.

Layout (top to bottom):
1. Page title: "Cohort Analysis"
2. Cohort selector — multiselect at top of page, defaults to all non-Unclassified cohorts (Pain & MSK, Frailty/Sarcopenia, Neurological, Post-Surgical/Rehab, Other-Mixed, Wellness)
3. Summary table — one row per selected cohort: N, % follow-up, % responders, % dropout, mean composite improvement
4. Side-by-side grouped bar chart — responder rate and dropout rate per cohort
5. Per-test improvement box plots — one subplot per functional test (6 total), colour-coded by cohort
6. Demographic breakdown — age band distribution (stacked bar) and gender split per cohort

### 3.3 Clinical Tools (`pages/clinical_tools.py`) — Clinical staff view

Audience: physiotherapists, clinical staff seeing patients.

Three sections on one page, in this order. No tabs.

**Section 1: Patient Lookup** (top)

- Text input: "Patient S/N"
- On match: renders a record card with four columns:
  - Demographics: age, gender, cohort, usage frequency
  - Baseline scores: VAS, TUG, 5xSST, normal gait speed, SPPB
  - Phenotype flags: all `final_*` columns equal to 1, displayed as clean label pills (text only, no emojis)
  - Outcomes: post scores, composite improvement, responder status (overall_responder), dropout flag, dosage label
- On no match: "Patient not found" message

**Section 2: Intake Estimator** (middle)

- Identical inputs to the current expander: age, baseline SPPB, TUG, 5xSST, normal gait speed, usage frequency, cohort, gender, comorbidity tags (free text)
- Fully visible — no expander wrapper
- Outputs displayed immediately below form: Predicted Composite Improvement, P(Responder), P(Dropout) as st.metric cards
- Disclaimer: "Model predictions based on similar patients. Not a clinical guarantee."

**Section 3: Dosage Recommender** (bottom)

- Moved verbatim from `pages/dosage_recommender.py`
- Intake form: age, gender, joined-with-pain, 11 condition checkboxes
- Output: recommended frequency label (once / twice / L+R 10), confidence %, probability breakdown bar chart
- Confidence warning if model confidence < 50%

---

## 4. Shared Utilities (`dashboard/_utils.py`)

Extract the following from `app.py` into a shared module imported by all pages:

- `load_data() -> pd.DataFrame` — cached parquet loader
- `load_models() -> dict` — cached joblib loader for regression, classifier, dropout, and dosage_frequency models (all four)
- `_unique_sorted(series) -> list` — helper for sidebar filter options
- `render_sidebar_filters(df) -> dict` — renders cohort, usage frequency, age band, gender multiselects + reset button; returns a dict of selected values. Called only by pages that use filters (Overview). Cohort Analysis does not call this.

This eliminates duplication between pages that need the same data and filters.

---

## 5. Out of Scope

- No pipeline changes (no re-running make ingest / make model etc.)
- No model retraining
- No deployment — dashboard remains local-only
- No Data Quality page (deferred)
- No changes to config YAML files
- No changes to `src/qtx/` library code

---

## 6. Success Criteria

- Three pages load without error from `make dashboard`
- Intake Estimator is visible on Clinical Tools page without any expander interaction
- Patient Lookup returns a full record card for a valid S/N
- Cohort Analysis renders comparison charts for any selection of 2+ cohorts
- No emojis appear anywhere in the UI
- All existing 63 tests continue to pass (dashboard changes do not touch library code)
