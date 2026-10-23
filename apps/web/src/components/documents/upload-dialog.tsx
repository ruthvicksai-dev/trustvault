import React, { useState, useRef } from "react";
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
import {
  formatBytes,
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  getMimeLabel,
} from "@/lib/utils";
import {
  RiUploadCloud2Line,
  RiFileTextLine,
  RiAlertLine,
  RiCheckLine,
  RiCloseLine,
} from "@remixicon/react";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function UploadDialog({ open, onOpenChange, onSuccess }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Confidential");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setFile(null);
    setTitle("");
    setCategory("Confidential");
    setError(null);
    setLoading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const selected = e.target.files?.[0];
    if (!selected) return;

    if (selected.size > MAX_FILE_SIZE_BYTES) {
      setError(`File size (${formatBytes(selected.size)}) exceeds maximum limit of 10 MB.`);
      setFile(null);
      return;
    }

    setFile(selected);
    if (!title) {
      // Clean extension off default title
      const cleanName = selected.name.replace(/\.[^/.]+$/, "");
      setTitle(cleanName);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError("Please select a file to upload.");
      return;
    }

    if (!title.trim()) {
      setError("Document title is required.");
      return;
    }

    if (!category.trim()) {
      setError("Category is required.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", title.trim());
    formData.append("category", category.trim());

    setLoading(true);
    try {
      await documentsApi.upload(formData);
      resetForm();
      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      setError(err?.message || "Failed to upload document. Ensure file type and size are permitted.");
    } finally {
      setLoading(false);
    }
  };

  const categoryPresets = ["Confidential", "Financial", "Legal", "Security", "Operations", "HR"];

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        if (!loading) {
          if (!val) resetForm();
          onOpenChange(val);
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <RiUploadCloud2Line className="size-5" />
            <DialogTitle>Upload Secure Document</DialogTitle>
          </div>
          <DialogDescription>
            Files are stored in private encrypted storage with per-document authorization. Maximum file size is 10 MB.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-sm border border-destructive/20 animate-in fade-in-50">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          {/* File Picker Drag & Drop / Button Area */}
          <div className="space-y-1.5">
            <Label>Document File</Label>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ALLOWED_UPLOAD_EXTENSIONS.join(",")}
              onChange={handleFileChange}
              disabled={loading}
            />

            {!file ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-border rounded-3xl hover:border-primary/50 hover:bg-muted/40 transition-colors cursor-pointer text-center group"
              >
                <div className="flex items-center justify-center size-10 rounded-2xl bg-muted group-hover:bg-primary/10 group-hover:text-primary transition-colors text-muted-foreground mb-2">
                  <RiUploadCloud2Line className="size-5" />
                </div>
                <p className="text-xs font-semibold text-foreground">Click to browse or drop file</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  PDF, DOCX, XLSX, PNG, JPG, WEBP, TXT, CSV, JSON (max 10 MB)
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-between p-3.5 rounded-2xl border border-border bg-card">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex items-center justify-center size-8 rounded-xl bg-primary/10 text-primary shrink-0">
                    <RiFileTextLine className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">{file.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatBytes(file.size)} • {getMimeLabel(file.type || "file")}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  disabled={loading}
                >
                  <RiCloseLine className="size-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Title Input */}
          <div className="space-y-1.5">
            <Label htmlFor="upload-title">Document Title</Label>
            <Input
              id="upload-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q4 Financial Audit Report"
              maxLength={200}
              disabled={loading}
              required
            />
          </div>

          {/* Category Input & Quick Presets */}
          <div className="space-y-1.5">
            <Label htmlFor="upload-category">Category</Label>
            <Input
              id="upload-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Financial, Legal, Confidential"
              maxLength={100}
              disabled={loading}
              required
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {categoryPresets.map((cat) => (
                <button
                  type="button"
                  key={cat}
                  onClick={() => setCategory(cat)}
                  disabled={loading}
                  className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
                    category === cat
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/40 hover:bg-muted text-muted-foreground border-border"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <DialogFooter className="pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !file}>
              {loading ? "Encrypting & Uploading…" : "Upload Document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
