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
