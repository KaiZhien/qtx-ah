# External Data Points to Request

Questions about data that isn't currently in the pipeline but would meaningfully improve
EDA depth and model performance. Grouped by category.

---

## 1. Treatment / Session Data

These are the highest-priority gaps. Session-level data would unlock time-series analysis,
adherence modelling, and dose-response curves.

| Question | Why it matters |
|---|---|
| How many sessions did each patient complete? | Strongest adherence signal; separates early dropouts from late dropouts |
| What were the session dates? | Enables treatment duration calculation and time-to-dropout analysis |
| What was the gap between baseline assessment and first session? | Long gaps may predict dropout |
| What was the gap between last session and follow-up assessment? | Affects post-measurement validity |
| Which leg(s) were treated in each session (1x protocol)? | Allows bilateral vs unilateral comparison |
| Were any sessions missed and then made up? | Distinguishes irregular attendance from pure dropout |
| Was there a standardised warm-up or cool-down protocol? | Controls for confounders in gait/functional tests |
| What device/machine ID was used? | Batch effects between machines at the centre |

---

## 2. Patient Characteristics

| Question | Why it matters |
|---|---|
| Height and weight (BMI)? | BMI is a known confounder for mobility and pain outcomes |
| Grip strength (hand dynamometry)? | Strong predictor of frailty and functional recovery |
| Cognitive status (MMSE or equivalent)? | Affects follow-up adherence and self-reported pain accuracy |
| Living situation (alone vs with family)? | Social support predicts adherence |
| Smoking status? | Affects muscle recovery and cardiovascular fitness |
| Employment / activity level? | Sedentary vs active baseline affects trajectory |
| Prior physiotherapy or similar treatment in the past 12 months? | Controls for concurrent care effects |
| Number of falls in the past 12 months? | Grounds the fall-risk flag in a quantitative measure |

---

## 3. Clinical / Medical Data

| Question | Why it matters |
|---|---|
| Comorbidity severity, not just presence (e.g., HbA1c for diabetes, Hoehn & Yahr for Parkinson's)? | Binary flags lose severity information that affects prognosis |
| Current medications (especially opioids, NSAIDs, beta-blockers, statins)? | Multiple drug classes confound pain, gait, and muscle response |
| Pain location specificity (which joint, bilateral vs unilateral)? | OA in knee vs hip vs shoulder have very different trajectories |
| Frailty scale score (e.g., FRAIL or CFS), not just binary flag? | Quantitative frailty gradient predicts recovery rate |
| Reason for referral (GP, specialist, self)? | Referral source correlates with severity and motivation |
| Any adverse events or treatment pauses reported? | Necessary for safety analysis and dropout attribution |
| Post-surgical type and time since surgery (for post-surgical cohort)? | Recency and procedure type drive expected recovery curve |

---

## 4. Dropout / Non-Completion

| Question | Why it matters |
|---|---|
| Was dropout voluntary (patient decision) or administrative (moved, cost, scheduling)? | Voluntary dropout may carry clinical signal; admin dropout is noise |
| Was a reason recorded for not completing follow-up assessment? | Separates "improved and discharged" from "lost to follow-up" |
| Were patients contacted after dropout? Any outcome data available? | Even partial post data would reduce outcome selection bias |
| Was there a planned endpoint different from the standard follow-up window? | Some patients may have had shorter programmes by design |

---

## 5. Programme / Operational Data

| Question | Why it matters |
|---|---|
| Referring department or physician? | Referral pathway may correlate with patient preparation and motivation |
| Subsidy or insurance type (MediShield Life, CHAS, self-pay)? | Cost burden predicts dropout in Singapore context |
| Time of day / day of week for sessions? | Scheduling patterns can proxy for lifestyle and motivation |
| Was this the patient's first QTX programme or a repeat? | Repeat patients have different baselines and expectations |
| Was a home exercise programme prescribed alongside QTX sessions? | Co-intervention must be controlled for in outcome modelling |

---

## 6. Mid-Programme Assessments

| Question | Why it matters |
|---|---|
| Are any mid-programme assessments available (e.g., at session 5 or 10)? | Enables early-response prediction and trajectory modelling |
| Are patient-reported outcomes (pain diaries, satisfaction scores) collected during the programme? | Richer signal than a single post-assessment |

---

## Priority Order

If only some of these can be obtained, prioritise in this order:

1. **Sessions completed + session dates** — unlocks adherence, dropout timing, dose-response
2. **Dropout reason** — resolves the biggest modelling ambiguity
3. **BMI** — quick to collect, high confounding impact
4. **Comorbidity severity scores** — upgrades binary flags to continuous features
5. **Medications** — major confounder currently uncontrolled
