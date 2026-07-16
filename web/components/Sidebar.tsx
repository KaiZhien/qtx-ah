"use client";

import React from "react";
import type { Filters } from "@/lib/types";
import { COHORTS, COHORT_COLORS, USAGE, AGE_BANDS } from "@/lib/constants";
import { Icon } from "@/components/ui/Icons";

interface SidebarProps {
  page: string;
  setPage: (page: string) => void;
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
}

export function Sidebar({ page, setPage, filters, setFilters }: SidebarProps) {
  function toggle(group: keyof Filters, value: string) {
    setFilters((f) => {
      const list = f[group] as string[];
      const next = list.includes(value)
        ? list.filter((x) => x !== value)
        : [...list, value];
      return { ...f, [group]: next };
    });
  }

  function reset() {
    setFilters({
      cohorts: COHORTS,
      usage: USAGE,
      ageBands: AGE_BANDS,
      gender: ["F", "M"],
      fuOnly: false,
    });
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <div className="brand-glyph">Q</div>
          <div>
            <div className="brand-name">
              QuantumTX{" "}
              <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>· AH</span>
            </div>
          </div>
        </div>
        <div className="brand-sub">
          Clinical Analytics
          <br />
          Alexandra Hospital, 2024
        </div>
      </div>

      <nav className="nav">
        <div className="nav-section-label">Workspaces</div>
        <button
          className={`nav-item ${page === "overview" ? "active" : ""}`}
          onClick={() => setPage("overview")}
        >
          <Icon.Overview /> Overview
        </button>
        <button
          className={`nav-item ${page === "cohorts" ? "active" : ""}`}
          onClick={() => setPage("cohorts")}
        >
          <Icon.Cohort /> Cohort Analysis
        </button>
        <button
          className={`nav-item ${page === "clinical" ? "active" : ""}`}
          onClick={() => setPage("clinical")}
        >
          <Icon.Clinical /> Clinical Tools
        </button>
        <button
          className={`nav-item ${page === "triage" ? "active" : ""}`}
          onClick={() => setPage("triage")}
        >
          <Icon.Triage /> Triage
        </button>
      </nav>

      <div className="filters">
        <div className="filter-block">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="filter-label">Filters</div>
            <button
              className="btn subtle"
              style={{ fontSize: 11, padding: "2px 8px", height: "auto" }}
              onClick={reset}
            >
              Reset
            </button>
          </div>
        </div>

        <div className="filter-block">
          <div className="filter-label">Cohort</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {COHORTS.map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={filters.cohorts.includes(c)}
                  onChange={() => toggle("cohorts", c)}
                />
                <span className="box" />
                <span
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    fontSize: 12.5,
                    lineHeight: 1.35,
                  }}
                >
                  <span
                    className="dot"
                    style={{
                      background: COHORT_COLORS[c],
                      marginTop: 5,
                      flexShrink: 0,
                    }}
                  />
                  <span>{c}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <div className="filter-label">Usage frequency</div>
          {USAGE.map((u) => {
            const short = u.startsWith("L+R")
              ? "L+R 10 (both legs)"
              : u.startsWith("Twice")
              ? "Twice / week"
              : "Once / week";
            return (
              <label key={u} className="check">
                <input
                  type="checkbox"
                  checked={filters.usage.includes(u)}
                  onChange={() => toggle("usage", u)}
                />
                <span className="box" />
                <span style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{short}</span>
              </label>
            );
          })}
        </div>

        <div className="filter-block">
          <div className="filter-label">Age band</div>
          <div className="chip-row">
            {AGE_BANDS.map((a) => (
              <button
                key={a}
                className={`chip ${filters.ageBands.includes(a) ? "on" : ""}`}
                onClick={() => toggle("ageBands", a)}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <div className="filter-label">Gender</div>
          <div className="chip-row">
            {(["F", "M"] as const).map((g) => (
              <button
                key={g}
                className={`chip ${filters.gender.includes(g) ? "on" : ""}`}
                onClick={() => toggle("gender", g)}
              >
                {g === "F" ? "Female" : "Male"}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <label className="check">
            <input
              type="checkbox"
              checked={filters.fuOnly}
              onChange={(e) =>
                setFilters((f) => ({ ...f, fuOnly: e.target.checked }))
              }
            />
            <span className="box" />
            <span style={{ fontSize: 12.5 }}>Follow-up only</span>
          </label>
        </div>
      </div>

      <div
        style={{
          padding: "10px 18px",
          borderTop: "1px solid var(--line)",
        }}
      >
        <a
          href="/admin"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            color: "var(--ink-4)",
            textDecoration: "none",
            padding: "6px 0",
          }}
        >
          <Icon.Gear /> Admin
        </a>
      </div>

      <div
        style={{
          marginTop: "auto",
          padding: "14px 18px",
          borderTop: "1px solid var(--line)",
          fontSize: 10.5,
          color: "var(--ink-4)",
        }}
      >
        <div className="mono">v0.2.0 · XGBoost models</div>
        <div style={{ marginTop: 4 }}>Last run · 2026-05-12</div>
      </div>
    </aside>
  );
}
