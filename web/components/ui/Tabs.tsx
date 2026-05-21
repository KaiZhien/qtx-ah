"use client";

import React from "react";

interface TabOption {
  value: string;
  label: React.ReactNode;
}

interface TabsProps {
  value: string;
  options: TabOption[];
  onChange: (value: string) => void;
}

export function Tabs({ value, options, onChange }: TabsProps) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          className={`tab ${value === o.value ? "on" : ""}`}
          onClick={() => onChange(o.value)}
          role="tab"
          aria-selected={value === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
