"use client";

import React from "react";
import type { TimelineResponse, InsightRow } from "@/lib/types";
import { fetchTimeline, fetchInsights } from "@/lib/api";
import { MetricChart } from "./MetricChart";
import { InsightCard } from "./InsightCard";
import { QAPanel } from "./QAPanel";

interface TimelineTabProps {
  sn: string;
}

const METRIC_DEFS = [
  { key: "post_vas",          label: "Pain (VAS)",          lowerIsBetter: true  },
  { key: "post_tug_s",        label: "Mobility (TUG s)",    lowerIsBetter: true  },
  { key: "post_5xsst_s",      label: "Sit-Stand (5xSST s)", lowerIsBetter: true  },
  { key: "post_normal_gs_ms", label: "Gait Speed (m/s)",    lowerIsBetter: false },
  { key: "post_sppb",         label: "Balance (SPPB)",      lowerIsBetter: false },
] as const;

type MetricKey = typeof METRIC_DEFS[number]["key"];

export function TimelineTab({ sn }: TimelineTabProps) {
  const [timeline, setTimeline] = React.useState<TimelineResponse | null>(null);
  const [insights, setInsights] = React.useState<InsightRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([fetchTimeline(sn), fetchInsights(sn)])
      .then(([tl, ins]) => {
        setTimeline(tl);
        setInsights(ins);
      })
      .catch(() => setError("Could not load timeline data."))
      .finally(() => setLoading(false));
  }

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sn]);

  function handleAnswer(insight: InsightRow) {
    setInsights((prev) => [insight, ...prev]);
  }

  if (loading) {
    return (
      <div style={{ padding: "32px 0", textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
        Loading timeline...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--danger)",
            padding: "8px 12px",
            background: "var(--danger-soft, rgba(252,129,129,0.1))",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
        <button className="btn" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  const sessions = timeline?.sessions ?? [];
  const trends = timeline?.trends ?? [];

  const metricSeries = METRIC_DEFS.map((def) => {
    const pts = sessions
      .filter((s) => s[def.key as MetricKey] != null)
      .map((s) => ({ session_number: s.session_number, value: s[def.key as MetricKey] as number }));
    const trend = trends.find((t) => t.metric === def.key);
    return { ...def, pts, direction: trend?.direction ?? "baseline_only" };
  }).filter((m) => m.pts.length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Section 1: Metric Charts */}
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>
          Progress Charts
        </div>
        {metricSeries.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-4)", padding: "12px 0" }}>
            No session data yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {metricSeries.map((m) => (
              <MetricChart
                key={m.key}
                label={m.label}
                sessions={m.pts}
                direction={m.direction}
                lowerIsBetter={m.lowerIsBetter}
              />
            ))}
          </div>
        )}
      </div>

      {/* Section 2: Insight Cards */}
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>
          AI Insights ({insights.length})
        </div>
        {insights.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>
            No insights yet. Add a session or ask a question below.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {insights.map((ins) => (
              <InsightCard key={ins.id} insight={ins} />
            ))}
          </div>
        )}
      </div>

      {/* Section 3: Q&A Panel */}
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>
          Ask a Question
        </div>
        <QAPanel sn={sn} onAnswer={handleAnswer} onPdfDownload={() => {}} />
      </div>
    </div>
  );
}
