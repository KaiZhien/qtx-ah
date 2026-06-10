# Patient Trajectory Simulator — Design Spec

**Date:** 2026-06-10  
**Status:** Approved for implementation  
**Author:** Reet Mitra  

---

## 1. Context and Motivation

The BIXEPS rehabilitation platform has zero patient-facing surface area. Every component — predictions, insights, session prep, cohort curves — is designed for clinicians. Patients who use the device have no digital touchpoint to understand their own progress or feel invested in continuing.

This feature adds a **"Patient View" tab** to the existing `/patient/[sn]` drawer. A clinician opens it during or after a session and turns the screen toward the patient. It shows three things:

1. **How far you've come** — plain-English summary of pain and mobility improvement since session 1.
2. **Pick your goal** — two large tap targets: "Reduce my pain" / "Move better". Sets the active metric.
3. **Your projection** — a session slider (1–12 extra sessions) overlaid on the cohort percentile band, with the patient's actual trajectory and a projected dot at their chosen session count.

**Design constraints:**
- No new auth model. Lives inside the existing clinician portal.
- Designed for elderly patients (70–79 is the key RAISE window). Large text, plain language, high contrast, large touch targets (min 44px).
- No clinical jargon on screen. "TUG" → "getting up and walking". "VAS" → "pain score".
- Warm, encouraging tone. Never alarming.

---

## 2. Architecture

### New backend: 1 endpoint

`GET /api/patient/{sn}/metric_series?metric={metric_name}`

Added to `api/routers/patients.py`. Returns per-session values for a specific metric for a given patient. Used to plot the patient's actual trajectory on the chart.

**Valid metrics (whitelist — reject anything else with 400):**
- `vas_change`
- `tug_change_pct`

**Query:**
```sql
SELECT session_number, {metric} AS value
FROM sessions
WHERE patient_id = (SELECT id FROM patients WHERE sn = :sn)
  AND {metric} IS NOT NULL
  AND (ingested_from IS NULL OR ingested_from NOT ILIKE '%raise%')
ORDER BY session_number
```

**Response shape:**
```json
{
  "sn": "QTX001",
  "metric": "vas_change",
  "points": [
    {"session_number": 1, "value": -1.5},
    {"session_number": 2, "value": -2.0}
  ]
}
```

**Error cases:**
- `404` if patient sn not found.
- `400` with `{"detail": "Invalid metric. Must be one of: vas_change, tug_change_pct"}` if metric not in whitelist.
- `[]` points (not an error) if patient has no sessions with non-null values for that metric.

**Auth:** Uses existing `verify_api_key` dependency. Same as all other patient routes.

---

### New frontend: 4 components + 1 tab addition

```
web/
  components/
    patient/                          ← NEW directory
      PatientProgressView.tsx         ← NEW orchestrator
      ProgressHeroCard.tsx            ← NEW hero card
      GoalPicker.tsx                  ← NEW goal buttons
      TrajectoryChart.tsx             ← NEW chart
  components/
    PatientDrawerBody.tsx             ← MODIFY: add "patient" tab
  lib/
    api.ts                            ← MODIFY: add fetchMetricSeries
    types.ts                          ← MODIFY: add MetricSeriesPoint, MetricSeriesResponse
```

---

## 3. File-by-File Specification

### 3.1 `web/lib/types.ts` additions

```typescript
export interface MetricSeriesPoint {
  session_number: number
  value: number
}

export interface MetricSeriesResponse {
  sn: string
  metric: string
  points: MetricSeriesPoint[]
}
```

---

### 3.2 `web/lib/api.ts` addition

```typescript
export async function fetchMetricSeries(
  sn: string,
  metric: "vas_change" | "tug_change_pct"
): Promise<MetricSeriesResponse> {
  const res = await fetch(
    `/api/patient/${encodeURIComponent(sn)}/metric_series?metric=${metric}`,
    { headers: apiHeaders() }
  )
  if (!res.ok) throw new Error(`fetchMetricSeries: ${res.status}`)
  return res.json()
}
```

---

### 3.3 `api/routers/patients.py` addition

Add this route to the existing `patients.py` router (do not create a new router file). Place it after the existing `/patient/{sn}/timeline` route.

