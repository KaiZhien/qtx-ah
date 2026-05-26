"use client";

import React from "react";

interface MetricChartProps {
  label: string;
  sessions: { session_number: number; value: number }[];
  direction: string; // "improving" | "declining" | "stable" | "early_signal" | "baseline_only"
  lowerIsBetter: boolean;
}

const DIRECTION_COLOR: Record<string, string> = {
  improving:     "var(--success)",
  declining:     "var(--danger)",
  stable:        "var(--ink-3)",
  early_signal:  "var(--ink-3)",
  baseline_only: "var(--ink-3)",
};

export function MetricChart({ label, sessions, direction, lowerIsBetter }: MetricChartProps) {
  if (!sessions.length) return null;

  const W = 280, H = 140;
  const PAD_TOP = 28, PAD_BOT = 24, PAD_LEFT = 40, PAD_RIGHT = 16;
  const CHART_W = W - PAD_LEFT - PAD_RIGHT;
  const CHART_H = H - PAD_TOP - PAD_BOT;

  const values = sessions.map((s) => s.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;
  const padV = range * 0.12;
  const lo = minV - padV, hi = maxV + padV;

  const xOf = (i: number) =>
    PAD_LEFT + (sessions.length === 1 ? CHART_W / 2 : (i / (sessions.length - 1)) * CHART_W);
  const yOf = (v: number) =>
    PAD_TOP + CHART_H - ((v - lo) / (hi - lo)) * CHART_H;

  const lineD = sessions
    .map((s, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(s.value).toFixed(1)}`)
    .join(" ");

  const dotColor = DIRECTION_COLOR[direction] ?? "var(--ink-3)";
  const yTicks = [lo + (hi - lo) * 0.1, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.9];
  const badgeLabel = direction.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

  // Suppress unused-variable warning for lowerIsBetter (used by parent to pick direction)
  void lowerIsBetter;

  return (
    <div style={{ background: "var(--surface-sunken)", borderRadius: 8, padding: "10px 10px 6px" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {/* Title */}
        <text x={PAD_LEFT} y={16} fontSize="11.5" fontWeight="600" fill="var(--ink-2)">
          {label}
        </text>

        {/* Direction badge */}
        <rect
          x={W - PAD_RIGHT - 80}
          y={6}
          width={72}
          height={16}
          rx={4}
          fill={dotColor}
          opacity="0.15"
        />
        <text
          x={W - PAD_RIGHT - 44}
          y={17.5}
          textAnchor="middle"
          fontSize="9.5"
          fontWeight="600"
          fill={dotColor}
        >
          {badgeLabel}
        </text>

        {/* Grid lines + Y-axis labels */}
        {yTicks.map((tv, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={yOf(tv)}
              y2={yOf(tv)}
              stroke="var(--line)"
              strokeDasharray="2,3"
            />
            <text
              x={PAD_LEFT - 4}
              y={yOf(tv) + 3.5}
              textAnchor="end"
              fontSize="9"
              fontFamily="var(--font-mono)"
              fill="var(--ink-4)"
            >
              {tv.toFixed(tv > 10 ? 0 : 1)}
            </text>
          </g>
        ))}

        {/* Line */}
        {sessions.length > 1 && (
          <path d={lineD} fill="none" stroke={dotColor} strokeWidth="2" strokeLinejoin="round" />
        )}

        {/* Dots + X-axis labels */}
        {sessions.map((s, i) => (
          <g key={s.session_number}>
            <circle cx={xOf(i)} cy={yOf(s.value)} r="4" fill={dotColor} />
            <text
              x={xOf(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize="9"
              fontFamily="var(--font-mono)"
              fill="var(--ink-4)"
            >
              {s.session_number}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
