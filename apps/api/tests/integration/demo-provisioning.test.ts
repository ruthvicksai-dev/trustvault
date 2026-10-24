import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { verifyPassword, hashPassword } from "../../src/auth/argon2.js";
import {
  provisionDemoData,
  resetDemoData,
  validateDemoConfig,
  SYNTHETIC_DEMO_PDF_BUFFER,
  type DemoProvisionConfig,
} from "../../src/db/provision-demo.js";
import { setStorageDriver, InMemoryStorageDriver } from "../../src/documents/storage.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

describe("TrustVault — Demo Account Provisioning & Evaluator Access (Integration)", () => {
  const memoryStorage = new InMemoryStorageDriver();

  const timestamp = Date.now();
  const testConfig: DemoProvisionConfig = {
    enabled: true,
    isProduction: false,
    productionConfirmed: false,
    accounts: {
      admin: {
        email: `admin-eval-${timestamp}@vault.test`,
        password: "AdminEvalPassword123!",
        role: "admin",
        displayName: "Demo Administrator",
      },
      owner: {
        email: `owner-eval-${timestamp}@vault.test`,
        password: "OwnerEvalPassword123!",
        role: "owner",
        displayName: "Demo Document Owner",
      },
      viewer: {
        email: `viewer-eval-${timestamp}@vault.test`,
        password: "ViewerEvalPassword123!",
        role: "viewer",
        displayName: "Demo Document Viewer",
      },
    },
  };

  let docAId: string; // Active shared document
  let docBId: string; // Unshared confidential document
  let docCId: string; // Revoked access document

  beforeAll(async () => {
    setStorageDriver(memoryStorage);
  });

  afterAll(async () => {
    // Safely reset synthetic demo data
    await resetDemoData(pool, testConfig);
  });

  describe("1. Environment-Controlled Provisioning & Idempotency", () => {
    it("provisions synthetic demo accounts, documents, grants, and audit events", async () => {
      const result = await provisionDemoData(pool, testConfig);

      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(3);
      expect(result.documentsSeeded).toBe(3);
      expect(result.grantsSeeded).toBeGreaterThanOrEqual(2);
      expect(result.auditEventsRecorded).toBeGreaterThanOrEqual(5);

      // Verify each account was marked as 'created' on first run
      for (const acct of result.accounts) {
        expect(acct.status).toBe("created");
        expect(acct.userId).toBeDefined();
      }

      // Verify passwords in database are hashed with Argon2id and never stored in plaintext
      const userRows = await pool.query(
        "SELECT email, password_hash, role, status FROM public.users WHERE email = ANY($1)",
        [[
          testConfig.accounts.admin.email,
          testConfig.accounts.owner.email,
          testConfig.accounts.viewer.email,
        ]]
      );
      expect(userRows.rows).toHaveLength(3);

      for (const row of userRows.rows) {
        expect(row.password_hash).toMatch(/^\$argon2id\$/);
        expect(row.password_hash).not.toContain("AdminEvalPassword123!");
        expect(row.password_hash).not.toContain("OwnerEvalPassword123!");
        expect(row.password_hash).not.toContain("ViewerEvalPassword123!");

        if (row.email === testConfig.accounts.admin.email) {
          expect(await verifyPassword(row.password_hash, "AdminEvalPassword123!")).toBe(true);
          expect(row.role).toBe("admin");
        } else if (row.email === testConfig.accounts.owner.email) {
          expect(await verifyPassword(row.password_hash, "OwnerEvalPassword123!")).toBe(true);
          expect(row.role).toBe("owner");
        } else if (row.email === testConfig.accounts.viewer.email) {
          expect(await verifyPassword(row.password_hash, "ViewerEvalPassword123!")).toBe(true);
          expect(row.role).toBe("viewer");
        }
      }

      // Fetch the 3 seeded document IDs
      const docsRes = await pool.query(
        "SELECT id, storage_key FROM public.documents WHERE storage_key LIKE 'demo-%'"
      );
      for (const doc of docsRes.rows) {
        if (doc.storage_key === "demo-shared-q4-financial-audit.pdf") {
          docAId = doc.id;
        } else if (doc.storage_key === "demo-unshared-executive-comp.pdf") {
          docBId = doc.id;
        } else if (doc.storage_key === "demo-revoked-vendor-assessment.pdf") {
          docCId = doc.id;
        }
      }
      expect(docAId).toBeDefined();
      expect(docBId).toBeDefined();
      expect(docCId).toBeDefined();
    });

    it("is strictly idempotent: repeated execution does not duplicate accounts or overwrite existing hashes", async () => {
      // Record initial password hashes
      const beforeUsers = await pool.query(
        "SELECT email, password_hash, role FROM public.users WHERE email = ANY($1)",
        [[
          testConfig.accounts.admin.email,
          testConfig.accounts.owner.email,
          testConfig.accounts.viewer.email,
        ]]
      );
      const beforeMap = new Map(beforeUsers.rows.map((u) => [u.email, u.password_hash]));

      // Run provisioning a second time
      const secondResult = await provisionDemoData(pool, testConfig);
      expect(secondResult.success).toBe(true);

      // Verify all accounts report status 'preserved'
      for (const acct of secondResult.accounts) {
        expect(acct.status).toBe("preserved");
      }

      // Verify user count did NOT increase
      const afterUsers = await pool.query(
        "SELECT email, password_hash, role FROM public.users WHERE email = ANY($1)",
        [[
          testConfig.accounts.admin.email,
          testConfig.accounts.owner.email,
          testConfig.accounts.viewer.email,
        ]]
      );
      expect(afterUsers.rows).toHaveLength(3);

      // Verify password hashes and roles were NOT overwritten
      for (const u of afterUsers.rows) {
        expect(u.password_hash).toBe(beforeMap.get(u.email));
      }
    });

    it("does not overwrite or promote existing users if an existing account matches a demo email", async () => {
      const customEmail = `preexisting-user-${timestamp}@vault.test`;
      const originalCustomHash = await hashPassword("OriginalUserPassword999!");

      // Insert pre-existing user with role 'viewer'
      await pool.query(
        `INSERT INTO public.users (email, password_hash, role, status)
         VALUES ($1, $2, 'viewer', 'active')`,
        [customEmail, originalCustomHash]
      );

      // Attempt to provision demo admin using the pre-existing user's email
      const clashConfig: DemoProvisionConfig = {
        enabled: true,
        isProduction: false,
        productionConfirmed: false,
        accounts: {
          admin: {
            email: customEmail,
            password: "AttemptedAdminPassword123!",
            role: "admin", // Attempted promotion
            displayName: "Fake Admin",
          },
          owner: testConfig.accounts.owner,
          viewer: testConfig.accounts.viewer,
        },
      };

      const result = await provisionDemoData(pool, clashConfig);
      const clashingAccount = result.accounts.find((a) => a.email === customEmail);
      expect(clashingAccount?.status).toBe("preserved");
      expect(clashingAccount?.role).toBe("viewer"); // Stays viewer, NOT promoted!

      // Check DB directly
      const checkRes = await pool.query(
        "SELECT role, password_hash FROM public.users WHERE email = $1",
        [customEmail]
      );
      expect(checkRes.rows[0].role).toBe("viewer");
      expect(checkRes.rows[0].password_hash).toBe(originalCustomHash);

      // Cleanup pre-existing user
      await pool.query("DELETE FROM public.users WHERE email = $1", [customEmail]);
    });
  });

  describe("2. Demo Role Verification & Scenario Testing", () => {
    // Helper to log in and get cookie + csrf token
    async function loginUser(email: string, password: string) {
      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers["set-cookie"] as unknown as string[];
      expect(cookie).toBeDefined();

      const csrfRes = await request(app)
        .get("/api/auth/csrf-token")
        .set("Cookie", cookie);
      const csrfToken = csrfRes.body.csrfToken;

      return { cookie, csrfToken, user: loginRes.body.user };
    }

    it("Owner Demo: can authenticate, view owned documents, and access own audit trail", async () => {
      const { cookie, user } = await loginUser(
        testConfig.accounts.owner.email,
        testConfig.accounts.owner.password
      );

      expect(user.role).toBe("owner");

      // Can list documents and sees owned documents
      const docsRes = await request(app)
        .get("/api/documents")
        .set("Cookie", cookie);

      expect(docsRes.status).toBe(200);
      expect(docsRes.body.documents.length).toBeGreaterThanOrEqual(3);

      // Can view metadata of owned document
      const docARes = await request(app)
        .get(`/api/documents/${docAId}`)
        .set("Cookie", cookie);
      expect(docARes.status).toBe(200);
      expect(docARes.body.document.title).toBe("Confidential_Q4_Financial_Audit_Report.pdf");
      expect(docARes.body.document.isOwner).toBe(true);
      expect(docARes.body.document.permission).toBe("owner");

      // Can view audit events for own document
      const auditRes = await request(app)
        .get(`/api/documents/${docAId}/audit`)
        .set("Cookie", cookie);
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);

      // Cannot access administrative user management
      const adminRes = await request(app)
        .get("/api/admin/users")
        .set("Cookie", cookie);
      expect(adminRes.status).toBe(403);
    });

    it("Viewer Demo: can view granted Document A, but is denied upload and unshared documents", async () => {
      const { cookie, csrfToken, user } = await loginUser(
        testConfig.accounts.viewer.email,
        testConfig.accounts.viewer.password
      );

      expect(user.role).toBe("viewer");

      // 1. Can view granted Document A
      const docARes = await request(app)
        .get(`/api/documents/${docAId}`)
        .set("Cookie", cookie);
      expect(docARes.status).toBe(200);
      expect(docARes.body.document.id).toBe(docAId);
      expect(docARes.body.document.isOwner).toBe(false);
      expect(docARes.body.document.permission).toBe("read");

      // 2. CANNOT access unshared Document B (anti-enumeration 404)
      const docBRes = await request(app)
        .get(`/api/documents/${docBId}`)
        .set("Cookie", cookie);
      expect(docBRes.status).toBe(404);
      expect(docBRes.body.error).toBe("Document not found");

      // 3. CANNOT download unshared Document B (anti-enumeration 404)
      const dlBRes = await request(app)
        .get(`/api/documents/${docBId}/download`)
        .set("Cookie", cookie);
      expect(dlBRes.status).toBe(404);
      expect(dlBRes.body.error).toBe("Document not found");

      // 4. CANNOT access revoked Document C (anti-enumeration 404)
      const docCRes = await request(app)
        .get(`/api/documents/${docCId}`)
        .set("Cookie", cookie);
      expect(docCRes.status).toBe(404);
      expect(docCRes.body.error).toBe("Document not found");

      // 5. Cannot upload documents (403 Forbidden for viewer role)
      const uploadRes = await request(app)
        .post("/api/documents")
        .set("Cookie", cookie)
        .set("x-csrf-token", csrfToken)
        .set("Origin", TRUSTED_ORIGIN)
        .attach("file", SYNTHETIC_DEMO_PDF_BUFFER, {
          filename: "viewer-unauthorized.pdf",
          contentType: "application/pdf",
        })
        .field("title", "Unauthorized Viewer Upload")
        .field("category", "Test");
      expect(uploadRes.status).toBe(403);
    });

    it("Admin Demo: can manage users and audit log, but cannot access documents without a grant", async () => {
      const { cookie, user } = await loginUser(
        testConfig.accounts.admin.email,
        testConfig.accounts.admin.password
      );

      expect(user.role).toBe("admin");

      // 1. Can list all registered users
      const usersRes = await request(app)
        .get("/api/admin/users")
        .set("Cookie", cookie);
      expect(usersRes.status).toBe(200);
      expect(usersRes.body.users.length).toBeGreaterThanOrEqual(3);

      // 2. Can inspect system-wide audit oversight log
      const auditRes = await request(app)
        .get("/api/audit")
        .set("Cookie", cookie);
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.events.length).toBeGreaterThanOrEqual(3);

      // 3. Least privilege: Admin CANNOT view or download Document A without an explicit grant
      const docARes = await request(app)
        .get(`/api/documents/${docAId}`)
        .set("Cookie", cookie);
      expect(docARes.status).toBe(404); // Least-privilege anti-enumeration 404!

      const dlARes = await request(app)
        .get(`/api/documents/${docAId}/download`)
        .set("Cookie", cookie);
      expect(dlARes.status).toBe(404);
    });

    it("Immediate Revocation: revoking viewer's grant immediately blocks subsequent access", async () => {
      // 1. Owner logs in and grants viewer access to Document B
      const ownerSession = await loginUser(
        testConfig.accounts.owner.email,
        testConfig.accounts.owner.password
      );

      const grantRes = await request(app)
        .post(`/api/documents/${docBId}/grants`)
        .set("Cookie", ownerSession.cookie)
        .set("x-csrf-token", ownerSession.csrfToken)
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: testConfig.accounts.viewer.email,
          permission: "read",
        });

      expect(grantRes.status).toBe(201);
      const grantId = grantRes.body.grant.id;

      // 2. Viewer logs in and verifies access to Document B
      const viewerSession = await loginUser(
        testConfig.accounts.viewer.email,
        testConfig.accounts.viewer.password
      );

      const viewerAccessRes = await request(app)
        .get(`/api/documents/${docBId}`)
        .set("Cookie", viewerSession.cookie);
      expect(viewerAccessRes.status).toBe(200);
      expect(viewerAccessRes.body.document.id).toBe(docBId);

      // 3. Owner revokes viewer's grant
      const revokeRes = await request(app)
        .delete(`/api/documents/${docBId}/grants/${grantId}`)
        .set("Cookie", ownerSession.cookie)
        .set("x-csrf-token", ownerSession.csrfToken)
        .set("Origin", TRUSTED_ORIGIN);
      expect(revokeRes.status).toBe(200);

      // 4. Viewer immediately attempts to access Document B again -> 404 Not Found
      const revokedAccessRes = await request(app)
        .get(`/api/documents/${docBId}`)
        .set("Cookie", viewerSession.cookie);
      expect(revokedAccessRes.status).toBe(404);
      expect(revokedAccessRes.body.error).toBe("Document not found");
    });
  });

  describe("3. Safe Demo Data Reset", () => {
    it("resets synthetic demo records cleanly without affecting non-demo users", async () => {
      // Create a separate non-demo user
      const realUserEmail = `real-user-${timestamp}@vault.test`;
      const realPasswordHash = await hashPassword("RealPassword123!");
      await pool.query(
        `INSERT INTO public.users (email, password_hash, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [realUserEmail, realPasswordHash]
      );

      // Execute safe reset
      const resetResult = await resetDemoData(pool, testConfig);
      expect(resetResult.success).toBe(true);
      expect(resetResult.deletedUsers).toBe(3);

      // Verify demo users are gone
      const demoUsersRes = await pool.query(
        "SELECT id FROM public.users WHERE email = ANY($1)",
        [[
          testConfig.accounts.admin.email,
          testConfig.accounts.owner.email,
          testConfig.accounts.viewer.email,
        ]]
      );
      expect(demoUsersRes.rows).toHaveLength(0);

      // Verify real non-demo user is preserved!
      const realUserRes = await pool.query(
        "SELECT id, email FROM public.users WHERE email = $1",
        [realUserEmail]
      );
      expect(realUserRes.rows).toHaveLength(1);

      // Clean up the non-demo test user
      await pool.query("DELETE FROM public.users WHERE email = $1", [realUserEmail]);
    });
  });
});
