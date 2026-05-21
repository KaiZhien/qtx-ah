"use client";

import React from "react";

interface CardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  flush?: boolean;
}

export function Card({ title, subtitle, action, children, className = "", flush = false }: CardProps) {
  return (
    <div className={`card ${flush ? "card-flush" : ""} ${className}`.trim()}>
      {(title || subtitle || action) && (
        <div className="card-h" style={flush ? { padding: "18px 22px 0" } : {}}>
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
