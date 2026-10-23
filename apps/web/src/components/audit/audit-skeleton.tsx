import React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function AuditEventSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "p-4 rounded-3xl border border-border bg-card space-y-2.5",
        className
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4.5 w-16 rounded-full" />
          <Skeleton className="h-4 w-36 rounded-md" />
        </div>
        <Skeleton className="h-3 w-28 rounded-md self-end sm:self-auto" />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Skeleton className="h-3 w-32 rounded-md" />
        <Skeleton className="h-3 w-24 rounded-md" />
      </div>

      <Skeleton className="h-10 w-full rounded-2xl" />
    </div>
  );
}
