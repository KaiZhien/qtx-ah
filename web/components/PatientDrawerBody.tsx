"use client";

import React from "react";
import type { Patient } from "@/lib/types";
import { COHORT_COLORS, TESTS, FLAG_LABELS } from "@/lib/constants";
import { Pill } from "@/components/ui/Pill";

interface PatientDrawerBodyProps {
  patient: Patient | null;
}

function CompositeBar({ value }: { value: number }) {
  const v = Math.max(-2, Math.min(2, value));
  const pct = ((v + 2) / 4) * 100;
  const zeroPct = 50;
  const col = v >= 0 ? "var(--success)" : "var(--danger)";
  return (
    <div>
      <div
        style={{
          position: "relative",
          height: 28,
          background: "var(--surface-sunken)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${zeroPct}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: "var(--line-strong)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 4,
            bottom: 4,
            left: v >= 0 ? `${zeroPct}%` : `${pct}%`,
            width: `${Math.abs(pct - zeroPct)}%`,
            background: col,
            opacity: 0.85,
            borderRadius: 3,
            transition: "width 700ms cubic-bezier(0.2,0.7,0.2,1)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "50%",
            transform: "translateY(-50%)",
            left: `${pct}%`,
            marginLeft: v >= 0 ? 8 : -56,
            width: 48,
            textAlign: v >= 0 ? "left" : "right",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--ink)",
            fontWeight: 500,
          }}
        >
          {v >= 0 ? "+" : ""}
          {value.toFixed(2)}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--ink-4)",
          marginTop: 6,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>−2</span>
        <span>cohort mean (0)</span>
        <span>+2</span>
      </div>
    </div>
  );
}

export function PatientDrawerBody({ patient }: PatientDrawerBodyProps) {
  if (!patient) return null;

  const activeFlags = Object.keys(FLAG_LABELS).filter(
    (f) => (patient as Record<string, unknown>)[f] === 1
  );

  const cohortColor = COHORT_COLORS[patient.cohort] || "#888";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 8,
            background: cohortColor + "22",
            color: cohortColor,
            display: "grid",
            placeItems: "center",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            fontSize: 16,
            letterSpacing: "-0.02em",
          }}
        >
          {patient.initials}
        </div>
        <div>
          <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
            {patient.age}-year-old{" "}
            {patient.gender === "F" ? "female" : patient.gender === "M" ? "male" : ""}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            Intake {patient.intake_date} · {patient.usage_frequency}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          {patient.is_dropout ? (
            <Pill kind="warning">No follow-up</Pill>
          ) : patient.overall_responder === 1 ? (
            <Pill kind="success">Responder</Pill>
          ) : (
            <Pill>Non-responder</Pill>
          )}
        </div>
      </div>

      {/* Cohort */}
      <div>
        <div className="filter-label" style={{ marginBottom: 8 }}>
          Cohort
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span
            className="dot"
            style={{ background: cohortColor, width: 10, height: 10 }}
          />
          <span style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>
            {patient.cohort}
          </span>
        </div>
      </div>

      {/* Pre vs Post outcomes */}
      <div>
        <div className="filter-label" style={{ marginBottom: 8 }}>
          Pre vs Post outcomes
        </div>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Test</th>
                <th className="num">Pre</th>
                <th className="num">Post</th>
                <th className="num">Delta</th>
              </tr>
            </thead>
            <tbody>
              {TESTS.map((t) => {
                const pre = patient[t.pre] as number | null | undefined;
                const post = patient[t.post] as number | null | undefined;
                if (pre == null) return null;
                const delta = t.higherBetter
                  ? (post ?? 0) - pre
                  : pre - (post ?? 0);
                const meetsMcid =
                  post != null &&
                  (t.key === "vas"
                    ? delta >= 2
                    : t.key === "tug"
                    ? delta >= 3 || delta / pre >= 0.1
                    : t.key === "sst"
                    ? delta / pre >= 0.1
                    : t.key === "ngs"
                    ? delta >= 0.05
                    : t.key === "fgs"
                    ? delta >= 0.1
                    : t.key === "sppb"
                    ? delta >= 1
                    : false);
                return (
                  <tr key={t.key}>
                    <td>{t.label}</td>
                    <td className="num">
                      {typeof pre === "number"
                        ? pre % 1 === 0
                          ? pre
                          : pre.toFixed(2)
                        : "—"}
                    </td>
                    <td className="num">
                      {post == null
                        ? "—"
                        : typeof post === "number"
                        ? post % 1 === 0
                          ? post
                          : post.toFixed(2)
                        : "—"}
                    </td>
                    <td
                      className="num"
                      style={{
                        color:
                          post == null
                            ? "var(--ink-4)"
                            : meetsMcid
                            ? "var(--success)"
                            : "var(--ink-2)",
                      }}
                    >
                      {post == null
                        ? "—"
                        : (delta >= 0 ? "+" : "") + delta.toFixed(2)}
                      {meetsMcid && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 9.5,
                            color: "var(--success)",
                          }}
                        >
                          ●
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Composite improvement */}
      {patient.composite_improvement != null && (
        <div>
          <div className="filter-label" style={{ marginBottom: 8 }}>
            Composite improvement
          </div>
          <CompositeBar value={patient.composite_improvement} />
        </div>
      )}

      {/* Conditions */}
      <div>
        <div className="filter-label" style={{ marginBottom: 8 }}>
          Conditions ({activeFlags.length})
        </div>
        <div className="chip-row">
          {activeFlags.length ? (
            activeFlags.map((f) => (
              <span key={f} className="pill accent">
                {FLAG_LABELS[f]}
              </span>
            ))
          ) : (
            <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
              None recorded
            </span>
          )}
        </div>
      </div>

      {/* Free-text tags */}
      {patient.tags && (
        <div>
          <div className="filter-label" style={{ marginBottom: 6 }}>
            Free-text tags
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--ink-2)",
              padding: "10px 12px",
              background: "var(--surface-sunken)",
              borderRadius: 6,
              fontFamily: "var(--font-mono)",
            }}
          >
            {patient.tags}
          </div>
        </div>
      )}

      {/* Detail list */}
      <dl className="dl">
        <dt>S/N</dt>
        <dd>{patient.sn}</dd>
        <dt>Record ID</dt>
        <dd>{patient.id}</dd>
        <dt>Intake date</dt>
        <dd>{patient.intake_date}</dd>
        <dt>Age band</dt>
        <dd>{patient.age_band}</dd>
        <dt>MCID count</dt>
        <dd>{patient.mcid_count} / 6</dd>
      </dl>
    </div>
  );
}