```python
VALID_METRICS = {"vas_change", "tug_change_pct"}

@router.get("/patient/{sn}/metric_series", dependencies=[Depends(verify_api_key)])
def get_metric_series(
    sn: str,
    metric: str = Query(...),
    db: DBSession = Depends(get_db),
):
    if metric not in VALID_METRICS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid metric. Must be one of: {', '.join(sorted(VALID_METRICS))}",
        )
    patient = db.query(Patient).filter_by(sn=sn).first()
    if patient is None:
        raise HTTPException(status_code=404, detail=f"Patient sn={sn!r} not found")

    rows = db.execute(
        text(f"""
            SELECT session_number, {metric} AS value
            FROM sessions
            WHERE patient_id = :pid
              AND {metric} IS NOT NULL
              AND (ingested_from IS NULL OR ingested_from NOT ILIKE '%raise%')
            ORDER BY session_number
        """),
        {"pid": str(patient.id)},
    ).fetchall()

    return {
        "sn": sn,
        "metric": metric,
        "points": [{"session_number": int(r.session_number), "value": float(r.value)} for r in rows],
    }
```

**Security note:** `metric` is validated against a strict whitelist before being interpolated into the SQL string. No user input ever reaches the SQL template.

---

### 3.4 `web/components/patient/GoalPicker.tsx`

Two large buttons. Tap target minimum height 56px. Selected state uses `var(--accent)` background at 12% opacity with a solid border. No smaller sub-labels.

```tsx
"use client"
import React from "react"

type Goal = "pain" | "mobility"

interface GoalPickerProps {
  selected: Goal
  onChange: (goal: Goal) => void
}

export function GoalPicker({ selected, onChange }: GoalPickerProps) {
  const btn = (goal: Goal, icon: string, label: string) => {
    const active = selected === goal
    return (
      <button
        onClick={() => onChange(goal)}
        style={{
          flex: 1,
          minHeight: 56,
          borderRadius: 12,
          border: `2px solid ${active ? "var(--accent)" : "var(--line)"}`,
          background: active ? "rgba(59,107,217,0.10)" : "var(--surface)",
          color: active ? "var(--accent)" : "var(--ink-2)",
          fontSize: 15,
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          transition: "all 150ms",
        }}
      >
        <span style={{ fontSize: 22 }}>{icon}</span>
        {label}
      </button>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 10 }}>
        What matters most to you right now?
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        {btn("pain",     "💊", "Reduce my pain")}
        {btn("mobility", "🚶", "Move better")}
      </div>
    </div>
  )
}
```

---

### 3.5 `web/components/patient/ProgressHeroCard.tsx`

Shows two stat callouts, always both visible. Uses `patient.pre_vas` / `patient.pre_tug_s` as baseline. Reads latest session post values from timeline data passed in as props.

