"use client";

import React from "react";
import type { InsightRow } from "@/lib/types";

interface InsightCardProps {
  insight: InsightRow;
}

function _shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export function InsightCard({ insight }: InsightCardProps) {
  const isQA = insight.insight_type === "qa_response";
  const headerLeft = isQA
    ? "Q&A"
    : `Session ${insight.session_number ?? "?"}`;
  const date = _shortDate(insight.created_at);
  const showModel = insight.model && insight.model !== "stub";

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
          {headerLeft}
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-4)" }}>{date}</span>
      </div>

      {/* Question (Q&A only) */}
      {isQA && insight.question && (
        <div
          style={{
            fontSize: 12,
            fontStyle: "italic",
            color: "var(--ink-3)",
            borderLeft: "2px solid var(--line-strong)",
            paddingLeft: 8,
          }}
        >
          {insight.question}
        </div>
      )}

      {/* Content */}
      <div
        style={{
          fontSize: 12.5,
          color: "var(--ink)",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
        }}
      >
        {insight.content}
      </div>

      {/* Model footer */}
      {showModel && (
        <div
          style={{
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--ink-4)",
            marginTop: 2,
          }}
        >
          {insight.model}
        </div>
      )}
    </div>
  );
}
