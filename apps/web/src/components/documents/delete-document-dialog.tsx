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
import { documentsApi } from "@/lib/api";
import type { DocumentItem } from "@/types";
import { RiDeleteBinLine, RiAlertLine } from "@remixicon/react";

interface DeleteDocumentDialogProps {
  document: DocumentItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (id: string) => void;
}

export function DeleteDocumentDialog({
  document,
  open,
  onOpenChange,
  onSuccess,
}: DeleteDocumentDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!document) return null;

  const handleDelete = async () => {
    setError(null);
    setLoading(true);
    try {
      await documentsApi.delete(document.id);
      onSuccess(document.id);
      onOpenChange(false);
    } catch (err: any) {
      setError(err?.message || "Failed to delete document. Ensure you are the document owner.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-destructive mb-1">
            <RiDeleteBinLine className="size-5" />
            <DialogTitle>Delete Document</DialogTitle>
          </div>
          <DialogDescription>
            Are you sure you want to delete <strong>&ldquo;{document.title}&rdquo;</strong>? This document will be soft-deleted, active grants will no longer grant access, and the deletion will be logged in the immutable audit trail.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-sm border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? "Deleting…" : "Delete Document"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
