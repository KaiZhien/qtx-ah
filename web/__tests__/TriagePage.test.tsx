import React, { act } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TriagePage } from "@/components/pages/TriagePage"
import type { Patient, TriageResponse } from "@/lib/types"
import { fetchTriage } from "@/lib/api"

jest.mock("@/lib/api", () => ({
  fetchTriage: jest.fn(),
}))

const mockFetchTriage = fetchTriage as jest.Mock

// A patient whose sn matches the triage item below, so a row click resolves it.
const mockPatient: Patient = {
  sn: "SN100",
  id: "P100",
  name: "Jane Doe",
  initials: "JD",
  age: 74,
  age_band: "70-79",
  gender: "F",
  cohort: "A",
  usage_frequency: "3+",
  intake_date: "2024-01-01",
  tags: "",
  pre_vas: 7,
  pre_tug_s: 12,
  pre_5xsst_s: 18,
  pre_normal_gs_ms: 0.9,
  pre_fast_gs_ms: 1.2,
  baseline_sppb: 8,
  post_vas: 4,
  post_tug_s: 10,
  post_5xsst_s: 15,
  post_normal_gs_ms: 1.1,
  post_fast_gs_ms: 1.4,
  post_sppb: 10,
  composite_improvement: 0.6,
  overall_responder: true,
  mcid_count: 3,
  is_dropout: false,
  has_followup: true,
  has_oa: true,
  has_diabetes: false,
  has_stroke: false,
  has_parkinsons: false,
  has_frailty: false,
  has_cancer: false,
  has_hypertension: false,
  has_osteoporosis: false,
}

// > 80 chars: "URGENT" lives in the first 80 chars, "HIDDENTAIL" past char 80, so a
// correct truncation keeps URGENT and drops HIDDENTAIL.
const longAnomaly =
  "URGENT anomaly detected in the patient's latest session and the trend is concerning HIDDENTAIL enough to review now."

const fullResponse: TriageResponse = {
  generated_at: "2026-07-16T00:00:00Z",
  total: 1,
  items: [
    {
      sn: "SN100",
      name: "Jane Doe",
      last_session_number: 4,
      last_session_date: "2026-07-10",
      signals: {
        anomaly: {
          session_number: 4,
          content: longAnomaly,
          created_at: "2026-07-10T00:00:00Z",
        },
        declining_trends: [
          { metric: "post_tug_s", magnitude: -0.5, sessions_used: 3 },
        ],
        divergence: {
          session_number: 4,
          predicted: 0.2,
          actual: -0.35,
          delta: 0.55,
        },
      },
    },
  ],
}

const emptyResponse: TriageResponse = {
  generated_at: "2026-07-16T00:00:00Z",
  total: 0,
  items: [],
}

const noop = () => {}

describe("TriagePage", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // 1. Renders all three badge types from a mocked response.
  it("renders anomaly (truncated), a mapped metric label, and the divergence string", async () => {
    mockFetchTriage.mockResolvedValue(fullResponse)

    await act(async () => {
      render(<TriagePage patients={[mockPatient]} onPatientSelect={noop} />)
    })

    // Anomaly content is shown but truncated: prefix kept, tail dropped.
    await waitFor(() => {
      expect(
        screen.getByText((t) => t.includes("URGENT"))
      ).toBeInTheDocument()
    })
    expect(screen.queryByText((t) => t.includes("HIDDENTAIL"))).toBeNull()

    // Declining-trend metric maps post_tug_s -> "TUG".
    expect(screen.getByText((t) => t.includes("TUG"))).toBeInTheDocument()

    // Divergence badge shows signed predicted -> actual.
    expect(
      screen.getByText(
        (t) => t.includes("predicted +0.20") && t.includes("actual -0.35")
      )
    ).toBeInTheDocument()
  })

  // 2. Empty state.
  it("renders the empty state when total is 0", async () => {
    mockFetchTriage.mockResolvedValue(emptyResponse)

    await act(async () => {
      render(<TriagePage patients={[]} onPatientSelect={noop} />)
    })

    await waitFor(() => {
      expect(screen.getByText("No patients need attention")).toBeInTheDocument()
    })
  })

  // 3. Error state + Retry.
  it("shows an alert + Retry on failure, and re-fetches when Retry is clicked", async () => {
    mockFetchTriage
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(fullResponse)

    await act(async () => {
      render(<TriagePage patients={[mockPatient]} onPatientSelect={noop} />)
    })

    // Error surfaced with role=alert + a Retry control.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument()
    })
    const retry = screen.getByRole("button", { name: /retry/i })
    expect(mockFetchTriage).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(retry)
    })

    // Second call resolves -> worklist renders.
    await waitFor(() => {
      expect(mockFetchTriage).toHaveBeenCalledTimes(2)
      expect(screen.getByText("Jane Doe")).toBeInTheDocument()
    })
  })

  // 4. Row click resolves the patient and invokes onPatientSelect.
  it("invokes onPatientSelect with the matching patient when a row is clicked", async () => {
    mockFetchTriage.mockResolvedValue(fullResponse)
    const onSelect = jest.fn()

    await act(async () => {
      render(<TriagePage patients={[mockPatient]} onPatientSelect={onSelect} />)
    })

    const nameCell = await screen.findByText("Jane Doe")
    const row = nameCell.closest("tr")
    expect(row).not.toBeNull()

    await act(async () => {
      fireEvent.click(row!)
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(mockPatient)
  })
})
