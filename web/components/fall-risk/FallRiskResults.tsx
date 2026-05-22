// web/components/fall-risk/FallRiskResults.tsx
"use client";

import React from "react";
import type { FallRiskResult } from "@/lib/types";
import { Card } from "@/components/ui/Card";

interface Props {
  result: FallRiskResult;
  onReset: () => void;
}

const LABEL_CONFIG: Record<
  FallRiskResult["risk_label"],
  { color: string; bg: string; text: string }
> = {
  low:      { color: "var(--success)",  bg: "var(--success-soft,rgba(104,211,145,0.12))",  text: "LOW RISK"      },
  moderate: { color: "var(--warning)",  bg: "var(--warning-soft,rgba(246,173,85,0.12))",   text: "MODERATE RISK" },
  elevated: { color: "var(--warning)",  bg: "var(--warning-soft,rgba(246,173,85,0.12))",   text: "ELEVATED RISK" },
  high:     { color: "var(--danger)",   bg: "var(--danger-soft,rgba(252,129,129,0.12))",   text: "HIGH RISK"     },
};

export function FallRiskResults({ result, onReset }: Props) {
  const cfg = LABEL_CONFIG[result.risk_label];
  const pct = result.risk_score;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Score card */}
      <Card>
        <div style={{ textAlign: "center", padding: "20px 0 16px" }}>
          <div
            className="label"
            style={{ marginBottom: 8, color: "var(--ink-3)" }}
          >
            Your Fall Risk Score
          </div>
          <div
            className="mono"
            style={{ fontSize: 52, fontWeight: 700, color: cfg.color, lineHeight: 1 }}
          >
            {pct}
          </div>
          <div
            style={{
              display: "inline-block",
              marginTop: 6,
              padding: "2px 10px",
              borderRadius: 20,
              background: cfg.bg,
              color: cfg.color,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
            }}
          >
            {cfg.text}
          </div>

          {/* Progress bar */}
          <div
            style={{
              margin: "14px auto 0",
              maxWidth: 280,
              height: 8,
              background: "var(--surface-2, var(--sunken))",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background:
                  "linear-gradient(90deg, var(--success) 0%, var(--warning) 55%, var(--danger) 100%)",
                borderRadius: 4,
                transition: "width 600ms ease",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              maxWidth: 280,
              margin: "4px auto 0",
              fontSize: 10,
              color: "var(--ink-4)",
            }}
          >
            <span>Low</span>
            <span>Moderate</span>
            <span>High</span>
          </div>

          <div
            style={{ marginTop: 10, fontSize: 11, color: "var(--ink-4)" }}
          >
            {result.confidence === "high"
              ? "High-confidence estimate (clinical data included)"
              : "Standard estimate (add clinical measurements for higher accuracy)"}
          </div>
        </div>
      </Card>

      {/* Factors card */}
      <Card title="Key Risk Factors">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {result.top_factors.map((f, i) => (
            <div
              key={i}
              style={{
                background: "var(--sunken, var(--surface-2))",
                borderRadius: 6,
                padding: "10px 12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
                  {f.label}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.4 }}>
                  {f.explanation}
                </div>
              </div>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  color: f.impact === "high" ? "var(--danger)" : "var(--warning)",
                  flexShrink: 0,
                }}
              >
                {f.impact === "high" ? "High impact" : "Moderate impact"}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* CTA card */}
      <Card>
        <div style={{ padding: "4px 0" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--accent)",
              marginBottom: 6,
            }}
          >
            How QuantumTX Can Help
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--ink-2)",
              lineHeight: 1.55,
              marginBottom: 14,
            }}
          >
            {result.cohort_stat.cohort_size > 0 ? (
              <>
                Among patients with a similar profile in the Alexandra Hospital programme,{" "}
                <strong style={{ color: "var(--success)" }}>
                  {result.cohort_stat.improvement_pct}%
                </strong>{" "}
                achieved meaningful functional improvement. The magnetic-mitohormesis
                therapy directly targets the mobility and strength deficits that drive fall
                risk.
              </>
            ) : (
              <>
                Patients who completed the Alexandra Hospital programme showed significant
                improvements in gait speed, balance, and lower-limb strength — the key
                drivers of fall risk.
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn primary" style={{ flex: 1 }}>
              Learn About the Programme
            </button>
            <button className="btn" style={{ flex: 1 }}>
              Book a Consultation
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
