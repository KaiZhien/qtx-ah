import React from "react"
import { render, screen } from "@testing-library/react"
import { ProgressHeroCard } from "../../components/patient/ProgressHeroCard"
import type { Patient, TimelineSession } from "../../lib/types"

// Minimal Patient stub — only fields the component reads
const basePatient: Patient = {
  sn: 1,
  id: "p-001",
  initials: "AB",
  age: 70,
  age_band: "70-79",
  gender: "F",
  cohort: "A",
  usage_frequency: "3x/week",
  intake_date: "2024-01-01",
  tags: "",
  pre_vas: 0,        // overridden per test
  pre_tug_s: 0,      // overridden per test
  pre_5xsst_s: 0,
  pre_normal_gs_ms: 0,
  pre_fast_gs_ms: 0,
  baseline_sppb: 0,
  post_vas: null,
  post_tug_s: null,
  post_5xsst_s: null,
  post_normal_gs_ms: null,
  post_fast_gs_ms: null,
  post_sppb: null,
  composite_improvement: null,
  overall_responder: null,
  mcid_count: 0,
  is_dropout: 0,
  has_oa: 0,
  has_diabetes: 0,
  has_stroke: 0,
  has_parkinsons: 0,
  has_frailty: 0,
  has_cancer: 0,
  has_hypertension: 0,
  has_osteoporosis: 0,
}

function makeSession(overrides: Partial<TimelineSession> = {}): TimelineSession {
  return {
    session_number: 1,
    session_date: null,
    notes: null,
    post_vas: null,
    post_tug_s: null,
    post_5xsst_s: null,
    post_normal_gs_ms: null,
    post_fast_gs_ms: null,
    post_sppb: null,
    composite_improvement: null,
    overall_responder: null,
    is_dropout: false,
    ...overrides,
  }
}

const EARLY_NOTE = /Most people start seeing/i

describe("ProgressHeroCard", () => {
  // ── 1. No data at all: encouragement copy shown in both callouts ──────────
  it("shows encouragement copy when pre_vas is null and sessions are empty", () => {
    const patient = { ...basePatient, pre_vas: null as unknown as number }
    render(<ProgressHeroCard patient={patient} sessions={[]} />)

    const msgs = screen.getAllByText(EARLY_NOTE)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
  })

  // ── 2. Pain improved: delta positive (pre > post) ─────────────────────────
  it("displays pain reduction when post_vas is lower than pre_vas", () => {
    const patient = { ...basePatient, pre_vas: 8 }
    const sessions = [makeSession({ session_number: 1, post_vas: 5.5 })]

    render(<ProgressHeroCard patient={patient} sessions={sessions} />)

    // value rendered as "−2.5"
    expect(screen.getByText("−2.5")).toBeInTheDocument()
    expect(screen.getByText("points less pain")).toBeInTheDocument()
  })

  // ── 3. Pain worsened: delta negative (post > pre) ────────────────────────
  it("displays pain increase when post_vas is higher than pre_vas", () => {
    const patient = { ...basePatient, pre_vas: 5 }
    const sessions = [makeSession({ session_number: 1, post_vas: 7 })]

    render(<ProgressHeroCard patient={patient} sessions={sessions} />)

    // value rendered as "+2.0"
    expect(screen.getByText("+2.0")).toBeInTheDocument()
    expect(screen.getByText("points more pain")).toBeInTheDocument()
  })

  // ── 4. Mobility improved: TUG delta positive (pre_tug_s > post_tug_s) ────
  it("displays mobility improvement when post_tug_s is lower than pre_tug_s", () => {
    const patient = { ...basePatient, pre_tug_s: 12 }
    const sessions = [makeSession({ session_number: 1, post_tug_s: 9.5 })]

    render(<ProgressHeroCard patient={patient} sessions={sessions} />)

    // value rendered as "2.5s"
    expect(screen.getByText("2.5s")).toBeInTheDocument()
    expect(screen.getByText(/faster getting up/i)).toBeInTheDocument()
  })

  // ── 5. Reverse-order sessions — component reverses array so last item wins ─
  it("uses the last session in original array order that has a value", () => {
    // Provide sessions in ascending order; component does [...sessions].reverse()
    // so the last element becomes the first candidate after reverse.
    const patient = { ...basePatient, pre_vas: 10 }
    const sessions = [
      makeSession({ session_number: 1, post_vas: 9 }),   // earlier
      makeSession({ session_number: 3, post_vas: 6 }),   // later — should win
    ]

    render(<ProgressHeroCard patient={patient} sessions={sessions} />)

    // Delta from session 3: 10 − 6 = 4.0
    expect(screen.getByText("−4.0")).toBeInTheDocument()
    expect(screen.getByText("points less pain")).toBeInTheDocument()
  })

  // ── 6. Both metrics null → encouragement shown in both callouts ───────────
  it("shows encouragement in both callouts when all session values are null", () => {
    const patient = { ...basePatient, pre_vas: 8, pre_tug_s: 12 }
    const sessions = [makeSession({ session_number: 1, post_vas: null, post_tug_s: null })]

    render(<ProgressHeroCard patient={patient} sessions={sessions} />)

    const msgs = screen.getAllByText(EARLY_NOTE)
    // Both StatCallout components should render the noDataMsg
    expect(msgs).toHaveLength(2)
  })
})
