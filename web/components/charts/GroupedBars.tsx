"use client";

import React from "react";

interface GroupedBarsGroup {
  label?: string;
  sub?: string;
  values: number[];
}

interface GroupedBarsSeries {
  color: string;
  label?: string;
}

interface GroupedBarsProps {
  groups: GroupedBarsGroup[];
  series: GroupedBarsSeries[];
  height?: number;
}

export function GroupedBars({ groups, series, height = 280 }: GroupedBarsProps) {
  const w = 540, padL = 40, padR = 16, padT = 12, padB = 36;
  const cw = (w - padL - padR) / groups.length;
  const gw = cw * 0.62;
  const inner = gw / series.length;
  const max = Math.max(0.1, ...groups.flatMap((g) => g.values));
  const ch = height - padT - padB;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${height}`} style={{ display: "block" }}>
      {[0, max / 2, max].map((tv, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={padT + ch - (tv / max) * ch} y2={padT + ch - (tv / max) * ch} stroke="var(--line)" strokeDasharray="2,3" />
          <text x={padL - 6} y={padT + ch - (tv / max) * ch + 3} textAnchor="end" fontSize="10" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">{Math.round(tv * 100) / 100}</text>
        </g>
      ))}
      {groups.map((g, gi) => {
        const cx = padL + gi * cw + cw / 2;
        return (
          <g key={gi}>
            {g.values.map((v, si) => {
              const bx = cx - gw / 2 + si * inner;
              const bh = (v / max) * ch;
              return (
                <g key={si}>
                  <rect x={bx + 1} y={padT + ch - bh} width={inner - 2} height={bh} fill={series[si].color} rx="2" opacity="0.92" />
                  <text x={bx + inner / 2} y={padT + ch - bh - 4} textAnchor="middle" fontSize="9.5" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-3)">{Math.round(v * 100) / 100}</text>
                </g>
              );
            })}
            <text x={cx} y={height - 18} textAnchor="middle" fontSize="11" fill="var(--ink-2)">
              {(g.label || "").length > 16 ? (g.label!.slice(0, 14) + "…") : g.label}
            </text>
            {g.sub && <text x={cx} y={height - 6} textAnchor="middle" fontSize="9.5" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">{g.sub}</text>}
          </g>
        );
      })}
    </svg>
  );
}
