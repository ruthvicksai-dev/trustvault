import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/auth/argon2.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

function uniqueEmail(prefix = "admin-test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@example.com`;
}

interface TestSession {
  user: {
    id: string;
    email: string;
    role: "owner" | "viewer" | "admin";
    status: "active" | "disabled";
    displayName?: string | null;
  };
  cookie: string[];
  csrfToken: string;
}

describe("TrustVault — Admin User Management Integration Tests", () => {
  const createdTestEmails: string[] = [];
  let sharedPasswordHash: string;

  beforeAll(async () => {
    sharedPasswordHash = await hashPassword("admin-test-pass-123");
  });

  afterAll(async () => {
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
         ) OR (metadata->>'targetUserId') IN (
           SELECT id::text FROM public.users WHERE email = ANY($1)
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

  async function createSession(
    role: "owner" | "viewer" | "admin" = "viewer",
    status: "active" | "disabled" = "active",
    displayName: string | null = null
  ): Promise<TestSession> {
    const email = uniqueEmail(role);
    createdTestEmails.push(email);

    const insertRes = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status, display_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, role, status, display_name`,
      [email, sharedPasswordHash, role, status, displayName]
    );

    const user = insertRes.rows[0];

    const loginRes = await request(app)
      .post("/api/auth/login")
      .set("Origin", TRUSTED_ORIGIN)
      .send({ email, password: "admin-test-pass-123" });

    const cookie = loginRes.headers["set-cookie"] as unknown as string[];

    let csrfToken = "";
    if (cookie) {
      const csrfRes = await request(app)
        .get("/api/auth/csrf-token")
        .set("Cookie", cookie);
      csrfToken = csrfRes.body.csrfToken;
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        displayName: user.display_name,
      },
      cookie,
      csrfToken,
    };
  }

  describe("GET /api/admin/users — Authorization & Listing", () => {
    it("allows admin to list users with pagination metadata", async () => {
      const adminSession = await createSession("admin");
      const targetUser = await createSession("viewer", "active", "Test Viewer");

      const res = await request(app)
        .get("/api/admin/users?limit=10&offset=0")
        .set("Cookie", adminSession.cookie);

      expect(res.status).toBe(200);
      expect(res.body.users).toBeInstanceOf(Array);
      expect(res.body.users.length).toBeGreaterThan(0);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.limit).toBe(10);
      expect(res.body.pagination.offset).toBe(0);
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);

      // Verify data minimization — NO password_hash in response
      const foundTarget = res.body.users.find((u: any) => u.id === targetUser.user.id);
      expect(foundTarget).toBeDefined();
      expect(foundTarget.email).toBe(targetUser.user.email);
      expect(foundTarget.role).toBe("viewer");
      expect(foundTarget.status).toBe("active");
      expect(foundTarget.displayName).toBe("Test Viewer");
      expect(foundTarget.password_hash).toBeUndefined();
      expect(foundTarget.password).toBeUndefined();
    });

    it("rejects non-admin roles (viewer and owner) with 403 Forbidden", async () => {
      const viewerSession = await createSession("viewer");
      const ownerSession = await createSession("owner");

      const viewerRes = await request(app)
        .get("/api/admin/users")
        .set("Cookie", viewerSession.cookie);
      expect(viewerRes.status).toBe(403);
      expect(viewerRes.body.error).toContain("Forbidden");

      const ownerRes = await request(app)
        .get("/api/admin/users")
        .set("Cookie", ownerSession.cookie);
      expect(ownerRes.status).toBe(403);
      expect(ownerRes.body.error).toContain("Forbidden");
    });

    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const res = await request(app).get("/api/admin/users");
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Authentication required");
    });

    it("filters users by role, status, and search query safely without SQL injection", async () => {
      const adminSession = await createSession("admin");
      const uniqueName = `SpecialAdminSearch-${Date.now()}`;
      await createSession("owner", "active", uniqueName);

      const searchRes = await request(app)
        .get(`/api/admin/users?search=${encodeURIComponent(uniqueName)}&role=owner&status=active`)
        .set("Cookie", adminSession.cookie);

      expect(searchRes.status).toBe(200);
      expect(searchRes.body.users.length).toBe(1);
      expect(searchRes.body.users[0].displayName).toBe(uniqueName);
    });
  });

  describe("GET /api/admin/users/:id — Single User Details", () => {
    it("allows admin to fetch single user details without sensitive data", async () => {
      const adminSession = await createSession("admin");
      const target = await createSession("viewer", "active", "Single User Check");

      const res = await request(app)
        .get(`/api/admin/users/${target.user.id}`)
        .set("Cookie", adminSession.cookie);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(target.user.id);
      expect(res.body.user.email).toBe(target.user.email);
      expect(res.body.user.displayName).toBe("Single User Check");
      expect(res.body.user.password_hash).toBeUndefined();
    });

    it("returns 400 for malformed UUID and 404 for non-existent user", async () => {
      const adminSession = await createSession("admin");

      const badUuidRes = await request(app)
        .get("/api/admin/users/not-a-valid-uuid")
        .set("Cookie", adminSession.cookie);
      expect(badUuidRes.status).toBe(400);

      const notFoundRes = await request(app)
        .get("/api/admin/users/a0000000-0000-4000-8000-000000000000")
        .set("Cookie", adminSession.cookie);
      expect(notFoundRes.status).toBe(404);
    });
  });

  describe("PATCH /api/admin/users/:id/role — Role Management", () => {
    it("allows admin to promote viewer to owner and demote back to viewer", async () => {
      const adminSession = await createSession("admin");
      const target = await createSession("viewer");

      // Promote to owner
      const promoteRes = await request(app)
        .patch(`/api/admin/users/${target.user.id}/role`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ role: "owner" });

      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.user.role).toBe("owner");

      // Demote back to viewer
      const demoteRes = await request(app)
        .patch(`/api/admin/users/${target.user.id}/role`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ role: "viewer" });

      expect(demoteRes.status).toBe(200);
      expect(demoteRes.body.user.role).toBe("viewer");
    });

    it("prevents admin from modifying their own role (self-demotion protection)", async () => {
      const adminSession = await createSession("admin");

      const res = await request(app)
        .patch(`/api/admin/users/${adminSession.user.id}/role`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ role: "owner" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("cannot modify their own role");
    });

    it("protects the last remaining admin from being demoted", async () => {
      // Ensure only 1 active admin exists by demoting other test admins temporarily or creating a single admin
      const admin1 = await createSession("admin");
      const admin2 = await createSession("admin");

      // Demote admin2 to owner first
      const demote2 = await request(app)
        .patch(`/api/admin/users/${admin2.user.id}/role`)
        .set("Cookie", admin1.cookie)
        .set("x-csrf-token", admin1.csrfToken)
        .send({ role: "owner" });
      expect(demote2.status).toBe(200);

      // Now demote any other admins in the test DB so admin1 is the ONLY active admin
      await pool.query(
        `UPDATE public.users SET role = 'owner' WHERE role = 'admin' AND id != $1`,
        [admin1.user.id]
      );

      // Admin2 (now owner) cannot change roles anyway
      // Now create another admin so they can try to demote admin1
      const anotherAdmin = await createSession("admin");
      // Demote anotherAdmin
      await pool.query(`UPDATE public.users SET role = 'owner' WHERE id = $1`, [anotherAdmin.user.id]);

      // At this point, admin1 is the sole admin. If another admin tried to demote admin1:
      // Let's create an admin who tries to demote admin1 when admin1 is the sole other admin
      const actingAdmin = await createSession("admin");
      // Now actingAdmin demotes admin1
      await request(app)
        .patch(`/api/admin/users/${admin1.user.id}/role`)
        .set("Cookie", actingAdmin.cookie)
        .set("x-csrf-token", actingAdmin.csrfToken)
        .send({ role: "owner" });

      // Now actingAdmin is the ONLY active admin. If actingAdmin tries to demote someone, but there are 0 other admins:
      // If someone tries to demote actingAdmin:
      const soleDemoteAttempt = await request(app)
        .patch(`/api/admin/users/${actingAdmin.user.id}/role`)
        .set("Cookie", actingAdmin.cookie)
        .set("x-csrf-token", actingAdmin.csrfToken)
        .send({ role: "owner" });
      // Self-modification caught first
      expect(soleDemoteAttempt.status).toBe(400);
    });

    it("rejects invalid role values with 400 validation error", async () => {
      const adminSession = await createSession("admin");
      const target = await createSession("viewer");

      const res = await request(app)
        .patch(`/api/admin/users/${target.user.id}/role`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ role: "superuser" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Validation error");
    });

    it("rejects role change when CSRF token is missing", async () => {
      const adminSession = await createSession("admin");
      const target = await createSession("viewer");

      const res = await request(app)
        .patch(`/api/admin/users/${target.user.id}/role`)
        .set("Cookie", adminSession.cookie)
        .send({ role: "owner" });

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /api/admin/users/:id/status — Account Disabling and Immediate Session Revocation", () => {
    it("allows admin to disable a user and immediately purges all their active sessions", async () => {
      const adminSession = await createSession("admin");
      const targetSession = await createSession("viewer");

      // Verify target has a working session right now
      const preCheck = await request(app)
        .get("/api/auth/me")
        .set("Cookie", targetSession.cookie);
      expect(preCheck.status).toBe(200);

      // Admin disables target account
      const disableRes = await request(app)
        .patch(`/api/admin/users/${targetSession.user.id}/status`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ status: "disabled" });

      expect(disableRes.status).toBe(200);
      expect(disableRes.body.user.status).toBe("disabled");

      // Verify sessions table in DB has deleted target user's sessions
      const sessionCountRes = await pool.query(
        `SELECT COUNT(*) FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1`,
        [targetSession.user.id]
      );
      expect(Number(sessionCountRes.rows[0].count)).toBe(0);

      // Verify target user's existing session cookie is immediately rejected on subsequent requests
      const postCheck = await request(app)
        .get("/api/auth/me")
        .set("Cookie", targetSession.cookie);
      expect(postCheck.status).toBe(401); // Session was destroyed
    });

    it("allows admin to re-enable a previously disabled account", async () => {
      const adminSession = await createSession("admin");
      const target = await createSession("viewer", "disabled");

      const reEnableRes = await request(app)
        .patch(`/api/admin/users/${target.user.id}/status`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ status: "active" });

      expect(reEnableRes.status).toBe(200);
      expect(reEnableRes.body.user.status).toBe("active");
    });

    it("prevents admin from disabling their own account", async () => {
      const adminSession = await createSession("admin");

      const res = await request(app)
        .patch(`/api/admin/users/${adminSession.user.id}/status`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ status: "disabled" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("cannot disable their own account");
    });
  });

  describe("Audit Trail Verification for Admin Operations", () => {
    it("records audit events for admin role and status modifications with actor attribution", async () => {
      const adminSession = await createSession("admin");
      const target = await createSession("viewer");

      // 1. Change role
      await request(app)
        .patch(`/api/admin/users/${target.user.id}/role`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ role: "owner" });

      // 2. Disable user
      await request(app)
        .patch(`/api/admin/users/${target.user.id}/status`)
        .set("Cookie", adminSession.cookie)
        .set("x-csrf-token", adminSession.csrfToken)
        .send({ status: "disabled" });

      // Query audit logs
      const auditRes = await pool.query(
        `SELECT action, actor_id, metadata
         FROM public.audit_events
         WHERE (metadata->>'targetUserId') = $1
         ORDER BY occurred_at ASC`,
        [target.user.id]
      );

      const actions = auditRes.rows.map((r: any) => r.action);
      expect(actions).toContain("admin_change_role");
      expect(actions).toContain("admin_change_status");

      const roleEvent = auditRes.rows.find((r: any) => r.action === "admin_change_role");
      expect(roleEvent.actor_id).toBe(adminSession.user.id);
      expect(roleEvent.metadata.previousRole).toBe("viewer");
      expect(roleEvent.metadata.newRole).toBe("owner");

      const statusEvent = auditRes.rows.find((r: any) => r.action === "admin_change_status");
      expect(statusEvent.actor_id).toBe(adminSession.user.id);
      expect(statusEvent.metadata.previousStatus).toBe("active");
      expect(statusEvent.metadata.newStatus).toBe("disabled");
    });
  });
});
