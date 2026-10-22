import path from "node:path";

/**
 * Maximum permitted document file size: 10 MiB.
 * Enforced during upload streaming and before persistence.
 */
export const MAX_DOCUMENT_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Explicit allowlist of supported MIME types for TrustVault documents.
 */
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
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const MIME_TO_EXTENSION: Record<AllowedMimeType, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/**
 * Inspects buffer headers and content to detect genuine MIME type.
 * Never trusts client headers or file extensions.
 */
export function detectMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  // 1. PDF: starts with %PDF- (0x25 0x50 0x44 0x46 0x2D)
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return "application/pdf";
  }

  // 2. PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // 3. JPEG: 0xFF 0xD8 0xFF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  // 4. WebP: 0x52 0x49 0x46 0x46 (RIFF) at 0..3 and 0x57 0x45 0x42 0x50 (WEBP) at 8..11
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // 5. Office OpenXML / ZIP: 0x50 0x4B 0x03 0x04 (PK..)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    // Return base zip / office format
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  // Reject executable formats explicitly:
  // DOS MZ executable
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return "application/x-dosexec";
  }
  // ELF binary
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return "application/x-executable";
  }

  // 6. Text-based formats: Check for presence of binary null bytes and non-printable control characters
  // A genuine plain text file contains printable UTF-8 or standard whitespace (\t, \n, \r).
  // Any byte 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, or 0x7F indicates binary data.
  const sampleSize = Math.min(buffer.length, 8192);
  let isBinary = false;
  for (let i = 0; i < sampleSize; i++) {
    const b = buffer[i];
    if (
      b === 0x00 ||
      b < 0x09 ||
      b === 0x0b ||
      b === 0x0c ||
      (b >= 0x0e && b <= 0x1f) ||
      b === 0x7f
    ) {
      isBinary = true;
      break;
    }
  }

  if (!isBinary) {
    try {
      const textSample = buffer.subarray(0, sampleSize).toString("utf8");

      // Reject dangerous script tags disguised in text
      const lower = textSample.toLowerCase();
      if (
        lower.includes("<script") ||
        lower.includes("<?php") ||
        lower.startsWith("#!/bin/") ||
        lower.includes("<html")
      ) {
        return "application/x-untrusted-script";
      }

      // Check for JSON structure across full buffer (Finding F)
      if (isCandidateJson(buffer)) {
        try {
          JSON.parse(buffer.toString("utf8"));
          return "application/json";
        } catch {
          // If parsing fails, fall through without marking as application/json
        }
      }

      return "text/plain";
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks whether the buffer matches JSON framing (starts with { or [ and ends with } or ])
 * while accounting for UTF-8 BOM and leading/trailing whitespace.
 */
function isCandidateJson(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let start = 0;
  // Skip UTF-8 BOM if present (0xEF 0xBB 0xBF)
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    start = 3;
  }
  // Find first non-whitespace byte
  while (
    start < buffer.length &&
    (buffer[start] === 0x20 || buffer[start] === 0x09 || buffer[start] === 0x0a || buffer[start] === 0x0d)
  ) {
    start++;
  }
  if (start >= buffer.length) return false;
  const firstByte = buffer[start];
  if (firstByte !== 0x7b && firstByte !== 0x5b) {
    return false;
  }

  // Find last non-whitespace byte
  let end = buffer.length - 1;
  while (
    end > start &&
    (buffer[end] === 0x20 || buffer[end] === 0x09 || buffer[end] === 0x0a || buffer[end] === 0x0d)
  ) {
    end--;
  }
  const lastByte = buffer[end];
  if (firstByte === 0x7b && lastByte === 0x7d) return true; // { ... }
  if (firstByte === 0x5b && lastByte === 0x5d) return true; // [ ... ]
  return false;
}

/**
 * Validates that a filename does not contain null bytes or invalid control characters.
 * Rejection boundary for Finding H.
 */
export function validateFilename(filename?: string): { valid: true } | { valid: false; error: string } {
  if (!filename) return { valid: true };
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    return {
      valid: false,
      error: "Filename contains invalid control characters or null bytes",
    };
  }
  return { valid: true };
}

