import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { hashPassword } from "../src/auth/argon2.js";
import { setStorageDriver, InMemoryStorageDriver } from "../src/documents/storage.js";
import { authorizeDocumentAccess } from "../src/documents/authorization.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@example.com`;
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

describe("TrustVault — Phase 5: Production-Grade Document Authorization", () => {
  const createdTestEmails: string[] = [];
  const createdDocumentIds: string[] = [];
  const memoryStorage = new InMemoryStorageDriver();
  let sharedPasswordHash: string;

  beforeAll(async () => {
    // Direct file operations to fast, isolated in-memory storage for test isolation
    setStorageDriver(memoryStorage);
    sharedPasswordHash = await hashPassword("super-secure-test-pass-123");
  });

  afterAll(async () => {
    // Clean up isolated test data strictly — NEVER truncate or alter production data
    if (createdDocumentIds.length > 0) {
      await pool.query(
        `DELETE FROM public.document_grants WHERE document_id = ANY($1)`,
        [createdDocumentIds]
      );
      await pool.query(
        `DELETE FROM public.audit_events WHERE document_id = ANY($1)`,
        [createdDocumentIds]
      );
      await pool.query(
        `DELETE FROM public.documents WHERE id = ANY($1)`,
        [createdDocumentIds]
      );
    }

    if (createdTestEmails.length > 0) {
      await pool.query(
        `DELETE FROM public.sessions
         WHERE (sess::jsonb)->>'userId' IN (
           SELECT id::text FROM public.users WHERE email = ANY($1)
         )`,
        [createdTestEmails]
      );
      await pool.query(
        `DELETE FROM public.audit_events
         WHERE actor_id IN (
           SELECT id FROM public.users WHERE email = ANY($1)
         )`,
        [createdTestEmails]
      );
      await pool.query(
        `DELETE FROM public.users WHERE email = ANY($1)`,
        [createdTestEmails]
      );
    }

    await pool.end();
  });

  /**
   * Helper to create an authenticated session for a test user with a specific role.
   */
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

    // Authenticate to obtain valid session cookie
    const loginRes = await request(app)
      .post("/api/auth/login")
      .set("Origin", TRUSTED_ORIGIN)
      .send({ email, password: "super-secure-test-pass-123" });

    const cookie = loginRes.headers["set-cookie"] as unknown as string[];

    // Obtain session-bound CSRF token
    const csrfRes = await request(app)
      .get("/api/auth/csrf-token")
      .set("Cookie", cookie);

    const csrfToken = csrfRes.body.csrfToken;

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      cookie,
      csrfToken,
    };
  }

  /**
   * Helper to create a document on behalf of an owner session.
   */
  async function createDocument(
    session: TestSession,
    overrides?: { title?: string; category?: string; content?: string }
  ) {
    const title = overrides?.title || `Doc-${Date.now()}`;
    const category = overrides?.category || "Financial";
    const content = overrides?.content || "Confidential document payload: Top Secret!";

    const res = await request(app)
      .post("/api/documents")
      .set("Origin", TRUSTED_ORIGIN)
      .set("Cookie", session.cookie)
      .set("x-csrf-token", session.csrfToken)
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

  /* ── 1. Cross-User Access & Authorization Boundary ────────────────────────── */

  describe("1. Cross-User Access & Anti-Enumeration", () => {
    it("Owner A cannot read Owner B's document without an explicit grant (anti-enumeration 404)", async () => {
      const ownerA = await createSession("owner");
      const ownerB = await createSession("owner");

      const docB = await createDocument(ownerB, { title: "Owner B's Confidential Financials" });

      // Owner A attempts to access Owner B's document
      const res = await request(app)
        .get(`/api/documents/${docB.id}`)
        .set("Cookie", ownerA.cookie);

      // Safe response: Returns 404 to avoid leaking document existence
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Document not found");
      expect(res.body.document).toBeUndefined();
    });

    it("A viewer cannot read an unrelated document by guessing its UUID", async () => {
      const owner = await createSession("owner");
      const viewer = await createSession("viewer");

      const doc = await createDocument(owner, { title: "Executive Compensation Review" });

      const res = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", viewer.cookie);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Document not found");
    });

    it("An administrator does NOT automatically gain access to private document contents", async () => {
      const owner = await createSession("owner");
      const admin = await createSession("admin");

      const doc = await createDocument(owner, {
        title: "Whistleblower Report",
        content: "Highly sensitive confidential memo",
      });

      // Admin attempts metadata read
      const metaRes = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", admin.cookie);

      expect(metaRes.status).toBe(404);
      expect(metaRes.body.error).toBe("Document not found");

      // Admin attempts content download
      const downloadRes = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", admin.cookie);

      expect(downloadRes.status).toBe(404);
      expect(downloadRes.text).not.toContain("Highly sensitive");
    });

    it("Unauthorized download attempts never return document bytes", async () => {
      const owner = await createSession("owner");
      const attacker = await createSession("viewer");

      const secretPayload = "PATENT_PENDING_ALGORITHM_SOURCE_CODE_2026";
      const doc = await createDocument(owner, { content: secretPayload });

      const res = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", attacker.cookie);

      expect(res.status).toBe(404);
      expect(res.text).not.toContain(secretPayload);
      expect(res.body.error).toBe("Document not found");
    });

    it("Listing documents returns only documents the caller is authorized to discover", async () => {
      const owner1 = await createSession("owner");
      const owner2 = await createSession("owner");

      const doc1 = await createDocument(owner1, { title: "Owner1 Project Alpha" });
      const doc2 = await createDocument(owner2, { title: "Owner2 Project Beta" });

      // Owner 1 lists documents
      const listRes1 = await request(app)
        .get("/api/documents")
        .set("Cookie", owner1.cookie);

      expect(listRes1.status).toBe(200);
      const ids1 = listRes1.body.documents.map((d: any) => d.id);
      expect(ids1).toContain(doc1.id);
      expect(ids1).not.toContain(doc2.id); // Must not discover Owner2's doc

      // Owner 1 searches for Owner 2's doc title
      const searchRes = await request(app)
        .get("/api/documents?search=Project+Beta")
        .set("Cookie", owner1.cookie);

      expect(searchRes.status).toBe(200);
      expect(searchRes.body.documents.length).toBe(0);
      expect(searchRes.body.pagination.total).toBe(0);
    });
  });

  /* ── 2. Grant Permissions & Enforcement ──────────────────────────────────── */

  describe("2. Grant Permissions (Read vs Edit)", () => {
    it("Active 'read' grant allows reading metadata and downloading content, but forbids editing or deletion", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");

      const doc = await createDocument(owner, {
        title: "Q3 Earnings Report",
        category: "Finance",
        content: "Gross margin 82%",
      });

      // Owner grants 'read' access to grantee
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
      expect(grantRes.body.grant.permission).toBe("read");

      // Grantee can read metadata
      const readRes = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", grantee.cookie);

      expect(readRes.status).toBe(200);
      expect(readRes.body.document.title).toBe("Q3 Earnings Report");
      expect(readRes.body.document.permission).toBe("read");
      expect(readRes.body.document.isOwner).toBe(false);

      // Grantee can download content
      const downloadRes = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", grantee.cookie);

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.text).toBe("Gross margin 82%");

      // Grantee discovers document in list
      const listRes = await request(app)
        .get("/api/documents")
        .set("Cookie", grantee.cookie);

      expect(listRes.status).toBe(200);
      const found = listRes.body.documents.find((d: any) => d.id === doc.id);
      expect(found).toBeDefined();
      expect(found.permission).toBe("read");

      // Grantee attempts to edit metadata -> 403 Forbidden
      const editRes = await request(app)
        .patch(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", grantee.cookie)
        .set("x-csrf-token", grantee.csrfToken)
        .send({ title: "Tampered Title By Reader" });

      expect(editRes.status).toBe(403);
      expect(editRes.body.error).toBe("Forbidden: 'edit' permission required");

      // Grantee attempts to soft-delete document -> 403 Forbidden
      const deleteRes = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", grantee.cookie)
        .set("x-csrf-token", grantee.csrfToken);

      expect(deleteRes.status).toBe(403);
      expect(deleteRes.body.error).toBe("Forbidden: only the document owner may perform this action");

      // Grantee attempts to list grants -> 403 Forbidden
      const listGrantsRes = await request(app)
        .get(`/api/documents/${doc.id}/grants`)
        .set("Cookie", grantee.cookie);

      expect(listGrantsRes.status).toBe(403);

      // Grantee attempts to share with a third user -> 403 Forbidden
      const thirdUser = await createSession("viewer");
      const shareRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", grantee.cookie)
        .set("x-csrf-token", grantee.csrfToken)
        .send({ email: thirdUser.user.email, permission: "read" });

      expect(shareRes.status).toBe(403);
    });

    it("Active 'edit' grant permits updating metadata, but strictly forbids deletion or grant management", async () => {
      const owner = await createSession("owner");
      const editor = await createSession("viewer");

      const doc = await createDocument(owner, {
        title: "Draft Architecture Specification",
        category: "Engineering",
        content: "v1 system diagrams",
      });

      // Owner grants 'edit' permission
      await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          email: editor.user.email,
          permission: "edit",
        });

      // Editor updates permitted metadata (title and category)
      const editRes = await request(app)
        .patch(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", editor.cookie)
        .set("x-csrf-token", editor.csrfToken)
        .send({
          title: "Approved Architecture Specification v2",
          category: "Architecture",
        });

      expect(editRes.status).toBe(200);
      expect(editRes.body.document.title).toBe("Approved Architecture Specification v2");
      expect(editRes.body.document.category).toBe("Architecture");

      // Editor attempts deletion -> 403 Forbidden (only owner may delete)
      const deleteRes = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", editor.cookie)
        .set("x-csrf-token", editor.csrfToken);

      expect(deleteRes.status).toBe(403);
      expect(deleteRes.body.error).toBe("Forbidden: only the document owner may perform this action");

      // Editor attempts grant management -> 403 Forbidden
      const listGrantsRes = await request(app)
        .get(`/api/documents/${doc.id}/grants`)
        .set("Cookie", editor.cookie);

      expect(listGrantsRes.status).toBe(403);
    });

    it("A grant for one document never grants access to another document owned by the same person", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");

      const docShared = await createDocument(owner, { title: "Shared Public Whitepaper" });
      const docPrivate = await createDocument(owner, { title: "Unshared Internal Audit" });

      // Grant access only to docShared
      await request(app)
        .post(`/api/documents/${docShared.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: grantee.user.email, permission: "read" });

      // Access to docShared succeeds
      const sharedRes = await request(app)
        .get(`/api/documents/${docShared.id}`)
        .set("Cookie", grantee.cookie);
      expect(sharedRes.status).toBe(200);

      // Access to docPrivate is denied with 404
      const privateRes = await request(app)
        .get(`/api/documents/${docPrivate.id}`)
        .set("Cookie", grantee.cookie);
      expect(privateRes.status).toBe(404);
      expect(privateRes.body.error).toBe("Document not found");
    });
  });

  /* ── 3. Immediate Revocation & Concurrency ────────────────────────────────── */

  describe("3. Immediate Revocation & Grant Lifecycle", () => {
    it("Revoked grant takes effect immediately on subsequent metadata and download requests", async () => {
      const owner = await createSession("owner");
      const user = await createSession("viewer");

      const doc = await createDocument(owner, {
        title: "Confidential Roadmap",
        content: "Product launch date: Nov 15",
      });

      // Grant read access
      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "read" });

      const grantId = grantRes.body.grant.id;

      // Verify user can read
      const canReadRes = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", user.cookie);
      expect(canReadRes.status).toBe(200);

      // Owner revokes access immediately
      const revokeRes = await request(app)
        .delete(`/api/documents/${doc.id}/grants/${grantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.message).toBe("Grant revoked successfully");

      // Subsequent metadata access is immediately denied (404 anti-enumeration)
      const afterRevokeMeta = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", user.cookie);

      expect(afterRevokeMeta.status).toBe(404);
      expect(afterRevokeMeta.body.error).toBe("Document not found");

      // Subsequent download attempt is immediately denied
      const afterRevokeDownload = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", user.cookie);

      expect(afterRevokeDownload.status).toBe(404);
      expect(afterRevokeDownload.text).not.toContain("Nov 15");
    });

    it("Re-granting after revocation preserves historical grant records and activates access", async () => {
      const owner = await createSession("owner");
      const user = await createSession("viewer");

      const doc = await createDocument(owner, { title: "Client Agreement" });

      // First grant
      const firstGrantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "read" });

      const firstGrantId = firstGrantRes.body.grant.id;

      // Revoke first grant
      await request(app)
        .delete(`/api/documents/${doc.id}/grants/${firstGrantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      // Re-grant access with 'edit' permission
      const reGrantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "edit" });

      expect(reGrantRes.status).toBe(201);
      expect(reGrantRes.body.grant.permission).toBe("edit");
      expect(reGrantRes.body.grant.id).not.toBe(firstGrantId);

      // Listing grants shows BOTH the revoked grant and the active grant
      const grantsListRes = await request(app)
        .get(`/api/documents/${doc.id}/grants`)
        .set("Cookie", owner.cookie);

      expect(grantsListRes.status).toBe(200);
      expect(grantsListRes.body.grants.length).toBe(2);

      const activeGrant = grantsListRes.body.grants.find((g: any) => g.isActive);
      const revokedGrant = grantsListRes.body.grants.find((g: any) => !g.isActive);

      expect(activeGrant).toBeDefined();
      expect(activeGrant.permission).toBe("edit");
      expect(revokedGrant).toBeDefined();
      expect(revokedGrant.permission).toBe("read");
      expect(revokedGrant.revokedAt).toBeDefined();
    });

    it("Prevents duplicate active grants for the same user and handles unique conflict gracefully", async () => {
      const owner = await createSession("owner");
      const user = await createSession("viewer");

      const doc = await createDocument(owner, { title: "Intellectual Property Filing" });

      // First grant
      const firstRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "read" });

      expect(firstRes.status).toBe(201);

      // Duplicate grant attempt
      const dupRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "edit" });

      expect(dupRes.status).toBe(409);
      expect(dupRes.body.error).toBe("An active grant already exists for this user");
    });

    it("Owner can update an active grant's permission ('read' to 'edit')", async () => {
      const owner = await createSession("owner");
      const user = await createSession("viewer");

      const doc = await createDocument(owner, { title: "Joint Venture Agreement" });

      // Create read grant
      const grantRes = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: user.user.email, permission: "read" });

      const grantId = grantRes.body.grant.id;

      // Update grant to edit
      const updateRes = await request(app)
        .patch(`/api/documents/${doc.id}/grants/${grantId}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ permission: "edit" });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.grant.permission).toBe("edit");

      // Verify grantee now has edit permission
      const metaRes = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", user.cookie);

      expect(metaRes.status).toBe(200);
      expect(metaRes.body.document.permission).toBe("edit");
    });
  });

  /* ── 4. Identity & Request Tampering ─────────────────────────────────────── */

  describe("4. Identity and Request Manipulation Resistance", () => {
    it("Rejects client attempts to assign arbitrary owner_id on document creation", async () => {
      const ownerA = await createSession("owner");
      const ownerB = await createSession("owner");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", ownerA.cookie)
        .set("x-csrf-token", ownerA.csrfToken)
        .send({
          title: "Malicious Document",
          category: "General",
          content: "Attacker attempting to spoof owner_id",
          owner_id: ownerB.user.id, // Tampering attempt
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(res.body.details[0].message).toContain("Unexpected fields");
    });

    it("Rejects client attempts to modify owner_id or storage_key on update", async () => {
      const ownerA = await createSession("owner");
      const ownerB = await createSession("owner");

      const doc = await createDocument(ownerA, { title: "Original Title" });

      const res = await request(app)
        .patch(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", ownerA.cookie)
        .set("x-csrf-token", ownerA.csrfToken)
        .send({
          title: "New Title",
          owner_id: ownerB.user.id, // Tampering attempt
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(res.body.details[0].message).toContain("Unexpected fields");
    });

    it("Rejects document creation by users with least-privileged 'viewer' role", async () => {
      const viewer = await createSession("viewer");

      const res = await request(app)
        .post("/api/documents")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", viewer.cookie)
        .set("x-csrf-token", viewer.csrfToken)
        .send({
          title: "Unauthorized Document",
          category: "General",
          content: "Viewer attempting to upload",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Forbidden: viewers cannot create documents");
    });

    it("Rejects malformed document and grant UUIDs safely without 500 error", async () => {
      const owner = await createSession("owner");

      const badDocRes = await request(app)
        .get("/api/documents/not-a-valid-uuid-1234")
        .set("Cookie", owner.cookie);

      expect(badDocRes.status).toBe(404);
      expect(badDocRes.body.error).toBe("Document not found");

      const validDoc = await createDocument(owner);

      const badGrantRes = await request(app)
        .delete(`/api/documents/${validDoc.id}/grants/malformed-grant-uuid`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(badGrantRes.status).toBe(404);
      expect(badGrantRes.body.error).toBe("Grant not found");
    });

    it("Disallows owner granting access to themselves", async () => {
      const owner = await createSession("owner");
      const doc = await createDocument(owner);

      const res = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          email: owner.user.email,
          permission: "read",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Cannot grant access to the document owner");
    });

    it("Disallows granting access to a disabled user account", async () => {
      const owner = await createSession("owner");
      const disabledUserEmail = uniqueEmail("disabled");
      createdTestEmails.push(disabledUserEmail);

      const hash = await hashPassword("password12345678");
      await pool.query(
        `INSERT INTO public.users (email, password_hash, role, status)
         VALUES ($1, $2, 'viewer', 'disabled')`,
        [disabledUserEmail, hash]
      );

      const doc = await createDocument(owner);

      const res = await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({
          email: disabledUserEmail,
          permission: "read",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Cannot grant access to a disabled account");
    });
  });

  /* ── 5. Lifecycle, Soft-Deletion, and Audit Trail ────────────────────────── */

  describe("5. Lifecycle, Soft-Deletion & Audit Trail", () => {
    it("Soft-deleted document is inaccessible to owner, grantees, and search", async () => {
      const owner = await createSession("owner");
      const grantee = await createSession("viewer");

      const doc = await createDocument(owner, {
        title: "Retiring Product Roadmap",
        content: "EOL details for 2026",
      });

      // Grant access before deletion
      await request(app)
        .post(`/api/documents/${doc.id}/grants`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken)
        .send({ email: grantee.user.email, permission: "read" });

      // Owner soft-deletes document
      const deleteRes = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", owner.cookie)
        .set("x-csrf-token", owner.csrfToken);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.message).toBe("Document deleted successfully");

      // Verify owner receives 404
      const ownerRead = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);
      expect(ownerRead.status).toBe(404);

      // Verify grantee receives 404
      const granteeRead = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", grantee.cookie);
      expect(granteeRead.status).toBe(404);

      // Verify download receives 404
      const downloadRes = await request(app)
        .get(`/api/documents/${doc.id}/download`)
        .set("Cookie", owner.cookie);
      expect(downloadRes.status).toBe(404);

      // Verify document no longer appears in document list
      const listRes = await request(app)
        .get("/api/documents")
        .set("Cookie", owner.cookie);
      const ids = listRes.body.documents.map((d: any) => d.id);
      expect(ids).not.toContain(doc.id);
    });

    it("Records audit trail events in public.audit_events without leaking sensitive data", async () => {
      const owner = await createSession("owner");
      const doc = await createDocument(owner, {
        title: "Audit Test File",
        content: "Secret content that must never be recorded in audit logs",
      });

      // Read document to trigger audit event
      await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Cookie", owner.cookie);

      // Check audit events for this document
      const auditResult = await pool.query(
        `SELECT action, outcome, metadata
         FROM public.audit_events
         WHERE document_id = $1
         ORDER BY occurred_at DESC`,
        [doc.id]
      );

      expect(auditResult.rows.length).toBeGreaterThanOrEqual(2); // create_document + read_metadata
      const actions = auditResult.rows.map((r) => r.action);
      expect(actions).toContain("create_document");
      expect(actions).toContain("read_metadata");

      // Ensure secret content was not logged in metadata
      for (const row of auditResult.rows) {
        const metadataStr = JSON.stringify(row.metadata);
        expect(metadataStr).not.toContain("Secret content");
      }
    });

    it("Fails closed when database query encounters an unexpected error", async () => {
      const owner = await createSession("owner");

      const mockPool = {
        query: vi.fn().mockRejectedValue(new Error("Simulated PostgreSQL connection failure")),
      };

      const authResult = await authorizeDocumentAccess({
        user: {
          id: owner.user.id,
          email: owner.user.email,
          role: owner.user.role,
          status: "active",
        },
        documentId: "12345678-1234-4234-a234-123456789abc",
        action: "read_metadata",
        dbPool: mockPool as any,
      });

      // Must fail closed with 500 without leaking raw internal error
      expect(authResult.authorized).toBe(false);
      expect(authResult.statusCode).toBe(500);
      expect(authResult.reason).toBe("Authorization service failure");
    });
  });
});
