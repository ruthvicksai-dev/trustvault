import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/auth/argon2.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { finished } from "node:stream/promises";
import {
  setStorageDriver,
  InMemoryStorageDriver,
  reconcileOrphanedObjects,
} from "../../src/documents/storage.js";
import { validateFilename, sanitizeFilenameForHeader } from "../../src/documents/file-validator.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

interface TestSession {
  user: {
    id: string;
    email: string;
    role: "admin" | "owner" | "viewer";
  };
  cookie: string[];
  csrfToken: string;
}

describe("TrustVault — Phase 6: Document Lifecycle, Validation, and Storage Security", () => {
  const memoryStorage = new InMemoryStorageDriver();
  let sharedPasswordHash: string;
  const createdTestEmails: string[] = [];
  const createdDocumentIds: string[] = [];

  function uniqueEmail(prefix: string): string {
    return `test-${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@vault.test`;
  }

  beforeAll(async () => {
    setStorageDriver(memoryStorage);
    sharedPasswordHash = await hashPassword("lifecycle-secure-pass-123");
  });

  afterAll(async () => {
    if (createdDocumentIds.length > 0) {
      await pool.query(
        "DELETE FROM public.document_grants WHERE document_id = ANY($1)",
        [createdDocumentIds]
      );
      await pool.query(
        "DELETE FROM public.audit_events WHERE document_id = ANY($1)",
        [createdDocumentIds]
      );
      await pool.query(
        "DELETE FROM public.documents WHERE id = ANY($1)",
        [createdDocumentIds]
      );
    }

    if (createdTestEmails.length > 0) {
      // Clean up any documents and grants owned by created test users to satisfy foreign key constraints
      await pool.query(
        `DELETE FROM public.document_grants WHERE document_id IN (
           SELECT id FROM public.documents WHERE owner_id IN (
             SELECT id FROM public.users WHERE email = ANY($1)
           )
         )`,
        [createdTestEmails]
      );
      await pool.query(
        `DELETE FROM public.audit_events WHERE document_id IN (
           SELECT id FROM public.documents WHERE owner_id IN (
             SELECT id FROM public.users WHERE email = ANY($1)
           )
         )`,
        [createdTestEmails]
      );
      await pool.query(
        `DELETE FROM public.documents WHERE owner_id IN (
           SELECT id FROM public.users WHERE email = ANY($1)
         )`,
        [createdTestEmails]
      );

      await pool.query(
        `DELETE FROM public.sessions
         WHERE (sess::jsonb)->>'userId' IN (
           SELECT id::text FROM public.users WHERE email = ANY($1)
         )`,
        [createdTestEmails]
      );
      await pool.query(
        "DELETE FROM public.audit_events WHERE actor_id IN (SELECT id FROM public.users WHERE email = ANY($1))",
        [createdTestEmails]
      );
      await pool.query(
        "DELETE FROM public.users WHERE email = ANY($1)",
        [createdTestEmails]
      );
    }

    await pool.end();
  });

  async function createSession(
    role: "owner" | "viewer" | "admin" = "owner",
    status: "active" | "disabled" = "active"
  ): Promise<TestSession> {
    const email = uniqueEmail(role);
    createdTestEmails.push(email);

    const insertRes = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, status`,
      [email, sharedPasswordHash, role, status]
    );

    const user = insertRes.rows[0];

    const loginRes = await request(app)
      .post("/api/auth/login")
      .set("Origin", TRUSTED_ORIGIN)
      .send({ email, password: "lifecycle-secure-pass-123" });

    const cookie = loginRes.headers["set-cookie"] as unknown as string[];

    const csrfRes = await request(app)
      .get("/api/auth/csrf-token")
      .set("Cookie", cookie);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      cookie,
      csrfToken: csrfRes.body.csrfToken,
    };
  }

  /* ──────────────────────────────────────────────────────────────────────────
     1. UPLOAD VALIDATION & ADVERSARIAL REJECTION
  ────────────────────────────────────────────────────────────────────────── */
  describe("1. Upload Validation & Adversarial Rejection", () => {
    it("Successfully uploads a valid PDF document via multipart/form-data streaming", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Confidential Report\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Annual Financial Audit")
        .field("category", "Finance")
        .attach("file", pdfBuffer, "audit-report.pdf");

      expect(res.status).toBe(201);
      expect(res.body.message).toBe("Document created successfully");
      expect(res.body.document.title).toBe("Annual Financial Audit");
      expect(res.body.document.mimeType).toBe("application/pdf");
      expect(res.body.document.sizeBytes).toBe(pdfBuffer.length);
      expect(res.body.document.storage_key).toBeUndefined(); // Storage key strictly omitted

      createdDocumentIds.push(res.body.document.id);
    });

    it("Successfully uploads a valid PNG image document via multipart/form-data", async () => {
      const owner = await createSession("owner");
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Infrastructure Diagram")
        .field("category", "Architecture")
        .attach("file", pngBuffer, "diagram.png");

      expect(res.status).toBe(201);
      expect(res.body.document.mimeType).toBe("image/png");
      createdDocumentIds.push(res.body.document.id);
    });

    it("Rejects empty file upload with 400 Bad Request", async () => {
      const owner = await createSession("owner");
      const emptyBuffer = Buffer.alloc(0);

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Empty Document Test")
        .field("category", "Testing")
        .attach("file", emptyBuffer, "empty.pdf");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("cannot be empty");
    });

    it("Rejects file exceeding the 10 MB maximum size limit with 413 Payload Too Large", async () => {
      const owner = await createSession("owner");
      // 10 MB + 1024 bytes
      const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024);
      // Write valid PDF header so signature is valid, but size is oversized
      oversizedBuffer.write("%PDF-1.4\n");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Oversized Document")
        .field("category", "Testing")
        .attach("file", oversizedBuffer, "large.pdf");

      expect(res.status).toBe(413);
      expect(res.body.error).toContain("exceeds maximum permitted limit");
    });

    it("Rejects spoofed MIME type (claims application/pdf but body is non-PDF bytes)", async () => {
      const owner = await createSession("owner");
      const spoofedBuffer = Buffer.from("THIS IS NOT A VALID PDF FILE AT ALL");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Spoofed PDF Test",
          category: "Security",
          content: spoofedBuffer.toString("utf8"),
          mimeType: "application/pdf",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("File signature mismatch");
    });

    it("Rejects file signature mismatch (claims image/png but sends PDF bytes)", async () => {
      const owner = await createSession("owner");
      const pdfBytes = Buffer.from("%PDF-1.4\nMalicious disguised file\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Disguised File")
        .field("category", "Security")
        .attach("file", pdfBytes, { filename: "disguised.png", contentType: "image/png" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("File signature mismatch");
    });

    it("Rejects unsupported executable binaries (DOS MZ header)", async () => {
      const owner = await createSession("owner");
      const mzExecutable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Malware Test")
        .field("category", "Security")
        .attach("file", mzExecutable, "malware.exe");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("forbidden");
    });

    it("Rejects active script injection embedded in text documents (<script> tags)", async () => {
      const owner = await createSession("owner");
      const scriptPayload = Buffer.from("Hello world\n<script>alert('xss')</script>\nGoodbye");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "XSS Payload Document")
        .field("category", "Security")
        .attach("file", scriptPayload, "notes.txt");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("forbidden");
    });

    it("Rejects malformed multipart requests safely", async () => {
      const owner = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .set("Content-Type", "multipart/form-data; boundary=---------------------------corruptedBoundary")
        .send("CORRUPTED_RAW_STREAM_WITHOUT_PROPER_MULTIPART_HEADERS");

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("Rejects missing metadata in multipart request", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%No metadata\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        // Omit category and title
        .attach("file", pdfBuffer, "report.pdf");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });

    it("Rejects client attempts to inject storage_key or owner_id", async () => {
      const owner = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Injected Key Test",
          category: "Operations",
          content: "Valid plain text content",
          storage_key: "attacker-chosen-storage-key.pdf",
          owner_id: "00000000-0000-0000-0000-000000000001",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });

    it("Sanitizes path traversal and malicious filenames on upload and storage key generation", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Traversal filename\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Traversal Test")
        .field("category", "Security")
        .attach("file", pdfBuffer, "../../../etc/passwd.pdf");

      expect(res.status).toBe(201);
      const docId = res.body.document.id;
      createdDocumentIds.push(docId);

      // Verify the storage key in DB is a clean UUID without traversal path
      const dbRes = await pool.query("SELECT storage_key FROM public.documents WHERE id = $1", [docId]);
      const storedKey = dbRes.rows[0].storage_key;
      expect(storedKey).toMatch(/^[0-9a-f-]{36}\.pdf$/);
      expect(storedKey).not.toContain("..");
      expect(storedKey).not.toContain("passwd");
    });

    it("Rejects filenames containing null bytes safely with 400 Bad Request", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Null byte filename\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Null Byte Test")
        .field("category", "Security")
        .attach("file", pdfBuffer, "evil\0.pdf");

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("Detects and validates JSON document smaller than 8 KiB", async () => {
      const owner = await createSession("owner");
      const jsonContent = JSON.stringify({
        project: "TrustVault",
        securityAudit: true,
        features: ["mfa", "rbac", "encryption"],
      });

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Small JSON Config")
        .field("category", "Configuration")
        .attach("file", Buffer.from(jsonContent, "utf8"), "config.json");

      expect(res.status).toBe(201);
      expect(res.body.document.mimeType).toBe("application/json");
      createdDocumentIds.push(res.body.document.id);
    });

    it("Detects and validates JSON documents near the 8 KiB boundary (8191, 8192, 8193 bytes)", async () => {
      const owner = await createSession("owner");

      for (const targetSize of [8191, 8192, 8193]) {
        // Construct valid JSON with exact byte length
        const prefix = '{"title":"BoundaryTest","data":"';
        const suffix = '"}';
        const paddingNeeded = targetSize - (prefix.length + suffix.length);
        expect(paddingNeeded).toBeGreaterThan(0);
        const jsonStr = prefix + "A".repeat(paddingNeeded) + suffix;
        expect(Buffer.byteLength(jsonStr, "utf8")).toBe(targetSize);

        const res = await request(app)
          .post("/api/documents")
          .set("Origin", TRUSTED_ORIGIN)
          .set("Cookie", owner.cookie)
          .set("x-csrf-token", owner.csrfToken)
          .field("title", `Boundary JSON ${targetSize}`)
          .field("category", "Testing")
          .attach("file", Buffer.from(jsonStr, "utf8"), `boundary-${targetSize}.json`);

        expect(res.status).toBe(201);
        expect(res.body.document.mimeType).toBe("application/json");
        createdDocumentIds.push(res.body.document.id);
      }
    });

    it("Detects and validates JSON documents significantly larger than 8 KiB (50 KiB)", async () => {
      const owner = await createSession("owner");

      // Construct a 50 KiB valid JSON object
      const items: Record<string, string> = {};
      for (let i = 0; i < 500; i++) {
        items[`key_${i}`] = "Value string with descriptive metadata for stress testing large JSON detection";
      }
      const largeJsonStr = JSON.stringify({ configuration: items });
      const buffer = Buffer.from(largeJsonStr, "utf8");
      expect(buffer.length).toBeGreaterThan(40 * 1024);

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Large Config JSON")
        .field("category", "Configuration")
        .attach("file", buffer, "large-config.json");

      expect(res.status).toBe(201);
      expect(res.body.document.mimeType).toBe("application/json");
      expect(res.body.document.sizeBytes).toBe(buffer.length);
      createdDocumentIds.push(res.body.document.id);
    });

    it("Rejects malformed JSON with 400 Bad Request when declared as application/json", async () => {
      const owner = await createSession("owner");
      const malformedJson = '{"title": "Broken JSON without closing braces...';

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Malformed JSON Test",
          category: "Testing",
          content: malformedJson,
          mimeType: "application/json",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Malformed or invalid JSON document");
    });

    it("Rejects malformed JSON with 400 Bad Request when filename has .json extension", async () => {
      const owner = await createSession("owner");
      const malformedJson = '{"broken": [1, 2, 3, ';

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Broken JSON File")
        .field("category", "Testing")
        .attach("file", Buffer.from(malformedJson, "utf8"), "broken.json");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Malformed or invalid JSON document");
    });

    it("Accepts valid PDF declared as application/octet-stream and resolves to application/pdf", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Octet Stream PDF Test\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Octet Stream PDF")
        .field("category", "Testing")
        .attach("file", pdfBuffer, {
          filename: "raw-upload.bin",
          contentType: "application/octet-stream",
        });

      expect(res.status).toBe(201);
      expect(res.body.document.mimeType).toBe("application/pdf");
      createdDocumentIds.push(res.body.document.id);
    });

    it("Accepts valid PNG declared as application/octet-stream and resolves to image/png", async () => {
      const owner = await createSession("owner");
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Octet Stream PNG")
        .field("category", "Testing")
        .attach("file", pngBuffer, {
          filename: "raw-image.bin",
          contentType: "application/octet-stream",
        });

      expect(res.status).toBe(201);
      expect(res.body.document.mimeType).toBe("image/png");
      createdDocumentIds.push(res.body.document.id);
    });

    it("Rejects generic binary data declared as application/octet-stream when signature is not allowlisted", async () => {
      const owner = await createSession("owner");
      // Arbitrary non-matching binary bytes
      const randomBinary = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]);

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Raw Binary Document")
        .field("category", "Testing")
        .attach("file", randomBinary, {
          filename: "data.bin",
          contentType: "application/octet-stream",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("generic binary data (application/octet-stream) cannot be verified");
    });

    it("Rejects filenames containing control characters (CRLF, escape) in JSON payload with 400", async () => {
      const owner = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "CRLF Filename Test",
          category: "Security",
          content: "Valid document text content",
          filename: "malicious\r\ninjected.txt",
        });

      expect(res.status).toBe(400);
      const errMsg = res.body.details?.[0]?.message || res.body.error;
      expect(errMsg).toContain("Filename contains invalid control characters or null bytes");
    });

    it("Accepts valid Unicode filenames and encodes RFC 5987 Content-Disposition header", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Unicode Filename Test\n%%EOF");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Rapport Financier 2026")
        .field("category", "Finance")
        .attach("file", pdfBuffer, "rapport_décembre_2026.pdf");

      expect(res.status).toBe(201);
      const docId = res.body.document.id;
      createdDocumentIds.push(docId);

      // Download document and verify RFC 5987 header encoding
      const dlRes = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", owner.cookie);

      expect(dlRes.status).toBe(200);
      const disposition = dlRes.headers["content-disposition"];
      expect(disposition).toContain("attachment;");
      expect(disposition).toContain("filename=");
      expect(disposition).toContain("filename*=UTF-8''");
    });

    it("Verifies temporary file creation mode 0o600 and exclusive flags (Finding D)", async () => {
      const tempId = crypto.randomUUID();
      const tempPath = path.join(os.tmpdir(), `test-perm-${tempId}.tmp`);
      const ws = fs.createWriteStream(tempPath, { mode: 0o600, flags: "wx" });
      ws.write("test secure permissions data");
      ws.end();
      await finished(ws);

      const stats = await fs.promises.stat(tempPath);
      await fs.promises.unlink(tempPath);

      // On POSIX systems, verify owner-only permissions (0o600)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600);
      }
      expect(stats.size).toBeGreaterThan(0);
    });

    it("Unit tests validateFilename and sanitizeFilenameForHeader (Finding H)", () => {
      // Rejects null bytes and control chars
      expect(validateFilename("file\0.pdf").valid).toBe(false);
      expect(validateFilename("file\r\n.pdf").valid).toBe(false);
      expect(validateFilename("file\x1b.pdf").valid).toBe(false);
      expect(validateFilename("valid_file.pdf").valid).toBe(true);
      expect(validateFilename(undefined).valid).toBe(true);

      // Sanitize header formatting
      const header = sanitizeFilenameForHeader("my report (2026).pdf");
      expect(header.asciiFilename).toBeDefined();
      expect(header.headerValue).toContain("attachment;");
      expect(header.headerValue).toContain("filename=");
      expect(header.headerValue).toContain("filename*=");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     2. STORAGE & PERSISTENCE FAILURE RECOVERY
  ────────────────────────────────────────────────────────────────────────── */
  describe("2. Storage and Persistence Failures & Cleanup", () => {
    it("Does not insert document record if storage upload fails", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Upload Failure Test\n%%EOF");

      memoryStorage.simulateUploadError = new Error("Simulated storage cluster outage");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Storage Outage Document")
        .field("category", "Operations")
        .attach("file", pdfBuffer, "outage.pdf");

      memoryStorage.simulateUploadError = null;

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create document");

      // Verify no document with this title was inserted
      const dbCheck = await pool.query(
        "SELECT id FROM public.documents WHERE title = 'Storage Outage Document' AND owner_id = $1",
        [owner.user.id]
      );
      expect(dbCheck.rows.length).toBe(0);
    });

    it("Cleans up uploaded storage object if database persistence fails", async () => {
      const owner = await createSession("owner");
      const uploadSpy = vi.spyOn(memoryStorage, "upload");
      const deleteSpy = vi.spyOn(memoryStorage, "delete");

      const originalQuery = pool.query.bind(pool);
      const dbSpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any, ...args: any[]) => {
        const text = typeof sql === "string" ? sql : sql?.text || "";
        if (text.includes("INSERT INTO public.documents")) {
          throw new Error("Simulated DB connection failure on insert");
        }
        return (originalQuery as any)(sql, ...args);
      });

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Compensating Cleanup Test",
          category: "Operations",
          content: "Valid document payload",
        });

      dbSpy.mockRestore();

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create document");

      expect(uploadSpy).toHaveBeenCalled();
      const uploadedKey = uploadSpy.mock.calls[uploadSpy.mock.calls.length - 1][0];
      expect(deleteSpy).toHaveBeenCalledWith(uploadedKey);
      expect(memoryStorage.has(uploadedKey)).toBe(false);

      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it("Handles storage cleanup failure safely without crashing or exposing secrets", async () => {
      const owner = await createSession("owner");
      memoryStorage.simulateDeleteError = new Error("Simulated storage delete timeout");

      const originalQuery = pool.query.bind(pool);
      const dbSpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any, ...args: any[]) => {
        const text = typeof sql === "string" ? sql : sql?.text || "";
        if (text.includes("INSERT INTO public.documents")) {
          throw new Error("Simulated DB failure");
        }
        return (originalQuery as any)(sql, ...args);
      });

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Double Fault Test",
          category: "Operations",
          content: "Valid document payload",
        });

      dbSpy.mockRestore();
      memoryStorage.simulateDeleteError = null;

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create document");

      // Verify audit event was logged for storage_cleanup_failed
      const auditRes = await pool.query(
        "SELECT action, outcome, metadata FROM public.audit_events WHERE actor_id = $1 AND action = 'storage_cleanup_failed' ORDER BY occurred_at DESC LIMIT 1",
        [owner.user.id]
      );
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].outcome).toBe("failure");
    });

    it("Reconciles orphaned storage objects when no database document record exists", async () => {
      const orphanKey = "orphaned-object-uuid-test.pdf";
      await memoryStorage.upload(orphanKey, Buffer.from("%PDF-1.4\nOrphaned\n%%EOF"), "application/pdf");
      // Backdate to 30 mins ago so it is outside the default 15m grace period
      memoryStorage.setCreatedAt(orphanKey, new Date(Date.now() - 30 * 60 * 1000));
      expect(memoryStorage.has(orphanKey)).toBe(true);

      const report = await reconcileOrphanedObjects(memoryStorage, pool);
      expect(report.scanned).toBeGreaterThan(0);
      expect(report.reconciled).toContain(orphanKey);
      expect(memoryStorage.has(orphanKey)).toBe(false);
    });

    it("Safely paginates across multiple pages during reconciliation (Finding A)", async () => {
      // Create 12 orphan objects
      const orphanKeys: string[] = [];
      const pastDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      for (let i = 0; i < 12; i++) {
        const key = `multi-page-orphan-${i}-${Date.now()}.pdf`;
        orphanKeys.push(key);
        await memoryStorage.upload(key, Buffer.from("%PDF-1.4\nMultiPage\n%%EOF"), "application/pdf");
        memoryStorage.setCreatedAt(key, pastDate);
      }

      // Reconcile with batchSize: 4 (will require 3 full pages + 1 final check)
      const report = await reconcileOrphanedObjects(memoryStorage, pool, {
        batchSize: 4,
        gracePeriodMs: 0,
      });

      expect(report.scanned).toBeGreaterThanOrEqual(12);
      for (const key of orphanKeys) {
        expect(report.reconciled).toContain(key);
        expect(memoryStorage.has(key)).toBe(false);
      }
    });

    it("Returns zero deletions and zero errors for an empty storage bucket (Finding A)", async () => {
      // Clear all items in memory storage
      memoryStorage.clear();

      const report = await reconcileOrphanedObjects(memoryStorage, pool, { gracePeriodMs: 0 });
      expect(report.scanned).toBe(0);
      expect(report.reconciled.length).toBe(0);
      expect(report.errors.length).toBe(0);
    });

    it("Aborts reconciliation and deletes ZERO objects if pagination fails (Finding A)", async () => {
      // Populate 5 orphan objects
      const pastDate = new Date(Date.now() - 30 * 60 * 1000);
      const keys = ["fail-test-1.pdf", "fail-test-2.pdf", "fail-test-3.pdf"];
      for (const k of keys) {
        await memoryStorage.upload(k, Buffer.from("%PDF-1.4\nTest\n%%EOF"), "application/pdf");
        memoryStorage.setCreatedAt(k, pastDate);
      }

      // Simulate a list error on the storage driver
      memoryStorage.simulateListError = new Error("Storage cluster list timeout at page boundary");

      const report = await reconcileOrphanedObjects(memoryStorage, pool, { gracePeriodMs: 0 });

      // Clean up simulated error immediately
      memoryStorage.simulateListError = null;

      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors[0]).toContain("Storage cluster list timeout");
      // Critical invariant: zero objects must be deleted when listing fails
      expect(report.reconciled.length).toBe(0);
      for (const k of keys) {
        expect(memoryStorage.has(k)).toBe(true);
        // Clean up
        await memoryStorage.delete(k);
      }
    });

    it("Mitigates reconciliation races by preserving in-flight uploads within the grace period (Finding B)", async () => {
      const inFlightKey = `inflight-upload-${Date.now()}.pdf`;
      const oldOrphanKey = `old-orphan-${Date.now()}.pdf`;

      // 1. inFlightKey uploaded just now (0 minutes ago)
      await memoryStorage.upload(inFlightKey, Buffer.from("%PDF-1.4\nInFlight\n%%EOF"), "application/pdf");

      // 2. oldOrphanKey uploaded 30 minutes ago
      await memoryStorage.upload(oldOrphanKey, Buffer.from("%PDF-1.4\nOld\n%%EOF"), "application/pdf");
      memoryStorage.setCreatedAt(oldOrphanKey, new Date(Date.now() - 30 * 60 * 1000));

      // Reconcile with 15-minute grace period
      const report = await reconcileOrphanedObjects(memoryStorage, pool, {
        gracePeriodMs: 15 * 60 * 1000,
      });

      // In-flight upload is preserved because age < 15 minutes
      expect(report.reconciled).not.toContain(inFlightKey);
      expect(memoryStorage.has(inFlightKey)).toBe(true);

      // Old orphan is purged because age >= 15 minutes
      expect(report.reconciled).toContain(oldOrphanKey);
      expect(memoryStorage.has(oldOrphanKey)).toBe(false);

      // Clean up in-flight test key
      await memoryStorage.delete(inFlightKey);
    });

    it("Records truncation error when scan budget maxScanned is reached before listing terminates (Review Fix)", async () => {
      // Upload 6 orphan objects
      const pastDate = new Date(Date.now() - 30 * 60 * 1000);
      const keys: string[] = [];
      for (let i = 0; i < 6; i++) {
        const k = `budget-test-${i}-${Date.now()}.pdf`;
        keys.push(k);
        await memoryStorage.upload(k, Buffer.from("%PDF-1.4\nBudget\n%%EOF"), "application/pdf");
        memoryStorage.setCreatedAt(k, pastDate);
      }

      // Reconcile with maxScanned: 4, batchSize: 2 (budget exhausted after 2 batches)
      const report = await reconcileOrphanedObjects(memoryStorage, pool, {
        maxScanned: 4,
        batchSize: 2,
        gracePeriodMs: 0,
      });

      expect(report.scanned).toBe(4);
      expect(report.errors.some((e) => e.includes("Scan budget exhausted"))).toBe(true);

      // Clean up remaining objects
      for (const k of keys) {
        if (memoryStorage.has(k)) {
          await memoryStorage.delete(k);
        }
      }
    });

    it("Preserves objects with missing, null, or invalid createdAt during reconciliation (Review Fix)", async () => {
      const nullCreatedKey = `null-created-${Date.now()}.pdf`;
      await memoryStorage.upload(nullCreatedKey, Buffer.from("%PDF-1.4\nNullCreatedAt\n%%EOF"), "application/pdf");
      memoryStorage.setCreatedAt(nullCreatedKey, null); // Indeterminate creation time

      const report = await reconcileOrphanedObjects(memoryStorage, pool, {
        gracePeriodMs: 0,
      });

      // Crucial invariant: Object with null or unknown createdAt must NEVER be deleted
      expect(report.reconciled).not.toContain(nullCreatedKey);
      expect(memoryStorage.has(nullCreatedKey)).toBe(true);

      // Clean up test key
      await memoryStorage.delete(nullCreatedKey);
    });

    it("Bounds rawKeys inventory scan to maxScanned and records truncation when rawKeys contains additional keys (Review Fix)", async () => {
      const keys = ["raw-1", "raw-2", "raw-3", "raw-4", "raw-5"];
      const legacyDriver = {
        upload: vi.fn(),
        download: vi.fn(),
        delete: vi.fn(),
        verifyBucket: vi.fn().mockResolvedValue({ verified: true, isPrivate: true }),
        listKeys: vi.fn().mockResolvedValue(keys),
      };

      const report = await reconcileOrphanedObjects(legacyDriver as any, pool, {
        maxScanned: 3,
        gracePeriodMs: 0,
      });

      expect(report.scanned).toBe(3);
      expect(report.errors.some((e) => e.includes("Scan budget exhausted (3 objects scanned)"))).toBe(true);
    });

    it("Does not record truncation when rawKeys count is within maxScanned budget", async () => {
      const keys = ["raw-1", "raw-2"];
      const legacyDriver = {
        upload: vi.fn(),
        download: vi.fn(),
        delete: vi.fn(),
        verifyBucket: vi.fn().mockResolvedValue({ verified: true, isPrivate: true }),
        listKeys: vi.fn().mockResolvedValue(keys),
      };

      const report = await reconcileOrphanedObjects(legacyDriver as any, pool, {
        maxScanned: 3,
        gracePeriodMs: 0,
      });

      expect(report.scanned).toBe(2);
      expect(report.errors.some((e) => e.includes("Scan budget exhausted"))).toBe(false);
    });

    it("Does not terminate on a short page and continues scanning until page is empty (Review Fix)", async () => {
      const pages = [
        [{ name: "short-1", createdAt: null }, { name: "short-2", createdAt: null }],
        [{ name: "short-3", createdAt: null }, { name: "short-4", createdAt: null }],
        [],
      ];
      let callCount = 0;
      const driver = {
        upload: vi.fn(),
        download: vi.fn(),
        delete: vi.fn(),
        verifyBucket: vi.fn().mockResolvedValue({ verified: true, isPrivate: true }),
        listObjects: vi.fn().mockImplementation(async () => {
          return pages[callCount++] ?? [];
        }),
      };

      const report = await reconcileOrphanedObjects(driver as any, pool, {
        batchSize: 4,
        maxScanned: 100,
        gracePeriodMs: 0,
      });

      expect(report.scanned).toBe(4);
      expect(callCount).toBe(3);
      expect(report.errors.some((e) => e.includes("Scan budget exhausted"))).toBe(false);
    });

    it("Enforces maxScanned budget when driver returns an oversized page exceeding remaining budget (Review Fix)", async () => {
      const oversizedPage = Array.from({ length: 10 }, (_, i) => ({
        name: `oversized-${i}`,
        createdAt: null,
      }));
      const driver = {
        upload: vi.fn(),
        download: vi.fn(),
        delete: vi.fn(),
        verifyBucket: vi.fn().mockResolvedValue({ verified: true, isPrivate: true }),
        listObjects: vi.fn().mockResolvedValue(oversizedPage),
      };

      const report = await reconcileOrphanedObjects(driver as any, pool, {
        batchSize: 5,
        maxScanned: 4,
        gracePeriodMs: 0,
      });

      expect(report.scanned).toBe(4);
      expect(report.errors.some((e) => e.includes("Scan budget exhausted (4 objects scanned)"))).toBe(true);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     3. AUTHORIZATION & SECURE DOWNLOAD STREAMING
  ────────────────────────────────────────────────────────────────────────── */
  describe("3. Authorization & Secure Download Streaming", () => {
    it("Streams document bytes with strict security headers for authorized owner", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Top Secret Project Plan\n%%EOF");

      const createRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Project Plan")
        .field("category", "Strategy")
        .attach("file", pdfBuffer, "plan.pdf");

      const docId = createRes.body.document.id;
      createdDocumentIds.push(docId);

      const downloadRes = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", owner.cookie);

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers["content-type"]).toBe("application/pdf");
      expect(downloadRes.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate, private");
      expect(downloadRes.headers["pragma"]).toBe("no-cache");
      expect(downloadRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(downloadRes.headers["content-disposition"]).toContain("attachment; filename=");
      expect(downloadRes.body.toString("utf8")).toBe(pdfBuffer.toString("utf8"));
    });

    it("Prevents HTTP response splitting / header injection on download filename", async () => {
      const owner = await createSession("owner");
      const maliciousTitle = 'Malicious\r\nInjected-Header: evil\r\n"quote"';

      const createRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: maliciousTitle,
          category: "Security",
          content: "Valid plain text content",
        });

      const docId = createRes.body.document.id;
      createdDocumentIds.push(docId);

      const downloadRes = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", owner.cookie);

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers["injected-header"]).toBeUndefined();
      expect(downloadRes.headers["content-disposition"]).toBeDefined();
      expect(downloadRes.headers["content-disposition"]).not.toContain("\r");
      expect(downloadRes.headers["content-disposition"]).not.toContain("\n");
    });

    it("Rejects download if storage provider is temporarily unavailable", async () => {
      const owner = await createSession("owner");
      const createRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Storage Outage Test",
          category: "Operations",
          content: "Content payload",
        });

      const docId = createRes.body.document.id;
      createdDocumentIds.push(docId);

      memoryStorage.simulateDownloadError = new Error("Simulated storage cluster network timeout");

      const downloadRes = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", owner.cookie);

      memoryStorage.simulateDownloadError = null;

      expect(downloadRes.status).toBe(500);
      expect(downloadRes.body.error).toBe("Failed to download document content");
    });

    it("Denies download and returns 0 bytes for unauthorized user (anti-enumeration 404)", async () => {
      const owner = await createSession("owner");
      const intruder = await createSession("owner");

      const createRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Private Document",
          category: "Personal",
          content: "Confidential payload never to be leaked",
        });

      const docId = createRes.body.document.id;
      createdDocumentIds.push(docId);

      const res = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", intruder.cookie);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Document not found");
      expect(res.text).not.toContain("Confidential payload");
    });

    it("Immediately denies download when a user's grant is revoked", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");

      const createRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Shared Document Revoke Test",
          category: "Legal",
          content: "Confidential grant revocation test content",
        });

      const docId = createRes.body.document.id;
      createdDocumentIds.push(docId);

      // Create active read grant
      const grantRes = await request(app)
        .post(`/api/documents/${docId}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: grantee.user.email, permission: "read" });

      const grantId = grantRes.body.grant.id;

      // Grantee downloads successfully
      const dl1 = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", grantee.cookie);
      expect(dl1.status).toBe(200);

      // Owner revokes grant
      await request(app)
        .delete(`/api/documents/${docId}/grants/${grantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      // Subsequent download immediately returns 404
      const dl2 = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", grantee.cookie);
      expect(dl2.status).toBe(404);
    });

    it("Enforces Cache-Control: private, no-store and Pragma: no-cache across document endpoints (Finding I)", async () => {
      const owner = await createSession("owner");
      const pdfBuffer = Buffer.from("%PDF-1.4\n%Header Check\n%%EOF");

      const createRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Cache-Control Verification")
        .field("category", "Security")
        .attach("file", pdfBuffer, "cache-check.pdf");

      expect(createRes.status).toBe(201);
      const docId = createRes.body.document.id;
      createdDocumentIds.push(docId);

      // 1. Metadata endpoint
      const metaRes = await request(app)
        .get(`/api/documents/${docId}`)
        .set("Cookie", owner.cookie);

      expect(metaRes.status).toBe(200);
      expect(metaRes.headers["cache-control"]).toMatch(/private/);
      expect(metaRes.headers["cache-control"]).toMatch(/no-store/);
      expect(metaRes.headers["pragma"]).toBe("no-cache");

      // 2. Listing endpoint
      const listRes = await request(app)
        .get("/api/documents")
        .set("Cookie", owner.cookie);

      expect(listRes.status).toBe(200);
      expect(listRes.headers["cache-control"]).toMatch(/private/);
      expect(listRes.headers["cache-control"]).toMatch(/no-store/);
      expect(listRes.headers["pragma"]).toBe("no-cache");

      // 3. Download endpoint
      const dlRes = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", owner.cookie);

      expect(dlRes.status).toBe(200);
      expect(dlRes.headers["cache-control"]).toMatch(/private/);
      expect(dlRes.headers["cache-control"]).toMatch(/no-store/);
      expect(dlRes.headers["pragma"]).toBe("no-cache");
      expect(dlRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(dlRes.headers["content-disposition"]).toMatch(/attachment/);

      // 4. Error response (404 Not Found)
      const errRes = await request(app)
        .get("/api/documents/00000000-0000-0000-0000-000000000000")
        .set("Cookie", owner.cookie);

      expect(errRes.status).toBe(404);
      expect(errRes.headers["cache-control"]).toMatch(/private/);
      expect(errRes.headers["cache-control"]).toMatch(/no-store/);
      expect(errRes.headers["pragma"]).toBe("no-cache");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     4. DELETION, RECOVERY & STORAGE LIFECYCLE
  ────────────────────────────────────────────────────────────────────────── */
  describe("4. Deletion, Recovery & Storage Lifecycle", () => {
    it("Soft-deleted document is immediately inaccessible to metadata, search, and download", async () => {
      const owner = await createSession("owner");
      const docRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Document To Soft Delete",
          category: "Operations",
          content: "Payload of document to be deleted",
        });

      const docId = docRes.body.document.id;
      createdDocumentIds.push(docId);

      // Delete document
      const delRes = await request(app)
        .delete(`/api/documents/${docId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(delRes.status).toBe(200);
      expect(delRes.body.message).toBe("Document deleted successfully");

      // Verify metadata returns 404
      const metaRes = await request(app)
        .get(`/api/documents/${docId}`)
        .set("Cookie", owner.cookie);
      expect(metaRes.status).toBe(404);

      // Verify download returns 404
      const dlRes = await request(app)
        .get(`/api/documents/${docId}/download`)
        .set("Cookie", owner.cookie);
      expect(dlRes.status).toBe(404);

      // Verify search does not return deleted document
      const listRes = await request(app)
        .get("/api/documents?search=Document+To+Soft+Delete")
        .set("Cookie", owner.cookie);
      expect(listRes.body.documents.length).toBe(0);

      // Repeated deletion request returns 404 safely
      const repeatDel = await request(app)
        .delete(`/api/documents/${docId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect(repeatDel.status).toBe(404);
    });

    it("User with active edit grant cannot delete document (restricted to owner)", async () => {
      const owner = await createSession("owner");
      const editor = await createSession("owner");

      const docRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "Owner-Protected Document",
          category: "Confidential",
          content: "Payload that editor cannot delete",
        });

      const docId = docRes.body.document.id;
      createdDocumentIds.push(docId);

      // Grant editor 'edit' permission
      await request(app)
        .post(`/api/documents/${docId}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: editor.user.email, permission: "edit" });

      // Editor attempts deletion -> forbidden 403
      const delRes = await request(app)
        .delete(`/api/documents/${docId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", editor.cookie)
        .set("x-csrf-token", editor.csrfToken);

      expect(delRes.status).toBe(403);
      expect(delRes.body.error).toContain("only the document owner");
    });
  });
});