export interface ValidationSuccess {
  valid: true;
  mimeType: AllowedMimeType;
  extension: string;
  sizeBytes: number;
}

export interface ValidationFailure {
  valid: false;
  error: string;
  statusCode: 400 | 413 | 415;
}

export type FileValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validates file content, sizes, and MIME signatures against strict security policies.
 */
export function validateUploadedBuffer(params: {
  buffer: Buffer;
  declaredMimeType?: string;
  originalFilename?: string;
}): FileValidationResult {
  const { buffer, declaredMimeType, originalFilename } = params;

  // 1. Filename validation (Finding H: reject null bytes and control chars upfront)
  if (originalFilename) {
    const fnCheck = validateFilename(originalFilename);
    if (!fnCheck.valid) {
      return {
        valid: false,
        error: fnCheck.error,
        statusCode: 400,
      };
    }
  }

  // 2. Empty file validation
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      error: "Document content cannot be empty",
      statusCode: 400,
    };
  }

  // 3. Maximum size validation (10 MiB limit)
  if (buffer.length > MAX_DOCUMENT_FILE_SIZE) {
    return {
      valid: false,
      error: `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds maximum permitted limit of 10 MB`,
      statusCode: 413,
    };
  }

  // 4. Inspect genuine content signature
  const detectedMime = detectMimeTypeFromBuffer(buffer);

  // Normalize declared MIME if provided
  const declared = declaredMimeType?.trim().toLowerCase();

  // 5. Generic binary policy (Finding G): application/octet-stream is NEVER allowed as the final type
  // and MUST be independently verified as an allowlisted document type.
  if (declared === "application/octet-stream") {
    if (!detectedMime || !ALLOWED_MIME_TYPES.includes(detectedMime as AllowedMimeType)) {
      return {
        valid: false,
        error:
          "Unsupported file type: generic binary data (application/octet-stream) cannot be verified as an allowed document format",
        statusCode: 400,
      };
    }
  }

  if (!detectedMime) {
    return {
      valid: false,
      error: "Unsupported or unrecognized file format",
      statusCode: 400,
    };
  }

  // 5. Reject active scripts and executables
  if (
    detectedMime === "application/x-dosexec" ||
    detectedMime === "application/x-executable" ||
    detectedMime === "application/x-untrusted-script"
  ) {
    return {
      valid: false,
      error: "Executable or active script content is strictly forbidden",
      statusCode: 400,
    };
  }

  // 6. Allowlist check
  if (
    declared &&
    !ALLOWED_MIME_TYPES.includes(declared as AllowedMimeType) &&
    declared !== "application/octet-stream"
  ) {
    return {
      valid: false,
      error: `Declared MIME type '${declared}' is not in the allowed document types list`,
      statusCode: 400,
    };
  }

  // 8. JSON document validation (Finding F): reject malformed JSON if declared as application/json or named .json
  const isDeclaredOrNamedJson =
    declared === "application/json" ||
    (originalFilename && originalFilename.toLowerCase().endsWith(".json"));

  if (isDeclaredOrNamedJson && detectedMime !== "application/json") {
    return {
      valid: false,
      error: "Malformed or invalid JSON document: content cannot be parsed as valid JSON",
      statusCode: 400,
    };
  }

  // 9. Signature consistency verification
  if (declared && declared !== "application/octet-stream") {
    const isBinaryMatch =
      (declared === "application/pdf" && detectedMime === "application/pdf") ||
      (declared === "image/png" && detectedMime === "image/png") ||
      (declared === "image/jpeg" && detectedMime === "image/jpeg") ||
      (declared === "image/webp" && detectedMime === "image/webp") ||
      (declared.startsWith("application/vnd.openxmlformats-") &&
        detectedMime.startsWith("application/vnd.openxmlformats-"));

    const isTextMatch =
      (declared === "text/plain" ||
        declared === "text/markdown" ||
        declared === "text/csv") &&
      (detectedMime === "text/plain" || detectedMime === "application/json");

    const isJsonMatch =
      declared === "application/json" && detectedMime === "application/json";

    if (!isBinaryMatch && !isTextMatch && !isJsonMatch) {
      return {
        valid: false,
        error: `File signature mismatch: declared '${declared}' does not match detected content signature '${detectedMime}'`,
        statusCode: 400,
      };
    }
  }

  // Choose resolved MIME type
  let resolvedMime: AllowedMimeType;
  if (declared === "application/octet-stream") {
    resolvedMime = detectedMime as AllowedMimeType;
  } else if (declared && ALLOWED_MIME_TYPES.includes(declared as AllowedMimeType)) {
    resolvedMime = declared as AllowedMimeType;
  } else if (ALLOWED_MIME_TYPES.includes(detectedMime as AllowedMimeType)) {
    resolvedMime = detectedMime as AllowedMimeType;
  } else {
    return {
      valid: false,
      error: "Unsupported file format: content does not match any allowed document type",
      statusCode: 400,
    };
  }

  // Derive extension
  let extension = MIME_TO_EXTENSION[resolvedMime] || "bin";
  if (originalFilename) {
    const ext = path.extname(originalFilename).replace(/^\./, "").toLowerCase();
    if (ext && /^[a-z0-9]{1,5}$/.test(ext)) {
      // Validate that extension doesn't conflict with binary MIME (e.g., .exe for PDF)
      if (
        (resolvedMime === "application/pdf" && ext === "pdf") ||
        (resolvedMime === "image/png" && ext === "png") ||
        (resolvedMime === "image/jpeg" && (ext === "jpg" || ext === "jpeg")) ||
        (resolvedMime === "image/webp" && ext === "webp") ||
        (resolvedMime === "text/plain" && (ext === "txt" || ext === "log")) ||
        (resolvedMime === "text/markdown" && (ext === "md" || ext === "markdown")) ||
        (resolvedMime === "text/csv" && ext === "csv") ||
        (resolvedMime === "application/json" && ext === "json")
      ) {
        extension = ext;
      }
    }
  }

  return {
    valid: true,
    mimeType: resolvedMime,
    extension,
    sizeBytes: buffer.length,
  };
}

