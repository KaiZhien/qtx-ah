"use client";

import React from "react";
import type { InsightRow } from "@/lib/types";
import { askQuestion, downloadPatientPdf } from "@/lib/api";

const PREPARE_SESSION_PROMPT =
  "Summarise this patient's last session, highlight any metrics that crossed a clinical threshold, and list what I should prepare or watch for in today's session.";

interface QAPanelProps {
  sn: string;
  onAnswer: (insight: InsightRow) => void;
  onPdfDownload: () => void;
}

export function QAPanel({ sn, onAnswer, onPdfDownload }: QAPanelProps) {
  const [question, setQuestion] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
        onClick={() => handleAsk(PREPARE_SESSION_PROMPT)}
        disabled={loading}
      >
        Prepare session
      </button>

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
        onClick={handleAsk}
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
    </div>
  );
}
