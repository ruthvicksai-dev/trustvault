import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { documentsApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { DocumentItem, AuditEvent } from "@/types";
import {
  RiHistoryLine,
  RiCheckLine,
  RiCloseLine,
  RiAlertLine,
  RiShieldCheckLine,
} from "@remixicon/react";

interface DocumentAuditDialogProps {
  document: DocumentItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DocumentAuditDialog({
  document,
  open,
  onOpenChange,
}: DocumentAuditDialogProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && document) {
      setLoading(true);
      setError(null);
      documentsApi
        .getDocumentAudit(document.id, { limit: 50, offset: 0 })
        .then((res) => {
          setEvents(res.events || []);
        })
        .catch((err: any) => {
          setError(
            err?.message ||
              "Failed to load document audit trail. Only the document owner is authorized to view audit events."
          );
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, document]);

  if (!document) return null;

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <RiHistoryLine className="size-5" />
            <DialogTitle>Document Access Audit Trail</DialogTitle>
          </div>
          <DialogDescription>
            Immutable event history for <strong>&ldquo;{document.title}&rdquo;</strong>. Only the document owner can inspect this trail.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="space-y-3 py-4">
            <div className="h-12 bg-muted/40 rounded-2xl animate-pulse" />
            <div className="h-12 bg-muted/40 rounded-2xl animate-pulse" />
            <div className="h-12 bg-muted/40 rounded-2xl animate-pulse" />
          </div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground bg-muted/30 rounded-3xl border border-border/50">
            No audit records found for this document.
          </div>
        ) : (
          <div className="space-y-2 pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1">
              Events ({events.length})
            </div>
            <div className="space-y-2">
              {events.map((evt) => (
                <div
                  key={evt.id}
                  className="p-3 rounded-2xl border border-border bg-card text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      {formatActionName(evt.action)}
                    </span>
                    <div className="flex items-center gap-2">
                      {getOutcomeBadge(evt.outcome)}
                      <span className="text-[11px] text-muted-foreground">
                        {formatDate(evt.occurredAt)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    {evt.actorId && (
                      <span className="font-mono text-[10px]">
                        Actor ID: {evt.actorId.slice(0, 8)}…
                      </span>
                    )}
                    {evt.reason && (
                      <span className="text-amber-600 dark:text-amber-400">
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
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-border/60 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <RiShieldCheckLine className="size-3.5 text-primary" />
            <span>Audit events are append-only and cryptographically timestamped.</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
