import React from "react";
import { Spinner } from "./spinner";

interface PageLoaderProps {
  label?: string;
  className?: string;
}

export function PageLoader({ label = "Loading secure vault interface...", className = "" }: PageLoaderProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={`flex min-h-[50vh] w-full flex-col items-center justify-center gap-3 p-8 text-muted-foreground ${className}`}
    >
      <Spinner size="lg" className="text-primary" />
      <span className="text-xs font-medium tracking-wide uppercase">{label}</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}
