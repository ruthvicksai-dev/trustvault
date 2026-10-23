import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { documentsApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { DocumentItem, DocumentGrant } from "@/types";
import {
  RiShareLine,
  RiUserAddLine,
  RiDeleteBinLine,
  RiAlertLine,
  RiCheckLine,
  RiInformationLine,
  RiLockLine,
  RiUser3Line,
} from "@remixicon/react";

interface ShareDialogProps {
  document: DocumentItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ document, open, onOpenChange }: ShareDialogProps) {
  const [grants, setGrants] = useState<DocumentGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // New grant form state
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [granting, setGranting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Revoking state
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeGrant, setConfirmRevokeGrant] = useState<DocumentGrant | null>(null);

  const fetchGrants = async () => {
    if (!document) return;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await documentsApi.listGrants(document.id);
      setGrants(res.grants || []);
    } catch (err: any) {
      setFetchError(err?.message || "Failed to load document permissions. Only the document owner may view grants.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && document) {
      fetchGrants();
      setActionError(null);
      setActionSuccess(null);
      setEmail("");
      setPermission("read");
      setConfirmRevokeGrant(null);
    }
  }, [open, document]);

  const handleCreateGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!document) return;
    setActionError(null);
    setActionSuccess(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setActionError("Recipient email address is required.");
      return;
    }

    setGranting(true);
    try {
      const res = await documentsApi.createGrant(document.id, {
        email: trimmedEmail,
        permission,
      });
      setActionSuccess(`Access granted to ${res.grant.userEmail} with ${res.grant.permission} permission.`);
      setEmail("");
      await fetchGrants();
    } catch (err: any) {
      setActionError(err?.message || "Failed to grant access. Verify that the user exists and is not disabled.");
    } finally {
      setGranting(false);
    }
  };

  const handleUpdatePermission = async (grantId: string, newPermission: "read" | "edit") => {
    if (!document) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await documentsApi.updateGrant(document.id, grantId, { permission: newPermission });
      setActionSuccess("Permission updated successfully.");
      await fetchGrants();
    } catch (err: any) {
      setActionError(err?.message || "Failed to update permission.");
    }
  };

  const handleRevokeGrant = async (grant: DocumentGrant) => {
    if (!document) return;
    setRevokingId(grant.id);
    setActionError(null);
    setActionSuccess(null);
    try {
      await documentsApi.revokeGrant(document.id, grant.id);
      setActionSuccess(`Access revoked for ${grant.userEmail}.`);
      setConfirmRevokeGrant(null);
      await fetchGrants();
    } catch (err: any) {
      setActionError(err?.message || "Failed to revoke access.");
    } finally {
      setRevokingId(null);
    }
  };

  if (!document) return null;

  const activeGrants = grants.filter((g) => g.isActive !== false && !g.revokedAt);
  const revokedGrants = grants.filter((g) => g.revokedAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <RiShareLine className="size-5" />
            <DialogTitle>Share Document & Manage Grants</DialogTitle>
          </div>
          <DialogDescription>
            Grant or revoke access to <strong>&ldquo;{document.title}&rdquo;</strong>. Only the document owner can configure permissions.
          </DialogDescription>
        </DialogHeader>

        {/* Status Feedback */}
        {actionError && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20 animate-in fade-in-50">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}

        {actionSuccess && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs border border-emerald-500/20 animate-in fade-in-50">
            <RiCheckLine className="size-4 shrink-0 mt-0.5" />
            <span>{actionSuccess}</span>
          </div>
        )}

        {fetchError && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{fetchError}</span>
          </div>
        )}

        {/* Grant Creation Form */}
        <form onSubmit={handleCreateGrant} className="space-y-3 pt-1">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="grant-email" className="text-xs">User Email</Label>
              <Input
                id="grant-email"
                type="email"
                placeholder="colleague@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={granting || loading}
                required
              />
            </div>

            <div className="w-full sm:w-36 space-y-1">
              <Label htmlFor="grant-permission" className="text-xs">Permission</Label>
              <select
                id="grant-permission"
                value={permission}
                onChange={(e) => setPermission(e.target.value as "read" | "edit")}
                disabled={granting || loading}
                className="w-full h-9 rounded-2xl border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="read">Read (Download)</option>
                <option value="edit">Edit (Metadata)</option>
              </select>
            </div>

            <div className="flex items-end">
              <Button
                type="submit"
                size="default"
                disabled={granting || loading}
                aria-busy={granting}
                className="w-full sm:w-auto"
              >
                {granting ? (
                  <>
                    <Spinner size="xs" className="mr-1.5" />
                    <span>Granting…</span>
                  </>
                ) : (
                  <>
                    <RiUserAddLine className="size-4 mr-1.5" />
                    <span>Grant Access</span>
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <RiInformationLine className="size-3.5 shrink-0 text-primary" />
            <span><strong>Read:</strong> view and download document. <strong>Edit:</strong> modify title and category.</span>
          </div>
        </form>

        <Separator className="my-2" />

        {/* Active Grants List */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Active Access Grants ({activeGrants.length})
            </h4>
          </div>

          {loading ? (
            <div className="space-y-2 py-1" aria-busy="true" role="status">
              <Skeleton className="h-12 w-full rounded-2xl" />
              <Skeleton className="h-12 w-full rounded-2xl" />
            </div>
          ) : activeGrants.length === 0 ? (
            <div className="p-4 rounded-2xl bg-muted/30 border border-border/50 text-center text-xs text-muted-foreground">
              No active grants. Only you (the owner) have access to this document.
            </div>
          ) : (
            <div className="space-y-2">
              {activeGrants.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center justify-between p-3 rounded-2xl border border-border bg-card text-xs gap-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex items-center justify-center size-7 rounded-full bg-primary/10 text-primary font-bold text-[10px] shrink-0">
                      <RiUser3Line className="size-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground truncate">{grant.userEmail}</p>
                      <p className="text-[10px] text-muted-foreground">
                        Granted {formatDate(grant.createdAt)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Permission switcher */}
                    <select
                      value={grant.permission}
                      onChange={(e) =>
                        handleUpdatePermission(grant.id, e.target.value as "read" | "edit")
                      }
                      className="h-7 text-[11px] rounded-xl border border-input bg-background px-2 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="read">Read</option>
                      <option value="edit">Edit</option>
                    </select>

                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl"
                      title="Revoke access"
                      onClick={() => setConfirmRevokeGrant(grant)}
                      disabled={revokingId === grant.id}
                    >
                      <RiDeleteBinLine className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Revocation Confirmation Dialog Layer */}
        {confirmRevokeGrant && (
          <div className="p-4 rounded-2xl bg-destructive/10 border border-destructive/20 space-y-2 mt-2 animate-in fade-in-50">
            <div className="flex items-center gap-2 text-destructive font-semibold text-xs">
              <RiAlertLine className="size-4" />
              Confirm Access Revocation
            </div>
            <p className="text-xs text-foreground/80">
              Revoke access for <strong>{confirmRevokeGrant.userEmail}</strong>? This user will immediately lose read, download, and edit capabilities.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="xs"
                onClick={() => setConfirmRevokeGrant(null)}
                disabled={!!revokingId}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => handleRevokeGrant(confirmRevokeGrant)}
                disabled={!!revokingId}
                aria-busy={revokingId === confirmRevokeGrant.id}
              >
                {revokingId === confirmRevokeGrant.id ? (
                  <>
                    <Spinner size="xs" className="mr-1.5" />
                    <span>Revoking…</span>
                  </>
                ) : (
                  "Revoke Access"
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Historical Revoked Grants Section */}
        {revokedGrants.length > 0 && (
          <div className="pt-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Historical Revoked Grants ({revokedGrants.length})
            </h4>
            <div className="space-y-1.5 opacity-70">
              {revokedGrants.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center justify-between p-2 rounded-xl border border-dashed border-border/80 bg-muted/20 text-[11px]"
                >
                  <span className="truncate max-w-[200px] text-muted-foreground">{grant.userEmail}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                      {grant.permission}
                    </Badge>
                    <span className="text-[10px] text-destructive">
                      Revoked {formatDate(grant.revokedAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-muted-foreground/80 pt-2 border-t border-border/60">
          Note: Revoking access immediately prevents any subsequent downloads or API access. Revocation does not retroactively delete local copies already saved by recipients.
        </div>
      </DialogContent>
    </Dialog>
  );
}
