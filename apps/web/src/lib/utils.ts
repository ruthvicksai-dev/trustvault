export { cn } from "cn";

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return dateString;
  }
}

export function getMimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "PDF",
    "image/png": "PNG Image",
    "image/jpeg": "JPEG Image",
    "image/webp": "WebP Image",
    "text/plain": "Plain Text",
    "text/markdown": "Markdown",
    "text/csv": "CSV",
    "application/json": "JSON",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word Doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel Sheet",
  };
  return map[mimeType] || mimeType.split("/")[1]?.toUpperCase() || mimeType;
}

export const ALLOWED_UPLOAD_EXTENSIONS = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
];

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
