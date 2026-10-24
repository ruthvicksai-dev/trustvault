import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/auth-context";
import { authApi } from "@/lib/api";
import { RiUser3Line, RiAlertLine, RiCheckLine, RiShieldCheckLine } from "@remixicon/react";

interface EditProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditProfileDialog({ open, onOpenChange }: EditProfileDialogProps) {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (open && user) {
      setDisplayName(user.displayName || "");
      setError(null);
      setSuccess(null);
    }
  }, [open, user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmed = displayName.trim();
    if (trimmed.length > 100) {
      setError("Display name must not exceed 100 characters.");
      return;
    }

    if (/<[^>]*>|javascript:/i.test(trimmed)) {
      setError("Display name cannot contain HTML entities or script tags.");
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.updateProfile({
        displayName: trimmed.length > 0 ? trimmed : null,
      });
      setSuccess(res.message || "Profile updated successfully.");
      await refreshUser();
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(null);
      }, 1500);
    } catch (err: any) {
      setError(err?.message || "Failed to update profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <RiUser3Line className="size-5" />
            <DialogTitle>Edit Profile Metadata</DialogTitle>
          </div>
          <DialogDescription>
            Update your account display name. Privileged fields (role, email, account status) are managed by system administrators.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-sm border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-sm border border-emerald-500/20">
            <RiCheckLine className="size-4 shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Read-Only Account Email */}
          <div className="space-y-1.5">
            <Label htmlFor="profile-email" className="text-xs text-muted-foreground">
              Account Email (Immutable)
            </Label>
            <Input
              id="profile-email"
              value={user.email}
              disabled
              className="bg-muted/50 cursor-not-allowed text-xs text-muted-foreground"
            />
          </div>

          {/* Read-Only Role & Status */}
          <div className="flex items-center gap-4 py-1">
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground block">Assigned Role</span>
              <Badge variant="secondary" className="uppercase text-[10px] tracking-wider font-bold">
                {user.role}
              </Badge>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground block">Account Status</span>
              <Badge
                variant="outline"
                className={`text-[10px] capitalize font-medium ${
                  user.status === "active"
                    ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                    : "bg-destructive/10 text-destructive border-destructive/20"
                }`}
              >
                {user.status}
              </Badge>
            </div>
          </div>

          {/* Editable Display Name */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="display-name" className="text-xs font-semibold">
                Display Name
              </Label>
              <span className="text-[10px] text-muted-foreground">
                {displayName.length}/100
              </span>
            </div>
            <Input
              id="display-name"
              placeholder="e.g. Jane Doe or Alice Chen (Engineering)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={loading}
              maxLength={100}
              className="text-xs"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              Shown across the platform on shared documents and navigation.
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={loading}>
              {loading ? (
                <>
                  <Spinner size="xs" className="mr-1.5" />
                  Saving…
                </>
              ) : (
                "Save Profile"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
