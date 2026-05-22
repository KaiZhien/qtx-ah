"use client";

import React, { useState } from "react";
import type { FallRiskResult } from "@/lib/types";
import { FallRiskForm } from "@/components/fall-risk/FallRiskForm";
import { FallRiskResults } from "@/components/fall-risk/FallRiskResults";

export function FallRiskPage() {
  const [result, setResult] = useState<FallRiskResult | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="grid-12-7-5" style={{ alignItems: "start" }}>
      <div>
        {!result ? (
          <FallRiskForm onResult={setResult} onLoading={setLoading} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                padding: "10px 14px",
                background: "var(--accent-soft)",
                borderRadius: 6,
                fontSize: 12.5,
                color: "var(--accent)",
                borderLeft: "3px solid var(--accent)",
              }}
            >
              Assessment complete. Your results are shown on the right.
            </div>
            <button
              className="btn subtle"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setResult(null)}
            >
              Start new assessment
            </button>
          </div>
        )}

        {loading && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 14px",
              fontSize: 12.5,
              color: "var(--ink-3)",
            }}
          >
            Calculating your fall risk...
          </div>
        )}
      </div>

      <div>
        {result ? (
          <FallRiskResults result={result} onReset={() => setResult(null)} />
        ) : (
          <div
            style={{
              padding: 20,
              background: "var(--sunken, var(--surface-2))",
              borderRadius: 8,
              fontSize: 13,
              color: "var(--ink-3)",
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 500, color: "var(--ink-2)", marginBottom: 8 }}>
              Your personalised fall risk score
            </div>
            Complete the form on the left to see your risk score, the key factors driving
            it, and how the QuantumTX programme can help.
          </div>
        )}
      </div>
    </div>
  );
}
