# Claude Code — Patient Trajectory Simulator: Implement, Test & Audit

## Your mission

Implement the **Patient Trajectory Simulator** feature end-to-end, verify it works, then run a structured multi-agent audit and report back only when every check passes.

Read `IMPLEMENTATION.md` (the "Next Feature" section at the top) and `docs/superpowers/specs/2026-06-10-patient-trajectory-simulator-design.md` in full before writing a single line of code. The spec is the source of truth.

---

## Environment conventions (never deviate from these)

- Python binary: `.venv/bin/python3.14` — never plain `python3`
- API imports: bare (`from db import get_db`, `from deps import verify_api_key`) — no `api.` prefix
- Timestamps: `datetime.now(timezone.utc)` — never `datetime.utcnow()`
- Tests: `PYTHONPATH=src:api .venv/bin/pytest tests/ -v`
- TypeScript check: `cd web && npx tsc --noEmit`
- No new migration needed (no new table)

---

## Implementation steps (in order)

Execute these sequentially. Do not skip ahead.

### Step 1 — Read all context files first

Before writing any code, read:
- `IMPLEMENTATION.md` (full file)
- `docs/superpowers/specs/2026-06-10-patient-trajectory-simulator-design.md` (full file)
- `api/routers/patients.py` (understand existing route patterns and imports)
- `web/components/PatientDrawerBody.tsx` (understand current tab structure exactly)
- `web/lib/api.ts` (understand existing fetch patterns)
- `web/lib/types.ts` (understand existing types)
- `web/components/charts/ResponseCurveChart.tsx` (understand SVG chart patterns — the TrajectoryChart follows the same idioms)
- `tests/test_benchmark_api.py` (understand mock/test patterns to replicate)

### Step 2 — Add types to `web/lib/types.ts`

Add `MetricSeriesPoint` and `MetricSeriesResponse` interfaces. See spec section 3.1.

### Step 3 — Add `fetchMetricSeries` to `web/lib/api.ts`

Add the function and import the new types. See spec section 3.2.

### Step 4 — Add `metric_series` endpoint to `api/routers/patients.py`

Add the `VALID_METRICS` whitelist and `get_metric_series` route. Do NOT create a new router file — add to the existing `patients.py`. See spec section 3.3. The `text()` import is already used in this file; add `Query` to the FastAPI imports if not already there.

### Step 5 — Create `web/components/patient/` directory with 4 components

Create in this order (each depends on the previous):
1. `web/components/patient/GoalPicker.tsx` — spec section 3.4
2. `web/components/patient/ProgressHeroCard.tsx` — spec section 3.5
3. `web/components/patient/TrajectoryChart.tsx` — spec section 3.6
4. `web/components/patient/PatientProgressView.tsx` — spec section 3.7

### Step 6 — Modify `web/components/PatientDrawerBody.tsx`

Apply the 6 surgical changes listed in spec section 3.8. Read the file first to find the exact insertion points. Do not rewrite the whole file — use targeted edits only.

### Step 7 — Create `tests/test_metric_series_api.py`

Write all tests listed in spec section 4. Follow the mock pattern from `test_benchmark_api.py` exactly (stub weasyprint, set `QTX_API_KEY`, `deps.load_all = lambda: None`, override `get_db`).

---

## Verification steps (run after implementation)

```bash
# 1. TypeScript — must be zero errors
cd web && npx tsc --noEmit

# 2. New tests — all must pass
PYTHONPATH=src:api .venv/bin/pytest tests/test_metric_series_api.py -v

# 3. Full suite — must not regress below 556 passing
PYTHONPATH=src:api .venv/bin/pytest tests/ -v

# 4. Dev server — start it and navigate to a patient drawer, open "Patient View" tab
make dev
```

Confirm in the browser:
- "Patient View" tab appears in the drawer
- Hero card renders (or shows the "keep going" message if no post data)
- Goal picker switches between Pain and Mobility
- Chart renders cohort band and/or patient line
- Slider moves the projected dot without any network request

