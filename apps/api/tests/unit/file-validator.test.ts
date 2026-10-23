import { describe, it, expect } from "vitest";
import {
  validateFilename,
  sanitizeFilenameForHeader,
  detectMimeTypeFromBuffer,
  validateUploadedBuffer,
  MAX_DOCUMENT_FILE_SIZE,
} from "../../src/documents/file-validator.js";

describe("Document File Validator (Unit)", () => {
  describe("Filename Validation & Control Character Mitigation", () => {
    it("accepts safe document filenames", () => {
      const res = validateFilename("Annual-Report-2026.pdf");
      expect(res.valid).toBe(true);
    });

    it("rejects filenames with null bytes or invalid control characters", () => {
      expect(validateFilename("malicious\0file.pdf").valid).toBe(false);
      expect(validateFilename("payload\x1fbad.pdf").valid).toBe(false);
      expect(validateFilename("line\nbreak.pdf").valid).toBe(false);
      expect(validateFilename("tab\tchar.pdf").valid).toBe(false);
    });

    it("handles undefined or empty filename safely", () => {
      expect(validateFilename(undefined).valid).toBe(true);
    });
  });

  describe("HTTP Header Sanitization (Anti-Response Splitting)", () => {
    it("sanitizes filenames for Content-Disposition header safely", () => {
      const result = sanitizeFilenameForHeader("Quarterly_Report_2026.pdf");
      expect(result.asciiFilename).toBe("Quarterly_Report_2026.pdf");
      expect(result.headerValue).toContain('filename="Quarterly_Report_2026.pdf"');
    });

    it("strips newline and carriage return characters to prevent header injection", () => {
      const result = sanitizeFilenameForHeader("Report\r\nSet-Cookie: evil=session\r\n.pdf");
      expect(result.headerValue).not.toContain("\r");
      expect(result.headerValue).not.toContain("\n");
      // Verify header value remains safely on a single line
      expect(result.headerValue.split("\n")).toHaveLength(1);
    });

    it("strips quote characters that could break out of header parameter strings", () => {
      const result = sanitizeFilenameForHeader('test"filename".pdf');
      expect(result.asciiFilename).not.toContain('"');
    });
  });

  describe("Magic Byte MIME Type Verification", () => {
    it("detects PDF magic bytes (%PDF-)", () => {
      const pdfBuffer = Buffer.from("%PDF-1.7\n%fake-pdf-content");
      const detected = detectMimeTypeFromBuffer(pdfBuffer);
      expect(detected).toBe("application/pdf");
    });

    it("detects PNG magic bytes", () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const detected = detectMimeTypeFromBuffer(pngBuffer);
      expect(detected).toBe("image/png");
    });

    it("detects JPEG magic bytes", () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const detected = detectMimeTypeFromBuffer(jpegBuffer);
      expect(detected).toBe("image/jpeg");
    });

    it("returns null for unrecognized binary formats", () => {
      const randomBuffer = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]);
      const detected = detectMimeTypeFromBuffer(randomBuffer);
      expect(detected).toBeNull();
    });
  });

  describe("Uploaded Buffer Security Validation", () => {
    it("accepts authentic PDF buffer with matching declared MIME and filename", () => {
      const pdfBuffer = Buffer.from("%PDF-1.7\n%valid-content");
      const res = validateUploadedBuffer({
        buffer: pdfBuffer,
        declaredMimeType: "application/pdf",
        originalFilename: "valid-doc.pdf",
      });

      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.mimeType).toBe("application/pdf");
        expect(res.extension).toBe("pdf");
      }
    });

    it("rejects file exceeding size limit (10MB)", () => {
      const oversized = Buffer.alloc(MAX_DOCUMENT_FILE_SIZE + 1);
      const res = validateUploadedBuffer({
        buffer: oversized,
        declaredMimeType: "application/pdf",
      });

      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.statusCode).toBe(413);
        expect(res.error).toContain("exceeds maximum permitted limit");
      }
    });

    it("rejects MIME spoofing where declared type does not match magic bytes", () => {
      // Disguise shell script / random binary as PDF
      const fakePdf = Buffer.from("#!/bin/bash\necho evil");
      const res = validateUploadedBuffer({
        buffer: fakePdf,
        declaredMimeType: "application/pdf",
        originalFilename: "trojan.pdf",
      });

      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.statusCode).toBe(400);
      }
    });
  });
});
