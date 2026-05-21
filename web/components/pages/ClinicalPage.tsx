"use client";

import React, { useState } from "react";
import { Tabs } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { IntakeEstimator } from "@/components/clinical/IntakeEstimator";
import { PatientLookup } from "@/components/clinical/PatientLookup";
import { DosageRecommender } from "@/components/clinical/DosageRecommender";
import type { Patient } from "@/lib/types";

interface ClinicalPageProps {
  data: Patient[];
  onPatientClick: (p: Patient) => void;
}

export function ClinicalPage({ data, onPatientClick }: ClinicalPageProps) {
  const [tab, setTab] = useState<"intake" | "lookup" | "dosage">("intake");

  return (
    <div className="content">
      <Card>
        <Tabs
          value={tab}
          onChange={(v) => setTab(v as "intake" | "lookup" | "dosage")}
          options={[
            { label: "Intake Estimator", value: "intake" },
            { label: "Patient Lookup", value: "lookup" },
            { label: "Dosage Recommender", value: "dosage" },
          ]}
        />
      </Card>
      {tab === "intake" && <IntakeEstimator data={data} onPatientClick={onPatientClick} />}
      {tab === "lookup" && <PatientLookup data={data} onPatientClick={onPatientClick} />}
      {tab === "dosage" && <DosageRecommender />}
    </div>
  );
}
