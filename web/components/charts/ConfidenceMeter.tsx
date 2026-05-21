"use client";

import React from "react";

interface ConfidenceMeterProps {
  value: number;
  label?: string;
  color?: string;
  height?: number;
}

export function ConfidenceMeter({ value, label, color = "var(--accent)", height = 8 }: ConfidenceMeterProps) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--ink-2)" }}>
        <span>{label}</span>
        <span className="mono num" style={{ color: "var(--ink)" }}>{(v * 100).toFixed(0)}%</span>
      </div>
      <div style={{ background: "var(--surface-sunken)", borderRadius: 999, height, overflow: "hidden" }}>
        <div style={{ width: `${v * 100}%`, height: "100%", background: color, transition: "width 600ms cubic-bezier(0.2,0.7,0.2,1)" }} />
      </div>
    </div>
  );
}
