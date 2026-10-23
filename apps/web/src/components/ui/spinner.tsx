import React from "react";
import { cn } from "@/lib/utils";

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "xs" | "sm" | "md" | "lg";
  label?: string;
}

const sizeClasses = {
  xs: "size-3 border-[1.5px]",
  sm: "size-4 border-2",
  md: "size-5 border-2",
  lg: "size-8 border-[2.5px]",
};

export function Spinner({
  size = "sm",
  label = "Loading…",
  className,
  ...props
}: SpinnerProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn("inline-flex items-center justify-center shrink-0", className)}
      {...props}
    >
      <div
        className={cn(
          "rounded-full border-current border-t-transparent animate-spin motion-reduce:animate-none motion-reduce:border-dashed",
          sizeClasses[size]
        )}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
