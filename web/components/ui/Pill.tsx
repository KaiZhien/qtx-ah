"use client";

import React from "react";

interface PillProps {
  children: React.ReactNode;
  kind?: string;
}

export function Pill({ children, kind = "" }: PillProps) {
  return <span className={`pill ${kind}`}>{children}</span>;
}
