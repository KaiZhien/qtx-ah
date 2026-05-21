"use client";

import React, { useState } from "react";
import type { Patient } from "@/lib/types";
import { COHORTS, COHORT_COLORS, AGE_BANDS } from "@/lib/constants";
import { GroupedBars } from "@/components/charts/GroupedBars";
import { StackedBars } from "@/components/charts/StackedBars";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";

export interface CohortsPageProps {
  data: Patient[];
  onPatientClick: (p: Patient) => void;
}

// Internal helper — arithmetic mean
function mean(arr: (number | null | undefined)[]): number | null {
  const nums = arr.filter((x): x is number => x != null);
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

// Micro horizontal box-strip
function MicroBox({
  values,
  color,
  width = 120,
  height = 26,
}: {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (!values || values.length === 0)
    return <div style={{ color: "var(--ink-4)", fontSize: 11 }}>—</div>;
  const a = values.slice().sort((p, q) => p - q);
  const q1 = a[Math.floor(a.length * 0.25)];
  const q2 = a[Math.floor(a.length * 0.5)];
  const q3 = a[Math.floor(a.length * 0.75)];
  const min = a[0], max = a[a.length - 1];
  // Use a fixed [-3, 3] range typical for z-improvement
  const lo = Math.min(-2, min), hi = Math.max(2, max);
  const s = (v: number) => ((v - lo) / (hi - lo)) * width;
  const zeroX = s(0);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="var(--line)" />
      <line x1={zeroX} x2={zeroX} y1="2" y2={height - 2} stroke="var(--ink-5)" strokeDasharray="2,2" />
      <line x1={s(min)} x2={s(max)} y1={height / 2} y2={height / 2} stroke={color} strokeWidth="1" />
      <rect x={s(q1)} y={6} width={Math.max(2, s(q3) - s(q1))} height={height - 12} fill={color} opacity="0.22" stroke={color} rx="2" />
      <line x1={s(q2)} x2={s(q2)} y1="4" y2={height - 4} stroke={color} strokeWidth="2" />
    </svg>
  );
}

interface LegendItem {
  label: string;
  color: string;
}

function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 11.5, color: "var(--ink-3)", flexWrap: "wrap" }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="dot" style={{ background: i.color }} /> {i.label}
        </div>
      ))}
    </div>
  );
}

