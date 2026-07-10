"use client";
import React from "react";
import type { InsightRow, AnomalyWarning, BenchmarkResult } from "@/lib/types";
import { fetchInsights, fetchLatestPredictions, fetchBenchmark, fetchLatestAnomaly } from "@/lib/api";
import type { LatestPredictions } from "@/lib/types";
import { InsightCard } from "./InsightCard";
import { QAPanel } from "./QAPanel";
import { PredictionChips } from "./PredictionChips";
import { AnomalyWarningCard } from "./AnomalyWarningCard";
import { BenchmarkCard } from "./BenchmarkCard";

interface AITabProps { sn: string; }

export function AITab({ sn }: AITabProps) {
  const [insights, setInsights] = React.useState<InsightRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [predictions, setPredictions] = React.useState<LatestPredictions | null>(null);
  const [benchmark, setBenchmark] = React.useState<BenchmarkResult | null>(null);
  const [anomaly, setAnomaly] = React.useState<AnomalyWarning | null>(null);

  React.useEffect(() => {
    setLoading(true); setError(null);
    Promise.all([fetchInsights(sn), fetchLatestPredictions(sn), fetchBenchmark(sn), fetchLatestAnomaly(sn)])
      .then(([ins, preds, bench, anom]) => { setInsights(ins); setPredictions(preds); setBenchmark(bench); setAnomaly(anom); })
      .catch(() => setError("Could not load insights."))
      .finally(() => setLoading(false));
  }, [sn]);

  function handleAnswer(insight: InsightRow) { setInsights((prev) => [insight, ...prev]); }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <AnomalyWarningCard warning={anomaly} />
      {predictions && (
        <div>
          <div className="filter-label" style={{ marginBottom: 8 }}>Model signals</div>
          <PredictionChips predictions={predictions} cohortPercentile={benchmark?.cohort_percentile ?? null} />
        </div>
      )}
      <BenchmarkCard data={benchmark} />
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>Ask a Question</div>
        <QAPanel sn={sn} onAnswer={handleAnswer} onPdfDownload={() => {}} />
      </div>
      <div>
        <div className="filter-label" style={{ marginBottom: 10 }}>Insight History ({loading ? "…" : insights.length})</div>
        {loading && <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Loading…</div>}
        {error && !loading && <div style={{ fontSize: 12.5, color: "var(--danger)", padding: "8px 12px", background: "var(--danger-soft, rgba(252,129,129,0.1))", borderRadius: 6 }}>{error}</div>}
        {!loading && !error && insights.length === 0 && <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>No insights yet. Ask a question above.</div>}
        {!loading && insights.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {insights.map((ins) => <InsightCard key={ins.id} insight={ins} />)}
          </div>
        )}
      </div>
    </div>
  );
}
