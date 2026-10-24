import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/auth/argon2.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

function uniqueEmail(prefix = "profile-test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@example.com`;
}

interface TestSession {
  user: {
    id: string;
    email: string;
    role: "owner" | "viewer" | "admin";
    displayName?: string | null;
  };
  cookie: string[];
  csrfToken: string;
}

describe("TrustVault — User Profile Metadata Integration Tests", () => {
  const createdTestEmails: string[] = [];
  let sharedPasswordHash: string;

  beforeAll(async () => {
    sharedPasswordHash = await hashPassword("profile-test-pass-123");
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
    displayName: string | null = null
  ): Promise<TestSession> {
    const email = uniqueEmail(role);
    createdTestEmails.push(email);

    const insertRes = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status, display_name)
       VALUES ($1, $2, $3, 'active', $4)
       RETURNING id, email, role, display_name`,
      [email, sharedPasswordHash, role, displayName]
    );

    const user = insertRes.rows[0];

    const loginRes = await request(app)
      .post("/api/auth/login")
      .set("Origin", TRUSTED_ORIGIN)
      .send({ email, password: "profile-test-pass-123" });

    const cookie = loginRes.headers["set-cookie"] as unknown as string[];

    const csrfRes = await request(app)
      .get("/api/auth/csrf-token")
      .set("Cookie", cookie);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.display_name,
      },
      cookie,
      csrfToken: csrfRes.body.csrfToken,
    };
  }

  describe("PATCH /api/auth/profile", () => {
    it("allows authenticated user to update their display name", async () => {
      const session = await createSession("viewer", "Initial Name");

      const res = await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", session.cookie)
        .set("x-csrf-token", session.csrfToken)
        .send({ displayName: "Jane Doe" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Profile updated successfully");
      expect(res.body.user).toBeDefined();
      expect(res.body.user.displayName).toBe("Jane Doe");
      expect(res.body.user.password_hash).toBeUndefined();

      // Verify GET /api/auth/me returns updated display name
      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", session.cookie);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.displayName).toBe("Jane Doe");
    });

    it("allows setting display name to null / removing it", async () => {
      const session = await createSession("viewer", "Remove Me");

      const res = await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", session.cookie)
        .set("x-csrf-token", session.csrfToken)
        .send({ displayName: null });

      expect(res.status).toBe(200);
      expect(res.body.user.displayName).toBeNull();
    });

    it("rejects attempt to modify role, status, or email through profile endpoint", async () => {
      const session = await createSession("viewer", "Original");

      const res = await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", session.cookie)
        .set("x-csrf-token", session.csrfToken)
        .send({
          displayName: "Hacked Admin",
          role: "admin",
          status: "active",
        });

      // Strict validation schema rejects unexpected fields
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });

    it("rejects script tags or HTML in displayName", async () => {
      const session = await createSession("viewer");

      const res = await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", session.cookie)
        .set("x-csrf-token", session.csrfToken)
        .send({ displayName: "<script>alert('xss')</script>" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(res.body.details[0].message).toContain("script tags");
    });

    it("rejects unauthenticated profile update attempts", async () => {
      const res = await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ displayName: "Unauthenticated" });

      expect(res.status).toBe(401);
    });

    it("rejects profile update without CSRF token", async () => {
      const session = await createSession("viewer");

      const res = await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", session.cookie)
        .send({ displayName: "No CSRF" });

      expect(res.status).toBe(403);
    });

    it("records user_update_profile audit event in database", async () => {
      const session = await createSession("viewer", "Audit Check User");

      await request(app)
        .patch("/api/auth/profile")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Cookie", session.cookie)
        .set("x-csrf-token", session.csrfToken)
        .send({ displayName: "Audited Display Name" });

      const auditRes = await pool.query(
        `SELECT action, actor_id, metadata
         FROM public.audit_events
         WHERE actor_id = $1 AND action = 'user_update_profile'`,
        [session.user.id]
      );

      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].metadata.newDisplayName).toBe("Audited Display Name");
    });
  });
});
