"use client";

import React, { useMemo } from "react";
import type { Patient } from "@/lib/types";
import {
  COHORTS,
  COHORT_COLORS,
  FLAGS,
  FLAG_LABELS,
  TESTS,
} from "@/lib/constants";
import { Donut } from "@/components/charts/Donut";
import { HBars } from "@/components/charts/HBars";
import { PrePostBox } from "@/components/charts/PrePostBox";
import { Histogram } from "@/components/charts/Histogram";
import { Card } from "@/components/ui/Card";
import { KPI } from "@/components/ui/KPI";

function mean(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export interface OverviewPageProps {
  data: Patient[];
  dataAll: Patient[];
  onPatientClick: (p: Patient) => void;
  showFunnel: boolean;
}

// Sub-component: Funnel
function Funnel({ data }: { data: Patient[] }) {
  const n = data.length;
  const fu = data.filter((p) => !p.is_dropout).length;
  const resp = data.filter((p) => p.overall_responder === 1).length;
  const drop = n - fu;
  const stages = [
    { label: "Intake records", value: n, color: "var(--ink-2)" },
    { label: "Completed follow-up", value: fu, color: "var(--accent)" },
    { label: "Overall responders", value: resp, color: "var(--success)" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 4 }}>
      {stages.map((s, i) => {
        const pct = n ? (s.value / n) * 100 : 0;
        const prev = i === 0 ? null : stages[i - 1].value;
        const localPct = prev ? (s.value / prev) * 100 : 100;
        return (
          <div key={i} style={{ position: "relative" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="dot" style={{ background: s.color }} />
                <span style={{ color: "var(--ink-2)" }}>{s.label}</span>
              </div>
              <div className="mono" style={{ color: "var(--ink-3)" }}>
                <span style={{ color: "var(--ink)", fontWeight: 500 }}>{s.value.toLocaleString()}</span>
                <span style={{ marginLeft: 8 }}>{pct.toFixed(1)}%</span>
              </div>
            </div>
            <div style={{ background: "var(--surface-sunken)", borderRadius: 4, overflow: "hidden", height: 28, position: "relative" }}>
              <div style={{
                background: s.color, height: "100%",
                width: `${pct}%`,
                transition: "width 700ms cubic-bezier(0.2,0.7,0.2,1)",
                opacity: 0.18,
              }} />
              <div style={{
                position: "absolute", top: 0, left: 0, bottom: 0,
                width: `${pct}%`,
                borderLeft: `3px solid ${s.color}`,
                transition: "width 700ms cubic-bezier(0.2,0.7,0.2,1)",
              }} />
            </div>
            {prev && (
              <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 4, textAlign: "right" }} className="mono">
                {localPct.toFixed(1)}% of previous step
              </div>
            )}
          </div>
        );
      })}
      <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--danger-soft)", borderRadius: 6, fontSize: 11.5, color: "var(--danger)", display: "flex", justifyContent: "space-between" }}>
        <span>Did not complete follow-up</span>
        <span className="mono">{drop.toLocaleString()} ({n ? ((drop / n) * 100).toFixed(1) : "0.0"}%)</span>
      </div>
    </div>
  );
}

