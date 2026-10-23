import React, { useState } from "react";
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
import { authApi } from "@/lib/api";
import { RiLockPasswordLine, RiAlertLine, RiCheckLine } from "@remixicon/react";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!currentPassword) {
      setError("Current password is required.");
      return;
    }

    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters long.");
      return;
    }

    if (newPassword.length > 128) {
      setError("New password must not exceed 128 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("New password confirmation does not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.changePassword({
        currentPassword,
        newPassword,
      });
      setSuccess(res.message || "Password changed successfully! All other sessions have been invalidated.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => {
        onOpenChange(false);
        setSuccess(null);
      }, 2500);
    } catch (err: any) {
      setError(err?.message || "Failed to change password. Please check your current password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <RiLockPasswordLine className="size-5" />
            <DialogTitle>Change Account Password</DialogTitle>
          </div>
          <DialogDescription>
            Enter your current password and choose a secure new password (min. 12 characters). For security, all other active sessions will be revoked.
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

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••••••"
              disabled={loading}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min. 12 characters"
              disabled={loading}
              required
              minLength={12}
              maxLength={128}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm New Password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              disabled={loading}
              required
            />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Updating..." : "Update Password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