---

## Multi-agent audit (run after all verification passes)

Once all tests pass and you have confirmed the UI renders correctly, run this Workflow to have agents audit the implementation independently, discuss their findings, and produce a single consolidated report.

```javascript
export const meta = {
  name: 'patient-trajectory-audit',
  description: 'Adversarial multi-agent audit of the Patient Trajectory Simulator',
  phases: [
    { title: 'Audit', detail: 'Independent agents check different dimensions' },
    { title: 'Verify', detail: 'Adversarial cross-check of each finding' },
    { title: 'Discuss', detail: 'Panel synthesises into a verdict' },
  ],
}

const DIMENSIONS = [
  {
    key: 'api_correctness',
    prompt: `Audit the metric_series API endpoint in api/routers/patients.py.
Check: (1) Is the metric whitelist enforced before SQL interpolation? (2) Does it return 400 for invalid metrics, 404 for unknown patients, 200 with correct shape otherwise? (3) Are RAISE sessions correctly excluded? (4) Does the endpoint use verify_api_key? (5) Are there any SQL injection vectors?
Read the file and the tests. Report findings as JSON with fields: passed (bool), issues (string[]), confidence (high/medium/low).`,
  },
  {
    key: 'frontend_rendering',
    prompt: `Audit the four new patient-facing components in web/components/patient/.
Check: (1) Does PatientProgressView fetch both metric_series and response_curves in parallel (Promise.all)? (2) Does the slider change state without triggering a fetch? (3) Does ProgressHeroCard handle null pre_vas / pre_tug_s and null post values gracefully without crashing? (4) Does TrajectoryChart handle zero patient points without crashing? (5) Does GoalPicker switch goals correctly?
Read each component. Report findings as JSON with fields: passed (bool), issues (string[]), confidence (high/medium/low).`,
  },
  {
    key: 'tab_integration',
    prompt: `Audit the PatientDrawerBody.tsx modification.
Check: (1) Is "patient" added to the activeTab type union? (2) Is timelineSessions reset when the patient changes (in the existing reset effect)? (3) Does the "Patient View" tab only fetch timeline data when that tab is active (lazy loading)? (4) Are all necessary imports present? (5) Does the tab render PatientProgressView with the correct props?
Read web/components/PatientDrawerBody.tsx. Report findings as JSON with fields: passed (bool), issues (string[]), confidence (high/medium/low).`,
  },
  {
    key: 'test_coverage',
    prompt: `Audit tests/test_metric_series_api.py.
Check: (1) Is 401 (missing API key) tested? (2) Is 404 (unknown patient) tested? (3) Is 400 (invalid metric) tested? (4) Is the empty-points case (patient exists, no data) tested? (5) Do tests verify the response schema (session_number is int, value is float)? (6) Is RAISE exclusion tested? (7) Do tests follow the same mock pattern as test_benchmark_api.py?
Read both files. Report findings as JSON with fields: passed (bool), issues (string[]), confidence (high/medium/low).`,
  },
  {
    key: 'ux_accessibility',
    prompt: `Audit the patient-facing UI for accessibility and usability given the target audience (elderly patients, 70–79 years old, being shown a screen by a clinician).
Check: (1) Are all interactive elements (GoalPicker buttons, slider) at least 44px in height? (2) Is font size for key numbers at least 28px? (3) Is there any clinical jargon visible to patients (TUG, VAS, composite_improvement, percentile)? (4) Is the encouragement copy shown when no data exists? (5) Are there any raw numbers or error messages that would confuse a non-technical patient?
Read all four patient components. Report findings as JSON with fields: passed (bool), issues (string[]), confidence (high/medium/low).`,
  },
  {
    key: 'type_safety',
    prompt: `Audit TypeScript type safety across the new code.
