"use client";

import React, { useState } from "react";

interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

interface DonutProps {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  onSlice?: (slice: DonutSlice & { path: string; pct: number }) => void;
}

export function Donut({ data, size = 240, thickness = 32, centerLabel, centerValue, onSlice }: DonutProps) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 8;
  const ir = r - thickness;
  let acc = 0;
  const slices = data.map((d) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += d.value;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const xi0 = cx + ir * Math.cos(a1), yi0 = cy + ir * Math.sin(a1);
    const xi1 = cx + ir * Math.cos(a0), yi1 = cy + ir * Math.sin(a0);
    const path = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi0} ${yi0} A ${ir} ${ir} 0 ${large} 0 ${xi1} ${yi1} Z`;
    return { ...d, path, pct: d.value / total };
  });
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <svg width={size} height={size}>
        {slices.map((s, i) => (
          <path key={i} d={s.path} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.30}
            style={{ cursor: onSlice ? "pointer" : "default", transition: "opacity 180ms" }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            onClick={() => onSlice && onSlice(s)} />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: "var(--font-mono)" }} fontSize="26" fontWeight="600" fill="var(--ink)" letterSpacing="-0.03em">
          {hover !== null ? Math.round(slices[hover].pct * 100) + "%" : centerValue}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize="11" fill="var(--ink-3)">
          {hover !== null ? slices[hover].label : centerLabel}
        </text>
      </svg>
    </div>
  );
}
