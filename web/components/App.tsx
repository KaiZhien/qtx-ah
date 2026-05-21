"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { Patient, Filters, Tweaks } from "@/lib/types";
import {
  COHORTS,
  USAGE,
  AGE_BANDS,
  DEFAULT_TWEAKS,
  DEFAULT_FILTERS,
} from "@/lib/constants";
import { fetchPatients } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Drawer } from "@/components/ui/Drawer";
import { PatientDrawerBody } from "@/components/PatientDrawerBody";

interface TweaksUIProps {
  open: boolean;
  onClose: () => void;
  tweaks: Tweaks;
  setTweak: (kOrObj: string | Partial<Tweaks>, v?: unknown) => void;
}

function TweaksUI({ open: _open, onClose: _onClose, tweaks: _tweaks, setTweak: _setTweak }: TweaksUIProps) {
  // TweaksPanel will be connected in Task 6
  return null;
}

const PAGE_META: Record<string, { title: string; sub: string }> = {
  overview: { title: "Overview", sub: "Programme-level KPIs and outcomes" },
  cohorts: { title: "Cohort Analysis", sub: "Compare outcomes across phenotype cohorts" },
  clinical: { title: "Clinical Tools", sub: "Patient lookup, intake estimation, dosage recommendations" },
};

export function App() {
  // Routing
  const [page, setPage] = useState<string>("overview");

  // Patient data
  const [allData, setAllData] = useState<Patient[]>([]);
  const [filteredData, setFilteredData] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);

  // Sidebar filters
  const [filters, setFilters] = useState<Filters>({
    ...DEFAULT_FILTERS,
    cohorts: COHORTS,
    usage: USAGE,
    ageBands: AGE_BANDS,
    gender: ["F", "M"],
    fuOnly: false,
  });

  // Fetch all patients once on mount
  useEffect(() => {
    fetchPatients({
      cohorts: COHORTS,
      usage: USAGE,
      ageBands: AGE_BANDS,
      gender: ["F", "M"],
      fuOnly: false,
    })
      .then(setAllData)
      .catch(console.error);
  }, []);

  // Fetch filtered patients whenever filters change
  useEffect(() => {
    setLoading(true);
    fetchPatients(filters)
      .then((data) => {
        setFilteredData(data);
        setLoading(false);
      })
      .catch((e) => {
        console.error(e);
        setLoading(false);
      });
  }, [filters]);

  // Drawer
  const [drawerPatient, setDrawerPatient] = useState<Patient | null>(null);
  const openDrawer = useCallback((p: Patient) => setDrawerPatient(p), []);
  const closeDrawer = useCallback(() => setDrawerPatient(null), []);

  // Tweaks
  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULT_TWEAKS);
  const setTweak = useCallback((kOrObj: string | Partial<Tweaks>, v?: unknown) => {
    setTweaks((t) => {
      if (typeof kOrObj === "string") {
        return { ...t, [kOrObj]: v } as Tweaks;
      }
      return { ...t, ...kOrObj } as Tweaks;
    });
  }, []);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  // Apply theme + density + accent via root attributes & CSS vars
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    document.documentElement.setAttribute("data-density", tweaks.density);
    document.documentElement.style.setProperty("--accent", tweaks.accent);
    const hex = tweaks.accent.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (tweaks.theme === "dark") {
      document.documentElement.style.setProperty("--accent-soft", `rgba(${r},${g},${b},0.18)`);
    } else {
      document.documentElement.style.setProperty("--accent-soft", `rgba(${r},${g},${b},0.10)`);
    }
    document.documentElement.style.setProperty(
      "--accent-strong",
      `oklch(from ${tweaks.accent} calc(l - 0.06) c h)`
    );
  }, [tweaks.theme, tweaks.density, tweaks.accent]);

  // Edit-mode panel listener
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (!e?.data || typeof e.data !== "object") return;
      if (e.data.type === "__activate_edit_mode") setTweaksOpen(true);
      if (e.data.type === "__deactivate_edit_mode") setTweaksOpen(false);
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const meta = PAGE_META[page] ?? PAGE_META["overview"];

  return (
    <div className="app" data-screen-label={page}>
      <Sidebar
        page={page}
        setPage={setPage}
        filters={filters}
        setFilters={setFilters}
      />
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{meta.title}</h1>
            <p>{meta.sub}</p>
          </div>
          <div className="topbar-actions">
            <span className="tag">
              <span className="tag-dot" />
              Live · {filteredData.length.toLocaleString()} patients
            </span>
            <span className="tag" title="2024 dataset">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 1.5h7l3 3v10h-10z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <path d="M10 1.5v3h3M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              {" "}2024 cohort
            </span>
            <button className="btn subtle">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 1.5h7l3 3v10h-10z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <path d="M10 1.5v3h3M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              {" "}Export report
            </button>
          </div>
        </header>

        {page === "overview" && (
          <div style={{ padding: 28 }}>
            {loading ? (
              <div style={{ color: "var(--ink-3)" }}>Loading patients…</div>
            ) : (
              <div style={{ color: "var(--ink-3)", fontSize: 13 }}>
                Overview — {filteredData.length} patients
              </div>
            )}
          </div>
        )}
        {page === "cohorts" && (
          <div style={{ padding: 28, color: "var(--ink-3)" }}>Cohort Analysis</div>
        )}
        {page === "clinical" && (
          <div style={{ padding: 28, color: "var(--ink-3)" }}>Clinical Tools</div>
        )}
      </main>

      <Drawer
        open={!!drawerPatient}
        onClose={closeDrawer}
        title={drawerPatient ? drawerPatient.id : ""}
        subtitle="Patient record"
        footer={
          <>
            <button className="btn" onClick={closeDrawer}>Close</button>
            <button className="btn primary">Open full chart</button>
          </>
        }
      >
        <PatientDrawerBody patient={drawerPatient} />
      </Drawer>

      <TweaksUI
        open={tweaksOpen}
        onClose={() => setTweaksOpen(false)}
        tweaks={tweaks}
        setTweak={setTweak}
      />
    </div>
  );
}

// Suppress unused-variable warnings for page-level callbacks used only by child pages
export type { };
