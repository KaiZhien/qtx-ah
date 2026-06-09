"use client";

import React from "react";
import type { InsightRow } from "@/lib/types";
import { askQuestion, downloadPatientPdf, prepareSession } from "@/lib/api";
import type { PreSessionBrief } from "@/lib/api";

interface QAPanelProps {
  sn: string;
  onAnswer: (insight: InsightRow) => void;
  onPdfDownload: () => void;
}

export function QAPanel({ sn, onAnswer, onPdfDownload }: QAPanelProps) {
  const [question, setQuestion] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [prepLoading, setPrepLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [brief, setBrief] = React.useState<PreSessionBrief | null>(null);

  async function handlePrepareSession(force?: boolean) {
    setPrepLoading(true);
    setError(null);
    try {
      const result = await prepareSession(sn, force);
      setBrief(result);
    } catch {
      setError("Could not generate pre-session brief — please try again.");
    } finally {
      setPrepLoading(false);
    }
  }

  async function handleAsk(overrideQuestion?: string) {
    const q = (overrideQuestion ?? question).trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const { answer, model } = await askQuestion(sn, q);
      const insight: InsightRow = {
        id: `local-${Date.now()}`,
        session_number: null,
        insight_type: "qa_response",
        question: q,
        content: answer,
        model,
        created_at: new Date().toISOString(),
      };
      onAnswer(insight);
      setQuestion("");
    } catch {
      setError("Could not get an answer — please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleAsk();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        className="btn"
        onClick={() => handlePrepareSession()}
        disabled={prepLoading || loading}
      >
        {prepLoading ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 12,
                height: 12,
                border: "2px solid currentColor",
                borderTopColor: "transparent",
                borderRadius: "50%",
                display: "inline-block",
                animation: "spin 0.7s linear infinite",
              }}
            />
            Preparing...
          </span>
        ) : (
          "Prepare session"
        )}
      </button>

      {brief && (
        <div
          style={{
            borderLeft: "3px solid #0ea5e9",
            background: "rgba(14,165,233,0.06)",
            borderRadius: "0 6px 6px 0",
            padding: "10px 14px",
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--ink)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 12, color: "#0ea5e9", letterSpacing: "0.04em" }}>
              PRE-SESSION BRIEF
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {brief.cached && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    color: "#64748b",
                    background: "rgba(100,116,139,0.12)",
                    borderRadius: 4,
                    padding: "1px 6px",
                  }}
                >
                  CACHED
                </span>
              )}
              <button
                onClick={() => handlePrepareSession(true)}
                disabled={prepLoading}
                style={{
                  fontSize: 11,
                  color: "#0ea5e9",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                Refresh
              </button>
            </div>
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{brief.brief}</div>
        </div>
      )}

      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder="Ask a clinical question about this patient..."
        disabled={loading}
        style={{
          resize: "vertical",
          fontSize: 13,
          padding: "8px 10px",
          borderRadius: 6,
          border: "1px solid var(--line-strong)",
          background: "var(--surface)",
          color: "var(--ink)",
          fontFamily: "inherit",
          width: "100%",
          boxSizing: "border-box",
        }}
      />

      {error && (
        <div
          style={{
            fontSize: 12,
            color: "var(--danger)",
            padding: "6px 10px",
            background: "var(--danger-soft, rgba(252,129,129,0.1))",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <button
        className="btn primary"
        onClick={() => handleAsk()}
        disabled={loading || !question.trim()}
      >
        {loading ? "Asking..." : "Ask"}
      </button>

      <button
        className="btn"
        onClick={() => { onPdfDownload(); downloadPatientPdf(sn); }}
        style={{ marginTop: 4 }}
      >
        Download PDF
      </button>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
