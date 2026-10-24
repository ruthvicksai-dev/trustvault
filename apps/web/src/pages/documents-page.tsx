import React, { useState, useEffect, useMemo } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { UploadDialog } from "@/components/documents/upload-dialog";
import { EditDocumentDialog } from "@/components/documents/edit-document-dialog";
import { DeleteDocumentDialog } from "@/components/documents/delete-document-dialog";
import { ShareDialog } from "@/components/sharing/share-dialog";
import { DocumentAuditDialog } from "@/components/audit/document-audit-dialog";
import { DocumentRowSkeleton } from "@/components/documents/document-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/auth-context";
import { documentsApi } from "@/lib/api";
import { formatBytes, formatDate, getMimeLabel } from "@/lib/utils";
import type { DocumentItem } from "@/types";
import {
  RiFileTextLine,
  RiUploadCloud2Line,
  RiDownloadLine,
  RiEditLine,
  RiShareLine,
  RiHistoryLine,
  RiDeleteBinLine,
  RiSearchLine,
  RiFilterLine,
  RiAlertLine,
  RiShieldCheckLine,
  RiRefreshLine,
} from "@remixicon/react";

export function DocumentsPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  // Dialog states
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<DocumentItem | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<DocumentItem | null>(null);
  const [sharingDoc, setSharingDoc] = useState<DocumentItem | null>(null);
  const [auditDoc, setAuditDoc] = useState<DocumentItem | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const fetchDocuments = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await documentsApi.list({
        search: searchQuery || undefined,
        category: selectedCategory !== "all" ? selectedCategory : undefined,
        limit: 100,
        offset: 0,
      });
      setDocuments(res.documents || []);
    } catch (err: any) {
      setError(err?.message || "Failed to retrieve documents.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchDocuments();
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, selectedCategory]);

  const handleDownload = async (doc: DocumentItem) => {
    setDownloadingId(doc.id);
    try {
      await documentsApi.download(doc.id, doc.title);
    } catch (err: any) {
      alert(`Download failed: ${err?.message || "Permission denied or file unavailable."}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleEditSuccess = (updated: DocumentItem) => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d))
    );
  };

  const handleDeleteSuccess = (deletedId: string) => {
    setDocuments((prev) => prev.filter((d) => d.id !== deletedId));
  };

  // Derive all unique categories present in the current view for quick filter pills
  const categories = useMemo(() => {
    const set = new Set<string>();
    documents.forEach((d) => {
      if (d.category) set.add(d.category);
    });
    return Array.from(set);
  }, [documents]);

  const canUpload = user?.role === "owner" || user?.role === "admin";

  return (
    <div>
      <Header
        title="Document Management"
        description="Inspect, download, share, and audit confidential files"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={fetchDocuments}
              disabled={loading}
              title="Refresh document list"
            >
              <RiRefreshLine className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            {canUpload && (
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                <RiUploadCloud2Line className="size-4 mr-1.5" />
                Upload Document
              </Button>
            )}
          </div>
        }
      />

      <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
        {/* Search and Filters Bar */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
          <div className="relative flex-1 max-w-md">
            <RiSearchLine className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Search documents by title…"
              className="pl-9 h-9 text-xs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
            <Button
              variant={selectedCategory === "all" ? "default" : "outline"}
              size="xs"
              onClick={() => setSelectedCategory("all")}
            >
              All Categories
            </Button>
            {categories.map((cat) => (
              <Button
                key={cat}
                variant={selectedCategory === cat ? "default" : "outline"}
                size="xs"
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </Button>
            ))}
          </div>
        </div>

        {/* Error Feedback */}
        {error && (
          <div className="flex items-start gap-2.5 p-4 rounded-3xl bg-destructive/10 text-destructive text-xs border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">Unable to fetch documents</p>
              <p className="mt-0.5">{error}</p>
            </div>
            <Button variant="outline" size="xs" onClick={fetchDocuments}>
              Retry
            </Button>
          </div>
        )}

        {/* Document Table / List */}
        {loading ? (
          <div role="status">
            <span className="sr-only">Loading documents…</span>
            <div className="space-y-3" aria-busy="true" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((i) => (
                <DocumentRowSkeleton key={i} />
              ))}
            </div>
          </div>
        ) : documents.length === 0 ? (
          <div className="p-12 text-center rounded-3xl border border-dashed border-border bg-card space-y-3">
            <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
              <RiFileTextLine className="size-6" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">No documents found</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                {searchQuery || selectedCategory !== "all"
                  ? "No documents match the current search or category filter."
                  : canUpload
                  ? "Upload your first confidential document to begin sharing securely."
                  : "No documents have been granted to your account."}
              </p>
            </div>
            {canUpload && !searchQuery && selectedCategory === "all" && (
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                <RiUploadCloud2Line className="size-4 mr-1.5" />
                Upload Document
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => {
              const canEdit = doc.isOwner || doc.permission === "edit";
              const isOwner = doc.isOwner;

              return (
                <div
                  key={doc.id}
                  className="flex flex-col lg:flex-row items-start lg:items-center justify-between p-4 rounded-3xl border border-border bg-card hover:bg-muted/15 transition-colors gap-4"
                >
                  {/* Left: Document info */}
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
                        <Badge
                          variant={isOwner ? "default" : "secondary"}
                          className="text-[10px] px-2 py-0 h-4.5 capitalize"
                        >
                          {doc.permission}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
                        <span>{formatBytes(doc.sizeBytes)}</span>
                        <span>•</span>
                        <span>{getMimeLabel(doc.mimeType)}</span>
                        <span>•</span>
                        <span>Uploaded {formatDate(doc.createdAt)}</span>
                        {doc.updatedAt && doc.updatedAt !== doc.createdAt && (
                          <>
                            <span>•</span>
                            <span className="text-[11px]">Edited {formatDate(doc.updatedAt)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex items-center gap-1.5 self-end lg:self-center shrink-0">
                    {/* Download button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownload(doc)}
                      disabled={downloadingId === doc.id}
                      aria-busy={downloadingId === doc.id}
                      title="Download verified document stream"
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

                    {/* Edit button (Owner or Edit grant) */}
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditingDoc(doc)}
                        title="Edit metadata"
                      >
                        <RiEditLine className="size-4" />
                      </Button>
                    )}

                    {/* Sharing button (Owner only) */}
                    {isOwner && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setSharingDoc(doc)}
                        title="Manage document sharing grants"
                      >
                        <RiShareLine className="size-4" />
                      </Button>
                    )}

                    {/* Audit trail button (Owner only) */}
                    {isOwner && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setAuditDoc(doc)}
                        title="View document audit trail"
                      >
                        <RiHistoryLine className="size-4" />
                      </Button>
                    )}

                    {/* Delete button (Owner only) */}
                    {isOwner && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setDeletingDoc(doc)}
                        title="Delete document"
                      >
                        <RiDeleteBinLine className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={fetchDocuments}
      />

      <EditDocumentDialog
        document={editingDoc}
        open={!!editingDoc}
        onOpenChange={(open) => !open && setEditingDoc(null)}
        onSuccess={handleEditSuccess}
      />

      <DeleteDocumentDialog
        document={deletingDoc}
        open={!!deletingDoc}
        onOpenChange={(open) => !open && setDeletingDoc(null)}
        onSuccess={handleDeleteSuccess}
      />

      <ShareDialog
        document={sharingDoc}
        open={!!sharingDoc}
        onOpenChange={(open) => !open && setSharingDoc(null)}
      />

      <DocumentAuditDialog
        document={auditDoc}
        open={!!auditDoc}
        onOpenChange={(open) => !open && setAuditDoc(null)}
      />
    </div>
  );
}
