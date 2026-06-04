"use client";

import React from "react";
import type { LatestPredictions } from "@/lib/api";

interface PredictionChipsProps {
  predictions: LatestPredictions;
}

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v * 100)}%`;
}

function signed(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 9px",
  borderRadius: 20,
  fontSize: 11.5,
  fontWeight: 500,
  background: "var(--surface-2, rgba(0,0,0,0.05))",
  color: "var(--ink-2)",
  border: "1px solid var(--line)",
  whiteSpace: "nowrap",
};

const labelStyle: React.CSSProperties = {
  color: "var(--ink-4)",
  fontWeight: 400,
};

const warnChip: React.CSSProperties = {
  ...chipStyle,
  background: "var(--warning-soft, rgba(251,191,36,0.12))",
  borderColor: "rgba(251,191,36,0.3)",
  color: "var(--ink-1)",
};

export function PredictionChips({ predictions }: PredictionChipsProps) {
  const { predicted_composite_improvement, responder_probability, dropout_probability, dosage_recommendation } = predictions;

  const dropoutHigh = dropout_probability !== null && dropout_probability > 0.5;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {predicted_composite_improvement !== null && (
        <span style={chipStyle}>
          <span style={labelStyle}>Predicted improvement</span>
          {signed(predicted_composite_improvement)}
        </span>
      )}
      {responder_probability !== null && (
        <span style={chipStyle}>
          <span style={labelStyle}>Responder</span>
          {pct(responder_probability)}
        </span>
      )}
      {dropout_probability !== null && (
        <span style={dropoutHigh ? warnChip : chipStyle}>
          <span style={labelStyle}>Dropout risk</span>
          {dropoutHigh ? `HIGH (${pct(dropout_probability)})` : `LOW (${pct(dropout_probability)})`}
        </span>
      )}
      {dosage_recommendation && (
        <span style={chipStyle}>
          <span style={labelStyle}>Dosage</span>
          {dosage_recommendation}
        </span>
      )}
    </div>
  );
}