```tsx
"use client"
import React from "react"
import type { Patient, TimelineSession } from "@/lib/types"

interface ProgressHeroCardProps {
  patient: Patient
  sessions: TimelineSession[]
}

function StatCallout({
  label,
  value,
  unit,
  positive,
  noDataMsg,
}: {
  label: string
  value: string | null
  unit: string
  positive: boolean | null
  noDataMsg: string
}) {
  return (
    <div style={{
      flex: 1,
      background: "var(--surface-sunken)",
      borderRadius: 12,
      padding: "18px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 500 }}>{label}</div>
      {value != null ? (
        <>
          <div style={{
            fontSize: 32,
            fontWeight: 700,
            fontFamily: "var(--font-mono)",
            color: positive ? "var(--success)" : positive === false ? "var(--danger)" : "var(--ink)",
            lineHeight: 1,
          }}>
            {value}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{unit}</div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: "var(--ink-4)", lineHeight: 1.4 }}>{noDataMsg}</div>
      )}
    </div>
  )
}

export function ProgressHeroCard({ patient, sessions }: ProgressHeroCardProps) {
  // Find latest session with post_vas
  const latestVas = [...sessions]
    .reverse()
    .find(s => s.post_vas != null)
  // Find latest session with post_tug_s
  const latestTug = [...sessions]
    .reverse()
    .find(s => s.post_tug_s != null)

  const painDelta = (latestVas && patient.pre_vas != null)
    ? patient.pre_vas - latestVas.post_vas!   // positive = pain reduced = good
    : null

  const tugDelta = (latestTug && patient.pre_tug_s != null)
    ? patient.pre_tug_s - latestTug.post_tug_s!  // positive = faster = good
    : null

  const earlyNote = "Most people start seeing changes around session 3–4. Keep going!"

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginBottom: 12 }}>
        Your progress so far
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <StatCallout
          label="Pain improvement"
          value={painDelta != null ? (painDelta >= 0 ? `−${Math.abs(painDelta).toFixed(1)}` : `+${Math.abs(painDelta).toFixed(1)}`) : null}
          unit={painDelta != null && painDelta >= 0 ? "points less pain" : painDelta != null ? "points more pain" : ""}
          positive={painDelta != null ? painDelta >= 0 : null}
          noDataMsg={earlyNote}
        />
        <StatCallout
          label="Mobility improvement"
          value={tugDelta != null ? `${Math.abs(tugDelta).toFixed(1)}s` : null}
          unit={tugDelta != null && tugDelta >= 0 ? "faster getting up & walking" : tugDelta != null ? "slower — still adapting" : ""}
          positive={tugDelta != null ? tugDelta >= 0 : null}
          noDataMsg={earlyNote}
        />
      </div>
    </div>
  )
}
```

---

### 3.6 `web/components/patient/TrajectoryChart.tsx`

Pure SVG. Three layers:
1. Cohort p25–p75 band (semi-transparent fill, opacity 0.15)
2. Patient's actual trajectory (solid line + dots)
3. Dashed projection line from last real point to the projected p50 dot at target session

**Projection logic:**
- `targetSession = maxPatientSession + extraSessions`
- Find the point in `cohortPoints` where `session_number === targetSession`. If not exact, use the closest `session_number <= targetSession` (nearest-floor lookup).
- If `targetSession` is beyond the cohort curve's range, show the projection dot at the last known p50 and add a small disclaimer label.
- If patient has zero real points, only show the cohort band (no patient line, no projection).

