import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AuditEventSkeleton } from "@/components/audit/audit-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/auth-context";
import { auditApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { AuditEvent } from "@/types";
import {
  RiAdminLine,
  RiCheckLine,
  RiCloseLine,
  RiAlertLine,
  RiShieldCheckLine,
  RiFilterLine,
  RiRefreshLine,
  RiLockLine,
} from "@remixicon/react";

export function AdminPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [actionFilter, setActionFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<"" | "success" | "denied" | "failure">("");
  const [actorIdFilter, setActorIdFilter] = useState("");
  const [documentIdFilter, setDocumentIdFilter] = useState("");

  const fetchSystemEvents = async () => {
    if (user?.role !== "admin") return;
    setLoading(true);
    setError(null);
    try {
      const res = await auditApi.listSystemEvents({
        action: actionFilter || undefined,
        outcome: outcomeFilter || undefined,
        actorId: actorIdFilter || undefined,
        documentId: documentIdFilter || undefined,
        limit: 50,
        offset: 0,
      });
      setEvents(res.events || []);
      setTotal(res.pagination?.total || 0);
    } catch (err: any) {
      setError(err?.message || "Failed to load system audit trail. Admin role required.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemEvents();
  }, [actionFilter, outcomeFilter]);

  // Route-level protection for unauthorized non-admins
  if (user?.role !== "admin") {
    return (
      <div>
        <Header title="Administration Restricted" />
        <div className="p-8 max-w-lg mx-auto mt-12 text-center space-y-4">
          <div className="flex items-center justify-center size-14 rounded-3xl bg-destructive/10 text-destructive mx-auto">
            <RiLockLine className="size-7" />
          </div>
          <div>
            <h2 className="text-lg font-bold font-heading text-foreground">Access Restricted</h2>
            <p className="text-xs text-muted-foreground mt-1">
              System Audit Oversight is restricted exclusively to authenticated users with the <strong>admin</strong> role. Your current role is <strong>{user?.role}</strong>. The backend enforces this policy with HTTP 403 Forbidden.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const getOutcomeBadge = (outcome: string) => {
    switch (outcome) {
      case "success":
        return (
          <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 gap-1 px-1.5 py-0">
            <RiCheckLine className="size-3" />
            Success
          </Badge>
        );
      case "denied":
        return (
          <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 gap-1 px-1.5 py-0">
            <RiAlertLine className="size-3" />
            Denied
          </Badge>
        );
      case "failure":
        return (
          <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20 gap-1 px-1.5 py-0">
            <RiCloseLine className="size-3" />
            Failure
          </Badge>
        );
      default:
        return <Badge variant="outline">{outcome}</Badge>;
    }
  };

  return (
    <div>
      <Header
        title="System Audit Oversight"
        description="Global platform security event log and administrative oversight"
        actions={
          <Button
            variant="outline"
            size="icon-sm"
            onClick={fetchSystemEvents}
            disabled={loading}
            title="Refresh system events"
          >
            <RiRefreshLine className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
        {/* Privacy & Admin Invariants Callout */}
        <div className="p-4 rounded-3xl bg-sidebar border border-sidebar-border text-xs text-muted-foreground flex items-start gap-3">
          <RiShieldCheckLine className="size-4 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Administrative Oversight & Privacy Invariants</p>
            <p>
              Administrators have global visibility into system security events (authentication attempts, grant modifications, rate limits, downloads), but do <strong>not</strong> possess implicit access to confidential document contents or keys. Backend authorization remains authoritative.
            </p>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="p-4 rounded-3xl border border-border bg-card space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <RiFilterLine className="size-4 text-primary" />
            <span>Filter Security Events</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">Action</label>
              <Input
                placeholder="e.g. auth_login, create_grant"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">Outcome</label>
              <select
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value as any)}
                className="w-full h-8 rounded-2xl border border-input bg-background px-3 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">All Outcomes</option>
                <option value="success">Success</option>
                <option value="denied">Denied</option>
                <option value="failure">Failure</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">Actor UUID</label>
              <Input
                placeholder="UUID of user"
                value={actorIdFilter}
                onChange={(e) => setActorIdFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && fetchSystemEvents()}
                className="h-8 text-xs font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">Document UUID</label>
              <Input
                placeholder="UUID of document"
                value={documentIdFilter}
                onChange={(e) => setDocumentIdFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && fetchSystemEvents()}
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>

          {(actorIdFilter || documentIdFilter) && (
            <div className="flex justify-end pt-1">
              <Button size="xs" onClick={fetchSystemEvents}>
                Apply UUID Filters
              </Button>
            </div>
          )}
        </div>

        {error && (
          <div className="p-4 rounded-3xl bg-destructive/10 text-destructive text-xs border border-destructive/20 flex items-start gap-2">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Events Table / List */}
        {loading ? (
          <div role="status">
            <span className="sr-only">Loading security events…</span>
            <div className="space-y-3" aria-busy="true" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((i) => (
                <AuditEventSkeleton key={i} />
              ))}
            </div>
          </div>
        ) : events.length === 0 ? (
          <div className="p-12 text-center rounded-3xl border border-dashed border-border bg-card space-y-2">
            <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
              <RiAdminLine className="size-6" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">No matching security events</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              No audit records match the current filter criteria.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
              <span>Showing {events.length} of {total} Events</span>
            </div>

            {events.map((evt) => (
              <div
                key={evt.id}
                className="p-4 rounded-3xl border border-border bg-card hover:bg-muted/10 transition-colors text-xs space-y-2"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-foreground">
                      {evt.action}
                    </span>
                    {getOutcomeBadge(evt.outcome)}
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {formatDate(evt.occurredAt)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1 border-t border-border/40">
                  {evt.actorId && (
                    <span>
                      Actor: <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">{evt.actorId}</code>
                    </span>
                  )}
                  {evt.documentId && (
                    <span>
                      Doc: <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">{evt.documentId}</code>
                    </span>
                  )}
                  {evt.reason && (
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      Reason: {evt.reason}
                    </span>
                  )}
                  {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground/80">
                      Meta: {JSON.stringify(evt.metadata)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
