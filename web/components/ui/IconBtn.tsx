"use client";

import React from "react";

interface IconBtnProps {
  children: React.ReactNode;
  onClick?: () => void;
  label?: string;
  className?: string;
}

export function IconBtn({ children, onClick, label, className = "" }: IconBtnProps) {
  return (
    <button className={`btn icon subtle ${className}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}
