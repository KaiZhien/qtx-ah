"use client";
import React from "react";

interface PlanCardProps {
  plan: string;
  generatedAt: string;
  onGenerate?: () => void;
  loading?: boolean;
}

export function PlanCard({ plan, generatedAt, onGenerate, loading }: PlanCardProps) {
  const lines = plan.split("\n");
  const dt = new Date(generatedAt).toLocaleString();

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "16px 20px", background: "var(--surface)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Generated {dt}</span>
        {onGenerate && (
          <button
            onClick={onGenerate}
            disabled={loading}
            style={{
              fontSize: 12, padding: "4px 10px", borderRadius: 5,
              border: "1px solid var(--border)", background: "transparent",
              cursor: loading ? "not-allowed" : "pointer", color: "var(--ink-2)",
            }}
          >
            {loading ? "Generating…" : "Regenerate Plan"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {lines.map((line, i) => {
          if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
          const isBold = line.startsWith("**") && line.endsWith("**");
          if (isBold) {
            return (
              <div key={i} style={{ fontWeight: 600, fontSize: 13, color: "var(--ink-1)", marginTop: 8 }}>
                {line.replace(/^\*\*|\*\*$/g, "")}
              </div>
            );
          }
          if (line.startsWith("- ")) {
            return (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--ink-2)", paddingLeft: 4 }}>
                <span style={{ color: "var(--ink-4)", flexShrink: 0 }}>•</span>
                <span>{line.slice(2)}</span>
              </div>
            );
          }
          return <div key={i} style={{ fontSize: 13, color: "var(--ink-2)" }}>{line}</div>;
        })}
      </div>
    </div>
  );
}
