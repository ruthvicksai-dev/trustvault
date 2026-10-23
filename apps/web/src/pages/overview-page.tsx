import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadDialog } from "@/components/documents/upload-dialog";
import { useAuth } from "@/context/auth-context";
import { documentsApi } from "@/lib/api";
import { formatBytes, formatDate, getMimeLabel } from "@/lib/utils";
import type { DocumentItem } from "@/types";
import {
  RiFileTextLine,
  RiShareLine,
  RiUploadCloud2Line,
  RiShieldCheckLine,
  RiDownloadLine,
  RiArrowRightLine,
  RiInformationLine,
  RiFolderLine,
} from "@remixicon/react";

export function OverviewPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const fetchOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      // List accessible documents with limit 100 to calculate accurate totals for the user
      const res = await documentsApi.list({ limit: 100, offset: 0 });
      setDocuments(res.documents || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load dashboard overview.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  const handleDownload = async (doc: DocumentItem) => {
    setDownloadingId(doc.id);
    try {
      await documentsApi.download(doc.id, doc.title);
    } catch (err: any) {
      alert(`Download failed: ${err?.message || "Unknown error"}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const ownedDocs = documents.filter((d) => d.isOwner);
  const sharedDocs = documents.filter((d) => !d.isOwner);
  const recentDocs = documents.slice(0, 5);
  const canUpload = user?.role === "owner" || user?.role === "admin";

  return (
    <div>
      <Header
        title="Dashboard Overview"
        description="Secure document sharing activity and vault metrics"
        actions={
          canUpload && (
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <RiUploadCloud2Line className="size-4 mr-1.5" />
              Upload Document
            </Button>
          )
        }
      />

      <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto">
        {/* Security / Role Notification Banner */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 rounded-3xl bg-sidebar border border-sidebar-border shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center size-10 rounded-2xl bg-primary/10 text-primary shrink-0">
              <RiShieldCheckLine className="size-5" />
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">
                Authenticated as <span className="text-primary font-bold">{user?.email}</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Current role: <strong className="capitalize">{user?.role}</strong>. Backend per-document authorization strictly enforced.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Badge variant="secondary" className="text-xs capitalize font-semibold px-2 py-0.5">
              {user?.role} Access
            </Badge>
          </div>
        </div>

        {/* Metric Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="rounded-3xl border-border/80 shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Total Accessible
              </CardTitle>
              <div className="flex items-center justify-center size-8 rounded-xl bg-primary/10 text-primary">
                <RiFolderLine className="size-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-heading">
                {loading ? "…" : documents.length}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Documents available under current grants
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-border/80 shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Owned Documents
              </CardTitle>
              <div className="flex items-center justify-center size-8 rounded-xl bg-primary/10 text-primary">
                <RiFileTextLine className="size-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-heading">
                {loading ? "…" : ownedDocs.length}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Created and managed by you
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-border/80 shadow-xs">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Shared With Me
              </CardTitle>
              <div className="flex items-center justify-center size-8 rounded-xl bg-primary/10 text-primary">
                <RiShareLine className="size-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-heading">
                {loading ? "…" : sharedDocs.length}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Granted by document owners
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Recent Documents Section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold font-heading text-foreground">Recent Documents</h2>
              <p className="text-xs text-muted-foreground">Recently created or granted documents</p>
            </div>
            <Link to="/documents">
              <Button variant="ghost" size="sm" className="text-xs">
                View All Documents
                <RiArrowRightLine className="size-3.5 ml-1" />
              </Button>
            </Link>
          </div>

          {error && (
            <div className="p-4 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20">
              {error}
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-2xl bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : recentDocs.length === 0 ? (
            <div className="p-8 text-center rounded-3xl border border-dashed border-border bg-card space-y-3">
              <div className="flex items-center justify-center size-12 rounded-2xl bg-muted mx-auto text-muted-foreground">
                <RiFolderLine className="size-6" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-foreground">No documents found</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  {canUpload
                    ? "Upload your first confidential document to get started."
                    : "No documents have been shared with your account yet."}
                </p>
              </div>
              {canUpload && (
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  <RiUploadCloud2Line className="size-4 mr-1.5" />
                  Upload First Document
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {recentDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-3.5 rounded-2xl border border-border bg-card hover:bg-muted/20 transition-colors gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex items-center justify-center size-9 rounded-xl bg-primary/10 text-primary shrink-0">
                      <RiFileTextLine className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground truncate">
                          {doc.title}
                        </span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                          {doc.category}
                        </Badge>
                        <Badge
                          variant={doc.isOwner ? "default" : "secondary"}
                          className="text-[9px] px-1.5 py-0 h-4 capitalize"
                        >
                          {doc.permission}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {formatBytes(doc.sizeBytes)} • {getMimeLabel(doc.mimeType)} • Added{" "}
                        {formatDate(doc.createdAt)}
                      </p>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => handleDownload(doc)}
                    disabled={downloadingId === doc.id}
                  >
                    <RiDownloadLine className="size-3.5 mr-1" />
                    {downloadingId === doc.id ? "Downloading…" : "Download"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Information Callout */}
        <div className="p-4 rounded-3xl bg-muted/40 border border-border/60 text-xs text-muted-foreground flex items-start gap-3">
          <RiInformationLine className="size-4 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Zero-Trust Authorization Invariants</p>
            <p>
              TrustVault enforces security policies at the database layer. Users can only access documents they own or have been actively granted. Soft-deleted documents and revoked grants are immediately denied.
            </p>
          </div>
        </div>
      </div>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={fetchOverview}
      />
    </div>
  );
}
