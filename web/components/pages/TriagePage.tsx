"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  Patient,
  TriageItem,
  TriageResponse,
} from "@/lib/types";
import { fetchTriage } from "@/lib/api";

export interface TriagePageProps {
  patients: Patient[];                    // the full loaded cohort (App's allData)
  onPatientSelect: (p: Patient) => void;  // App's openDrawer
}

// Human labels for the `post_*` metric keys carried by declining trends.
// Unmapped metrics fall back to the raw key rather than crashing.
const METRIC_LABELS: Record<string, string> = {
  post_vas: "VAS",
  post_tug_s: "TUG",
  post_5xsst_s: "5×SST",
  post_normal_gs_ms: "Gait speed",
  post_fast_gs_ms: "Fast gait",
  post_sppb: "SPPB",
};

function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

// Explicit +/- sign, 2 decimals (e.g. +0.20, -0.35).
function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

// The full anomaly text lives in the drawer's AI tab; truncate here.
function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// "s#4 · 2026-07-10", degrading gracefully when either part is null.
function lastSeen(item: TriageItem): string {
  const parts: string[] = [];
  if (item.last_session_number != null) parts.push(`s#${item.last_session_number}`);
  if (item.last_session_date != null) parts.push(item.last_session_date);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

const badgeBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 500,
  lineHeight: 1.4,
  maxWidth: 340,
  whiteSpace: "normal",
};

// Red — an active anomaly on the patient's latest session.
const anomalyStyle: React.CSSProperties = {
  ...badgeBase,
  background: "var(--danger-soft)",
  color: "var(--danger)",
};
// Amber — a declining metric trend (dark amber text matches .pill.warning).
const trendStyle: React.CSSProperties = {
  ...badgeBase,
  background: "var(--warning-soft)",
  color: "oklch(0.42 0.13 75)",
};
// Blue/purple — model prediction diverged from the observed outcome.
const divergenceStyle: React.CSSProperties = {
  ...badgeBase,
  background: "var(--accent-soft)",
  color: "var(--accent)",
};

function SignalBadges({ item }: { item: TriageItem }) {
  const { anomaly, declining_trends, divergence } = item.signals;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {anomaly && (
        <span style={anomalyStyle} title={anomaly.content}>
          ⚠ {truncate(anomaly.content)}
        </span>
      )}
      {declining_trends.map((t, i) => (
        <span key={`${t.metric}-${i}`} style={trendStyle}>
          ↓ {metricLabel(t.metric)}
        </span>
      ))}
      {divergence && (
        <span style={divergenceStyle}>
          Δ predicted {signed(divergence.predicted)} → actual {signed(divergence.actual)}
        </span>
      )}
    </div>
  );
}

export function TriagePage({ patients, onPatientSelect }: TriagePageProps) {
  const [data, setData] = useState<TriageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const cancelledRef = useRef(false);

  const load = useCallback(() => {
    cancelledRef.current = false;
    setLoading(true);
    setError(false);
    fetchTriage()
      .then((res) => {
        if (cancelledRef.current) return;
        setData(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelledRef.current) return;
        setError(true);
        setLoading(false);
      });
  }, []);

  // Fetch on mount (== on workspace open, since App mounts/unmounts on nav).
  useEffect(() => {
    load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  if (loading) {
    return (
      <div className="content fade-in" style={{ padding: 28, color: "var(--ink-3)" }}>
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="content fade-in" style={{ padding: 28 }}>
        <div role="alert" style={{ color: "var(--danger)", marginBottom: 12 }}>
          Could not load the triage worklist. Please retry.
        </div>
        <button className="btn" onClick={() => load()}>
          Retry
        </button>
      </div>
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="content fade-in">
      <div style={{ padding: "4px 0 14px", fontSize: 14, color: "var(--ink-2)" }}>
        {total > 0 ? `${total} patients need attention` : "No patients need attention"}
      </div>

      {items.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Signals</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              // Resolve against the loaded cohort; only clickable when found.
              const patient = patients.find((p) => p.sn === item.sn);
              return (
                <tr
                  key={item.sn}
                  className={patient ? "clickable" : ""}
                  onClick={patient ? () => onPatientSelect(patient) : undefined}
                >
                  <td>
                    <div style={{ fontWeight: 500, color: "var(--ink)" }}>
                      {item.name || item.sn}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 11.5, color: "var(--ink-3)" }}
                    >
                      {item.sn}
                    </div>
                  </td>
                  <td>
                    <SignalBadges item={item} />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                    {lastSeen(item)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
