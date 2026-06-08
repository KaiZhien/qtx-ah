"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  getModelStatus,
  triggerRetrain,
  reloadModels,
  fetchCalibration,
  ModelStatusResponse,
  CalibrationReport,
  CohortCalibration,
} from "@/lib/api";
import { Card } from "@/components/ui/Card";

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-SG", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function metricCell(v: number | undefined, decimals = 3) {
  if (v === undefined || v === null) return <span style={{ color: "var(--ink-4)" }}>—</span>;
  return <span className="mono">{v.toFixed(decimals)}</span>;
}

const STATUS_STYLE: Record<CohortCalibration["status"], React.CSSProperties> = {
  OK: { background: "rgba(34,197,94,0.12)", color: "#16a34a" },
  WARNING: { background: "rgba(251,191,36,0.12)", color: "#d97706" },
  ALERT: { background: "rgba(239,68,68,0.12)", color: "#dc2626" },
  NO_BASELINE: { background: "rgba(0,0,0,0.05)", color: "var(--ink-4)" },
};

function StatusPill({ status }: { status: CohortCalibration["status"] }) {
  return (
    <span
      style={{
        ...STATUS_STYLE[status],
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: "16px",
      }}
    >
      {status}
    </span>
  );
}

export function AdminPage() {
  const [adminKey, setAdminKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("qtx_admin_key") ?? "";
    }
    return "";
  });
  const [keyInput, setKeyInput] = useState("");
  const [authenticated, setAuthenticated] = useState(false);

  const [modelStatus, setModelStatus] = useState<ModelStatusResponse | null>(null);
  const [calibration, setCalibration] = useState<CalibrationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [retrainDisabled, setRetrainDisabled] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const [status, cal] = await Promise.all([
        getModelStatus(key),
        fetchCalibration(),
      ]);
      setModelStatus(status);
      setCalibration(cal);
      setAuthenticated(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("401")) {
        setError("Invalid admin key.");
        setAuthenticated(false);
      } else {
        setError(`Failed to load: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (adminKey) load(adminKey);
  }, [adminKey, load]);

  function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault();
    sessionStorage.setItem("qtx_admin_key", keyInput);
    setAdminKey(keyInput);
  }

  async function handleRetrain() {
    if (!adminKey) return;
    setRetrainDisabled(true);
    setActionMsg(null);
    try {
      const r = await triggerRetrain(adminKey);
      setActionMsg(`Retrain scheduled (${r.status})`);
    } catch (e: unknown) {
      setActionMsg(`Retrain failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => setRetrainDisabled(false), 30_000);
  }

  async function handleReload() {
    if (!adminKey) return;
    setActionMsg(null);
    try {
      const r = await reloadModels(adminKey);
      setActionMsg(`Hot-reload done — ${r.models_loaded.length} models loaded`);
    } catch (e: unknown) {
      setActionMsg(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!adminKey || !authenticated) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          gap: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Admin Access</div>
        <form
          onSubmit={handleKeySubmit}
          style={{ display: "flex", flexDirection: "column", gap: 8, width: 280 }}
        >
          <input
            type="password"
            className="input"
            placeholder="X-Admin-Key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            autoFocus
          />
          <button className="btn primary" type="submit" disabled={!keyInput}>
            Authenticate
          </button>
        </form>
        {error && (
          <div style={{ color: "#dc2626", fontSize: 13 }}>{error}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Admin Dashboard</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn"
            onClick={handleRetrain}
            disabled={retrainDisabled}
            title={retrainDisabled ? "Cooldown active (30s)" : "Schedule a retrain job"}
          >
            Trigger Retrain
          </button>
          <button className="btn" onClick={handleReload}>
            Hot-reload Models
          </button>
          <button
            className="btn subtle"
            onClick={() => load(adminKey)}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {actionMsg && (
        <div
          style={{
            padding: "8px 14px",
            background: "var(--surface-2, rgba(0,0,0,0.04))",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--ink-2)",
          }}
        >
          {actionMsg}
        </div>
      )}

      {error && (
        <div style={{ color: "#dc2626", fontSize: 13 }}>{error}</div>
      )}

      {loading && (
        <div style={{ fontSize: 13, color: "var(--ink-4)" }}>Loading…</div>
      )}

      {modelStatus && (
        <>
          <Card title="Model Files">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>Filename</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>Size (MB)</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>Last Modified</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(modelStatus.models).map(([name, info]) => (
                  <tr key={name} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td className="mono" style={{ padding: "6px 8px" }}>{name}</td>
                    <td className="mono" style={{ textAlign: "right", padding: "6px 8px" }}>
                      {info.size_mb.toFixed(2)}
                    </td>
                    <td style={{ textAlign: "right", padding: "6px 8px", color: "var(--ink-3)" }}>
                      {fmt(info.modified_at)}
                    </td>
                  </tr>
                ))}
                {Object.keys(modelStatus.models).length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ padding: "10px 8px", color: "var(--ink-4)", textAlign: "center" }}>
                      No model files found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-4)" }}>
              DB ready: {modelStatus.db_ready ? "Yes" : "No"}
            </div>
          </Card>

          <Card title="Last Retrain">
            {modelStatus.retrain_state.error ? (
              <div style={{ color: "#dc2626", fontSize: 13 }}>{modelStatus.retrain_state.error}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ color: "var(--ink-4)", marginRight: 6 }}>Retrained at</span>
                    <strong>
                      {modelStatus.retrain_state.last_retrain_at
                        ? fmt(modelStatus.retrain_state.last_retrain_at)
                        : "—"}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--ink-4)", marginRight: 6 }}>Training set n</span>
                    <strong className="mono">
                      {modelStatus.retrain_state.last_retrain_session_count ?? "—"}
                    </strong>
                  </div>
                </div>
                {modelStatus.retrain_state.last_metrics && (
                  <table style={{ borderCollapse: "collapse", fontSize: 13, marginTop: 4 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--line)" }}>
                        <th style={{ textAlign: "left", padding: "4px 12px 4px 0", fontWeight: 600 }}>Metric</th>
                        <th style={{ textAlign: "right", padding: "4px 0", fontWeight: 600 }}>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label: "RMSE (CV mean)", key: "rmse_mean" as const },
                        { label: "MAE (CV mean)", key: "mae_mean" as const },
                        { label: "R² (CV mean)", key: "r2_mean" as const },
                        { label: "AUC-ROC (CV mean)", key: "auc_roc_mean" as const },
                        { label: "CV n", key: "n" as const },
                      ].map(({ label, key }) => (
                        <tr key={key} style={{ borderBottom: "1px solid var(--line)" }}>
                          <td style={{ padding: "4px 12px 4px 0", color: "var(--ink-3)" }}>{label}</td>
                          <td style={{ textAlign: "right", padding: "4px 0" }}>
                            {metricCell(modelStatus.retrain_state.last_metrics?.[key], key === "n" ? 0 : 4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {calibration && (
        <Card title="Calibration Health">
          <div style={{ fontSize: 12, color: "var(--ink-4)", marginBottom: 10 }}>
            Generated {fmt(calibration.generated_at)} · drift threshold {calibration.drift_threshold}% · min cohort n={calibration.min_cohort_n} · matchable sessions={calibration.total_matchable}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px 6px 0", fontWeight: 600 }}>Cohort</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>n</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>Current MAE</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>Baseline MAE</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>Drift %</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {calibration.cohorts.map((c) => (
                <tr key={c.cohort} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td style={{ padding: "6px 8px 6px 0" }}>{c.cohort}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px" }}>{c.n}</td>
                  <td style={{ textAlign: "right", padding: "6px 8px" }}>{metricCell(c.current_mae)}</td>
                  <td style={{ textAlign: "right", padding: "6px 8px" }}>
                    {c.baseline_mae !== null ? metricCell(c.baseline_mae) : <span style={{ color: "var(--ink-4)" }}>—</span>}
                  </td>
                  <td style={{ textAlign: "right", padding: "6px 8px" }}>
                    {c.drift_pct !== null ? (
                      <span className="mono">{c.drift_pct.toFixed(1)}%</span>
                    ) : (
                      <span style={{ color: "var(--ink-4)" }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right", padding: "6px 8px" }}>
                    <StatusPill status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
