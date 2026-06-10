"use client";

import React from "react";
import type { ResponseCurvePoint } from "@/lib/types";

interface ResponseCurveChartProps {
  metric: string
  points: ResponseCurvePoint[]
  patientPoints: { session_number: number; value: number }[]
  color?: string
}

export function ResponseCurveChart({
  metric,
  points,
  patientPoints,
  color = "var(--accent)",
}: ResponseCurveChartProps) {
  if (!points.length && !patientPoints.length) return null;

  const W = 320, H = 160;
  const PAD_TOP = 28, PAD_BOT = 28, PAD_LEFT = 44, PAD_RIGHT = 16;
  const CW = W - PAD_LEFT - PAD_RIGHT;
  const CH = H - PAD_TOP - PAD_BOT;

  // Collect all session numbers for X axis
  const allSessions = Array.from(
    new Set([
      ...points.map((p) => p.session_number),
      ...patientPoints.map((p) => p.session_number),
    ])
  ).sort((a, b) => a - b);

  const minSn = allSessions[0] ?? 1;
  const maxSn = allSessions[allSessions.length - 1] ?? 1;
  const snRange = maxSn - minSn || 1;

  // Collect all values for Y axis
  const allVals: number[] = [
    ...points.flatMap((p) => [p.p25, p.p50, p.p75].filter((v): v is number => v != null)),
    ...patientPoints.map((p) => p.value),
  ];
  if (!allVals.length) return null;

  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const vRange = maxV - minV || 1;
  const vPad = vRange * 0.15;
  const lo = minV - vPad, hi = maxV + vPad;

  const xOf = (sn: number) => PAD_LEFT + ((sn - minSn) / snRange) * CW;
  const yOf = (v: number) => PAD_TOP + CH - ((v - lo) / (hi - lo)) * CH;

  // Build band polygon (p25 path forward, p75 path backward)
  const bandPts = points.filter((p) => p.p25 != null && p.p75 != null);
  let bandPath = "";
  if (bandPts.length >= 2) {
    const fwd = bandPts.map((p) => `${xOf(p.session_number).toFixed(1)},${yOf(p.p25!).toFixed(1)}`).join(" L ");
    const bwd = [...bandPts].reverse().map((p) => `${xOf(p.session_number).toFixed(1)},${yOf(p.p75!).toFixed(1)}`).join(" L ");
    bandPath = `M ${fwd} L ${bwd} Z`;
  }

  // Median line
  const medianPts = points.filter((p) => p.p50 != null);
  const medianD = medianPts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.session_number).toFixed(1)} ${yOf(p.p50!).toFixed(1)}`)
    .join(" ");

  // Patient line
  const patD = patientPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.session_number).toFixed(1)} ${yOf(p.value).toFixed(1)}`)
    .join(" ");

  const yTicks = [lo + (hi - lo) * 0.1, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.9];
  const label = metric.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div style={{ background: "var(--surface-sunken)", borderRadius: 8, padding: "10px 10px 6px" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {/* Title */}
        <text x={PAD_LEFT} y={16} fontSize="11" fontWeight="600" fill="var(--ink-2)">{label}</text>

        {/* Grid lines */}
        {yTicks.map((tv, i) => (
          <g key={i}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={yOf(tv)} y2={yOf(tv)}
              stroke="var(--line)" strokeDasharray="2,3" />
            <text x={PAD_LEFT - 4} y={yOf(tv) + 3.5} textAnchor="end" fontSize="9"
              fontFamily="var(--font-mono)" fill="var(--ink-4)">
              {tv.toFixed(Math.abs(tv) > 10 ? 0 : 1)}
            </text>
          </g>
        ))}

        {/* p25–p75 band */}
        {bandPath && (
          <path d={bandPath} fill={color} opacity="0.15" />
        )}

        {/* Median (p50) dashed line */}
        {medianD && (
          <path d={medianD} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="4,3" opacity="0.6" />
        )}

        {/* Patient trajectory */}
        {patD && patientPoints.length > 1 && (
          <path d={patD} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        )}

        {/* Patient dots */}
        {patientPoints.map((p) => (
          <circle key={p.session_number} cx={xOf(p.session_number)} cy={yOf(p.value)} r="4" fill={color} />
        ))}

        {/* X-axis labels */}
        {allSessions.map((sn) => (
          <text key={sn} x={xOf(sn)} y={H - 6} textAnchor="middle" fontSize="9"
            fontFamily="var(--font-mono)" fill="var(--ink-4)">{sn}</text>
        ))}
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--ink-4)", paddingLeft: PAD_LEFT, marginTop: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="18" height="6">
            <rect x="0" y="1" width="18" height="4" fill={color} opacity="0.15" rx="1" />
            <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="1.5" strokeDasharray="4,3" opacity="0.6" />
          </svg>
          Cohort p25–p75
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="18" height="6">
            <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2.5" />
          </svg>
          This patient
        </div>
      </div>
    </div>
  );
}
