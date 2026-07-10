"use client";

import React, { useState } from "react";
import type { Patient, ResponseCurve } from "@/lib/types";
import { COHORTS, COHORT_COLORS, AGE_BANDS } from "@/lib/constants";
import { fetchWearableSummary, getResponseCurves } from "@/lib/api";
import { GroupedBars } from "@/components/charts/GroupedBars";
import { StackedBars } from "@/components/charts/StackedBars";
import { ResponseCurveChart } from "@/components/charts/ResponseCurveChart";
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
            <td className="num">{p.pre_tug_s != null ? p.pre_tug_s.toFixed(1) : "—"}</td>
            <td className="num">{p.composite_improvement != null ? (p.composite_improvement >= 0 ? "+" : "") + p.composite_improvement.toFixed(2) : "—"}</td>
            <td>
              {p.is_dropout ? <Pill kind="warning">No follow-up</Pill>
                : p.overall_responder ? <Pill kind="success">Responder</Pill>
                : <Pill>Non-responder</Pill>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const GRP_FLAGS = [
  { key: "grp_joint_disease",      label: "Joint Disease" },
  { key: "grp_spine_back",         label: "Spine / Back" },
  { key: "grp_neurological",       label: "Neurological" },
  { key: "grp_post_surgical",      label: "Post-Surgical" },
  { key: "grp_frailty_sarcopenia", label: "Frailty / Sarcopenia" },
  { key: "grp_balance_falls",      label: "Balance / Falls" },
  { key: "grp_metabolic",          label: "Metabolic" },
  { key: "grp_cardiovascular",     label: "Cardiovascular" },
  { key: "grp_oncology",           label: "Oncology" },
  { key: "grp_autoimmune",         label: "Autoimmune" },
  { key: "grp_softtissue_injury",  label: "Soft Tissue Injury" },
  { key: "grp_generalised_pain",   label: "Generalised Pain" },
  { key: "grp_osteoporosis",       label: "Osteoporosis" },
  { key: "grp_wellness",           label: "Wellness" },
];

const CURVE_METRICS = [
  { key: "composite_improvement",  label: "Composite Improvement" },
  { key: "tug_change_pct",         label: "TUG Change %" },
  { key: "sst_change_pct",         label: "5xSST Change %" },
  { key: "sppb_change",            label: "SPPB Change" },
  { key: "vas_change",             label: "VAS Change" },
  { key: "normal_gs_change_pct",   label: "Normal GS Change %" },
  { key: "fast_gs_change_pct",     label: "Fast GS Change %" },
];

export function CohortsPage({ data, onPatientClick }: CohortsPageProps) {
  // Allow user to compare a subset
  const initialSelected = COHORTS.filter((c) => c !== "Unclassified");
  const [selected, setSelected] = useState<string[]>(initialSelected);

  const [enrolledCount, setEnrolledCount] = React.useState<number | null>(null);

  // Response curves state
  const [curveGrp, setCurveGrp] = React.useState<string>("grp_frailty_sarcopenia");
  const [curveMetric, setCurveMetric] = React.useState<string>("composite_improvement");
  const [curvesData, setCurvesData] = React.useState<ResponseCurve[] | null>(null);
  const [curvesLoading, setCurvesLoading] = React.useState(false);

  React.useEffect(() => {
    fetchWearableSummary()
      .then((s) => setEnrolledCount(s.enrolled_count))
      .catch(() => { /* non-critical — silently ignore */ });
  }, []);

  React.useEffect(() => {
    setCurvesLoading(true);
    setCurvesData(null);
    getResponseCurves(curveGrp, curveMetric)
      .then((res) => setCurvesData(res ? res.curves : []))
      .catch(() => setCurvesData([]))
      .finally(() => setCurvesLoading(false));
  }, [curveGrp, curveMetric]);

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
      respPct: fu.length ? (fu.filter((p) => p.overall_responder).length / fu.length) * 100 : 0,
      dropPct: sub.length ? (sub.filter((p) => p.is_dropout).length / sub.length) * 100 : 0,
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
      {/* Wearable enrollment summary */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 18px",
          background: "var(--surface-raised, var(--surface))",
          border: "1px solid var(--line)",
          borderRadius: 10,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 4,
            }}
          >
            Wearable enrollment
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span
              style={{
                fontSize: 28,
                fontWeight: 700,
                fontFamily: "var(--font-mono)",
                color: "var(--ink)",
              }}
            >
              {enrolledCount ?? "—"}
            </span>
            <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
              patient{enrolledCount !== 1 ? "s" : ""} with active wearable
            </span>
          </div>
        </div>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background:
              enrolledCount != null && enrolledCount > 0
                ? "rgba(59,107,217,0.12)"
                : "var(--surface-sunken)",
            display: "grid",
            placeItems: "center",
            fontSize: 20,
          }}
        >
          ⌚
        </div>
      </div>

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

      {/* Cohort Response Curves */}
      <Card
        title="Cohort Response Curves"
        subtitle="Percentile bands (p25–p75) by session number for a phenotype group"
      >
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Group</label>
            <select
              value={curveGrp}
              onChange={(e) => setCurveGrp(e.target.value)}
              style={{
                fontSize: 12, padding: "4px 8px", borderRadius: 6,
                border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)",
              }}
            >
              {GRP_FLAGS.map((g) => (
                <option key={g.key} value={g.key}>{g.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Metric</label>
            <select
              value={curveMetric}
              onChange={(e) => setCurveMetric(e.target.value)}
              style={{
                fontSize: 12, padding: "4px 8px", borderRadius: 6,
                border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)",
              }}
            >
              {CURVE_METRICS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>

        {curvesLoading && (
          <div style={{ color: "var(--ink-3)", fontSize: 12 }}>Loading curves…</div>
        )}
        {!curvesLoading && curvesData !== null && curvesData.length === 0 && (
          <div style={{ color: "var(--ink-4)", fontSize: 12 }}>
            No data for this group yet — run the compute script after ingesting data.
          </div>
        )}
        {!curvesLoading && curvesData && curvesData.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
            {curvesData.map((curve) => (
              <ResponseCurveChart
                key={curve.metric}
                metric={curve.metric}
                points={curve.points}
                patientPoints={[]}
                color="var(--accent)"
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