export function OverviewPage({ data, dataAll, onPatientClick: _onPatientClick, showFunnel }: OverviewPageProps) {
  const n = data.length;
  const followUp = useMemo(() => data.filter((p) => p.is_dropout === 0), [data]);
  const pctFu = n ? (followUp.length / n) * 100 : 0;
  const meanImp = useMemo(
    () => mean(followUp.map((p) => p.composite_improvement).filter((v): v is number => v != null && !isNaN(v))),
    [followUp]
  );
  const respRate = followUp.length
    ? (followUp.filter((p) => p.overall_responder === 1).length / followUp.length) * 100
    : 0;

  // Sparklines — monthly intakes through 2024
  const { monthly, monthlyFu, monthlyResp } = useMemo(() => {
    const monthly = new Array(12).fill(0);
    const monthlyResp = new Array(12).fill(0);
    const monthlyFu = new Array(12).fill(0);
    data.forEach((p) => {
      const m = new Date(p.intake_date).getMonth();
      monthly[m]++;
      if (p.overall_responder === 1) monthlyResp[m]++;
      if (!p.is_dropout) monthlyFu[m]++;
    });
    return { monthly, monthlyResp, monthlyFu };
  }, [data]);

  // Cohort distribution
  const cohortCounts = useMemo(
    () =>
      COHORTS.map((c) => ({
        label: c,
        value: data.filter((p) => p.cohort === c).length,
        color: COHORT_COLORS[c],
      })).filter((x) => x.value > 0),
    [data]
  );

  // Comorbidity bars
  const flagRows = useMemo(
    () =>
      FLAGS.map((f) => {
        const sub = followUp
          .filter((p) => (p as Record<string, unknown>)[f] === 1)
          .map((p) => p.composite_improvement)
          .filter((v): v is number => v != null && !isNaN(v));
        return { label: FLAG_LABELS[f] || f, value: mean(sub) ?? 0, n: sub.length };
      })
        .filter((r) => r.n >= 10)
        .sort((a, b) => a.value - b.value),
    [followUp]
  );

  // Test rows
  const testRows = useMemo(
    () =>
      TESTS.map((t) => {
        const pre = followUp.map((p) => p[t.pre]).filter((v): v is number => v != null && !isNaN(v as number));
        const post = followUp.map((p) => p[t.post]).filter((v): v is number => v != null && !isNaN(v as number));
        return { ...t, pre, post };
      }),
    [followUp]
  );

  const flagMax = flagRows.length ? Math.max(...flagRows.map((r) => Math.abs(r.value))) : 1;

  return (
    <div className="content fade-in" key={`ov-${n}`}>
      {/* KPI strip */}
      <div className="kpi-row">
        <KPI label="Patients (Filtered)" value={n.toLocaleString()} sub={`of ${dataAll.length.toLocaleString()} total`} spark={monthly} color="var(--accent)" />
        <KPI label="Follow-up Rate" value={pctFu.toFixed(1)} unit="%" sub={`${followUp.length.toLocaleString()} with post-assessment`} spark={monthlyFu} color="var(--success)" delta={`${followUp.length}`} deltaDir="up" />
        <KPI label="Mean Improvement" value={meanImp != null ? meanImp.toFixed(2) : "—"} sub="Composite z-score, follow-up cohort" spark={monthlyResp} color="var(--ink-2)" />
        <KPI label="Responder Rate" value={respRate.toFixed(1)} unit="%" sub="MCID on ≥2 tests" spark={monthlyResp.map((r, i) => (monthlyFu[i] ? r / monthlyFu[i] : 0))} color="var(--accent-strong)" delta="+8.4 pp" deltaDir="up" />
      </div>

      {/* Cohort breakdown + monthly funnel */}
      <div className="grid-12-5-7">
        <Card title="Cohort Breakdown" subtitle={`${cohortCounts.length} phenotype groups`}>
          <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 8 }}>
            <Donut
              data={cohortCounts}
              centerLabel="patients"
              centerValue={n.toLocaleString()}
              onSlice={() => { /* could filter */ }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
              {cohortCounts.map((c) => (
                <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                  <span className="dot" style={{ background: c.color }} />
                  <span style={{ flex: 1, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                  <span className="mono" style={{ color: "var(--ink-3)" }}>{c.value.toLocaleString()}</span>
                  <span className="mono" style={{ color: "var(--ink-4)", width: 40, textAlign: "right" }}>{n ? ((c.value / n) * 100).toFixed(1) : "0.0"}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {showFunnel && (
          <Card title="Programme Funnel" subtitle="Intake → Follow-up → Responders">
            <Funnel data={data} />
          </Card>
        )}
      </div>

      {/* Pre/Post small multiples */}
      <Card title="Pre vs Post by Test" subtitle={`${followUp.length.toLocaleString()} patients with at least one post-assessment`}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {testRows.map((t) => (
            <div key={t.key} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", padding: 6 }}>
              <PrePostBox label={t.label} unit={t.unit} pre={t.pre} post={t.post} higherBetter={t.higherBetter} h={180} />
            </div>
          ))}
        </div>
      </Card>

      {/* Composite improvement distribution + comorbidity bars */}
      <div className="grid-12-7-5">
        <Card title="Composite Improvement Distribution" subtitle="Z-score across follow-up cohort">
          <Histogram
            values={followUp.map((p) => p.composite_improvement)}
            bins={26}
            color="var(--accent)"
            markers={[
              { value: 0, color: "var(--ink-4)", label: "0" },
              { value: meanImp ?? 0, color: "var(--accent-strong)", label: `μ=${(meanImp ?? 0).toFixed(2)}` },
            ]}
          />
          <div style={{ display: "flex", gap: 20, fontSize: 11.5, color: "var(--ink-3)", marginTop: 8 }}>
            <div><span className="dot" style={{ background: "var(--accent)" }} /> {followUp.length.toLocaleString()} patients</div>
            <div>Responders (≥2 MCIDs): <strong style={{ color: "var(--ink-2)" }}>{respRate.toFixed(1)}%</strong></div>
          </div>
        </Card>

        <Card title="Mean Improvement by Comorbidity" subtitle="Min n=10">
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            <HBars data={flagRows} maxVal={flagMax} />
          </div>
        </Card>
      </div>
    </div>
  );
}