```tsx
"use client"
import React from "react"
import type { ResponseCurvePoint, MetricSeriesPoint } from "@/lib/types"

interface TrajectoryChartProps {
  cohortPoints: ResponseCurvePoint[]
  patientPoints: MetricSeriesPoint[]
  extraSessions: number
  color?: string
  metricLabel: string
}

export function TrajectoryChart({
  cohortPoints,
  patientPoints,
  extraSessions,
  color = "var(--accent)",
  metricLabel,
}: TrajectoryChartProps) {
  const W = 340, H = 200
  const PAD = { top: 32, right: 20, bottom: 32, left: 48 }
  const CW = W - PAD.left - PAD.right
  const CH = H - PAD.top - PAD.bottom

  const maxPatientSn = patientPoints.length
    ? Math.max(...patientPoints.map(p => p.session_number))
    : 0
  const targetSn = maxPatientSn + extraSessions

  // Determine x range
  const allSns = [
    ...cohortPoints.map(p => p.session_number),
    ...patientPoints.map(p => p.session_number),
    targetSn,
  ]
  const minSn = Math.min(...allSns)
  const maxSn = Math.max(...allSns)
  const snRange = maxSn - minSn || 1

  // Determine y range from all values
  const allVals: number[] = [
    ...cohortPoints.flatMap(p => [p.p25, p.p50, p.p75].filter((v): v is number => v != null)),
    ...patientPoints.map(p => p.value),
  ]
  if (!allVals.length) return null
  const minV = Math.min(...allVals)
  const maxV = Math.max(...allVals)
  const vRange = maxV - minV || 1
  const vPad = vRange * 0.2
  const lo = minV - vPad, hi = maxV + vPad

  const xOf = (sn: number) => PAD.left + ((sn - minSn) / snRange) * CW
  const yOf = (v: number) => PAD.top + CH - ((v - lo) / (hi - lo)) * CH

  // Build band polygon
  const bandPts = cohortPoints.filter(p => p.p25 != null && p.p75 != null)
  let bandPath = ""
  if (bandPts.length >= 2) {
    const fwd = bandPts.map(p => `${xOf(p.session_number).toFixed(1)},${yOf(p.p25!).toFixed(1)}`).join(" L ")
    const bwd = [...bandPts].reverse().map(p => `${xOf(p.session_number).toFixed(1)},${yOf(p.p75!).toFixed(1)}`).join(" L ")
    bandPath = `M ${fwd} L ${bwd} Z`
  }

  // Median line
  const medianD = cohortPoints
    .filter(p => p.p50 != null)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.session_number).toFixed(1)} ${yOf(p.p50!).toFixed(1)}`)
    .join(" ")

  // Patient line
  const patD = patientPoints.length > 1
    ? patientPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.session_number).toFixed(1)} ${yOf(p.value).toFixed(1)}`).join(" ")
    : ""

  // Projection
  const lastPt = patientPoints[patientPoints.length - 1]
  const projCandidates = cohortPoints
    .filter(p => p.p50 != null && p.session_number <= targetSn)
  const projCurvePoint = projCandidates[projCandidates.length - 1]
  const isCapped = projCurvePoint && projCurvePoint.session_number < targetSn
  const projX = isCapped ? xOf(projCurvePoint.session_number) : xOf(targetSn)
  const projY = projCurvePoint ? yOf(projCurvePoint.p50!) : null

  const projD = (lastPt && projY != null)
    ? `M ${xOf(lastPt.session_number).toFixed(1)} ${yOf(lastPt.value).toFixed(1)} L ${projX.toFixed(1)} ${projY.toFixed(1)}`
    : ""

  const yTicks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.85]
  const xTickSns = Array.from(new Set([minSn, ...patientPoints.map(p => p.session_number), targetSn]))
    .filter(sn => sn <= maxSn)

  return (
    <div style={{ background: "var(--surface-sunken)", borderRadius: 12, padding: "12px 10px 8px" }}>
      {/* Chart title */}
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 6, paddingLeft: PAD.left }}>
        {metricLabel} — your trajectory vs. similar patients
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {/* Y-axis grid + labels */}
        {yTicks.map((tv, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yOf(tv)} y2={yOf(tv)}
              stroke="var(--line)" strokeDasharray="2,4" />
            <text x={PAD.left - 4} y={yOf(tv) + 3.5} textAnchor="end"
              fontSize="9" fontFamily="var(--font-mono)" fill="var(--ink-4)">
              {tv.toFixed(Math.abs(tv) > 10 ? 0 : 1)}
            </text>
          </g>
        ))}

        {/* Cohort band */}
        {bandPath && <path d={bandPath} fill={color} opacity="0.13" />}

        {/* Median dashed */}
        {medianD && <path d={medianD} fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray="4,3" opacity="0.5" />}

        {/* Patient actual line */}
        {patD && <path d={patD} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />}

        {/* Patient dots */}
        {patientPoints.map(p => (
          <circle key={p.session_number} cx={xOf(p.session_number)} cy={yOf(p.value)}
            r="4.5" fill={color} />
        ))}

        {/* Projection dashed line */}
        {projD && <path d={projD} fill="none" stroke={color} strokeWidth="2"
          strokeDasharray="5,4" opacity="0.7" />}

        {/* Projected dot */}
        {projY != null && lastPt && (
          <g>
            <circle cx={projX} cy={projY} r="6" fill="none" stroke={color} strokeWidth="2" opacity="0.8" />
            <circle cx={projX} cy={projY} r="3" fill={color} opacity="0.6" />
          </g>
        )}

        {/* Capped note */}
        {isCapped && projY != null && (
          <text x={projX + 8} y={projY - 6} fontSize="9" fill="var(--ink-4)">
            beyond data
          </text>
        )}

        {/* X-axis labels */}
        {xTickSns.map(sn => (
          <text key={sn} x={xOf(sn)} y={H - 6} textAnchor="middle"
            fontSize="9" fontFamily="var(--font-mono)" fill="var(--ink-4)">
            {sn}
          </text>
        ))}
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, fontSize: 10.5, color: "var(--ink-4)",
        paddingLeft: PAD.left, marginTop: 4, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="16" height="6">
            <rect x="0" y="0" width="16" height="6" fill={color} opacity="0.13" rx="1" />
          </svg>
          Middle 50% of similar patients
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="16" height="3">
            <line x1="0" y1="1.5" x2="16" y2="1.5" stroke={color} strokeWidth="2.5" />
          </svg>
          Your results
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="16" height="3">
            <line x1="0" y1="1.5" x2="16" y2="1.5" stroke={color} strokeWidth="2"
              strokeDasharray="4,3" opacity="0.7" />
          </svg>
          Projected
        </span>
      </div>
    </div>
  )
}
```

