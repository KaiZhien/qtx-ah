"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Patient } from "@/lib/types";
import { fetchPatient } from "@/lib/api";
import { PatientDrawerBody } from "@/components/PatientDrawerBody";

export default function PatientPage() {
  const { sn } = useParams<{ sn: string }>();
  const router = useRouter();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPatient(sn)
      .then(setPatient)
      .catch(() => setError("Patient not found"));
  }, [sn]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--surface-1, #f8f9fb)" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 24px 48px" }}>
        <button
          onClick={() => router.back()}
          style={{ marginBottom: 20, background: "none", border: "none", cursor: "pointer", color: "var(--ink-2, #555)", fontSize: 14 }}
        >
          ← Back
        </button>
        {error ? (
          <p style={{ color: "var(--danger, red)" }}>{error}</p>
        ) : (
          <PatientDrawerBody patient={patient} />
        )}
      </div>
    </div>
  );
}
