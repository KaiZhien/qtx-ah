"use client";

import React from "react";
import type { AnomalyWarning } from "@/lib/types";

interface AnomalyWarningCardProps {
  warning: AnomalyWarning | null;
}

export function AnomalyWarningCard({ warning }: AnomalyWarningCardProps) {
  if (warning === null) return null;

  return (
    <div
      style={{
        borderLeft: "3px solid rgba(251,191,36,0.8)",
        borderTop: "1px solid var(--line)",
        borderRight: "1px solid var(--line)",
        borderBottom: "1px solid var(--line)",
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: "var(--warning-soft, rgba(251,191,36,0.12))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          fontWeight: 600,
          color: "rgba(180,120,0,1)",
        }}
      >
        <span>⚠</span>
        <span>
          Clinical Alert — Session {warning.session_number ?? "?"}
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--ink-2)",
          lineHeight: 1.5,
        }}
      >
        {warning.content}
      </div>
    </div>
  );
}
