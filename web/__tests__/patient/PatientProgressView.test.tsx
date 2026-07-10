import React, { act } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PatientProgressView } from "../../components/patient/PatientProgressView"
import type { Patient, TimelineSession, MetricSeriesResponse, ResponseCurvesResponse } from "../../lib/types"
import { fetchMetricSeries, getResponseCurves } from "@/lib/api"

jest.mock("@/lib/api", () => ({
  fetchMetricSeries: jest.fn(),
  getResponseCurves: jest.fn(),
}))

const mockFetchMetricSeries = fetchMetricSeries as jest.Mock
const mockGetResponseCurves = getResponseCurves as jest.Mock

const mockPatient: Patient = {
  sn: "1",
  id: "P001",
  name: "Test Patient",
  initials: "TP",
  age: 72,
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

const mockSessions: TimelineSession[] = [
  {
    session_number: 1,
    session_date: "2024-01-15",
    notes: null,
    post_vas: 6,
    post_tug_s: 11,
    post_5xsst_s: 17,
    post_normal_gs_ms: 1.0,
    post_fast_gs_ms: 1.3,
    post_sppb: 9,
    composite_improvement: 0.3,
    overall_responder: null,
    is_dropout: false,
  },
]

const mockSeriesResponse: MetricSeriesResponse = {
  sn: "1",
  metric: "vas_change",
  points: [
    { session_number: 1, value: -1 },
    { session_number: 2, value: -2 },
  ],
}

const mockCurvesResponse: ResponseCurvesResponse = {
  grp_flag: "grp_joint_disease",
  curves: [
    {
      metric: "vas_change",
      points: [
        { session_number: 1, p25: -0.5, p50: -1.0, p75: -1.5, n: 50 },
        { session_number: 2, p25: -1.0, p50: -1.5, p75: -2.0, n: 48 },
      ],
    },
    {
      metric: "tug_change_pct",
      points: [
        { session_number: 1, p25: 2.0, p50: 4.0, p75: 6.0, n: 50 },
        { session_number: 2, p25: 3.0, p50: 5.0, p75: 7.0, n: 48 },
      ],
    },
  ],
}

function renderView() {
  return render(
    <PatientProgressView patient={mockPatient} sessions={mockSessions} />
  )
}

describe("PatientProgressView", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetchMetricSeries.mockResolvedValue(mockSeriesResponse)
    mockGetResponseCurves.mockResolvedValue(mockCurvesResponse)
  })

  // 1. On mount, both fetches called once
  it("calls fetchMetricSeries and getResponseCurves once on mount", async () => {
    await act(async () => {
      renderView()
    })
    await waitFor(() => {
      expect(mockFetchMetricSeries).toHaveBeenCalledTimes(1)
      expect(mockGetResponseCurves).toHaveBeenCalledTimes(1)
    })
  })

  // 2. Initial goal is pain → fetchMetricSeries called with vas_change
  it("calls fetchMetricSeries with metric='vas_change' on initial mount (pain goal)", async () => {
    await act(async () => {
      renderView()
    })
    await waitFor(() => {
      expect(mockFetchMetricSeries).toHaveBeenCalledWith(
        String(mockPatient.sn),
        "vas_change"
      )
    })
  })

  // 3. Goal switch triggers re-fetch with tug_change_pct
  it("re-fetches with metric='tug_change_pct' when 'Move better' goal is selected", async () => {
    const tugSeriesResponse: MetricSeriesResponse = {
      sn: "1",
      metric: "tug_change_pct",
      points: [{ session_number: 1, value: 5 }],
    }
    mockFetchMetricSeries.mockResolvedValue(tugSeriesResponse)

    await act(async () => {
      renderView()
    })

    // Wait for initial fetch to complete
    await waitFor(() => expect(mockFetchMetricSeries).toHaveBeenCalledTimes(1))

    // Click "Move better" button
    await act(async () => {
      fireEvent.click(screen.getByText("Move better"))
    })

    await waitFor(() => {
      expect(mockFetchMetricSeries).toHaveBeenCalledWith(
        String(mockPatient.sn),
        "tug_change_pct"
      )
    })
  })

  // 4. Slider change does NOT trigger a new fetch
  it("does not call fetchMetricSeries again when slider value changes", async () => {
    await act(async () => {
      renderView()
    })

    await waitFor(() => expect(mockFetchMetricSeries).toHaveBeenCalledTimes(1))

    const slider = screen.getByRole("slider")
    await act(async () => {
      fireEvent.change(slider, { target: { value: "8" } })
    })

    // Count should remain 1 — no extra fetch
    expect(mockFetchMetricSeries).toHaveBeenCalledTimes(1)
  })

  // 5. Loading state shows text while fetch is pending
  it("shows 'Loading your data…' while fetch is pending", async () => {
    // Create a deferred promise that we never resolve during this test
    let resolveFetch!: (val: MetricSeriesResponse) => void
    const pending = new Promise<MetricSeriesResponse>(res => { resolveFetch = res })
    mockFetchMetricSeries.mockReturnValue(pending)

    await act(async () => {
      renderView()
    })

    expect(screen.getByText(/Loading your data/i)).toBeInTheDocument()

    // Clean up: resolve so no open handles remain
    resolveFetch(mockSeriesResponse)
  })

  // 6. After fetch resolves, loading text disappears
  it("removes loading text after fetches resolve", async () => {
    await act(async () => {
      renderView()
    })

    await waitFor(() => {
      expect(screen.queryByText(/Loading your data/i)).not.toBeInTheDocument()
    })
  })

  // 7. Both fetches reject → no crash
  it("does not throw when both fetches reject", async () => {
    mockFetchMetricSeries.mockRejectedValue(new Error("network error"))
    mockGetResponseCurves.mockRejectedValue(new Error("network error"))

    await expect(
      act(async () => {
        renderView()
      })
    ).resolves.not.toThrow()

    await waitFor(() => {
      // Loading should be gone (finally block ran)
      expect(screen.queryByText(/Loading your data/i)).not.toBeInTheDocument()
    })
  })

  // 8. Encouragement note is visible after load
  it("shows the encouragement note about the shaded area", async () => {
    await act(async () => {
      renderView()
    })

    await waitFor(() => {
      expect(
        screen.getByText(/The shaded area shows how patients with similar conditions/i)
      ).toBeInTheDocument()
    })
  })
})