---

### 3.7 `web/components/patient/PatientProgressView.tsx`

Orchestrates all state. Fetches metric series on mount and on goal change. Passes cohort curves + patient points to TrajectoryChart. No fetching happens when slider moves — slider is purely client-side.

```tsx
"use client"
import React from "react"
import type { Patient, TimelineSession, ResponseCurvePoint } from "@/lib/types"
import { fetchMetricSeries, getResponseCurves } from "@/lib/api"
import { ProgressHeroCard } from "./ProgressHeroCard"
import { GoalPicker } from "./GoalPicker"
import { TrajectoryChart } from "./TrajectoryChart"

type Goal = "pain" | "mobility"

// Priority-ordered list to pick primary grp_* flag
const GRP_PRIORITY = [
  "grp_frailty_sarcopenia", "grp_joint_disease", "grp_neurological",
  "grp_post_surgical", "grp_balance_falls", "grp_metabolic",
  "grp_cardiovascular", "grp_oncology", "grp_autoimmune",
  "grp_softtissue_injury", "grp_generalised_pain", "grp_osteoporosis",
  "grp_spine_back", "grp_wellness",
]

function primaryGrpFlag(patient: Patient): string {
  const p = patient as unknown as Record<string, unknown>
  return GRP_PRIORITY.find(f => p[f] === 1 || p[f] === true) ?? "grp_wellness"
}

const GOAL_META: Record<Goal, { metric: "vas_change" | "tug_change_pct"; label: string }> = {
  pain:     { metric: "vas_change",     label: "Pain score change per session" },
  mobility: { metric: "tug_change_pct", label: "Walking speed improvement per session" },
}

interface PatientProgressViewProps {
  patient: Patient
  sessions: TimelineSession[]
}

export function PatientProgressView({ patient, sessions }: PatientProgressViewProps) {
  const [goal, setGoal] = React.useState<Goal>("pain")
  const [extraSessions, setExtraSessions] = React.useState(4)
  const [patientPoints, setPatientPoints] = React.useState<{ session_number: number; value: number }[]>([])
  const [cohortPoints, setCohortPoints] = React.useState<ResponseCurvePoint[]>([])
  const [loading, setLoading] = React.useState(true)

  const grpFlag = React.useMemo(() => primaryGrpFlag(patient), [patient.id])
  const { metric, label } = GOAL_META[goal]

  React.useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchMetricSeries(String(patient.sn), metric),
      getResponseCurves(grpFlag, metric),
    ]).then(([series, curves]) => {
      setPatientPoints(series.points)
      const curve = curves?.curves.find(c => c.metric === metric)
      setCohortPoints(curve?.points ?? [])
    }).catch(() => {
      setPatientPoints([])
      setCohortPoints([])
    }).finally(() => setLoading(false))
  }, [patient.id, metric, grpFlag])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Section 1: Hero */}
      <ProgressHeroCard patient={patient} sessions={sessions} />

      {/* Section 2: Goal picker */}
      <GoalPicker selected={goal} onChange={setGoal} />

      {/* Section 3: Chart + slider */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
          Where could you be?
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "24px 0", textAlign: "center" }}>
            Loading your data…
          </div>
        ) : (
          <TrajectoryChart
            cohortPoints={cohortPoints}
            patientPoints={patientPoints}
            extraSessions={extraSessions}
            metricLabel={label}
          />
        )}

        {/* Session slider */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--ink-2)" }}>
            <span style={{ fontWeight: 600 }}>
              {extraSessions === 1 ? "1 more session" : `${extraSessions} more sessions`}
            </span>
            <span style={{ color: "var(--ink-4)", fontSize: 12 }}>Drag to explore</span>
          </div>
          <input
            type="range"
            min={1}
            max={12}
            value={extraSessions}
            onChange={e => setExtraSessions(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--ink-4)" }}>
            <span>1 session</span>
            <span>12 sessions</span>
          </div>
        </div>

        {/* Warm encouragement note */}
        <div style={{
          fontSize: 12.5,
          color: "var(--ink-3)",
          background: "var(--surface-sunken)",
          borderRadius: 8,
          padding: "10px 14px",
          lineHeight: 1.5,
        }}>
          The shaded area shows how patients with similar conditions typically progress.
          Your clinician will help you set the right pace.
        </div>
      </div>
    </div>
  )
}
```

