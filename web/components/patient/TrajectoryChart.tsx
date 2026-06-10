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

  const allSns = [
    ...cohortPoints.map(p => p.session_number),
    ...patientPoints.map(p => p.session_number),
    targetSn,
  ]
  const minSn = Math.min(...allSns)
  const maxSn = Math.max(...allSns)
  const snRange = maxSn - minSn || 1

  const allVals: number[] = [
    ...cohortPoints.flatMap(p => [p.p25, p.p50, p.p75].filter((v): v is number => v != null)),
    ...patientPoints.map(p => p.value),
  ]
  if (!allVals.length) return (
    <div style={{
      background: "var(--surface-sunken)",
      borderRadius: 12,
      padding: "32px 20px",
      textAlign: "center",
      fontSize: 13,
      color: "var(--ink-3)",
      lineHeight: 1.5,
    }}>
      No data yet — your progress chart will appear after your first few sessions.
    </div>
  )
  const minV = Math.min(...allVals)
  const maxV = Math.max(...allVals)
  const vRange = maxV - minV || 1
  const vPad = vRange * 0.2
  const lo = minV - vPad, hi = maxV + vPad

  const xOf = (sn: number) => PAD.left + ((sn - minSn) / snRange) * CW
  const yOf = (v: number) => PAD.top + CH - ((v - lo) / (hi - lo)) * CH

  const bandPts = cohortPoints.filter(p => p.p25 != null && p.p75 != null)
  let bandPath = ""
  if (bandPts.length >= 2) {
    const fwd = bandPts.map(p => `${xOf(p.session_number).toFixed(1)},${yOf(p.p25!).toFixed(1)}`).join(" L ")
    const bwd = [...bandPts].reverse().map(p => `${xOf(p.session_number).toFixed(1)},${yOf(p.p75!).toFixed(1)}`).join(" L ")
    bandPath = `M ${fwd} L ${bwd} Z`
  }

  const medianD = cohortPoints
    .filter(p => p.p50 != null)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.session_number).toFixed(1)} ${yOf(p.p50!).toFixed(1)}`)
    .join(" ")

  const patD = patientPoints.length > 1
    ? patientPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.session_number).toFixed(1)} ${yOf(p.value).toFixed(1)}`).join(" ")
    : ""

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
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 6, paddingLeft: PAD.left }}>
        {metricLabel} — your trajectory vs. similar patients
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
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

        {bandPath && <path d={bandPath} fill={color} opacity="0.13" />}

        {medianD && <path d={medianD} fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray="4,3" opacity="0.5" />}

        {patD && <path d={patD} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />}

        {patientPoints.map(p => (
          <circle key={p.session_number} cx={xOf(p.session_number)} cy={yOf(p.value)}
            r="4.5" fill={color} />
        ))}

        {projD && <path d={projD} fill="none" stroke={color} strokeWidth="2"
          strokeDasharray="5,4" opacity="0.7" />}

        {projY != null && lastPt && (
          <g>
            <circle cx={projX} cy={projY} r="6" fill="none" stroke={color} strokeWidth="2" opacity="0.8" />
            <circle cx={projX} cy={projY} r="3" fill={color} opacity="0.6" />
          </g>
        )}

        {isCapped && projY != null && (
          <text x={projX + 8} y={projY - 6} fontSize="9" fill="var(--ink-4)">
            beyond data
          </text>
        )}

        {xTickSns.map(sn => (
          <text key={sn} x={xOf(sn)} y={H - 6} textAnchor="middle"
            fontSize="9" fontFamily="var(--font-mono)" fill="var(--ink-4)">
            {sn}
          </text>
        ))}
      </svg>

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
