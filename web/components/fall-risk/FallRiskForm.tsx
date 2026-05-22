// web/components/fall-risk/FallRiskForm.tsx
"use client";

import React, { useState } from "react";
import type { FallRiskInput, FallRiskResult } from "@/lib/types";
import { predictFallRisk } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";

interface Props {
  onResult: (result: FallRiskResult) => void;
  onLoading: (loading: boolean) => void;
}

type PatientFields = {
  age: string;
  gender: "M" | "F" | "";
  falls_history: 0 | 1 | 2;
  walking_aid: "none" | "stick" | "frame" | "";
  exercise_frequency: "rarely" | "1-2" | "3+" | "";
  has_oa: boolean;
  has_diabetes: boolean;
  has_stroke: boolean;
  has_parkinsons: boolean;
  has_heart_disease: boolean;
  polypharmacy: boolean | null;
};

type ClinicalFields = {
  pre_tug_s: string;
  pre_5xsst_s: string;
  pre_normal_gs_ms: string;
  baseline_sppb: string;
  pre_vas: string;
};

const DEFAULT_PATIENT: PatientFields = {
  age: "",
  gender: "",
  falls_history: 0,
  walking_aid: "",
  exercise_frequency: "",
  has_oa: false,
  has_diabetes: false,
  has_stroke: false,
  has_parkinsons: false,
  has_heart_disease: false,
  polypharmacy: null,
};

const DEFAULT_CLINICAL: ClinicalFields = {
  pre_tug_s: "",
  pre_5xsst_s: "",
  pre_normal_gs_ms: "",
  baseline_sppb: "",
  pre_vas: "",
};

