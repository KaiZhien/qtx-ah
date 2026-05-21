"use client";

import React from "react";

interface SparkProps {
  data: number[];
  color?: string;
  className?: string;
  w?: number;
  h?: number;
  smooth?: boolean;
  fill?: boolean;
}

export function Spark({ data, color = "var(--accent)", className = "", w = 130, h = 50, smooth = true, fill = true }: SparkProps) {
  if (!data || !data.length) return <svg className={className} width={w} height={h} />;
  const min = Math.min(...data), max = Math.max(...data);
  const span = (max - min) || 1;
  const padX = 2, padY = 4;
  const xs = data.map((_, i) => padX + (i * (w - padX * 2)) / Math.max(1, data.length - 1));
  const ys = data.map((v) => h - padY - ((v - min) / span) * (h - padY * 2));
  let path = "";
  if (smooth) {
    for (let i = 0; i < xs.length; i++) {
      if (i === 0) path += `M ${xs[i]} ${ys[i]} `;
      else {
        const xc = (xs[i - 1] + xs[i]) / 2;
        path += `Q ${xs[i - 1]} ${ys[i - 1]} ${xc} ${(ys[i - 1] + ys[i]) / 2} `;
      }
    }
    path += `T ${xs[xs.length - 1]} ${ys[ys.length - 1]}`;
  } else {
    path = xs.map((x, i) => `${i ? "L" : "M"} ${x} ${ys[i]}`).join(" ");
  }
  const fillPath = `${path} L ${xs[xs.length - 1]} ${h} L ${xs[0]} ${h} Z`;
  const gid = `g_${Math.abs(data.reduce((a, b) => a + b, 0)).toString(36).slice(0, 5)}`;
  return (
    <svg className={className} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={fillPath} fill={`url(#${gid})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

interface KPIProps {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  deltaDir?: string;
  spark?: number[];
  color?: string;
}

export function KPI({ label, value, unit, sub, delta, deltaDir, spark, color }: KPIProps) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        <span className="num">{value}</span>
        {unit && <span className="kpi-unit">{unit}</span>}
      </div>
      <div className="kpi-sub">
        {delta && <span className={`kpi-delta ${deltaDir || "up"}`}>{delta}</span>}
        <span>{sub}</span>
      </div>
      {spark && <Spark data={spark} color={color || "var(--accent)"} className="kpi-spark" />}
    </div>
  );
}