Check: (1) Are MetricSeriesPoint and MetricSeriesResponse defined in web/lib/types.ts? (2) Is fetchMetricSeries typed with the metric param as a union type ("vas_change" | "tug_change_pct")? (3) Does TrajectoryChart accept ResponseCurvePoint[] (from existing types) for cohortPoints? (4) Does ProgressHeroCard correctly type the sessions prop as TimelineSession[]? (5) Is there any use of 'any' in the new components?
Read web/lib/types.ts, web/lib/api.ts, and each new component. Report findings as JSON with fields: passed (bool), issues (string[]), confidence (high/medium/low).`,
  },
]

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['passed', 'issues', 'confidence'],
}

// Phase 1: All 6 dimensions audit independently in parallel
phase('Audit')
const auditResults = await parallel(
  DIMENSIONS.map(d => () =>
    agent(d.prompt, {
      label: `audit:${d.key}`,
      phase: 'Audit',
      schema: VERDICT_SCHEMA,
    }).then(result => ({ key: d.key, ...result }))
  )
)

const withFindings = auditResults.filter(Boolean).filter(r => r.issues.length > 0)

// Phase 2: Adversarial cross-check — each finding gets a skeptic
phase('Verify')
const allIssues = withFindings.flatMap(r =>
  r.issues.map(issue => ({ dimension: r.key, issue }))
)

const verified = allIssues.length > 0
  ? await parallel(
      allIssues.map(({ dimension, issue }) => () =>
        agent(
          `An auditor flagged this issue in the ${dimension} dimension:
"${issue}"

Try hard to REFUTE this finding. Is it actually a real problem in the code, or is it a false positive? Read the relevant files to check.
Default to refuted=true if you are uncertain.
Return: { refuted: boolean, reason: string }`,
          {
            label: `verify:${dimension}`,
            phase: 'Verify',
            schema: {
              type: 'object',
              properties: {
                refuted: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['refuted', 'reason'],
            },
          }
        ).then(v => ({ dimension, issue, ...v }))
      )
    )
  : []

const confirmed = verified.filter(Boolean).filter(v => !v.refuted)

// Phase 3: Discussion panel — synthesise into final verdict
phase('Discuss')
const discussionPrompt = `
You are a panel of senior engineers reviewing a new feature: the Patient Trajectory Simulator for a clinical rehabilitation platform.

Here is a summary of the audit:

DIMENSIONS CHECKED: ${DIMENSIONS.map(d => d.key).join(', ')}

CONFIRMED ISSUES (survived adversarial review):
${confirmed.length === 0
  ? 'None. All flagged issues were refuted.'
  : confirmed.map(c => `- [${c.dimension}] ${c.issue}`).join('\n')}

REFUTED ISSUES (false positives):
${verified.filter(Boolean).filter(v => v.refuted).map(v => `- [${v.dimension}] ${v.issue} (reason: ${v.reason})`).join('\n') || 'None.'}

Based on this, provide a final verdict:
1. Is the feature ready to ship as-is?
2. Are there any blocking issues that must be fixed before merge?
3. Are there any non-blocking suggestions worth noting?
4. Overall confidence score (0–100).

Be concise but specific. Reference file names and line numbers where relevant.
`

const verdict = await agent(discussionPrompt, { label: 'panel:verdict', phase: 'Discuss' })

return {
  dimensions_audited: DIMENSIONS.length,
  issues_found: allIssues.length,
  issues_confirmed: confirmed.length,
  confirmed_issues: confirmed,
  verdict,
}
```

---

## Final report

Once the Workflow completes, format and present the output to the user as follows:

```
## Patient Trajectory Simulator — Audit Report

### Dimensions audited
[list each dimension and pass/fail]

### Confirmed issues
[list each confirmed issue with dimension and description, or "None"]

### Panel verdict
[paste the panel verdict verbatim]

### Test results
[paste the pytest summary line]

### TypeScript
[pass/fail]

### Overall status
READY TO MERGE / NEEDS FIXES
```

Do not present this report until every step above is complete. If the audit finds blocking issues, fix them before presenting the report.
