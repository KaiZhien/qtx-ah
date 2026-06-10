import React from "react"
import { render, screen } from "@testing-library/react"
import { TrajectoryChart } from "../../components/patient/TrajectoryChart"
import type { ResponseCurvePoint, MetricSeriesPoint } from "../../lib/types"

const makeCohortPoint = (
  session_number: number,
  p25: number | null = 4,
  p50: number | null = 6,
  p75: number | null = 8
): ResponseCurvePoint => ({ session_number, p25, p50, p75, n: 10 })

const makePatientPoint = (session_number: number, value: number): MetricSeriesPoint => ({
  session_number,
  value,
})

const cohortPoints: ResponseCurvePoint[] = [
  makeCohortPoint(1),
  makeCohortPoint(2),
  makeCohortPoint(3),
  makeCohortPoint(4),
  makeCohortPoint(5),
]

const patientPoints: MetricSeriesPoint[] = [
  makePatientPoint(1, 7),
  makePatientPoint(2, 6),
  makePatientPoint(3, 5),
]

describe("TrajectoryChart", () => {
  // 1. Empty state — both arrays empty → renders div with "No data yet" text, no SVG
  it("renders 'No data yet' div when cohort and patient data are both empty", () => {
    const { container } = render(
      <TrajectoryChart
        cohortPoints={[]}
        patientPoints={[]}
        extraSessions={0}
        metricLabel="Pain"
      />
    )
    expect(screen.getByText(/No data yet/i)).toBeInTheDocument()
    expect(container.querySelector("svg")).toBeNull()
  })

  // 2. SVG with valid data
  it("renders an SVG when valid cohort and patient data are provided", () => {
    const { container } = render(
      <TrajectoryChart
        cohortPoints={cohortPoints}
        patientPoints={patientPoints}
        extraSessions={2}
        metricLabel="Pain"
      />
    )
    expect(container.querySelector("svg")).not.toBeNull()
  })

  // 3. SVG with cohort only — no patient points → renders SVG, no crash
  it("renders an SVG when only cohort data is provided (no patient points)", () => {
    const { container } = render(
      <TrajectoryChart
        cohortPoints={cohortPoints}
        patientPoints={[]}
        extraSessions={0}
        metricLabel="TUG"
      />
    )
    expect(container.querySelector("svg")).not.toBeNull()
  })

  // 4. isCapped text — targetSn > max(cohortPoints.session_number) → "beyond data" appears
  it("shows 'beyond data' text when targetSn exceeds max cohort session_number", () => {
    // maxPatientSn = 3, extraSessions = 10, targetSn = 13, max cohort sn = 5
    render(
      <TrajectoryChart
        cohortPoints={cohortPoints}
        patientPoints={patientPoints}
        extraSessions={10}
        metricLabel="Pain"
      />
    )
    expect(screen.getByText(/beyond data/i)).toBeInTheDocument()
  })

  // 5. Legend items present when data exists
  it("renders legend items when data is present", () => {
    render(
      <TrajectoryChart
        cohortPoints={cohortPoints}
        patientPoints={patientPoints}
        extraSessions={2}
        metricLabel="Pain"
      />
    )
    expect(screen.getByText("Middle 50% of similar patients")).toBeInTheDocument()
    expect(screen.getByText("Your results")).toBeInTheDocument()
    expect(screen.getByText("Projected")).toBeInTheDocument()
  })

  // 6. metricLabel in title
  it("displays the metricLabel in the chart title", () => {
    render(
      <TrajectoryChart
        cohortPoints={cohortPoints}
        patientPoints={patientPoints}
        extraSessions={2}
        metricLabel="Pain"
      />
    )
    expect(screen.getByText(/Pain/)).toBeInTheDocument()
  })
})
