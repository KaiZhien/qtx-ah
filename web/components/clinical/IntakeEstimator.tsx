"use client";

import React, { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { Icon } from "@/components/ui/Icons";
import { ConfidenceMeter } from "@/components/charts/ConfidenceMeter";
import { predictOutcomes } from "@/lib/api";
import { COHORTS, USAGE, FLAG_LABELS } from "@/lib/constants";
import type { Patient, PatientProfile, PredictionResult } from "@/lib/types";

interface IntakeEstimatorProps {
  data: Patient[];
  onPatientClick: (p: Patient) => void;
}

interface FormState {
  age: number;
  gender: string;
  baseline_sppb: number;
  pre_tug_s: number;
  pre_5xsst_s: number;
  pre_normal_gs_ms: number;
  pre_fast_gs_ms: number;
  pre_vas: number;
  usage: string;
  cohort: string;
  tags: string;
  flags: Record<string, boolean>;
}

interface BigStatProps {
  label: string;
  value: string;
  color: string;
}

function BigStat({ label, value, color }: BigStatProps) {
  return (
    <div style={{ background: "var(--surface-sunken)", padding: "12px 14px", borderRadius: 8, borderTop: `2px solid ${color}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 6 }}>{label}</div>
      <div className="mono num" style={{ fontSize: 22, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.02em" }}>{value}</div>
    </div>
  );
}

function PredictionEmpty() {
  return (
    <div style={{ padding: "24px 8px", textAlign: "center", color: "var(--ink-4)" }}>
      <div style={{ width: 44, height: 44, borderRadius: 999, background: "var(--surface-sunken)", display: "inline-grid", placeItems: "center", marginBottom: 10 }}>
        <Icon.Spark />
      </div>
      <div style={{ fontSize: 12.5 }}>Predictions appear here once you submit the intake form.</div>
    </div>
  );
}

interface PredictionDisplayProps {
  prediction: PredictionResult;
}

function PredictionDisplay({ prediction }: PredictionDisplayProps) {
  const { composite_improvement, p_responder, p_dropout } = prediction;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <BigStat
          label="Predicted Composite Delta"
          value={(composite_improvement >= 0 ? "+" : "") + composite_improvement.toFixed(2)}
          color={composite_improvement >= 0 ? "var(--success)" : "var(--danger)"}
        />
        <BigStat label="P(Responder)" value={(p_responder * 100).toFixed(0) + "%"} color="var(--accent)" />
        <BigStat label="P(Dropout)" value={(p_dropout * 100).toFixed(0) + "%"} color="var(--warning)" />
      </div>
      <ConfidenceMeter
        label="Composite improvement (vs cohort mean 0.00)"
        value={Math.max(0, Math.min(1, (composite_improvement + 1) / 2))}
        color="var(--success)"
      />
      <ConfidenceMeter label="Responder probability" value={p_responder} color="var(--accent)" />
      <ConfidenceMeter label="Dropout risk" value={p_dropout} color="var(--warning)" />
      <div style={{ fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.4 }}>
        Predictions are based on the training cohort and carry uncertainty.
        Not a clinical guarantee — use alongside clinical judgement.
      </div>
    </div>
  );
}

function PerTestPredictions({ perTest }: { perTest: PredictionResult["per_test"] }) {
  const fmt = (v: number) => (v % 1 === 0 ? v.toString() : v.toFixed(2));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {perTest.map((t) => (
        <div key={t.name} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr", alignItems: "center", padding: "8px 4px", borderBottom: "1px solid var(--line)", gap: 12 }}>
          <div style={{ fontSize: 12.5 }}>{t.name}</div>
          <div className="mono num" style={{ color: "var(--ink-3)", fontSize: 12 }}>{fmt(t.baseline)}</div>
          <div style={{ color: "var(--ink-4)" }}>→</div>
          <div className="mono num" style={{ color: "var(--ink)", fontSize: 12, fontWeight: 500 }}>{fmt(t.predicted)}</div>
          <div style={{ textAlign: "right" }}>
            {t.mcid
              ? <Pill kind="success">MCID</Pill>
              : <Pill>
                  {(() => {
                    const delta = t.predicted - t.baseline;
                    return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
                  })()}
                </Pill>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Contributions({ contributions }: { contributions: PredictionResult["contributions"] }) {
  const max = Math.max(...contributions.map((c) => Math.abs(c.value)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {contributions.map((c, i) => {
        const pct = max > 0 ? Math.abs(c.value) / max : 0;
        const col = c.value >= 0 ? "var(--success)" : "var(--danger)";
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "200px 1fr 60px", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{c.feature}</div>
            <div style={{ position: "relative", height: 8 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--line-strong)" }} />
              <div style={{
                position: "absolute", top: 0, height: "100%",
                left: c.value >= 0 ? "50%" : `${50 - pct * 50}%`,
                width: `${pct * 50}%`,
                background: col, opacity: 0.85,
                borderRadius: 2, transition: "width 600ms cubic-bezier(0.2,0.7,0.2,1)",
              }} />
            </div>
            <div className="mono num" style={{ fontSize: 11, color: col, textAlign: "right", fontWeight: 500 }}>
              {c.value >= 0 ? "+" : ""}{c.value.toFixed(2)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FLAG_KEYS = [
  "has_oa", "has_diabetes", "has_frailty", "has_balance_issue",
  "has_post_surgery", "has_chronic_pain", "has_spinal_issue",
  "has_knee_issue", "has_neurological",
] as const;

export function IntakeEstimator({ data: _data, onPatientClick: _onPatientClick }: IntakeEstimatorProps) {
  const [form, setForm] = useState<FormState>({
    age: 68, gender: "F",
    baseline_sppb: 7,
    pre_tug_s: 14.5,
    pre_5xsst_s: 18.2,
    pre_normal_gs_ms: 0.85,
    pre_fast_gs_ms: 1.10,
    pre_vas: 4,
    usage: USAGE[2],
    cohort: COHORTS[0],
    tags: "",
    flags: {},
  });
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [predicting, setPredicting] = useState(false);

  function set(k: keyof FormState, v: unknown) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function setFlag(f: string, v: boolean) {
    setForm((s) => ({ ...s, flags: { ...s.flags, [f]: v } }));
  }

  const handlePredict = async () => {
    setPredicting(true);
    try {
      const profile: PatientProfile = {
        age: form.age,
        gender: form.gender,
        cohort: form.cohort,
        usage_frequency: form.usage,
        pre_vas: form.pre_vas,
        pre_tug_s: form.pre_tug_s,
        pre_5xsst_s: form.pre_5xsst_s,
        pre_normal_gs_ms: form.pre_normal_gs_ms,
        pre_fast_gs_ms: form.pre_fast_gs_ms,
        baseline_sppb: form.baseline_sppb,
        has_oa: form.flags["has_oa"] ? 1 : 0,
        has_diabetes: form.flags["has_diabetes"] ? 1 : 0,
        has_stroke: 0,
        has_parkinsons: 0,
        has_frailty: form.flags["has_frailty"] ? 1 : 0,
        has_cancer: 0,
        has_hypertension: 0,
        has_osteoporosis: 0,
        has_balance_issue: form.flags["has_balance_issue"] ? 1 : 0,
        has_post_surgery: form.flags["has_post_surgery"] ? 1 : 0,
        has_chronic_pain: form.flags["has_chronic_pain"] ? 1 : 0,
        has_spinal_issue: form.flags["has_spinal_issue"] ? 1 : 0,
        has_knee_issue: form.flags["has_knee_issue"] ? 1 : 0,
        has_neurological: form.flags["has_neurological"] ? 1 : 0,
      };
      const result = await predictOutcomes(profile);
      setPrediction(result);
    } catch (e) {
      console.error(e);
    } finally {
      setPredicting(false);
    }
  };

  return (
    <>
      <div className="grid-12-7-5" key="intake-grid">
        <Card title="Patient profile" subtitle="Enter intake details">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Age">
              <input className="input" type="number" min="18" max="110" value={form.age} onChange={(e) => set("age", +e.target.value)} />
            </Field>
            <Field label="Gender">
              <select className="select" value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                <option>F</option><option>M</option><option>Unknown</option>
              </select>
            </Field>

            <Field label="Cohort" style={{ gridColumn: "span 2" }}>
              <select className="select" value={form.cohort} onChange={(e) => set("cohort", e.target.value)}>
                {COHORTS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Usage frequency" style={{ gridColumn: "span 2" }}>
              <select className="select" value={form.usage} onChange={(e) => set("usage", e.target.value)}>
                {USAGE.map((u) => <option key={u}>{u}</option>)}
              </select>
            </Field>

            <Field label={`Baseline SPPB (${form.baseline_sppb} / 12)`} style={{ gridColumn: "span 2" }}>
              <input className="slider" type="range" min="0" max="12" step="1" value={form.baseline_sppb} onChange={(e) => set("baseline_sppb", +e.target.value)} />
            </Field>

            <Field label="VAS Pain (0-10)">
              <input className="input mono" type="number" min="0" max="10" step="0.5" value={form.pre_vas} onChange={(e) => set("pre_vas", +e.target.value)} />
            </Field>
            <Field label="TUG (sec)">
              <input className="input mono" type="number" min="0" step="0.1" value={form.pre_tug_s} onChange={(e) => set("pre_tug_s", +e.target.value)} />
            </Field>
            <Field label="5xSST (sec)">
              <input className="input mono" type="number" min="0" step="0.1" value={form.pre_5xsst_s} onChange={(e) => set("pre_5xsst_s", +e.target.value)} />
            </Field>
            <Field label="Normal gait (m/s)">
              <input className="input mono" type="number" min="0" max="2.5" step="0.05" value={form.pre_normal_gs_ms} onChange={(e) => set("pre_normal_gs_ms", +e.target.value)} />
            </Field>

            <Field label="Comorbidity tags" style={{ gridColumn: "span 2" }} hint="Free text (e.g. knee osteoarthritis, DM)">
              <input className="input" placeholder="e.g. knee OA, diabetes" value={form.tags} onChange={(e) => set("tags", e.target.value)} />
            </Field>
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <div className="filter-label">Conditions (override)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginTop: 4 }}>
              {FLAG_KEYS.map((f) => (
                <label key={f} className="check">
                  <input type="checkbox" checked={!!form.flags[f]} onChange={(e) => setFlag(f, e.target.checked)} />
                  <span className="box" />
                  <span>{FLAG_LABELS[f] ?? f}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={handlePredict} disabled={predicting}>
              {predicting ? "Predicting..." : "Predict outcomes"} <Icon.Arrow />
            </button>
            <button className="btn" onClick={() => { setPrediction(null); setForm({ ...form, tags: "", flags: {} }); }}>
              Reset
            </button>
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Model output" subtitle={prediction ? "Based on API prediction model" : "Run a prediction to see results"}>
            {!prediction ? (
              <PredictionEmpty />
            ) : (
              <PredictionDisplay prediction={prediction} />
            )}
          </Card>
          {prediction && (
            <Card title="Per-test predicted outcomes" subtitle="Baseline vs predicted post; MCID-positive marked">
              <PerTestPredictions perTest={prediction.per_test} />
            </Card>
          )}
        </div>
      </div>

      {prediction && (
        <Card title="Feature contributions" subtitle="Largest model drivers (SHAP)">
          <Contributions contributions={prediction.contributions} />
        </Card>
      )}
    </>
  );
}
