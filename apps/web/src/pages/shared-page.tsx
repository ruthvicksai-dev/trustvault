import React, { useState, useEffect } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DocumentRowSkeleton } from "@/components/documents/document-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EditDocumentDialog } from "@/components/documents/edit-document-dialog";
import { documentsApi } from "@/lib/api";
import { formatBytes, formatDate, getMimeLabel } from "@/lib/utils";
import type { DocumentItem } from "@/types";
import {
  RiShareLine,
  RiFileTextLine,
  RiDownloadLine,
  RiEditLine,
  RiAlertLine,
  RiShieldCheckLine,
  RiRefreshLine,
} from "@remixicon/react";

export function SharedPage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingDoc, setEditingDoc] = useState<DocumentItem | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const fetchSharedDocs = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await documentsApi.list({ limit: 100, offset: 0 });
      // Filter strictly to documents granted to user (where isOwner === false)
      const shared = (res.documents || []).filter((d) => !d.isOwner);
      setDocuments(shared);
    } catch (err: any) {
      setError(err?.message || "Failed to load shared documents.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSharedDocs();
  }, []);

  const handleDownload = async (doc: DocumentItem) => {
    setDownloadingId(doc.id);
    try {
      await documentsApi.download(doc.id, doc.title);
    } catch (err: any) {
      alert(`Download failed: ${err?.message || "Access may have been revoked by the owner."}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleEditSuccess = (updated: DocumentItem) => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d))
    );
  };

  return (
    <div>
      <Header
        title="Shared with Me"
        description="Documents shared with your account via active grants"
        actions={
          <Button
            variant="outline"
            size="icon-sm"
            onClick={fetchSharedDocs}
            disabled={loading}
            title="Refresh list"
          >
            <RiRefreshLine className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
        {/* Info Banner */}
        <div className="p-4 rounded-3xl bg-sidebar border border-sidebar-border text-xs text-muted-foreground flex items-start gap-3">
          <RiShieldCheckLine className="size-4 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Grant-Based Access Control</p>
            <p>
              These documents are owned by other users who have granted you access. If access is revoked by the owner, download and metadata privileges are immediately terminated by the server.
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2.5 p-4 rounded-3xl bg-destructive/10 text-destructive text-xs border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">Unable to load shared documents</p>
              <p className="mt-0.5">{error}</p>
            </div>
            <Button variant="outline" size="xs" onClick={fetchSharedDocs}>
              Retry
            </Button>
          </div>
        )}

        {loading ? (
          <div role="status">
            <span className="sr-only">Loading shared documents…</span>
            <div className="space-y-3" aria-busy="true" aria-hidden="true">
              {[1, 2, 3].map((i) => (
                <DocumentRowSkeleton key={i} />
              ))}
            </div>
          </div>
        ) : documents.length === 0 ? (
          <div className="p-12 text-center rounded-3xl border border-dashed border-border bg-card space-y-3">
            <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
              <RiShareLine className="size-6" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">No shared documents</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                No documents have been shared with your account yet. When a document owner shares a document with your email, it will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => {
              const canEdit = doc.permission === "edit";

              return (
                <div
                  key={doc.id}
                  className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 rounded-3xl border border-border bg-card hover:bg-muted/15 transition-colors gap-4"
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="flex items-center justify-center size-10 rounded-2xl bg-primary/10 text-primary shrink-0 mt-0.5">
                      <RiFileTextLine className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-heading font-semibold text-sm text-foreground truncate max-w-xs sm:max-w-md">
                          {doc.title}
                        </span>
                        <Badge variant="outline" className="text-[10px] px-2 py-0 h-4.5 font-medium">
                          {doc.category}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px] px-2 py-0 h-4.5 capitalize">
                          {doc.permission} Grant
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
                        <span>{formatBytes(doc.sizeBytes)}</span>
                        <span>•</span>
                        <span>{getMimeLabel(doc.mimeType)}</span>
                        <span>•</span>
                        <span>Shared {formatDate(doc.createdAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownload(doc)}
                      disabled={downloadingId === doc.id}
                      aria-busy={downloadingId === doc.id}
                    >
                      {downloadingId === doc.id ? (
                        <>
                          <Spinner size="xs" className="mr-1.5" />
                          <span>Downloading…</span>
                        </>
                      ) : (
                        <>
                          <RiDownloadLine className="size-3.5 mr-1" />
                          <span>Download</span>
                        </>
                      )}
                    </Button>

                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditingDoc(doc)}
                        title="Edit title and category"
                      >
                        <RiEditLine className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <EditDocumentDialog
        document={editingDoc}
        open={!!editingDoc}
        onOpenChange={(open) => !open && setEditingDoc(null)}
        onSuccess={handleEditSuccess}
      />
    </div>
  );
}
