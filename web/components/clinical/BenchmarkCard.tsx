"use client";
import React from "react";
import type { BenchmarkResult } from "@/lib/types";

const LABELS: Record<string, string> = {
  composite_improvement: "Overall Improvement",
  tug_change_pct: "TUG",
  sst_change_pct: "5× Sit-Stand",
  sppb_change: "SPPB",
  vas_change: "Pain (VAS)",
  normal_gs_change_pct: "Normal Gait",
  fast_gs_change_pct: "Fast Gait",
};

export function BenchmarkCard({ data }: { data: BenchmarkResult | null }) {
  if (!data || data.benchmarks.length === 0) return null;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="filter-label" style={{ marginBottom: 4 }}>
        Cohort Percentile Ranks
        {data.cohort && <span style={{ fontWeight: 400, color: "var(--ink-4)", marginLeft: 6 }}>— {data.cohort} (n={data.cohort_n})</span>}
      </div>
      {data.benchmarks.map((entry) => (
        <div key={entry.metric} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 110, flexShrink: 0, fontSize: 12, color: "var(--ink-2)", textAlign: "right" }}>{LABELS[entry.metric] ?? entry.metric}</div>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--line)", position: "relative" }}>
            <div style={{ position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 3, width: `${Math.round(entry.percentile * 100)}%`, background: "var(--accent, #6366f1)" }} />
          </div>
          <div style={{ width: 36, flexShrink: 0, fontSize: 11.5, color: "var(--ink-3)", textAlign: "left" }}>{entry.percentile_display}</div>
        </div>
      ))}
    </div>
  );
}
