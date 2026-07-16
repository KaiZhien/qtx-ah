"use client";

import React from "react";

export const Icon = {
  Overview: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="1.5" y="9.5" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="9.5" y="1.5" width="5" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="9.5" y="12.5" width="5" height="2" rx="1" stroke="currentColor" strokeWidth="1.2"/></svg>,
  Cohort: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.2"/><circle cx="11" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.2"/><path d="M2 13c0-1.7 1.3-3 3-3s3 1.3 3 3M8 13c0-1.7 1.3-3 3-3s3 1.3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  Clinical: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5v13M1.5 8h13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/></svg>,
  Models: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 12L6 8L9 11L14 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="14" cy="5" r="1.4" fill="currentColor"/><circle cx="9" cy="11" r="1.4" fill="currentColor"/><circle cx="6" cy="8" r="1.4" fill="currentColor"/><circle cx="2" cy="12" r="1.4" fill="currentColor"/></svg>,
  Search: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/><path d="M14 14l-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  Close: () => <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  Filter: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  Arrow: () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Spark: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.5 3.5l2 2M10.5 10.5l2 2M3.5 12.5l2-2M10.5 5.5l2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  Doc: () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 1.5h7l3 3v10h-10z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M10 1.5v3h3M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  FallRisk: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="3" r="1.4" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M5 6.5c1-1 4-1.5 5 0l1 3-2 .5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M7 9.5l-1.5 3M9.5 9.5l.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M3.5 13.5l2.5-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  ),
  Gear: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  ),
  Triage: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2.5L14 13H2L8 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <circle cx="8" cy="11.3" r="0.7" fill="currentColor"/>
    </svg>
  ),
};
