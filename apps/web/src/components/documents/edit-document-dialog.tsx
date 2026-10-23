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
import { documentsApi } from "@/lib/api";
import type { DocumentItem } from "@/types";
import { RiEditLine, RiAlertLine } from "@remixicon/react";

interface EditDocumentDialogProps {
  document: DocumentItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (updated: DocumentItem) => void;
}

export function EditDocumentDialog({
  document,
  open,
  onOpenChange,
  onSuccess,
}: EditDocumentDialogProps) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (document) {
      setTitle(document.title);
      setCategory(document.category);
      setError(null);
    }
  }, [document, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!document) return;
    setError(null);

    const trimmedTitle = title.trim();
    const trimmedCategory = category.trim();

    if (!trimmedTitle) {
      setError("Document title cannot be empty.");
      return;
    }
    if (!trimmedCategory) {
      setError("Category cannot be empty.");
      return;
    }

    setLoading(true);
    try {
      const res = await documentsApi.update(document.id, {
        title: trimmedTitle,
        category: trimmedCategory,
      });
      onSuccess(res.document);
      onOpenChange(false);
    } catch (err: any) {
      setError(err?.message || "Failed to update document metadata.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <RiEditLine className="size-5" />
            <DialogTitle>Edit Document Metadata</DialogTitle>
          </div>
          <DialogDescription>
            Modify the document title or category. Changes are recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-sm border border-destructive/20">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="edit-title">Document Title</Label>
            <Input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              maxLength={200}
              disabled={loading}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-category">Category</Label>
            <Input
              id="edit-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Category"
              maxLength={100}
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
              {loading ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
