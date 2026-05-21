"use client";

import React from "react";

interface StackedBarsStack {
  label?: string;
  values: number[];
}

interface StackedBarsProps {
  categories: string[];
  stacks: StackedBarsStack[];
  height?: number;
  colors: string[];
}

export function StackedBars({ categories, stacks, height = 240, colors }: StackedBarsProps) {
  const w = 540, padL = 36, padR = 12, padT = 12, padB = 36;
  const cw = (w - padL - padR) / categories.length;
  const totals = categories.map((_, i) => stacks.reduce((s, st) => s + (st.values[i] || 0), 0));
  const max = Math.max(...totals, 1);
  const ch = height - padT - padB;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${height}`} style={{ display: "block" }}>
      {[0, max / 2, max].map((tv, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={padT + ch - (tv / max) * ch} y2={padT + ch - (tv / max) * ch} stroke="var(--line)" strokeDasharray="2,3" />
          <text x={padL - 6} y={padT + ch - (tv / max) * ch + 3} textAnchor="end" fontSize="10" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">{Math.round(tv)}</text>
        </g>
      ))}
      {categories.map((cat, ci) => {
        let acc = 0;
        const cx = padL + ci * cw + cw * 0.15;
        return (
          <g key={ci}>
            {stacks.map((st, si) => {
              const v = st.values[ci] || 0;
              const bh = (v / max) * ch;
              const y = padT + ch - acc - bh;
              acc += bh;
              return <rect key={si} x={cx} y={y} width={cw * 0.7} height={bh} fill={colors[si]} opacity="0.95" />;
            })}
            <text x={cx + cw * 0.35} y={height - 14} textAnchor="middle" fontSize="11" fill="var(--ink-2)">{cat}</text>
            <text x={cx + cw * 0.35} y={height - 2} textAnchor="middle" fontSize="9.5" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">n={totals[ci]}</text>
          </g>
        );
      })}
    </svg>
  );
}
