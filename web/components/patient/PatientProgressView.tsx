"use client"
import React from "react"
import type { Patient, TimelineSession, ResponseCurvePoint } from "@/lib/types"
import { fetchMetricSeries, getResponseCurves } from "@/lib/api"
import { ProgressHeroCard } from "./ProgressHeroCard"
import { GoalPicker } from "./GoalPicker"
import { TrajectoryChart } from "./TrajectoryChart"

type Goal = "pain" | "mobility"

const GRP_PRIORITY = [
  "grp_frailty_sarcopenia", "grp_joint_disease", "grp_neurological",
  "grp_post_surgical", "grp_balance_falls", "grp_metabolic",
  "grp_cardiovascular", "grp_oncology", "grp_autoimmune",
  "grp_softtissue_injury", "grp_generalised_pain", "grp_osteoporosis",
  "grp_spine_back", "grp_wellness",
]

function primaryGrpFlag(patient: Patient): string {
  const p = patient as unknown as Record<string, unknown>
  return GRP_PRIORITY.find(f => p[f] === true) ?? "grp_wellness"
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
      <ProgressHeroCard patient={patient} sessions={sessions} />

      <GoalPicker selected={goal} onChange={setGoal} />

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
