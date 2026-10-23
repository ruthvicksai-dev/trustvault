import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AuditEventSkeleton } from "@/components/audit/audit-skeleton";
import { useAuth } from "@/context/auth-context";
import { documentsApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { DocumentItem, AuditEvent } from "@/types";
import {
  RiHistoryLine,
  RiCheckLine,
  RiCloseLine,
  RiAlertLine,
  RiFileTextLine,
  RiShieldCheckLine,
  RiRefreshLine,
} from "@remixicon/react";

export function AuditPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only load owned documents because only owners can query document audit trails
    documentsApi
      .list({ limit: 100, offset: 0 })
      .then((res) => {
        const owned = (res.documents || []).filter((d) => d.isOwner);
        setDocuments(owned);
        if (owned.length > 0) {
          setSelectedDocId(owned[0].id);
        }
      })
      .catch((err: any) => {
        setError(err?.message || "Failed to load documents.");
      })
      .finally(() => {
        setLoadingDocs(false);
      });
  }, []);

  const fetchEvents = async (docId: string) => {
    if (!docId) return;
    setLoadingEvents(true);
    setError(null);
    try {
      const res = await documentsApi.getDocumentAudit(docId, { limit: 100, offset: 0 });
      setEvents(res.events || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load document audit trail.");
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  };

  useEffect(() => {
    if (selectedDocId) {
      fetchEvents(selectedDocId);
    }
  }, [selectedDocId]);

  const selectedDoc = documents.find((d) => d.id === selectedDocId);

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

  const formatActionName = (action: string) => {
    const map: Record<string, string> = {
      create_document: "Document Created",
      update_document: "Metadata Updated",
      delete_document: "Document Deleted",
      download_content: "Content Downloaded",
      list_documents: "Document Listed",
      create_grant: "Access Granted",
      update_grant: "Grant Permission Updated",
      revoke_grant: "Access Revoked",
      list_grants: "Grants Inspected",
      read_audit_trail: "Audit Trail Viewed",
    };
    return map[action] || action.replace(/_/g, " ");
  };

  return (
    <div>
      <Header
        title="Document Audit Trail"
        description="Immutable security records for your confidential documents"
        actions={
          selectedDocId && (
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => fetchEvents(selectedDocId)}
              disabled={loadingEvents}
              title="Refresh audit events"
            >
              <RiRefreshLine className={`size-4 ${loadingEvents ? "animate-spin" : ""}`} />
            </Button>
          )
        }
      />

      <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
        {/* Security Invariant Banner */}
        <div className="p-4 rounded-3xl bg-sidebar border border-sidebar-border text-xs text-muted-foreground flex items-start gap-3">
          <RiShieldCheckLine className="size-4 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Immutable Audit Invariant</p>
            <p>
              Every access attempt, permission modification, download stream, and revocation is cryptographically recorded. Audit records cannot be altered or deleted through any client action.
            </p>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20">
            {error}
          </div>
        )}

        {/* Document Selector */}
        {loadingDocs ? (
          <Skeleton className="h-16 w-full rounded-3xl" aria-busy="true" />
        ) : documents.length === 0 ? (
          <div className="p-12 text-center rounded-3xl border border-dashed border-border bg-card space-y-2">
            <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
              <RiHistoryLine className="size-6" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">No owned documents</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              You must own at least one document to inspect document-specific audit trails.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-3xl border border-border bg-card">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Select Document to Audit
                </label>
                <div className="flex items-center gap-2">
                  <RiFileTextLine className="size-4 text-primary" />
                  <select
                    value={selectedDocId}
                    onChange={(e) => setSelectedDocId(e.target.value)}
                    className="h-9 text-xs font-medium rounded-2xl border border-input bg-background px-3 py-1 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} ({d.category})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {selectedDoc && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground self-end sm:self-center">
                  <span>ID: <code className="font-mono text-[10px]">{selectedDoc.id.slice(0, 8)}…</code></span>
                  <span>•</span>
                  <span>Created {formatDate(selectedDoc.createdAt)}</span>
                </div>
              )}
            </div>

            {/* Audit Events List */}
            {loadingEvents ? (
              <div className="space-y-3" aria-busy="true" role="status">
                {[1, 2, 3, 4].map((i) => (
                  <AuditEventSkeleton key={i} />
                ))}
              </div>
            ) : events.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground bg-muted/20 rounded-3xl border border-border/50">
                No recorded audit events for this document.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                  Recorded Security Events ({events.length})
                </div>
                {events.map((evt) => (
                  <div
                    key={evt.id}
                    className="p-4 rounded-3xl border border-border bg-card hover:bg-muted/10 transition-colors text-xs space-y-2"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-foreground">
                          {formatActionName(evt.action)}
                        </span>
                        <code className="text-[10px] text-muted-foreground font-mono">
                          {evt.action}
                        </code>
                      </div>
                      <div className="flex items-center gap-2 self-start sm:self-auto">
                        {getOutcomeBadge(evt.outcome)}
                        <span className="text-[11px] text-muted-foreground">
                          {formatDate(evt.occurredAt)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1 border-t border-border/40">
                      {evt.actorId && (
                        <span>
                          Actor ID: <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">{evt.actorId}</code>
                        </span>
                      )}
                      {evt.reason && (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          Reason: {evt.reason}
                        </span>
                      )}
                      {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          Metadata: {JSON.stringify(evt.metadata)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