---

### 3.8 `web/components/PatientDrawerBody.tsx` modification

**Three changes only:**

1. Add `"patient"` to the `activeTab` type union:
   ```typescript
   const [activeTab, setActiveTab] = React.useState<"clinical" | "wearable" | "timeline" | "ai" | "patient">("clinical");
   ```

2. Add import and fetch for timeline sessions (needed by PatientProgressView's ProgressHeroCard):
   ```typescript
   import { PatientProgressView } from "@/components/patient/PatientProgressView"
   import { fetchTimeline } from "@/lib/api"
   // Add state:
   const [timelineSessions, setTimelineSessions] = React.useState<TimelineSession[]>([])
   // Add effect (fetch when patient tab opens or patient changes):
   React.useEffect(() => {
     if (activeTab !== "patient" || !patient) return
     fetchTimeline(String(patient.sn))
       .then(r => setTimelineSessions(r.sessions))
       .catch(() => setTimelineSessions([]))
   }, [activeTab, patient?.id])
   // Reset on patient change (add to existing reset effect):
   setTimelineSessions([])
   ```

3. Add tab option and render block:
   ```typescript
   // In Tabs options array, add:
   { value: "patient", label: "Patient View" }

   // After the AI tab block, add:
   {activeTab === "patient" && (
     <PatientProgressView patient={patient} sessions={timelineSessions} />
   )}
   ```

---

## 4. Tests

**File:** `tests/test_metric_series_api.py`

Write tests that cover:
- `GET /api/patient/{sn}/metric_series?metric=vas_change` returns 200 with `points` array when data exists
- Returns 404 for unknown patient sn
- Returns 400 with clear message for invalid metric name (e.g. `?metric=injection_attempt`)
- Returns empty `points` array (not 404) when patient exists but has no non-null values for that metric
- Returns 401 when API key is missing
- `points` array items have `session_number` (int) and `value` (float) fields
- RAISE sessions are excluded (ingested_from ILIKE '%raise%')

Follow the same mock pattern as `test_benchmark_api.py`: stub weasyprint, set `QTX_API_KEY`, override `get_db` dependency with a MagicMock, use `TestClient`.

---

## 5. Acceptance Criteria

- [ ] `GET /api/patient/{sn}/metric_series?metric=vas_change` returns 200 with correct shape
- [ ] `GET /api/patient/{sn}/metric_series?metric=invalid` returns 400
- [ ] Patient View tab appears in the drawer for any patient
- [ ] Hero card shows pain delta and mobility delta in plain English
- [ ] Goal picker switches between pain and mobility; chart re-fetches
- [ ] Slider moves projection dot without triggering a network request
- [ ] Cohort band renders when response curves data exists for the patient's primary grp_* flag
- [ ] If patient has 0 sessions with data for the selected metric, chart renders cohort band only (no patient line crash)
- [ ] If response curves return 404 for grp_flag, chart renders patient line only (no crash)
- [ ] TypeScript compiles with no errors (`npx tsc --noEmit`)
- [ ] All new tests pass; no regressions in existing 549-passing tests

---

## 6. What Is Not In Scope

- Patient authentication or dedicated patient URL
- SMS / push notifications
- Sharing / export of the chart
- Home exercise content
- Any backend ML inference triggered by slider interaction (projection is purely client-side interpolation of existing cohort curve data)
