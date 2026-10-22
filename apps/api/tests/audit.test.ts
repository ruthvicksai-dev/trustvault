import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { hashPassword } from "../src/auth/argon2.js";
import { setStorageDriver, InMemoryStorageDriver } from "../src/documents/storage.js";
import { recordAuditEvent, sanitizeAuditMetadata, ALLOWED_METADATA_KEYS } from "../src/audit/service.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

function uniqueEmail(prefix = "audit-user"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@vault.test`;
}

interface TestSession {
  user: {
    id: string;
    email: string;
    role: "owner" | "viewer" | "admin";
  };
  cookie: string[];
  csrfToken: string;
}

describe("TrustVault — Phase 7: Audit Trail & Tamper Resistance", () => {
  const createdTestEmails: string[] = [];
  const createdDocumentIds: string[] = [];
  const memoryStorage = new InMemoryStorageDriver();
  let sharedPasswordHash: string;

  beforeAll(async () => {
    setStorageDriver(memoryStorage);
    sharedPasswordHash = await hashPassword("AuditTestPass123!");
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

    const userRes = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, status`,
      [email, sharedPasswordHash, role, status]
    );
    const user = userRes.rows[0];

    // Authenticate to obtain valid session cookie
    const loginRes = await request(app)
      .post("/api/auth/login")
      .set("Origin", TRUSTED_ORIGIN)
      .send({ email, password: "AuditTestPass123!" });

    const cookieHeader = loginRes.headers["set-cookie"];
    const cookie = Array.isArray(cookieHeader)
      ? cookieHeader
      : cookieHeader
        ? [cookieHeader]
        : [];

    // Obtain session-bound CSRF token AFTER login
    const csrfRes = await request(app)
      .get("/api/auth/csrf-token")
      .set("Cookie", cookie);

    const csrfToken = csrfRes.body.csrfToken;

    return { user, cookie, csrfToken };
  }

  async function createDocument(
    owner: TestSession,
    attrs?: { title?: string; category?: string; content?: string }
  ) {
    const title = attrs?.title || `Doc-${Date.now()}`;
    const category = attrs?.category || "Confidential";
    const content = attrs?.content || "Classified document payload for audit test";

    const res = await request(app)
      .post("/api/documents")
      .set("Origin", TRUSTED_ORIGIN)
      .set("Cookie", owner.cookie)
      .set("x-csrf-token", owner.csrfToken)
      .send({
        title,
        category,
        content: Buffer.from(content).toString("base64"),
        mimeType: "text/plain",
        filename: "test.txt",
      });

    expect(res.status).toBe(201);
    createdDocumentIds.push(res.body.document.id);
    return res.body.document;
  }

  /* ──────────────────────────────────────────────────────────────────────────
     1. EXACT EVENT COVERAGE & DEDUPLICATION
  ────────────────────────────────────────────────────────────────────────── */
  describe("1. Exact Event Coverage & Deduplication", () => {
    it("A successful document operation creates exactly one correct audit event", async () => {
      const owner = await createSession("owner");

      // 1. Create document
      const doc = await createDocument(owner, { title: "Deduplication Verification" });

      const createEvents = await pool.query(
        "SELECT action, outcome, actor_id FROM public.audit_events WHERE document_id = $1 AND action = 'create_document'",
        [doc.id]
      );
      expect(createEvents.rows.length).toBe(1);
      expect(createEvents.rows[0].outcome).toBe("success");
      expect(createEvents.rows[0].actor_id).toBe(owner.user.id);

      // 2. Read metadata
      await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);

      const readEvents = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE document_id = $1 AND action = 'read_metadata'",
        [doc.id]
      );
      expect(readEvents.rows.length).toBe(1);
      expect(readEvents.rows[0].outcome).toBe("success");

      // 3. Download content (must NOT create a duplicate read_content success event)
      await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", owner.cookie);

      const downloadEvents = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE document_id = $1 AND action = 'download_content'",
        [doc.id]
      );
      expect(downloadEvents.rows.length).toBe(1);
      expect(downloadEvents.rows[0].outcome).toBe("success");

      // Ensure no duplicate read_content success was created
      const duplicateReadContent = await pool.query(
        "SELECT action FROM public.audit_events WHERE document_id = $1 AND action = 'read_content'",
        [doc.id]
      );
      expect(duplicateReadContent.rows.length).toBe(0);

      // 4. Update metadata
      await request(app)
        .patch(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ title: "Updated Deduplication Title" });

      const updateEvents = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE document_id = $1 AND action = 'update_document'",
        [doc.id]
      );
      expect(updateEvents.rows.length).toBe(1);
      expect(updateEvents.rows[0].outcome).toBe("success");

      // 5. Soft delete document
      await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      const deleteEvents = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE document_id = $1 AND action = 'delete_document'",
        [doc.id]
      );
      expect(deleteEvents.rows.length).toBe(1);
      expect(deleteEvents.rows[0].outcome).toBe("success");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     2. ACCESS DENIAL & ANTI-ENUMERATION
  ────────────────────────────────────────────────────────────────────────── */
  describe("2. Access Denial & Anti-Enumeration", () => {
    it("A denied document access creates a denied event and still denies access", async () => {
      const owner = await createSession("owner");
      const stranger = await createSession("viewer");
      const doc = await createDocument(owner, { title: "Stranger Denied Access" });

      const res = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", stranger.cookie);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Document not found");

      const auditRes = await pool.query(
        `SELECT action, outcome, actor_id, reason
         FROM public.audit_events
         WHERE document_id = $1 AND actor_id = $2
         ORDER BY occurred_at DESC LIMIT 1`,
        [doc.id, stranger.user.id]
      );

      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].action).toBe("read_metadata");
      expect(auditRes.rows[0].outcome).toBe("denied");
      expect(auditRes.rows[0].reason).toContain("not document owner and no active grant");
    });

    it("Cross-user access does not disclose protected document content or metadata", async () => {
      const owner = await createSession("owner");
      const stranger = await createSession("viewer");
      const doc = await createDocument(owner, { title: "Secret Download Test" });

      const downloadRes = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", stranger.cookie);

      expect(downloadRes.status).toBe(404);
      expect(downloadRes.text).not.toContain("Classified document payload");

      const auditRes = await pool.query(
        `SELECT action, outcome, actor_id
         FROM public.audit_events
         WHERE document_id = $1 AND actor_id = $2 AND action = 'read_content'`,
        [doc.id, stranger.user.id]
      );

      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].outcome).toBe("denied");
    });

    it("Nonexistent and deleted document behavior preserves information-disclosure protections", async () => {
      const owner = await createSession("owner");
      const randomUuid = "12345678-1234-4234-a234-123456789abc";

      // Nonexistent document
      const nonExistentRes = await request(app)
        .get(`/api/documents/${randomUuid}`)
        .set("Cookie", owner.cookie);

      expect(nonExistentRes.status).toBe(404);
      expect(nonExistentRes.body.error).toBe("Document not found");

      const nonExistentAudit = await pool.query(
        "SELECT action, outcome, reason FROM public.audit_events WHERE document_id = $1",
        [randomUuid]
      );
      expect(nonExistentAudit.rows.length).toBe(1);
      expect(nonExistentAudit.rows[0].outcome).toBe("denied");
      expect(nonExistentAudit.rows[0].reason).toBe("Document not found");

      // Soft-deleted document
      const doc = await createDocument(owner, { title: "To Be Deleted" });
      await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      const deletedRes = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);

      expect(deletedRes.status).toBe(404);
      expect(deletedRes.body.error).toBe("Document not found");

      const deletedAudit = await pool.query(
        "SELECT action, outcome, reason FROM public.audit_events WHERE document_id = $1 AND reason = 'Document has been deleted'",
        [doc.id]
      );
      expect(deletedAudit.rows.length).toBe(1);
      expect(deletedAudit.rows[0].outcome).toBe("denied");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     3. GRANT ATTRIBUTION & ATOMICITY
  ────────────────────────────────────────────────────────────────────────── */
  describe("3. Grant Attribution & Atomicity", () => {
    it("Grant creation and revocation are attributed to the correct authenticated actor", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");
      const doc = await createDocument(owner, { title: "Grant Attribution Test" });

      // Create grant
      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          email: grantee.user.email,
          permission: "read",
        });

      expect(grantRes.status).toBe(201);
      const grantId = grantRes.body.grant.id;

      const createGrantAudit = await pool.query(
        `SELECT action, outcome, actor_id, metadata
         FROM public.audit_events
         WHERE document_id = $1 AND action = 'create_grant'`,
        [doc.id]
      );
      expect(createGrantAudit.rows.length).toBe(1);
      expect(createGrantAudit.rows[0].actor_id).toBe(owner.user.id);
      expect(createGrantAudit.rows[0].metadata.recipientId).toBe(grantee.user.id);
      expect(createGrantAudit.rows[0].metadata.permission).toBe("read");

      // Revoke grant
      const revokeRes = await request(app)
        .delete(`/api/documents/${doc.id}/grants/${grantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(revokeRes.status).toBe(200);

      const revokeGrantAudit = await pool.query(
        `SELECT action, outcome, actor_id, metadata
         FROM public.audit_events
         WHERE document_id = $1 AND action = 'revoke_grant'`,
        [doc.id]
      );
      expect(revokeGrantAudit.rows.length).toBe(1);
      expect(revokeGrantAudit.rows[0].actor_id).toBe(owner.user.id);
      expect(revokeGrantAudit.rows[0].metadata.grantId).toBe(grantId);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     4. FAILURE SAFETY & SECRET REDACTION
  ────────────────────────────────────────────────────────────────────────── */
  describe("4. Failure Safety & Secret Redaction", () => {
    it("A failed upload or validation operation does not create a misleading success event", async () => {
      const owner = await createSession("owner");

      // Attempt upload with disallowed executable extension
      const failRes = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .field("title", "Malicious Upload Attempt")
        .field("category", "Operations")
        .attach("file", Buffer.from("MZ\x90\x00executable binary"), "malware.exe");

      expect(failRes.status).toBe(400);

      const auditRes = await pool.query(
        `SELECT action, outcome, reason
         FROM public.audit_events
         WHERE actor_id = $1 AND action = 'create_document' AND outcome = 'denied'
         ORDER BY occurred_at DESC LIMIT 1`,
        [owner.user.id]
      );

      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].outcome).toBe("denied");

      // Verify no success event was recorded for this attempt
      const successAudit = await pool.query(
        `SELECT id FROM public.audit_events
         WHERE actor_id = $1 AND action = 'create_document' AND outcome = 'success'
         AND metadata->>'title' = 'Malicious Upload Attempt'`,
        [owner.user.id]
      );
      expect(successAudit.rows.length).toBe(0);
    });

    it("Audit metadata does not contain passwords, cookies, tokens, signed URLs, or document contents", async () => {
      const owner = await createSession("owner");
      const secretContent = "Top-Secret-Nuclear-Launch-Codes-998877";

      const doc = await createDocument(owner, {
        title: "Confidential Data",
        content: secretContent,
      });

      // Fetch all audit events related to this user and document
      const auditRes = await pool.query(
        `SELECT action, outcome, reason, metadata
         FROM public.audit_events
         WHERE actor_id = $1 OR document_id = $2`,
        [owner.user.id, doc.id]
      );

      expect(auditRes.rows.length).toBeGreaterThan(0);

      for (const row of auditRes.rows) {
        const metadataStr = JSON.stringify(row.metadata);
        expect(metadataStr).not.toContain(secretContent);
        expect(metadataStr).not.toContain("AuditTestPass123!");
        expect(metadataStr).not.toContain(owner.csrfToken);
        for (const cookieItem of owner.cookie) {
          const cookieVal = cookieItem.split(";")[0];
          expect(metadataStr).not.toContain(cookieVal);
        }
      }
    });

    it("Sanitizes metadata against arbitrary user keys and strictly enforces allowlist", () => {
      const maliciousMetadata = {
        title: "Valid Title",
        password: "ShouldBeRedacted",
        secretToken: "SuperSecretTokenValue",
        arbitraryInjectedField: "ShouldBeDroppedCompletely",
        nestedObject: { malicious: true },
        sizeBytes: 1024,
      };

      const sanitized = sanitizeAuditMetadata(maliciousMetadata);

      expect(sanitized.title).toBe("Valid Title");
      expect(sanitized.sizeBytes).toBe(1024);
      // Verify sanitized does not contain password or secretToken properties
      expect(sanitized).not.toHaveProperty("password");
      expect(sanitized).not.toHaveProperty("secretToken");
      expect(sanitized).not.toHaveProperty("arbitraryInjectedField");
      expect(sanitized).not.toHaveProperty("nestedObject");
      // Verify keys are strictly excluded from the allowlist
      expect(ALLOWED_METADATA_KEYS.has("password")).toBe(false);
      expect(ALLOWED_METADATA_KEYS.has("secretToken")).toBe(false);

      // Verify that credential-shaped string values in allowlisted fields are redacted
      const credentialMetadata = {
        title: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
        reason: "password=MySuperSecretValue123",
      };
      const redacted = sanitizeAuditMetadata(credentialMetadata);
      expect(redacted.title).toBe("[REDACTED]");
      expect(redacted.reason).toBe("[REDACTED]");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     5. ACCESS CONTROLS ON AUDIT TRAIL
  ────────────────────────────────────────────────────────────────────────── */
  describe("5. Access Controls & Append-Only Enforcement", () => {
    it("Document owner can read audit trail of their document", async () => {
      const owner = await createSession("owner");
      const doc = await createDocument(owner, { title: "Owner Audit Read" });

      const res = await request(app)
        .get(`/api/documents/${doc.id}/audit`)
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(res.body.events.length).toBeGreaterThanOrEqual(1);
      expect(res.headers["cache-control"]).toContain("no-store");
    });

    it("An ordinary user cannot read audit records outside their permitted scope", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");
      const stranger = await createSession("viewer");

      const doc = await createDocument(owner, { title: "Scope Restriction Test" });

      // Grant 'read' permission to grantee
      await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: grantee.user.email, permission: "read" });

      // 1. Grantee cannot read audit records (403 Forbidden)
      const granteeAuditRes = await request(app)
        .get(`/api/documents/${doc.id}/audit`)
        .set("Cookie", grantee.cookie);

      expect(granteeAuditRes.status).toBe(403);
      expect(granteeAuditRes.body.error).toContain("only the document owner may view audit records");

      // 2. Stranger gets 404 (anti-enumeration)
      const strangerAuditRes = await request(app)
        .get(`/api/documents/${doc.id}/audit`)
        .set("Cookie", stranger.cookie);

      expect(strangerAuditRes.status).toBe(404);

      // 3. Ordinary users cannot access the system audit endpoint /api/audit (403 Forbidden)
      const ownerSystemAudit = await request(app)
        .get("/api/audit")
        .set("Cookie", owner.cookie);
      expect(ownerSystemAudit.status).toBe(403);

      const viewerSystemAudit = await request(app)
        .get("/api/audit")
        .set("Cookie", grantee.cookie);
      expect(viewerSystemAudit.status).toBe(403);
    });

    it("Administrator can access the system audit endpoint", async () => {
      const admin = await createSession("admin");

      const res = await request(app)
        .get("/api/audit")
        .set("Cookie", admin.cookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(res.body.pagination).toBeDefined();
    });

    it("Audit events cannot be updated or deleted through exposed application routes", async () => {
      const admin = await createSession("admin");
      const owner = await createSession("owner");
      const doc = await createDocument(owner, { title: "Append Only Test" });

      // Document audit endpoint rejects non-GET methods
      const docPost = await request(app)
        .post(`/api/documents/${doc.id}/audit`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect([404, 405]).toContain(docPost.status);

      const docDelete = await request(app)
        .delete(`/api/documents/${doc.id}/audit`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect([404, 405]).toContain(docDelete.status);

      const docPatch = await request(app)
        .patch(`/api/documents/${doc.id}/audit`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect([404, 405]).toContain(docPatch.status);

      // System audit endpoint rejects non-GET methods
      const sysPost = await request(app)
        .post("/api/audit")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie);
      expect(sysPost.status).toBe(405);

      const sysDelete = await request(app)
        .delete("/api/audit")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie);
      expect(sysDelete.status).toBe(405);

      const sysPatch = await request(app)
        .patch("/api/audit")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie);
      expect(sysPatch.status).toBe(405);
    });

    it("Audit persistence failures throw when throwOnError is true (transactional safety)", async () => {
      const mockClient = {
        query: vi.fn().mockRejectedValue(new Error("Simulated database failure")),
      };

      await expect(
        recordAuditEvent({
          client: mockClient as any,
          throwOnError: true,
          action: "create_grant",
          outcome: "success",
        })
      ).rejects.toThrow("Simulated database failure");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     6. AUTHENTICATION & SESSION AUDIT EVENTS
  ────────────────────────────────────────────────────────────────────────── */
  describe("6. Authentication & Session Audit Events", () => {
    it("Records auth_register, auth_login, auth_logout, and auth_change_password events", async () => {
      const email = uniqueEmail("auth-audit");
      createdTestEmails.push(email);

      const agent = request.agent(app);

      // 1. Register
      const regRes = await agent
        .post("/api/auth/register")
        .send({ email, password: "AuthAuditPassword123!" });
      expect(regRes.status).toBe(201);
      const registeredUserId = regRes.body.user.id;

      const regAudit = await pool.query(
        "SELECT action, outcome, metadata FROM public.audit_events WHERE action = 'auth_register' AND outcome = 'success' AND metadata->>'email' = $1",
        [email]
      );
      expect(regAudit.rows.length).toBe(1);

      // 2. Failed login (wrong password)
      const badLoginRes = await agent
        .post("/api/auth/login")
        .send({ email, password: "WrongPassword999!" });
      expect(badLoginRes.status).toBe(401);

      const badLoginAudit = await pool.query(
        "SELECT action, outcome, reason FROM public.audit_events WHERE action = 'auth_login' AND outcome = 'denied' AND metadata->>'emailAttempted' = $1",
        [email]
      );
      expect(badLoginAudit.rows.length).toBe(1);

      // 3. Successful login
      const goodLoginRes = await agent
        .post("/api/auth/login")
        .send({ email, password: "AuthAuditPassword123!" });
      expect(goodLoginRes.status).toBe(200);

      const goodLoginAudit = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE action = 'auth_login' AND outcome = 'success' AND metadata->>'email' = $1",
        [email]
      );
      expect(goodLoginAudit.rows.length).toBe(1);

      // 4. Change password
      const csrfRes = await agent.get("/api/auth/csrf-token");
      const csrfToken = csrfRes.body.csrfToken;

      const changePassRes = await agent
        .post("/api/auth/change-password")
        .set("Origin", TRUSTED_ORIGIN)
        .set("x-csrf-token", csrfToken)
        .send({
          currentPassword: "AuthAuditPassword123!",
          newPassword: "NewAuthAuditPassword123!",
        });
      expect(changePassRes.status).toBe(200);

      const changePassAudit = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE action = 'auth_change_password' AND outcome = 'success' AND actor_id = $1",
        [registeredUserId]
      );
      expect(changePassAudit.rows.length).toBe(1);

      // 5. Logout
      const logoutRes = await agent.post("/api/auth/logout");
      expect(logoutRes.status).toBe(200);

      const logoutAudit = await pool.query(
        "SELECT action, outcome FROM public.audit_events WHERE action = 'auth_logout' AND outcome = 'success' AND actor_id = $1",
        [registeredUserId]
      );
      expect(logoutAudit.rows.length).toBe(1);
    });
  });
});
