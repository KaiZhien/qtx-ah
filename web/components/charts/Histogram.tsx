"use client";

import React from "react";

interface HistogramMarker {
  value: number;
  label?: string;
  color?: string;
}

interface HistogramProps {
  values: (number | null | undefined)[];
  bins?: number;
  height?: number;
  color?: string;
  markers?: HistogramMarker[];
  xLabel?: string;
}

export function Histogram({ values, bins = 24, height = 160, color = "var(--accent)", markers = [], xLabel }: HistogramProps) {
  const vals = values.filter((v): v is number => v != null && !isNaN(v as number));
  if (!vals.length) return <div style={{ color: "var(--ink-3)", padding: 12 }}>No data</div>;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const step = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of vals) {
    let bi = Math.floor((v - lo) / step);
    if (bi === bins) bi = bins - 1;
    counts[bi]++;
  }
  const maxC = Math.max(...counts);
  const w = 540, padL = 36, padR = 12, padT = 12, padB = 26;
  const cw = (w - padL - padR) / bins;
  const ch = height - padT - padB;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${height}`} style={{ display: "block" }}>
      {counts.map((c, i) => {
        const x = padL + i * cw;
        const bh = (c / maxC) * ch;
        return <rect key={i} x={x + 1} y={padT + ch - bh} width={cw - 2} height={bh} fill={color} opacity="0.85" rx="1" />;
      })}
      {[0, maxC / 2, maxC].map((tv, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={padT + ch - (tv / maxC) * ch} y2={padT + ch - (tv / maxC) * ch} stroke="var(--line)" strokeDasharray="2,3" />
          <text x={padL - 6} y={padT + ch - (tv / maxC) * ch + 3} textAnchor="end" fontSize="10" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">{Math.round(tv)}</text>
        </g>
      ))}
      {[lo, (lo + hi) / 2, hi].map((tv, i) => (
        <text key={i} x={padL + ((tv - lo) / (hi - lo)) * (w - padL - padR)} y={height - 8} textAnchor="middle" fontSize="10" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">{tv.toFixed(2)}</text>
      ))}
      {markers.map((m, i) => {
        const x = padL + ((m.value - lo) / (hi - lo)) * (w - padL - padR);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={padT} y2={padT + ch} stroke={m.color || "var(--ink)"} strokeWidth="1.5" strokeDasharray="4,2" />
            <text x={x + 4} y={padT + 10} fontSize="10" style={{ fontFamily: "var(--font-mono)" }} fill={m.color || "var(--ink)"}>{m.label}</text>
          </g>
        );
      })}
      {xLabel && <text x={w / 2} y={height - 0} textAnchor="middle" fontSize="10.5" fill="var(--ink-3)">{xLabel}</text>}
    </svg>
  );
}
