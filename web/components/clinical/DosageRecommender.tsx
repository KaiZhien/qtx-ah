"use client";

import React, { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icons";
import { ConfidenceMeter } from "@/components/charts/ConfidenceMeter";
import { predictDosage } from "@/lib/api";
import type { DosageIntake, DosageResult } from "@/lib/types";

interface DosageFormState {
  age: number;
  gender: string;
  pain: string;
  conditions: {
    knee: boolean;
    leg: boolean;
    back: boolean;
    balance: boolean;
    upper: boolean;
    foot: boolean;
    neuro: boolean;
    frailty: boolean;
    metabolic: boolean;
    injury: boolean;
    generalPain: boolean;
  };
}

const COND_LABEL: Record<string, string> = {
  knee: "Knee issue",
  leg: "Leg weakness",
  back: "Back/spine issue",
  balance: "Balance",
  upper: "Upper body",
  foot: "Foot/ankle",
  neuro: "Neurological",
  frailty: "Frailty",
  metabolic: "Metabolic (e.g. diabetes)",
  injury: "Injury/surgery",
  generalPain: "General pain",
};

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

export function DosageRecommender() {
  const [form, setForm] = useState<DosageFormState>({
    age: 70,
    gender: "F",
    pain: "Y",
    conditions: {
      knee: false, leg: false, back: false, balance: false, upper: false,
      foot: false, neuro: false, frailty: false, metabolic: false,
      injury: false, generalPain: false,
    },
  });
  const [rec, setRec] = useState<DosageResult | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setCond(k: keyof DosageFormState["conditions"], v: boolean) {
    setForm((f) => ({ ...f, conditions: { ...f.conditions, [k]: v } }));
  }

  const handleGetRec = async () => {
    setPredicting(true);
    setError(null);
    try {
      const intake: DosageIntake = {
        age: form.age,
        gender: form.gender,
        joined_with_pain: form.pain,
        hl_general_pain_issue: form.conditions.generalPain ? 1 : undefined,
        hl_knee_issue: form.conditions.knee ? 1 : undefined,
        hl_frailty_issue: form.conditions.frailty ? 1 : undefined,
        hl_balance_issue: form.conditions.balance ? 1 : undefined,
        hl_neuro_issue: form.conditions.neuro ? 1 : undefined,
        hl_back_spine_issue: form.conditions.back ? 1 : undefined,
        hl_leg_issue: form.conditions.leg ? 1 : undefined,
        hl_upper_body_issue: form.conditions.upper ? 1 : undefined,
        hl_foot_ankle_issue: form.conditions.foot ? 1 : undefined,
        hl_metabolic_issue: form.conditions.metabolic ? 1 : undefined,
        hl_injury_surgery_issue: form.conditions.injury ? 1 : undefined,
      };
      const result = await predictDosage(intake);
      setRec(result);
    } catch (e) {
      console.error(e);
      setError("Prediction failed — check that the API server is running.");
    } finally {
      setPredicting(false);
    }
  };

  return (
    <div className="grid-12-7-5">
      <Card title="Intake details" subtitle="Patient profile feeds the recommender">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          <Field label="Age">
            <input
              className="input"
              type="number"
              min="18"
              max="110"
              value={form.age}
              onChange={(e) => setForm((f) => ({ ...f, age: +e.target.value }))}
            />
          </Field>
          <Field label="Gender">
            <select
              className="select"
              value={form.gender}
              onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}
            >
              <option>F</option>
              <option>M</option>
            </select>
          </Field>
          <Field label="Joined with pain?">
            <select
              className="select"
              value={form.pain}
              onChange={(e) => setForm((f) => ({ ...f, pain: e.target.value }))}
            >
              <option>Y</option>
              <option>N</option>
            </select>
          </Field>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="filter-label">Reported conditions</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
            {(Object.entries(COND_LABEL) as [keyof DosageFormState["conditions"], string][]).map(([k, label]) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={form.conditions[k]}
                  onChange={(e) => setCond(k, e.target.checked)}
                />
                <span className="box" />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <button className="btn primary" onClick={handleGetRec} disabled={predicting}>
            {predicting ? "Calculating..." : "Get recommendation"} <Icon.Arrow />
          </button>
        </div>
      </Card>

      <Card
        title="Recommendation"
        subtitle={rec ? "Confidence-weighted across treatment options" : "Run the recommender"}
      >
        {error && !rec ? (
          <div style={{ padding: "16px 8px", textAlign: "center", color: "var(--red, #e53e3e)", fontSize: 13 }}>
            {error}
          </div>
        ) : !rec ? (
          <PredictionEmpty />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ background: "var(--accent-soft)", borderRadius: 8, padding: "16px 18px", borderLeft: "3px solid var(--accent)" }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 6 }}>
                Recommended dosage
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>{rec.recommendation}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                Model confidence <span className="mono" style={{ color: "var(--ink)", fontWeight: 500 }}>{Math.round(rec.confidence * 100)}%</span>
                {rec.confidence < 0.5 && (
                  <span style={{ color: "var(--warning)", marginLeft: 8 }}>· atypical profile — clinician judgement first</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.entries(rec.probabilities)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <ConfidenceMeter
                    key={k}
                    label={k}
                    value={v}
                    color={k === rec.recommendation ? "var(--accent)" : "var(--ink-4)"}
                  />
                ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
              Based on intake features only. Always combine with clinical judgement.
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
