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
  const latestVas = [...sessions]
    .reverse()
    .find(s => s.post_vas != null)
  const latestTug = [...sessions]
    .reverse()
    .find(s => s.post_tug_s != null)

  const painDelta = (latestVas && patient.pre_vas != null)
    ? patient.pre_vas - latestVas.post_vas!
    : null

  const tugDelta = (latestTug && patient.pre_tug_s != null)
    ? patient.pre_tug_s - latestTug.post_tug_s!
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
