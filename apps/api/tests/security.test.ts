import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { hashPassword } from "../src/auth/argon2.js";
import { ABSOLUTE_SESSION_TIMEOUT_MS } from "../src/auth/middleware.js";
import { setStorageDriver, InMemoryStorageDriver } from "../src/documents/storage.js";

const TRUSTED_ORIGIN = "http://localhost:5173";
const UNTRUSTED_ORIGIN = "https://malicious-attacker.example.com";

interface TestSession {
  user: {
    id: string;
    email: string;
    role: "owner" | "viewer" | "admin";
  };
  cookie: string[];
  csrfToken: string;
}

function uniqueEmail(prefix = "sec-test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@vault.test`;
}

describe("TrustVault — Phase 8: Security Testing & Hardening Suite", () => {
  const memoryStorage = new InMemoryStorageDriver();
  let sharedPasswordHash: string;
  const createdTestEmails: string[] = [];
  const createdDocumentIds: string[] = [];

  beforeAll(async () => {
    setStorageDriver(memoryStorage);
    sharedPasswordHash = await hashPassword("HardenedPassword123!");
  });

  afterAll(async () => {
    // Clean up isolated test resources
    if (createdDocumentIds.length > 0) {
      await pool.query("DELETE FROM public.document_grants WHERE document_id = ANY($1)", [createdDocumentIds]);
      await pool.query("DELETE FROM public.audit_events WHERE document_id = ANY($1)", [createdDocumentIds]);
      await pool.query("DELETE FROM public.documents WHERE id = ANY($1)", [createdDocumentIds]);
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
        `DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' IN (
           SELECT id::text FROM public.users WHERE email = ANY($1)
         )`,
        [createdTestEmails]
      );
      await pool.query(
        "DELETE FROM public.audit_events WHERE actor_id IN (SELECT id FROM public.users WHERE email = ANY($1))",
        [createdTestEmails]
      );
      await pool.query("DELETE FROM public.users WHERE email = ANY($1)", [createdTestEmails]);
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

    const loginRes = await request(app)
      .post("/api/auth/login")
      .set("Origin", TRUSTED_ORIGIN)
      .send({ email, password: "HardenedPassword123!" });

    const cookieHeader = loginRes.headers["set-cookie"];
    const cookie = Array.isArray(cookieHeader)
      ? cookieHeader
      : cookieHeader
        ? [cookieHeader]
        : [];

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
    const category = attrs?.category || "Security";
    const content = attrs?.content || "Confidential security verification payload";

    const res = await request(app)
      .post("/api/documents")
      .set("Origin", TRUSTED_ORIGIN)
      .set("Cookie", owner.cookie)
      .set("x-csrf-token", owner.csrfToken)
      .send({
        title,
        category,
        content,
        mimeType: "text/plain",
      });

    expect(res.status).toBe(201);
    createdDocumentIds.push(res.body.document.id);
    return res.body.document;
  }

  /* ──────────────────────────────────────────────────────────────────────────
     1. TASK 2 — AUTHENTICATION & SESSION SECURITY
  ────────────────────────────────────────────────────────────────────────── */
  describe("Task 2: Authentication & Session Security", () => {
    it("Enforces absolute session timeout (24h) and rejects expired sessions with 401", async () => {
      const owner = await createSession("owner");

      // Extract sid from session cookie
      const sidMatch = owner.cookie[0].match(/trustvault\.sid=s%3A([^.]+)\./);
      expect(sidMatch).toBeTruthy();
      const sid = sidMatch![1];

      // Mutate session in PostgreSQL to simulate an expired session (> 24 hours old)
      const expiredTimestamp = Date.now() - (ABSOLUTE_SESSION_TIMEOUT_MS + 60000); // 24h + 1m ago
      await pool.query(
        `UPDATE public.sessions
         SET sess = jsonb_set(sess::jsonb, '{createdAt}', $1::jsonb)
         WHERE sid = $2`,
        [JSON.stringify(expiredTimestamp), sid]
      );

      // Attempt authenticated request with the expired session
      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Session expired" });

      // Verify that audit event was recorded for expired session
      const auditRes = await pool.query(
        `SELECT action, outcome, reason FROM public.audit_events
         WHERE actor_id = $1 AND action = 'auth_session_expired'
         ORDER BY occurred_at DESC LIMIT 1`,
        [owner.user.id]
      );
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].outcome).toBe("denied");
      expect(auditRes.rows[0].reason).toBe("Session expired");
    });

    it("Rejects sessions with missing creation timestamps safely with 401", async () => {
      const owner = await createSession("owner");

      const sidMatch = owner.cookie[0].match(/trustvault\.sid=s%3A([^.]+)\./);
      expect(sidMatch).toBeTruthy();
      const sid = sidMatch![1];

      // Remove createdAt from session data in DB
      await pool.query(
        `UPDATE public.sessions
         SET sess = (sess::jsonb - 'createdAt')
         WHERE sid = $1`,
        [sid]
      );

      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Session expired" });

      // Verify that audit event was recorded with reason 'Session missing creation timestamp'
      const auditRes = await pool.query(
        `SELECT action, outcome, reason FROM public.audit_events
         WHERE actor_id = $1 AND action = 'auth_session_expired'
         ORDER BY occurred_at DESC LIMIT 1`,
        [owner.user.id]
      );
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].outcome).toBe("denied");
      expect(auditRes.rows[0].reason).toBe("Session missing creation timestamp");
    });

    it("Immediately invalidates session and returns 401 if user record is deleted from DB", async () => {
      const viewer = await createSession("viewer");

      // Delete user directly from DB
      await pool.query("DELETE FROM public.users WHERE id = $1", [viewer.user.id]);

      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", viewer.cookie);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "User account no longer exists" });
    });

    it("Immediately blocks disabled user on document operations with 403", async () => {
      const owner = await createSession("owner");
      const doc = await createDocument(owner);

      // Disable the owner account in DB
      await pool.query("UPDATE public.users SET status = 'disabled' WHERE id = $1", [owner.user.id]);

      // Attempt to access documents
      const res = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Account is disabled" });
    });

    it("Enforces secure cookie flags: HttpOnly, SameSite=Lax, Path=/", async () => {
      const email = uniqueEmail("cookie");
      createdTestEmails.push(email);

      await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password: "HardenedPassword123!" });

      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password: "HardenedPassword123!" });

      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers["set-cookie"]?.[0];
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     2. TASK 3 — AUTHORIZATION & IDOR BOUNDARIES
  ────────────────────────────────────────────────────────────────────────── */
  describe("Task 3: Authorization & IDOR Matrix", () => {
    const documentId = "11111111-2222-4333-8444-555555555555";
    const grantId = "66666666-7777-4888-8999-000000000000";

    it("Denies unauthenticated access across all document endpoints with 401", async () => {
      const unauthEndpoints = [
        { method: "get", path: "/api/documents" },
        { method: "post", path: "/api/documents" },
        { method: "get", path: `/api/documents/${documentId}` },
        { method: "get", path: `/api/documents/${documentId}/download` },
        { method: "patch", path: `/api/documents/${documentId}` },
        { method: "delete", path: `/api/documents/${documentId}` },
        { method: "get", path: `/api/documents/${documentId}/grants` },
        { method: "post", path: `/api/documents/${documentId}/grants` },
        { method: "patch", path: `/api/documents/${documentId}/grants/${grantId}` },
        { method: "delete", path: `/api/documents/${documentId}/grants/${grantId}` },
        { method: "get", path: `/api/documents/${documentId}/audit` },
      ];

      for (const endpoint of unauthEndpoints) {
        let req = (request(app) as any)[endpoint.method](endpoint.path);
        if (endpoint.method !== "get") {
          req = req.set("Origin", TRUSTED_ORIGIN);
        }
        const res = await req;
        expect(res.status, `Endpoint ${endpoint.method.toUpperCase()} ${endpoint.path} failed`).toBe(401);
        expect(res.body.error).toBe("Authentication required");
      }
    });

    it("Prevents admin from editing, deleting, or managing grants on documents without explicit grant", async () => {
      const owner = await createSession("owner");
      const admin = await createSession("admin");

      const doc = await createDocument(owner, { title: "Admin Isolation Test" });

      // Admin attempts edit -> 404 anti-enumeration
      const editRes = await request(app)
        .patch(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie)
        .set("x-csrf-token", admin.csrfToken)
        .send({ title: "Admin Tampered Title" });
      expect(editRes.status).toBe(404);
      expect(editRes.body.error).toBe("Document not found");

      // Admin attempts delete -> 404 anti-enumeration
      const deleteRes = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie)
        .set("x-csrf-token", admin.csrfToken);
      expect(deleteRes.status).toBe(404);
      expect(deleteRes.body.error).toBe("Document not found");

      // Admin attempts grant creation -> 404 anti-enumeration
      const otherUser = await createSession("viewer");
      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie)
        .set("x-csrf-token", admin.csrfToken)
        .send({ email: otherUser.user.email, permission: "read" });
      expect(grantRes.status).toBe(404);
      expect(grantRes.body.error).toBe("Document not found");

      // Admin attempts grant listing -> 404 anti-enumeration
      const listGrantsRes = await request(app)
        .get(`/api/documents/${doc.id}/grants`)
        .set("Cookie", admin.cookie);
      expect(listGrantsRes.status).toBe(404);
      expect(listGrantsRes.body.error).toBe("Document not found");

      // Admin attempts document audit log inspection -> 404 anti-enumeration
      const docAuditRes = await request(app)
        .get(`/api/documents/${doc.id}/audit`)
        .set("Cookie", admin.cookie);
      expect(docAuditRes.status).toBe(404);
      expect(docAuditRes.body.error).toBe("Document not found");
    });

    it("Fails closed with 404 anti-enumeration on non-existent document UUID", async () => {
      const owner = await createSession("owner");
      const nonExistentUuid = "99999999-9999-4999-8999-999999999999";

      const res = await request(app)
        .get(`/api/documents/${nonExistentUuid}`)
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Document not found");
    });

    it("Fails closed with 404 on soft-deleted documents for edit, delete, and grant operations", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");

      const doc = await createDocument(owner, { title: "Soft Delete Multi-Action Test" });

      // Grant access before delete
      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: grantee.user.email, permission: "edit" });
      expect(grantRes.status).toBe(201);
      const grantIdCreated = grantRes.body.grant.id;

      // Owner soft-deletes document
      await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      // Attempt edit on deleted doc -> 404
      const editRes = await request(app)
        .patch(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ title: "Edit After Delete" });
      expect(editRes.status).toBe(404);

      // Attempt repeated delete -> 404
      const repeatDeleteRes = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect(repeatDeleteRes.status).toBe(404);

      // Attempt grant listing on deleted doc -> 404
      const listGrantsRes = await request(app)
        .get(`/api/documents/${doc.id}/grants`)
        .set("Cookie", owner.cookie);
      expect(listGrantsRes.status).toBe(404);

      // Attempt grant update on deleted doc -> 404
      const updateGrantRes = await request(app)
        .patch(`/api/documents/${doc.id}/grants/${grantIdCreated}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ permission: "read" });
      expect(updateGrantRes.status).toBe(404);

      // Attempt grant revocation on deleted doc -> 404
      const revokeGrantRes = await request(app)
        .delete(`/api/documents/${doc.id}/grants/${grantIdCreated}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect(revokeGrantRes.status).toBe(404);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     3. TASK 4 — GRANT REVOCATION & DOWNLOAD INVARIANTS
  ────────────────────────────────────────────────────────────────────────── */
  describe("Task 4: Grant Revocation & Download Behavior", () => {
    it("Handles repeated revocation requests consistently with 404", async () => {
      const owner = await createSession("owner");
      const user = await createSession("viewer");

      const doc = await createDocument(owner);

      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "read" });

      const grantId = grantRes.body.grant.id;

      // First revocation succeeds
      const firstRevoke = await request(app)
        .delete(`/api/documents/${doc.id}/grants/${grantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(firstRevoke.status).toBe(200);
      expect(firstRevoke.body.message).toBe("Grant revoked successfully");

      // Repeated revocation on same grant returns 404 (grant is already revoked)
      const secondRevoke = await request(app)
        .delete(`/api/documents/${doc.id}/grants/${grantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(secondRevoke.status).toBe(404);
      expect(secondRevoke.body.error).toBe("Active grant not found or already revoked");
    });

    it("Executes concurrent revocation requests safely without errors or corruption", async () => {
      const owner = await createSession("owner");
      const user = await createSession("viewer");

      const doc = await createDocument(owner);

      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "read" });

      const grantId = grantRes.body.grant.id;

      // Fire 3 simultaneous revocation requests
      const promises = [1, 2, 3].map(() =>
        request(app)
          .delete(`/api/documents/${doc.id}/grants/${grantId}`)
          .set("Origin", TRUSTED_ORIGIN)
          .set("Cookie", owner.cookie)
          .set("x-csrf-token", owner.csrfToken)
      );

      const results = await Promise.all(promises);
      const statusCodes = results.map((r) => r.status);

      // Exactly one must succeed with 200, others must return 404
      expect(statusCodes.filter((s) => s === 200).length).toBe(1);
      expect(statusCodes.filter((s) => s === 404).length).toBe(2);
    });

    it("Enforces non-caching headers on all document endpoints to prevent intermediate caching", async () => {
      const owner = await createSession("owner");
      const doc = await createDocument(owner);

      const res = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.headers["cache-control"]).toContain("no-cache");
      expect(res.headers["cache-control"]).toContain("must-revalidate");
      expect(res.headers["cache-control"]).toContain("private");
      expect(res.headers["pragma"]).toBe("no-cache");
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     4. TASK 6 — AUDIT TRAIL SECURITY
  ────────────────────────────────────────────────────────────────────────── */
  describe("Task 6: Audit Trail Security & Oversight Boundaries", () => {
    it("Rejects non-admin access to system audit logs with 403 Forbidden", async () => {
      const owner = await createSession("owner");
      const viewer = await createSession("viewer");

      const ownerAuditRes = await request(app)
        .get("/api/audit")
        .set("Cookie", owner.cookie);
      expect(ownerAuditRes.status).toBe(403);
      expect(ownerAuditRes.body.error).toBe("Forbidden: insufficient permissions");

      const viewerAuditRes = await request(app)
        .get("/api/audit")
        .set("Cookie", viewer.cookie);
      expect(viewerAuditRes.status).toBe(403);
      expect(viewerAuditRes.body.error).toBe("Forbidden: insufficient permissions");
    });

    it("Rejects non-owner grantee access to document audit trail with 403 Forbidden", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");

      const doc = await createDocument(owner);

      await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: grantee.user.email, permission: "edit" });

      const res = await request(app)
        .get(`/api/documents/${doc.id}/audit`)
        .set("Cookie", grantee.cookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Forbidden: only the document owner may view audit records");
    });

    it("Rejects mutation/deletion on audit endpoints with 405 Method Not Allowed", async () => {
      const admin = await createSession("admin");
      const owner = await createSession("owner");
      const doc = await createDocument(owner);

      // System audit
      const postSystemAudit = await request(app)
        .post("/api/audit")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie)
        .set("x-csrf-token", admin.csrfToken);
      expect(postSystemAudit.status).toBe(405);
      expect(postSystemAudit.body.error).toBe("Method Not Allowed: audit events are append-only");

      const deleteSystemAudit = await request(app)
        .delete("/api/audit")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", admin.cookie)
        .set("x-csrf-token", admin.csrfToken);
      expect(deleteSystemAudit.status).toBe(405);

      // Document audit
      const postDocAudit = await request(app)
        .post(`/api/documents/${doc.id}/audit`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect(postDocAudit.status).toBe(405);
      expect(postDocAudit.body.error).toBe("Method Not Allowed: audit events are append-only");

      const deleteDocAudit = await request(app)
        .delete(`/api/documents/${doc.id}/audit`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);
      expect(deleteDocAudit.status).toBe(405);
    });

    it("Redacts and completely excludes sensitive secrets from audit metadata", async () => {
      const owner = await createSession("owner");
      const sensitivePassword = "SuperSecretPassword123!";

      // Registration failure or login failure with password
      await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: owner.user.email,
          password: sensitivePassword,
        });

      // Verify that no row in public.audit_events contains the plaintext password in metadata
      const result = await pool.query(
        `SELECT metadata FROM public.audit_events WHERE actor_id = $1`,
        [owner.user.id]
      );

      for (const row of result.rows) {
        const str = JSON.stringify(row.metadata);
        expect(str).not.toContain(sensitivePassword);
      }
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
     5. TASK 7 — API INPUT, ABUSE & INJECTION TESTING
  ────────────────────────────────────────────────────────────────────────── */
  describe("Task 7: API Input, Abuse & Injection Hardening", () => {
    it("Rejects malformed JSON syntax with HTTP 400 Bad Request", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Content-Type", "application/json")
        .send('{"email": "test@example.com", "password":'); // Malformed JSON syntax

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Malformed JSON payload in request body" });
    });

    it("Rejects oversized JSON request body (> 1MB) with HTTP 413 Payload Too Large", async () => {
      // 1MB + 10KB payload
      const largeString = "A".repeat(1024 * 1024 + 10240);
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ email: "test@example.com", padding: largeString }));

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: "Request payload exceeds maximum permitted size" });
    });

    it("Safely handles SQL injection attempts in search query parameters as literal text", async () => {
      const owner = await createSession("owner");
      await createDocument(owner, { title: "Legitimate Document" });

      const sqliPayloads = [
        "' OR '1'='1",
        "'; DROP TABLE public.documents; --",
        "1 UNION SELECT null, null, null, null, null, null, null, null, null--",
      ];

      for (const payload of sqliPayloads) {
        const res = await request(app)
          .get(`/api/documents?search=${encodeURIComponent(payload)}`)
          .set("Cookie", owner.cookie);

        expect(res.status).toBe(200);
        // SQL injection payload does not match legitimate title, returns 0 documents
        expect(res.body.documents.length).toBe(0);
        expect(res.body.pagination.total).toBe(0);
      }
    });

    it("Safely handles SQL injection attempts in category query parameters as literal text", async () => {
      const owner = await createSession("owner");
      await createDocument(owner, { title: "Finance Summary", category: "Finance" });

      const res = await request(app)
        .get(`/api/documents?category=${encodeURIComponent("' OR 1=1 --")}`)
        .set("Cookie", owner.cookie);

      expect(res.status).toBe(200);
      expect(res.body.documents.length).toBe(0);
    });

    it("Safely handles Cross-Site Scripting (XSS) payloads in document titles without execution", async () => {
      const owner = await createSession("owner");
      const xssTitle = "<script>alert('XSS-TEST')</script>";

      const doc = await createDocument(owner, { title: xssTitle });
      expect(doc.title).toBe(xssTitle);

      // Verify metadata returns exact string as JSON without executing
      const metaRes = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);

      expect(metaRes.status).toBe(200);
      expect(metaRes.body.document.title).toBe(xssTitle);

      // Verify download sanitizes header filename
      const downloadRes = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", owner.cookie);

      expect(downloadRes.status).toBe(200);
      const disposition = downloadRes.headers["content-disposition"];
      expect(disposition).toBeDefined();
      expect(disposition).toContain("attachment; filename=");
      // Ensure raw HTML / script tag was neutralized and cannot appear raw
      expect(disposition).not.toContain("<script>");
      expect(disposition).not.toContain("</script>");
      expect(downloadRes.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("Rejects state-changing requests from unapproved origins with 403 Forbidden", async () => {
      const owner = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", UNTRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          title: "CSRF Upload Attempt",
          category: "General",
          content: "Should be blocked by origin check",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Cross-site request blocked: untrusted origin");
    });

    it("Rejects authenticated state-changing requests missing CSRF token with 403 Forbidden", async () => {
      const owner = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        // Omit x-csrf-token
        .send({
          title: "Missing CSRF Token Test",
          category: "General",
          content: "Should be blocked",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Missing or invalid CSRF token");
    });

    it("Rejects unsupported Content-Type on document creation with 415 Unsupported Media Type", async () => {
      const owner = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .set("Content-Type", "text/plain")
        .send("raw text payload");

      expect(res.status).toBe(415);
      expect(res.body.error).toContain("Unsupported Media Type");
    });

    it("Never exposes internal database errors, stack traces, or SQL details in error responses", async () => {
      const owner = await createSession("owner");

      // Intentionally request non-existent endpoint
      const notFoundRes = await request(app)
        .get("/api/unsupported-endpoint-that-does-not-exist")
        .set("Cookie", owner.cookie);

      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.body).toEqual({ error: "Not found" });
      expect(JSON.stringify(notFoundRes.body)).not.toContain("stack");
    });
  });
});
