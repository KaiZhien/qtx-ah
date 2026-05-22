"use client";

import React from "react";
import type { Patient, WearableFeatures } from "@/lib/types";
import { COHORT_COLORS, TESTS, FLAG_LABELS } from "@/lib/constants";
import { Pill } from "@/components/ui/Pill";
import { Tabs } from "@/components/ui/Tabs";
import { fetchWearableFeatures, enrollPatient } from "@/lib/api";

interface PatientDrawerBodyProps {
  patient: Patient | null;
}

const DEVICE_BRANDS = [
  { value: "apple_health", label: "Apple Health" },
  { value: "garmin",       label: "Garmin" },
  { value: "fitbit",       label: "Fitbit" },
  { value: "whoop",        label: "WHOOP" },
  { value: "samsung",      label: "Samsung Health" },
];

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

function WearableMetricsPanel({ data }: { data: WearableFeatures }) {
  function fmt(v: number | null | undefined, decimals = 0, suffix = ""): string {
    if (v == null) return "—";
    return v.toFixed(decimals) + suffix;
  }

  const compliancePct =
    data.wearable_compliance_rate_30d != null
      ? Math.round(data.wearable_compliance_rate_30d * 100)
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <dl className="dl">
        <dt>Daily steps (avg 30d)</dt>
        <dd style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
          {data.wearable_steps_30d_avg != null
            ? Math.round(data.wearable_steps_30d_avg).toLocaleString()
            : "—"}
        </dd>
        <dt>Sedentary time (30d)</dt>
        <dd style={{ fontFamily: "var(--font-mono)" }}>
          {fmt(data.wearable_sedentary_pct_30d, 0, data.wearable_sedentary_pct_30d != null ? "%" : "")}
        </dd>
        <dt>Walking cadence (30d)</dt>
        <dd style={{ fontFamily: "var(--font-mono)" }}>
          {fmt(data.wearable_cadence_avg_30d, 1, data.wearable_cadence_avg_30d != null ? " spm" : "")}
        </dd>
        <dt>HRV — RMSSD (7d avg)</dt>
        <dd style={{ fontFamily: "var(--font-mono)" }}>
          {fmt(data.wearable_hrv_trend_7d, 1, data.wearable_hrv_trend_7d != null ? " ms" : "")}
        </dd>
        <dt>Fall events (90d)</dt>
        <dd
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            color:
              (data.wearable_fall_events_90d ?? 0) > 0
                ? "var(--danger)"
                : "var(--ink)",
          }}
        >
          {data.wearable_fall_events_90d ?? 0}
        </dd>
        <dt>Wear compliance (30d)</dt>
        <dd>
          {compliancePct != null ? (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color:
                  compliancePct >= 70
                    ? "var(--success)"
                    : compliancePct >= 30
                    ? "var(--warning)"
                    : "var(--danger)",
              }}
            >
              {compliancePct}%
            </span>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      {compliancePct != null && compliancePct < 30 && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--warning)",
            padding: "8px 10px",
            background: "var(--warning-soft, rgba(246,173,85,0.1))",
            borderRadius: 6,
          }}
        >
          Low compliance (&lt;30% of days recorded). Wearable data is excluded from fall risk scoring until compliance improves.
        </div>
      )}
    </div>
  );
}

export function PatientDrawerBody({ patient }: PatientDrawerBodyProps) {
  const [activeTab, setActiveTab] = React.useState<"clinical" | "wearable">("clinical");
  const [wearableData, setWearableData] = React.useState<WearableFeatures | null>(null);
  const [wearableLoading, setWearableLoading] = React.useState(false);
  const [wearableError, setWearableError] = React.useState<string | null>(null);
  const [deviceBrand, setDeviceBrand] = React.useState("apple_health");
  const [enrolling, setEnrolling] = React.useState(false);

  // Reset to clinical tab whenever the selected patient changes
  React.useEffect(() => {
    setActiveTab("clinical");
    setWearableData(null);
    setWearableError(null);
  }, [patient?.id]);

  // Fetch wearable data the first time the wearable tab is opened for this patient
  React.useEffect(() => {
    if (activeTab !== "wearable" || !patient) return;
    setWearableLoading(true);
    setWearableError(null);
    fetchWearableFeatures(patient.id)
      .then(setWearableData)
      .catch(() => setWearableError("Could not load wearable data"))
      .finally(() => setWearableLoading(false));
  }, [activeTab, patient?.id]);

  async function handleEnroll() {
    if (!patient) return;
    setEnrolling(true);
    setWearableError(null);
    try {
      const { widget_url } = await enrollPatient(patient.id, deviceBrand);
      window.open(widget_url, "_blank", "noopener,noreferrer");
    } catch {
      setWearableError("Enrollment failed — ensure Terra credentials are configured");
    } finally {
      setEnrolling(false);
    }
  }

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

      {/* Tab switcher */}
      <Tabs
        value={activeTab}
        options={[
          { value: "clinical", label: "Clinical" },
          { value: "wearable", label: "Wearable" },
        ]}
        onChange={(v) => setActiveTab(v as "clinical" | "wearable")}
      />

      {/* ── Clinical tab ── */}
      {activeTab === "clinical" && (
        <>
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
        </>
      )}

      {/* ── Wearable tab ── */}
      {activeTab === "wearable" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {wearableLoading && (
            <div
              style={{
                fontSize: 13,
                color: "var(--ink-3)",
                padding: "32px 0",
                textAlign: "center",
              }}
            >
              Loading wearable data…
            </div>
          )}

          {wearableError && !wearableLoading && (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--danger)",
                padding: "8px 12px",
                background: "var(--danger-soft, rgba(252,129,129,0.1))",
                borderRadius: 6,
              }}
            >
              {wearableError}
            </div>
          )}

          {wearableData && !wearableData.enrolled && !wearableLoading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="filter-label">Connect a wearable device</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {DEVICE_BRANDS.map((b) => (
                  <button
                    key={b.value}
                    className={`tab ${deviceBrand === b.value ? "on" : ""}`}
                    onClick={() => setDeviceBrand(b.value)}
                    style={{ justifyContent: "flex-start" }}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
              <button
                className="btn primary"
                disabled={enrolling}
                onClick={handleEnroll}
                style={{ alignSelf: "flex-start" }}
              >
                {enrolling ? "Opening widget…" : "Enroll patient"}
              </button>
              <p
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                Opens the Terra widget in a new tab. Ask the patient to
                authenticate with their health platform, then refresh this panel.
              </p>
            </div>
          )}

          {wearableData?.enrolled && !wearableLoading && (
            <>
              <div className="filter-label">Wearable metrics</div>
              <WearableMetricsPanel data={wearableData} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
