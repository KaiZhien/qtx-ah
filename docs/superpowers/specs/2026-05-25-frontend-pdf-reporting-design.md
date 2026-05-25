# Sub-project 4 — Frontend + PDF Reporting: Design Spec

**Date:** 2026-05-25
**Status:** Approved — ready for implementation plan

---

## Goal

Add a "Timeline" tab to the existing patient drawer that shows session-by-session progress charts, AI insight cards, a clinician Q&A interface, and a PDF export button. The backend gains a new `GET /api/patient/{sn}/report.pdf` endpoint that renders a clean A4 clinical summary via WeasyPrint.

---

## Architecture

```
PatientDrawerBody (existing)
  └── "Timeline" tab (new)
        │
        ├── TimelineTab.tsx
        │     ├── on mount: fetchTimeline(sn)     → GET /api/patient/{sn}/timeline
        │     ├── on mount: fetchInsights(sn)     → GET /api/patient/{sn}/insights
        │     │
        │     ├── Section 1: Metric Charts
        │     │     └── MetricChart.tsx × N       (one per metric with data)
        │     │
        │     ├── Section 2: Insight Cards
        │     │     └── InsightCard.tsx × N       (newest first)
        │     │
        │     └── Section 3: Q&A Panel
        │           ├── QAPanel.tsx               → POST /api/patient/{sn}/ask
        │           └── "Download PDF" button     → window.open(/api/patient/{sn}/report.pdf?key=…)
        │
GET /api/patient/{sn}/report.pdf
        │
        ▼
  ReportService.generate(sn, db)
        │  queries Patient + Sessions + PatientTrend + latest PatientInsight
        │  renders patient_report.html via Jinja2
        │  converts to PDF via WeasyPrint
        └──▶  returns PDF bytes (application/pdf)
```

---

## 1. Frontend Components

### `web/components/clinical/TimelineTab.tsx`

Orchestrator component. Fetches timeline and insights on mount. Manages local state for Q&A responses. Renders three sections in a single scrollable column.

**Props:** `{ sn: string }`

**State:**
- `timeline: TimelineResponse | null`
- `insights: InsightRow[]`
- `loading: boolean`
- `error: string | null`

On mount: fires `fetchTimeline(sn)` and `fetchInsights(sn)` in parallel. On Q&A submit: calls `askQuestion(sn, question)` and prepends the response to the insights list.

---

### `web/components/clinical/MetricChart.tsx`

Custom SVG line chart following the existing pattern in `components/charts/`. One instance per metric that has ≥ 1 data point.

**Props:**
```typescript
interface MetricChartProps {
  label: string;          // e.g. "TUG (s)"
  sessions: { session_number: number; value: number }[];
  direction: string;      // "improving" | "declining" | "stable" | "early_signal" | "baseline_only"
  lowerIsBetter: boolean;
}
```

**Renders:** SVG with labelled X-axis (session numbers), Y-axis (values), connected line with dots at each data point, direction badge (e.g. "improving") in top-right. Uses `var(--success)` for improving, `var(--danger)` for declining, `var(--ink-3)` for stable/early.

**Metrics shown** (only if the session data contains non-null values):

| Label | Session column | Lower is better |
|-------|---------------|-----------------|
| Pain (VAS) | `post_vas` | yes |
| Mobility (TUG s) | `post_tug_s` | yes |
| Sit-Stand (5xSST s) | `post_5xsst_s` | yes |
| Gait Speed (m/s) | `post_normal_gs_ms` | no |
| Balance (SPPB) | `post_sppb` | no |

---

### `web/components/clinical/InsightCard.tsx`

Renders one row from the insights list (session summary or Q&A response).

**Props:**
```typescript
interface InsightCardProps {
  insight: InsightRow;  // { id, session_number, insight_type, question, content, model, created_at }
}
```

**Renders:**
- Header: `Session {N} · {date}` for session_summary, or `Q&A · {date}` for qa_response
- If qa_response: shows question in italic above the answer
- Body: content text (pre-wrap to preserve bullet points)
- Footer: model name in muted monospace (hidden if model = "stub")

---

### `web/components/clinical/QAPanel.tsx`

Single-turn Q&A input panel. Stateless — parent (`TimelineTab`) owns the response list.

**Props:**
```typescript
interface QAPanelProps {
  sn: string;
  onAnswer: (insight: InsightRow) => void;  // called with the new insight row after successful ask
  onPdfDownload: () => void;
}
```

**Renders:**
- `<textarea>` for the question (3 rows, expands on focus)
- "Ask" button — disabled while in-flight, shows "Asking..." label
- Inline error message if request fails
- "Download PDF" button below

---

## 2. API Client additions (`web/lib/api.ts`)

