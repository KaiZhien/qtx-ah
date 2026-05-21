"use client";

import React from "react";

interface BoxRowProps {
  x: number;
  y: number;
  w: number;
  h: number;
  q1: number;
  q2: number;
  q3: number;
  min: number;
  max: number;
  mean?: number;
  color: string;
  opacity?: number;
}

function BoxRow({ x, y, w, q1, q2, q3, min, max, mean, color, opacity = 0.85 }: BoxRowProps) {
  const cx = x + w / 2;
  return (
    <g opacity={opacity}>
      <line x1={cx} x2={cx} y1={y - max} y2={y - min} stroke={color} strokeWidth="1" />
      <line x1={cx - w * 0.25} x2={cx + w * 0.25} y1={y - min} y2={y - min} stroke={color} strokeWidth="1" />
      <line x1={cx - w * 0.25} x2={cx + w * 0.25} y1={y - max} y2={y - max} stroke={color} strokeWidth="1" />
      <rect x={x} y={y - q3} width={w} height={Math.max(1, q3 - q1)} fill={color} opacity="0.18" stroke={color} strokeWidth="1" rx="2" />
      <line x1={x} x2={x + w} y1={y - q2} y2={y - q2} stroke={color} strokeWidth="2" />
      {mean != null && <circle cx={cx} cy={y - mean} r="2.5" fill={color} stroke="white" strokeWidth="1" />}
    </g>
  );
}

interface StatsResult {
  q1: number;
  q2: number;
  q3: number;
  min: number;
  max: number;
  mean: number;
  raw: { q1: number; q2: number; q3: number; mean: number };
}

interface PrePostBoxProps {
  pre: (number | null | undefined)[];
  post: (number | null | undefined)[];
  label?: string;
  w?: number;
  h?: number;
  higherBetter?: boolean;
  unit?: string;
}

export function PrePostBox({ pre, post, label, w = 220, h = 200, higherBetter, unit }: PrePostBoxProps) {
  const all = [...pre, ...post].filter((x): x is number => x != null && !isNaN(x as number));
  if (!all.length) return <div style={{ padding: 16, color: "var(--ink-3)" }}>No data</div>;
  const minV = Math.min(...all), maxV = Math.max(...all);
  const pad = (maxV - minV) * 0.08 + 0.001;
  const lo = minV - pad, hi = maxV + pad;
  const padTop = 28, padBot = 26;
  const scale = (v: number) => ((v - lo) / (hi - lo)) * (h - padTop - padBot);
  function stats(arr: (number | null | undefined)[]): StatsResult | null {
    const a = arr.filter((x): x is number => x != null && !isNaN(x as number)).slice().sort((p, q) => p - q);
    if (!a.length) return null;
    const q = (qv: number) => {
      const pos = (a.length - 1) * qv;
      const f = Math.floor(pos), c = Math.ceil(pos);
      return f === c ? a[f] : a[f] + (a[c] - a[f]) * (pos - f);
    };
    return {
      q1: scale(q(0.25)), q2: scale(q(0.5)), q3: scale(q(0.75)),
      min: scale(a[0]), max: scale(a[a.length - 1]),
      mean: scale(a.reduce((s, x) => s + x, 0) / a.length),
      raw: { q1: q(0.25), q2: q(0.5), q3: q(0.75), mean: a.reduce((s, x) => s + x, 0) / a.length },
    };
  }
  const s1 = stats(pre), s2 = stats(post);
  const baselineY = h - padBot;
  const preMean = s1 ? s1.raw.mean : 0;
  const postMean = s2 ? s2.raw.mean : 0;
  const improved = higherBetter ? postMean > preMean : postMean < preMean;
  const postColor = improved ? "var(--success)" : "var(--danger)";
  const delta = higherBetter ? postMean - preMean : preMean - postMean;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <text x={w / 2} y={16} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="var(--ink-2)">{label}</text>
      <text x={w / 2} y={30} textAnchor="middle" fontSize="10" fill="var(--ink-4)">{unit}</text>
      {[lo, (lo + hi) / 2, hi].map((tv, i) => (
        <g key={i}>
          <line x1="36" x2={w - 8} y1={baselineY - scale(tv)} y2={baselineY - scale(tv)} stroke="var(--line)" strokeDasharray="2,3" />
          <text x="32" y={baselineY - scale(tv) + 3} textAnchor="end" fontSize="9.5" style={{ fontFamily: "var(--font-mono)" }} fill="var(--ink-4)">{tv.toFixed(tv > 10 ? 0 : 1)}</text>
        </g>
      ))}
      {s1 && <BoxRow x={56} y={baselineY} w={50} h={h} {...s1} color="var(--ink-3)" />}
      {s2 && <BoxRow x={130} y={baselineY} w={50} h={h} {...s2} color={postColor} />}
      <text x={56 + 25} y={h - 8} textAnchor="middle" fontSize="10.5" fill="var(--ink-3)">Pre</text>
      <text x={130 + 25} y={h - 8} textAnchor="middle" fontSize="10.5" fill="var(--ink-3)">Post</text>
      {s1 && s2 && (
        <g>
          <line x1={56 + 25} y1={baselineY - s1.mean} x2={130 + 25} y2={baselineY - s2.mean} stroke={postColor} strokeWidth="1" strokeDasharray="3,3" />
          <text x={w - 8} y={48} textAnchor="end" fontSize="10.5" style={{ fontFamily: "var(--font-mono)" }} fill={postColor} fontWeight="600">
            {improved ? "▼" : "▲"} {Math.abs(delta).toFixed(2)}
          </text>
        </g>
      )}
    </svg>
  );
}
