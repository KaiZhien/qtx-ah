"use client";
import React, { useEffect, useState } from "react";
import { fetchCalibration } from "@/lib/api";
import type { CalibrationReport, CohortCalibration, ModelAucDrift } from "@/lib/types";
import { formatRelative } from "@/components/clinical/PredictionChips";
import { Card } from "@/components/ui/Card";

type StatusKey = CohortCalibration["status"];

const STATUS_PILL: Record<StatusKey, React.CSSProperties> = {
  OK: {
    background: "rgba(34,197,94,0.12)",
    color: "#16a34a",
  },
  WARNING: {
    background: "var(--warning-soft, rgba(251,191,36,0.12))",
    color: "#d97706",
  },
  ALERT: {
    background: "rgba(239,68,68,0.12)",
    color: "#dc2626",
  },
  NO_BASELINE: {
    background: "var(--surface-2, rgba(0,0,0,0.05))",
    color: "var(--ink-4)",
  },
};

function pillStyle(status: StatusKey): React.CSSProperties {
  return {
    ...STATUS_PILL[status],
    display: "inline-block",
    padding: "2px 7px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: "16px",
  };
}

function buildSummary(cohorts: CohortCalibration[]): string {
  const counts: Partial<Record<StatusKey, number>> = {};
  for (const c of cohorts) {
    counts[c.status] = (counts[c.status] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (counts.OK) parts.push(`${counts.OK} OK`);
  if (counts.WARNING) parts.push(`${counts.WARNING} WARNING`);
  if (counts.ALERT) parts.push(`${counts.ALERT} ALERT`);
  return parts.join(" · ");
}

export function ModelHealthCard() {
  const [report, setReport] = useState<CalibrationReport | null | undefined>(undefined);

  useEffect(() => {
    fetchCalibration()
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  // Loading
  if (report === undefined) {
    return (
      <Card>
        <div style={{ padding: "18px 22px", fontSize: 13, color: "var(--ink-4)" }}>
          Loading model health...
        </div>
      </Card>
    );
  }

  // Error — silently absent
  if (report === null) {
    return null;
  }

  // No baseline
  const allNoBaseline =
    report.cohorts.length === 0 ||
    report.cohorts.every((c) => c.status === "NO_BASELINE");

  if (allNoBaseline) {
    return (
      <Card title="Model Calibration">
        <div style={{ padding: "10px 0 6px", fontSize: 13, color: "var(--ink-4)" }}>
          No calibration baseline yet. Run a retrain to establish one.
        </div>
      </Card>
    );
  }

  const summary = buildSummary(report.cohorts);

  const thStyle: React.CSSProperties = {
    textAlign: "left",
    fontWeight: 500,
    fontSize: 11.5,
    color: "var(--ink-4)",
    padding: "0 10px 8px 0",
    borderBottom: "1px solid var(--line)",
    whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = {
    padding: "7px 10px 7px 0",
    fontSize: 12.5,
    color: "var(--ink-2)",
    borderBottom: "1px solid var(--line-soft, rgba(0,0,0,0.06))",
    verticalAlign: "middle",
  };

  const tdMono: React.CSSProperties = {
    ...tdStyle,
    fontVariantNumeric: "tabular-nums",
    color: "var(--ink-3)",
  };

  return (
    <Card
      title="Model Calibration"
      action={
        summary ? (
          <span style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 400 }}>
            {summary}
          </span>
        ) : undefined
      }
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Cohort</th>
              <th style={{ ...thStyle, textAlign: "right" }}>n</th>
              <th style={{ ...thStyle, textAlign: "right" }}>MAE</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Baseline</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Drift</th>
              <th style={{ ...thStyle }}> </th>
            </tr>
          </thead>
          <tbody>
            {report.cohorts.map((c) => {
              const driftStr =
                c.drift_pct !== null
                  ? `${c.drift_pct >= 0 ? "+" : ""}${c.drift_pct.toFixed(1)}%`
                  : "—";
              return (
                <tr key={c.cohort}>
                  <td style={{ ...tdStyle, color: "var(--ink-1)", fontWeight: 500 }}>{c.cohort}</td>
                  <td style={{ ...tdMono, textAlign: "right" }}>{c.n.toLocaleString()}</td>
                  <td style={{ ...tdMono, textAlign: "right" }}>{c.current_mae.toFixed(3)}</td>
                  <td style={{ ...tdMono, textAlign: "right" }}>
                    {c.baseline_mae !== null ? c.baseline_mae.toFixed(3) : "—"}
                  </td>
                  <td style={{ ...tdMono, textAlign: "right" }}>{driftStr}</td>
                  <td style={{ ...tdStyle }}>
                    <span style={pillStyle(c.status)}>{c.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {report.model_auc_drift && report.model_auc_drift.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)", marginBottom: 8, letterSpacing: "0.03em", textTransform: "uppercase" }}>
            Classifier AUC Drift
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Model</th>
                <th style={{ ...thStyle, textAlign: "right" }}>n</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Current AUC</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Baseline</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Drift</th>
                <th style={{ ...thStyle }}> </th>
              </tr>
            </thead>
            <tbody>
              {report.model_auc_drift.map((row: ModelAucDrift) => {
                const friendlyName =
                  row.model === "classifier" ? "Responder Classifier" : "Dropout Predictor";
                const driftStr =
                  row.drift_pct !== null
                    ? `${row.drift_pct >= 0 ? "+" : ""}${row.drift_pct.toFixed(1)}%`
                    : "—";
                return (
                  <tr key={row.model}>
                    <td style={{ ...tdStyle, color: "var(--ink-1)", fontWeight: 500 }}>{friendlyName}</td>
                    <td style={{ ...tdMono, textAlign: "right" }}>{row.n > 0 ? row.n.toLocaleString() : "—"}</td>
                    <td style={{ ...tdMono, textAlign: "right" }}>
                      {row.current_auc !== null ? row.current_auc.toFixed(3) : "—"}
                    </td>
                    <td style={{ ...tdMono, textAlign: "right" }}>
                      {row.baseline_auc !== null ? row.baseline_auc.toFixed(3) : "—"}
                    </td>
                    <td style={{ ...tdMono, textAlign: "right" }}>{driftStr}</td>
                    <td style={{ ...tdStyle }}>
                      <span style={pillStyle(row.status)}>{row.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 10,
          fontSize: 11,
          color: "var(--ink-4)",
        }}
      >
        <span>Updated {formatRelative(report.generated_at)}</span>
        <span>{report.total_matchable.toLocaleString()} matchable sessions</span>
      </div>
    </Card>
  );
}
