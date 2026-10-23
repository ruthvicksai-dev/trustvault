import React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function DocumentRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex flex-col lg:flex-row items-start lg:items-center justify-between p-4 rounded-3xl border border-border bg-card gap-4",
        className
      )}
    >
      {/* Left: Document icon + title & metadata */}
      <div className="flex items-start gap-3.5 min-w-0 flex-1">
        <Skeleton className="size-10 rounded-2xl shrink-0 mt-0.5" />
        <div className="space-y-2 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4.5 w-44 sm:w-64 rounded-lg" />
            <Skeleton className="h-4 w-16 rounded-full" />
            <Skeleton className="h-4 w-14 rounded-full" />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Skeleton className="h-3 w-16 rounded-md" />
            <span className="text-muted-foreground/30">•</span>
            <Skeleton className="h-3 w-12 rounded-md" />
            <span className="text-muted-foreground/30">•</span>
            <Skeleton className="h-3 w-28 rounded-md" />
          </div>
        </div>
      </div>

      {/* Right: Action buttons */}
      <div className="flex items-center gap-1.5 self-end lg:self-center shrink-0">
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-16 rounded-full" />
        <Skeleton className="h-7 w-14 rounded-full" />
      </div>
    </div>
  );
}

export function MetricCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("rounded-3xl border-border/80 shadow-xs", className)} aria-hidden="true">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-3.5 w-28 rounded-md" />
        <Skeleton className="size-8 rounded-xl" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-8 w-16 rounded-lg" />
        <Skeleton className="h-3 w-36 rounded-md" />
      </CardContent>
    </Card>
  );
}