```typescript
// Types to add to web/lib/types.ts
export interface TimelineSession {
  session_number: number;
  session_date: string | null;
  notes: string | null;
  post_vas: number | null;
  post_tug_s: number | null;
  post_5xsst_s: number | null;
  post_normal_gs_ms: number | null;
  post_fast_gs_ms: number | null;
  post_sppb: number | null;
  composite_improvement: number | null;
  overall_responder: boolean | null;
  is_dropout: boolean;
}

export interface TrendRow {
  metric: string;
  direction: string;
  sessions_used: number;
  magnitude: number | null;
  first_value: number | null;
  last_value: number | null;
}

export interface TimelineResponse {
  patient: { sn: string; name: string; age: number; gender: string; cohort: string; primary_indication: string };
  sessions: TimelineSession[];
  trends: TrendRow[];
}

export interface InsightRow {
  id: string;
  session_number: number | null;
  insight_type: string;
  question: string | null;
  content: string;
  model: string;
  created_at: string;
}

// Functions to add to web/lib/api.ts
export async function fetchTimeline(sn: string): Promise<TimelineResponse>
export async function fetchInsights(sn: string): Promise<InsightRow[]>
export async function askQuestion(sn: string, question: string): Promise<{ answer: string; model: string }>
```

PDF is downloaded via `window.open(`/api/patient/${sn}/report.pdf?key=${API_KEY}`, "_blank")` — no fetch needed.

---

## 3. Backend — Report Endpoint

### `api/routers/report.py`

```
GET /api/patient/{sn}/report.pdf
```

- Validates API key (same `X-Api-Key` header pattern, but also accepts `?key=` query param for browser navigation)
- Returns 404 if patient not found, 503 if DB not ready
- Calls `ReportService(db).generate(sn)` → bytes
- Returns `Response(content=pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="patient_{sn}_report.pdf"'})`

### `api/services/report.py`

`ReportService.generate(sn: str) -> bytes`

1. Queries Patient, all Sessions (ordered by session_number), PatientTrend rows, most recent PatientInsight with `insight_type="session_summary"`
2. Renders `api/templates/patient_report.html` via Jinja2
3. Calls `weasyprint.HTML(string=html).write_pdf()` and returns the bytes

### `api/templates/patient_report.html`

A4-formatted HTML with inline CSS. Sections:

1. **Header** — patient name, gender, age, cohort, primary indication, generation date
2. **Session History** — table with columns: Session, Date, VAS, TUG, 5xSST, Gait (m/s), SPPB, Responder. Rows alternate background (`#f8f8f8` / white). Null values shown as `—`.
3. **Trend Signals** — one row per trend: metric label, direction badge (coloured), magnitude (e.g. `−2.5 s`), sessions used
4. **Latest AI Insight** — session number, date, and the full content text (pre-wrap)
5. **Clinician Notes** — any session rows where `notes` is non-null, shown as `Session N: {notes}`
6. **Footer** — `Generated by QTX Clinical Intelligence · {date}` in muted text

Fonts: system sans-serif. Colours: black text, `#2563eb` for section headers, `#16a34a` / `#dc2626` for improving/declining trend badges.

---

## 4. File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/components/clinical/TimelineTab.tsx` | Create | Orchestrator — fetch, state, three sections |
| `web/components/clinical/MetricChart.tsx` | Create | SVG line chart for one metric |
| `web/components/clinical/InsightCard.tsx` | Create | Single insight row display |
| `web/components/clinical/QAPanel.tsx` | Create | Q&A input + PDF download button |
| `web/components/PatientDrawerBody.tsx` | Modify | Add "Timeline" tab |
| `web/lib/api.ts` | Modify | Add `fetchTimeline`, `fetchInsights`, `askQuestion` |
| `web/lib/types.ts` | Modify | Add `TimelineSession`, `TrendRow`, `TimelineResponse`, `InsightRow` |
| `api/routers/report.py` | Create | `GET /api/patient/{sn}/report.pdf` |
| `api/services/report.py` | Create | `ReportService` — Jinja2 render + WeasyPrint |
| `api/templates/patient_report.html` | Create | A4 PDF HTML template |
| `api/main.py` | Modify | Register report router |
| `tests/test_report_api.py` | Create | PDF endpoint tests |

---

## 5. Error Handling

| Scenario | Frontend | Backend |
|----------|----------|---------|
| Timeline/insights fetch fails | Inline error message, retry button | 503/404 with JSON detail |
| Q&A request fails (502/503) | Inline error below input, button re-enabled | HTTPException with detail |
| PDF download fails | `window.open` navigates to error page | 500 JSON (WeasyPrint failure) |
| No sessions yet | "No session data yet" placeholder in charts section | Timeline returns empty sessions array |
| Stub mode (no API key) | Insight cards show stub placeholder text | 200 with STUB_RESPONSE content |

---

## 6. Testing

- **`tests/test_report_api.py`** — API tests using TestClient + SQLite in-memory + WeasyPrint monkeypatched to return `b"%PDF-stub"`. Covers: 200 with `content-type: application/pdf`, `Content-Disposition` header present, 404 on unknown sn, 503 when `_db_ready = False`, API key validation via `?key=` query param.
- **Frontend** — no automated tests (none exist in the project). Manual verification checklist: Timeline tab appears in drawer, charts render for a patient with sessions, insight cards display, Q&A returns response and card appears, PDF opens in new tab and is readable.

---

## 7. Out of Scope

- Streaming Q&A responses
- Prompt editing UI
- Embeddings / semantic search (deferred from Sub-project 3)
- Session creation or editing from the frontend (data entry is API-only)
- Multi-patient PDF batch export