function PatientSampleTable({
  data,
  onClick,
}: {
  data: Patient[];
  onClick: (p: Patient) => void;
}) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>ID</th>
          <th>Age</th>
          <th>Sex</th>
          <th>Cohort</th>
          <th>Usage</th>
          <th className="num">SPPB</th>
          <th className="num">TUG (s)</th>
          <th className="num">Composite &Delta;</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.map((p) => (
          <tr key={p.sn} className="clickable" onClick={() => onClick(p)}>
            <td className="mono" style={{ color: "var(--ink-2)" }}>{p.id}</td>
            <td>{p.age}</td>
            <td>{p.gender}</td>
            <td>{p.cohort}</td>
            <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{p.usage_frequency}</td>
            <td className="num">{p.baseline_sppb}</td>
            <td className="num">{p.pre_tug_s.toFixed(1)}</td>
            <td className="num">{p.composite_improvement != null ? (p.composite_improvement >= 0 ? "+" : "") + p.composite_improvement.toFixed(2) : "—"}</td>
            <td>
              {p.is_dropout ? <Pill kind="warning">No follow-up</Pill>
                : p.overall_responder === 1 ? <Pill kind="success">Responder</Pill>
                : <Pill>Non-responder</Pill>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CohortsPage({ data, onPatientClick }: CohortsPageProps) {
  // Allow user to compare a subset
  const initialSelected = COHORTS.filter((c) => c !== "Unclassified");
  const [selected, setSelected] = useState<string[]>(initialSelected);

  function toggle(c: string) {
    setSelected((s) => s.includes(c) ? s.filter((x) => x !== c) : [...s, c]);
  }

  const rows = selected.map((c) => {
    const sub = data.filter((p) => p.cohort === c);
    const fu = sub.filter((p) => !p.is_dropout);
    return {
      cohort: c,
      n: sub.length,
      fuPct: sub.length ? (fu.length / sub.length) * 100 : 0,
      respPct: fu.length ? (fu.filter((p) => p.overall_responder === 1).length / fu.length) * 100 : 0,
      dropPct: sub.length ? (sub.filter((p) => p.is_dropout === 1).length / sub.length) * 100 : 0,
      meanImp: mean(fu.map((p) => p.composite_improvement)),
      values: fu.map((p) => p.composite_improvement).filter((x): x is number => x != null),
      color: COHORT_COLORS[c],
    };
  });

  // Grouped bars: responder vs dropout
  const groupedGroups = rows.map((r) => ({
    label: r.cohort,
    values: [r.respPct, r.dropPct],
    sub: `n=${r.n}`,
  }));
  const groupedSeries = [
    { label: "Responder %", color: "var(--accent)" },
    { label: "Dropout %", color: "var(--danger)" },
  ];

  // Age band stacks
  const ageStacks = rows.map((r) => {
    const sub = data.filter((p) => p.cohort === r.cohort);
    return {
      key: r.cohort,
      label: r.cohort,
      values: AGE_BANDS.map((b) => sub.filter((p) => p.age_band === b).length),
    };
  });
  const cohortColors = rows.map((r) => r.color);

  return (
    <div className="content fade-in" key={selected.join(",")}>
      <Card title="Cohorts to compare" subtitle="Click a cohort to include or exclude">
        <div className="chip-row">
          {COHORTS.map((c) => (
            <button key={c} onClick={() => toggle(c)}
                    className={`chip ${selected.includes(c) ? "on" : ""}`}
                    style={selected.includes(c) ? { background: COHORT_COLORS[c], borderColor: COHORT_COLORS[c] } : {}}>
              <span className="dot" style={{ background: COHORT_COLORS[c], marginRight: 6, opacity: selected.includes(c) ? 0 : 1 }} />
              {c}
            </button>
          ))}
        </div>
      </Card>

      {rows.length < 2 ? (
        <Card><div style={{ color: "var(--ink-3)" }}>Select at least 2 cohorts to compare.</div></Card>
      ) : (
        <>
          {/* Summary table */}
          <Card flush title="Summary">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th className="num">N</th>
                  <th className="num">Follow-up</th>
                  <th className="num">Responders</th>
                  <th className="num">Dropout</th>
                  <th className="num">Mean Improvement</th>
                  <th className="num">Distribution</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cohort}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="dot" style={{ background: r.color }} />
                        <span style={{ fontWeight: 500, color: "var(--ink)" }}>{r.cohort}</span>
                      </div>
                    </td>
                    <td className="num">{r.n.toLocaleString()}</td>
                    <td className="num">{r.fuPct.toFixed(1)}%</td>
                    <td className="num">{r.respPct.toFixed(1)}%</td>
                    <td className="num">{r.dropPct.toFixed(1)}%</td>
                    <td className="num">{r.meanImp != null ? r.meanImp.toFixed(2) : "—"}</td>
                    <td className="num" style={{ width: 140 }}>
                      <MicroBox values={r.values} color={r.color} width={120} height={26} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="grid-12-7-5">
            <Card title="Responder vs Dropout Rate" subtitle="Programme outcomes by cohort">
              <GroupedBars groups={groupedGroups} series={groupedSeries} />
              <Legend items={groupedSeries} />
            </Card>

            <Card title="Composite Improvement" subtitle="Distribution per cohort (follow-up only)">
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
                {rows.map((r) => (
                  <div key={r.cohort} style={{ display: "grid", gridTemplateColumns: "120px 1fr 48px", alignItems: "center", gap: 12, padding: "4px 0" }}>
                    <div style={{ fontSize: 11.5, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      <span className="dot" style={{ background: r.color, marginRight: 6 }} /> {r.cohort}
                    </div>
                    <div style={{ height: 30 }}>
                      <MicroBox values={r.values} color={r.color} width={300} height={30} />
                    </div>
                    <div className="mono num" style={{ fontSize: 11.5, color: "var(--ink-3)", textAlign: "right" }}>
                      {r.meanImp != null ? (r.meanImp >= 0 ? "+" : "") + r.meanImp.toFixed(2) : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title="Age Band Distribution" subtitle="Stacked counts per cohort across age bands">
            <StackedBars
              categories={AGE_BANDS}
              stacks={ageStacks}
              colors={cohortColors}
            />
            <Legend items={ageStacks.map((s, i) => ({ label: s.label, color: cohortColors[i] }))} />
          </Card>

          {/* Sample patient table */}
          <Card flush title="Patient sample" action={<Pill>click row &rarr; drawer</Pill>}>
            <PatientSampleTable data={data.filter((p) => selected.includes(p.cohort)).slice(0, 12)} onClick={onPatientClick} />
          </Card>
        </>
      )}
    </div>
  );
}
