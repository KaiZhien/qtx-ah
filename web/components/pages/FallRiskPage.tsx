"use client";

import React, { useState } from "react";
import type { FallRiskResult } from "@/lib/types";
import { FallRiskForm } from "@/components/fall-risk/FallRiskForm";
import { FallRiskResults } from "@/components/fall-risk/FallRiskResults";

function Skeleton({ w = "100%", h = 14, radius = 6, style }: { w?: string | number; h?: number; radius?: number; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        background: "var(--surface-2)",
        backgroundImage:
          "linear-gradient(90deg, var(--surface-2) 0%, var(--line) 40%, var(--surface-2) 80%)",
        backgroundSize: "200% 100%",
        animation: "shimmer 1.4s ease-in-out infinite",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

function FallRiskSkeleton() {
  const card: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius)",
    padding: "var(--pad-card)",
    boxShadow: "var(--shadow-2)",
  };
  return (
    <>
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Score card skeleton */}
        <div style={card}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "20px 0 16px" }}>
            <Skeleton w={80} h={11} />
            <Skeleton w={72} h={52} radius={8} />
            <Skeleton w={100} h={20} radius={20} />
            <div style={{ width: "100%", maxWidth: 280, display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
              <Skeleton w="100%" h={8} radius={4} />
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 280 }}>
                <Skeleton w={24} h={10} />
                <Skeleton w={52} h={10} />
                <Skeleton w={24} h={10} />
              </div>
            </div>
            <Skeleton w={220} h={11} />
          </div>
        </div>

        {/* Factors card skeleton */}
        <div style={card}>
          <Skeleton w={110} h={13} style={{ marginBottom: 14 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  background: "var(--surface-2)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <Skeleton w="55%" h={13} />
                  <Skeleton w="85%" h={11} />
                </div>
                <Skeleton w={72} h={11} />
              </div>
            ))}
          </div>
        </div>

        {/* CTA card skeleton */}
        <div style={card}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
            <Skeleton w={160} h={13} />
            <Skeleton w="100%" h={11} />
            <Skeleton w="75%" h={11} />
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <Skeleton w="50%" h={34} radius={6} />
              <Skeleton w="50%" h={34} radius={6} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

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
      </div>

      <div>
        {result ? (
          <FallRiskResults result={result} onReset={() => setResult(null)} />
        ) : loading ? (
          <FallRiskSkeleton />
        ) : (
          <div
            style={{
              padding: 20,
              background: "var(--surface-sunken)",
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
