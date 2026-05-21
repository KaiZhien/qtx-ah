"use client";

import React from "react";

interface HBarsDatum {
  label: string;
  value: number;
  color?: string;
  n?: number;
}

interface HBarsProps {
  data: HBarsDatum[];
  height?: number;
  barH?: number;
  gap?: number;
  maxVal?: number;
  color?: string;
  showN?: boolean;
  labelW?: number;
  axis?: boolean;
}

export function HBars({ data, height: _height, barH = 22, gap = 8, maxVal, color = "var(--accent)", showN = true, labelW = 160, axis = true }: HBarsProps) {
  const max = maxVal || Math.max(0, ...data.map((d) => Math.abs(d.value)));
  const min = Math.min(0, ...data.map((d) => d.value));
  const w = 540;
  const xZero = labelW + ((-min) / (max - min || 1)) * (w - labelW - 60);
  const scale = (w - labelW - 60) / (max - min || 1);
  const h = data.length * (barH + gap) + (axis ? 26 : 8);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {data.map((d, i) => {
        const y = i * (barH + gap) + 4;
        const valX = xZero;
        const len = d.value * scale;
        const x = len >= 0 ? valX : valX + len;
        const isNeg = d.value < 0;
        const c = d.color || (isNeg ? "var(--danger)" : color);
        return (
          <g key={i}>
            <text x={labelW - 8} y={y + barH * 0.65} textAnchor="end" fontSize="12" fill="var(--ink-2)">{d.label}</text>
            <rect x={x} y={y} width={Math.abs(len)} height={barH} fill={c} rx="2" opacity="0.92" />
            <text x={x + Math.abs(len) + (isNeg ? -6 : 6)} y={y + barH * 0.65} textAnchor={isNeg ? "end" : "start"} fontSize="11" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-3)">
              {d.value > 0 ? "+" : ""}{d.value.toFixed(2)}{showN && d.n ? ` · n=${d.n}` : ""}
            </text>
          </g>
        );
      })}
      {axis && <line x1={xZero} y1="0" x2={xZero} y2={h - 22} stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="2,3" />}
    </svg>
  );
}