/**
 * Sanitizes filename to prevent path traversal, null bytes, and HTTP response splitting.
 * Produces safe Content-Disposition header values complying with RFC 6266 and RFC 5987.
 */
export function sanitizeFilenameForHeader(rawFilename: string): {
  asciiFilename: string;
  rfc5987Filename: string;
  headerValue: string;
} {
  // 1. Strip null bytes, CR, LF, and control characters
  let clean = rawFilename.replace(/[\x00-\x1f\x7f]/g, "").trim();

  // 2. Strip directory traversal characters
  clean = path.basename(clean);

  // 3. Fallback if empty or stripped completely
  if (!clean || clean.length === 0) {
    clean = "document";
  }

  // 4. Truncate to maximum safe length (120 chars)
  if (clean.length > 120) {
    const ext = path.extname(clean);
    const base = path.basename(clean, ext);
    clean = base.substring(0, 120 - ext.length) + ext;
  }

  // 5. Create ASCII-safe filename (replace non-ASCII and double quotes with underscores)
  const asciiFilename = clean.replace(/[^a-zA-Z0-9._-]/g, "_");

  // 6. Create RFC 5987 UTF-8 encoded filename for modern browsers
  const rfc5987Filename = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

  const headerValue = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${rfc5987Filename}`;

  return {
    asciiFilename,
    rfc5987Filename,
    headerValue,
  };
}
