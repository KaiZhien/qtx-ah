"use client";

import React from "react";

interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Field({ label, hint, children, style }: FieldProps) {
  return (
    <div className="field" style={style}>
      {label && <div className="field-label">{label}</div>}
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
