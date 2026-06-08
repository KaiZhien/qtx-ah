"use client";

import React from "react";
import type { InsightRow, AnomalyWarning } from "@/lib/types";
import { fetchInsights, fetchLatestPredictions, fetchBenchmark, fetchLatestAnomaly, type LatestPredictions } from "@/lib/api";
import { InsightCard } from "./InsightCard";
import { QAPanel } from "./QAPanel";
import { PredictionChips } from "./PredictionChips";
import { AnomalyWarningCard } from "./AnomalyWarningCard";

interface AITabProps {
  sn: string;
}

export function AITab({ sn }: AITabProps) {
  const [insights, setInsights] = React.useState<InsightRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [predictions, setPredictions] = React.useState<LatestPredictions | null>(null);
  const [cohortPercentile, setCohortPercentile] = React.useState<number | null>(null);
  const [anomaly, setAnomaly] = React.useState<AnomalyWarning | null>(null);

  React.useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchInsights(sn),
      fetchLatestPredictions(sn),
      fetchBenchmark(sn),
      fetchLatestAnomaly(sn),
    ])
      .then(([ins, preds, bench, anom]) => {
        setInsights(ins);
        setPredictions(preds);
        setCohortPercentile(bench?.cohort_percentile ?? null);
        setAnomaly(anom);
      })
      .catch(() => setError("Could not load insights."))
      .finally(() => setLoading(false));
  }, [sn]);

  function handleAnswer(insight: InsightRow) {
    setInsights((prev) => [insight, ...prev]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Anomaly warning */}
      <AnomalyWarningCard warning={anomaly} />

      {/* Model signals */}
      {predictions && (
        <div>
          <div className="filter-label" style={{ marginBottom: 8 }}>
            Model signals
          </div>
          <PredictionChips predictions={predictions} cohortPercentile={cohortPercentile} />
        </div>
      )}

      {/* Q&A */}
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>
          Ask a Question
        </div>
        <QAPanel sn={sn} onAnswer={handleAnswer} onPdfDownload={() => {}} />
      </div>

      {/* Saved insights */}
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>
          Insight History ({loading ? "…" : insights.length})
        </div>

        {loading && (
          <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Loading…</div>
        )}

        {error && !loading && (
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
        )}

        {!loading && !error && insights.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>
            No insights yet. Ask a question above.
          </div>
        )}

        {!loading && insights.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {insights.map((ins) => (
              <InsightCard key={ins.id} insight={ins} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