export function FallRiskForm({ onResult, onLoading }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [patient, setPatient] = useState<PatientFields>(DEFAULT_PATIENT);
  const [clinical, setClinical] = useState<ClinicalFields>(DEFAULT_CLINICAL);
  const [error, setError] = useState<string | null>(null);
  const [patientId, setPatientId] = useState<string>("");

  function setP<K extends keyof PatientFields>(k: K, v: PatientFields[K]) {
    setPatient((p) => ({ ...p, [k]: v }));
  }

  function step1Valid() {
    return (
      patient.age !== "" &&
      parseInt(patient.age) > 0 &&
      patient.gender !== "" &&
      patient.walking_aid !== "" &&
      patient.exercise_frequency !== "" &&
      patient.polypharmacy !== null
    );
  }

  function buildInput(skipClinical: boolean): FallRiskInput {
    const clinical_fields = skipClinical ? {} : {
      pre_tug_s:        clinical.pre_tug_s        ? parseFloat(clinical.pre_tug_s)        : null,
      pre_5xsst_s:      clinical.pre_5xsst_s      ? parseFloat(clinical.pre_5xsst_s)      : null,
      pre_normal_gs_ms: clinical.pre_normal_gs_ms ? parseFloat(clinical.pre_normal_gs_ms) : null,
      baseline_sppb:    clinical.baseline_sppb    ? parseFloat(clinical.baseline_sppb)    : null,
      pre_vas:          clinical.pre_vas          ? parseFloat(clinical.pre_vas)          : null,
    };
    return {
      age:                parseInt(patient.age),
      gender:             patient.gender as "M" | "F",
      falls_history:      patient.falls_history,
      walking_aid:        patient.walking_aid as FallRiskInput["walking_aid"],
      exercise_frequency: patient.exercise_frequency as FallRiskInput["exercise_frequency"],
      has_oa:             patient.has_oa ? 1 : 0,
      has_diabetes:       patient.has_diabetes ? 1 : 0,
      has_stroke:         patient.has_stroke ? 1 : 0,
      has_parkinsons:     patient.has_parkinsons ? 1 : 0,
      has_heart_disease:  patient.has_heart_disease ? 1 : 0,
      polypharmacy:       patient.polypharmacy ? 1 : 0,
      ...(patientId ? { patient_id: patientId } : {}),
      ...clinical_fields,
    };
  }

  async function submit(skipClinical: boolean) {
    setError(null);
    onLoading(true);
    try {
      const result = await predictFallRisk(buildInput(skipClinical));
      onResult(result);
    } catch {
      setError("Could not complete assessment. Please try again.");
    } finally {
      onLoading(false);
    }
  }

  const pills = (
    opts: { label: string; value: string }[],
    active: string | number,
    onSelect: (v: string) => void
  ) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn ${String(active) === o.value ? "primary" : "subtle"}`}
          style={{ fontSize: 12.5, padding: "4px 12px", height: "auto" }}
          onClick={() => onSelect(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  if (step === 1) {
    return (
      <Card title="About You" subtitle="Answer a few questions to get your personalised fall risk score">
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Field label="Age">
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                placeholder="e.g. 68"
                value={patient.age}
                onChange={(e) => setP("age", e.target.value)}
              />
            </Field>
            <Field label="Gender">
              {pills(
                [{ label: "Male", value: "M" }, { label: "Female", value: "F" }],
                patient.gender,
                (v) => setP("gender", v as "M" | "F")
              )}
            </Field>
          </div>

          <Field label="Falls in the past 12 months">
            {pills(
              [{ label: "None", value: "0" }, { label: "1", value: "1" }, { label: "2 or more", value: "2" }],
              patient.falls_history,
              (v) => setP("falls_history", parseInt(v) as 0 | 1 | 2)
            )}
          </Field>

          <Field label="Do you use a walking aid?">
            {pills(
              [
                { label: "None", value: "none" },
                { label: "Walking stick", value: "stick" },
                { label: "Frame or rollator", value: "frame" },
              ],
              patient.walking_aid,
              (v) => setP("walking_aid", v as PatientFields["walking_aid"])
            )}
          </Field>

          <Field label="How often do you exercise?">
            {pills(
              [
                { label: "Rarely", value: "rarely" },
                { label: "1–2× per week", value: "1-2" },
                { label: "3+ times per week", value: "3+" },
              ],
              patient.exercise_frequency,
              (v) => setP("exercise_frequency", v as PatientFields["exercise_frequency"])
            )}
          </Field>

          <Field label="Conditions (select all that apply)">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(
                [
                  ["has_oa", "Osteoarthritis"],
                  ["has_diabetes", "Diabetes"],
                  ["has_stroke", "Stroke"],
                  ["has_parkinsons", "Parkinson's"],
                  ["has_heart_disease", "Heart disease"],
                ] as [keyof PatientFields, string][]
              ).map(([key, label]) => (
                <label key={key} className="check" style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={patient[key] as boolean}
                    onChange={(e) => setP(key, e.target.checked as any)}
                  />
                  <span className="box" />
                  {label}
                </label>
              ))}
            </div>
          </Field>

          <Field label="Do you take 4 or more medications daily?">
            {pills(
              [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
              patient.polypharmacy === null ? "" : patient.polypharmacy ? "yes" : "no",
              (v) => setP("polypharmacy", v === "yes")
            )}
          </Field>

          {/* Optional patient ID to link wearable data */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ display: "block", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Patient ID <span style={{ fontWeight: 400 }}>(optional — links wearable data)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. PTX-001"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value.trim())}
              style={{
                width: "100%",
                padding: "7px 10px",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                background: "var(--surface-sunken)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                color: "var(--ink)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              className="btn subtle"
              style={{ flex: 1 }}
              disabled={!step1Valid()}
              onClick={() => submit(true)}
            >
              Get Result Now
            </button>
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={!step1Valid()}
              onClick={() => setStep(2)}
            >
              Add Clinical Measurements
            </button>
          </div>

          {error && (
            <div style={{ color: "var(--danger)", fontSize: 12.5, textAlign: "center" }}>
              {error}
            </div>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Clinical Measurements"
      subtitle="Optional — enter test scores for a higher-accuracy assessment"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label="Timed Up & Go (seconds)" hint="At risk >= 12s">
            <input
              className="input"
              type="number"
              step="0.1"
              placeholder="e.g. 14.2"
              value={clinical.pre_tug_s}
              onChange={(e) => setClinical((c) => ({ ...c, pre_tug_s: e.target.value }))}
            />
          </Field>
          <Field label="5x Sit-to-Stand (seconds)">
            <input
              className="input"
              type="number"
              step="0.1"
              placeholder="e.g. 16.5"
              value={clinical.pre_5xsst_s}
              onChange={(e) => setClinical((c) => ({ ...c, pre_5xsst_s: e.target.value }))}
            />
          </Field>
          <Field label="Gait Speed (m/s)" hint="At risk < 0.8 m/s">
            <input
              className="input"
              type="number"
              step="0.01"
              placeholder="e.g. 0.82"
              value={clinical.pre_normal_gs_ms}
              onChange={(e) => setClinical((c) => ({ ...c, pre_normal_gs_ms: e.target.value }))}
            />
          </Field>
          <Field label="SPPB Score (0-12)">
            <input
              className="input"
              type="number"
              min={0}
              max={12}
              placeholder="e.g. 8"
              value={clinical.baseline_sppb}
              onChange={(e) => setClinical((c) => ({ ...c, baseline_sppb: e.target.value }))}
            />
          </Field>
          <Field label="VAS Pain Score (0-10)">
            <input
              className="input"
              type="number"
              min={0}
              max={10}
              step="0.5"
              placeholder="e.g. 4"
              value={clinical.pre_vas}
              onChange={(e) => setClinical((c) => ({ ...c, pre_vas: e.target.value }))}
            />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <button className="btn subtle" style={{ flex: 1 }} onClick={() => setStep(1)}>
            Back
          </button>
          <button className="btn subtle" style={{ flex: 1 }} onClick={() => submit(true)}>
            Skip — Use My Data Only
          </button>
          <button className="btn primary" style={{ flex: 1 }} onClick={() => submit(false)}>
            Get Full Assessment
          </button>
        </div>

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12.5, textAlign: "center" }}>
            {error}
          </div>
        )}
      </div>
    </Card>
  );
}
