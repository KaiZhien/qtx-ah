"use client";

import React, { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Icon } from "@/components/ui/Icons";
import type { Patient } from "@/lib/types";

interface PatientLookupProps {
  data: Patient[];
  onPatientClick: (p: Patient) => void;
}

export function PatientLookup({ data, onPatientClick }: PatientLookupProps) {
  const [q, setQ] = useState("");

  const list = q.trim()
    ? data.filter((p) =>
        (p.id ?? "").toLowerCase().includes(q.toLowerCase()) ||
        (p.tags ?? "").toLowerCase().includes(q.toLowerCase()) ||
        String(p.sn) === q.trim()
      ).slice(0, 14)
    : [];

  const recentlyFlagged = data
    .filter((p) => p.is_dropout === 1 && p.age > 70)
    .slice(0, 6);

  return (
    <div>
      <Card title="Look up a patient" subtitle="Search by record ID, S/N, or tag">
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--ink-4)" }}>
            <Icon.Search />
          </div>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. AH-24-0042, 1042, knee OA"
            style={{ paddingLeft: 36 }}
            autoFocus
          />
        </div>
        {q && (
          <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {list.length === 0 ? (
              <div style={{ padding: 22, color: "var(--ink-3)", fontSize: 13, textAlign: "center" }}>No matches</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Age</th>
                    <th>Cohort</th>
                    <th>Tags</th>
                    <th className="num">Composite Delta</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.sn} className="clickable" onClick={() => onPatientClick(p)}>
                      <td className="mono" style={{ color: "var(--ink-2)" }}>{p.id}</td>
                      <td>{p.age}</td>
                      <td>{p.cohort}</td>
                      <td style={{ color: "var(--ink-3)", fontSize: 11.5 }}>{p.tags || "—"}</td>
                      <td className="num">
                        {p.composite_improvement != null
                          ? (p.composite_improvement >= 0 ? "+" : "") + p.composite_improvement.toFixed(2)
                          : "—"}
                      </td>
                      <td>
                        {p.is_dropout
                          ? <Pill kind="warning">No FU</Pill>
                          : p.overall_responder === 1
                            ? <Pill kind="success">Responder</Pill>
                            : <Pill>Non-resp.</Pill>}
                      </td>
                      <td style={{ textAlign: "right" }}><Icon.Arrow /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>
      {!q && (
        <Card title="Recently flagged" subtitle="Patients with dropout risk in last cycle (sample)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {recentlyFlagged.map((p) => (
              <div
                key={p.sn}
                className="clickable"
                onClick={() => onPatientClick(p)}
                style={{ background: "var(--surface-sunken)", borderRadius: 8, padding: 12, cursor: "pointer" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{p.id}</span>
                  <Pill kind="warning">Dropout</Pill>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{p.cohort} · {p.age}yo {p.gender}</div>
                {p.tags && <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>{p.tags}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
