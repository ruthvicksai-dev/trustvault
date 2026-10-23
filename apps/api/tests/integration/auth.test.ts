import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

function uniqueEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@example.com`;
}

describe("TrustVault Authentication & Session Security", () => {
  const createdTestEmails: string[] = [];

  afterAll(async () => {
    // Clean up only test records created during test runs — NEVER truncate or reset production DB
    if (createdTestEmails.length > 0) {
      await pool.query(
        `DELETE FROM public.sessions
         WHERE (sess::jsonb)->>'userId' IN (
           SELECT id::text FROM public.users WHERE email = ANY($1)
         )`,
        [createdTestEmails]
      );
      await pool.query(
        `DELETE FROM public.users WHERE email = ANY($1)`,
        [createdTestEmails]
      );
    }
    // Close the database pool so Vitest can exit cleanly
    await pool.end();
  });

  describe("Registration", () => {
    it("successfully registers a new user with least-privileged role 'viewer'", async () => {
      const email = uniqueEmail();
      createdTestEmails.push(email);

      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email,
          password: "correct-horse-battery-staple-123",
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe("Registration successful. Please log in.");
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBeDefined();
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.role).toBe("viewer"); // Enforces least-privilege
      expect(res.body.user.status).toBe("active");
      expect(res.body.user.password_hash).toBeUndefined(); // Never leak hashes!
    });

    it("rejects client attempts to self-assign privileged role 'admin' or 'owner'", async () => {
      const email = uniqueEmail();

      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email,
          password: "secure-password-123",
          role: "admin", // Malicious role self-assignment attempt
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(res.body.details[0].message).toContain("Unexpected fields");
    });

    it("rejects client attempts to self-assign account status or id", async () => {
      const email = uniqueEmail();

      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email,
          password: "secure-password-123",
          status: "disabled",
          id: "00000000-0000-0000-0000-000000000000",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });

    it("rejects duplicate email registrations safely without exposing DB internals", async () => {
      const email = uniqueEmail();
      createdTestEmails.push(email);

      // Register first time
      await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password: "secure-password-123" });

      // Register second time with identical email
      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password: "secure-password-123" });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "An account with this email address already exists",
      });
    });

    it("enforces case-insensitive email uniqueness (lower(email))", async () => {
      const baseName = `test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const emailLower = `${baseName}@example.com`;
      const emailUpper = `${baseName.toUpperCase()}@EXAMPLE.COM`;
      createdTestEmails.push(emailLower);

      await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email: emailLower, password: "secure-password-123" });

      // Attempt with uppercase email
      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email: emailUpper, password: "secure-password-123" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("An account with this email address already exists");
    });

    it("rejects password shorter than 12 characters", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: uniqueEmail(),
          password: "short",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });

    it("rejects oversized password (> 128 characters)", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: uniqueEmail(),
          password: "x".repeat(129),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });

    it("rejects malformed email addresses", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: "not-an-email",
          password: "valid-password-123",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });
  });

  describe("Login and Enumeration Resistance", () => {
    it("logs in with valid credentials, sets session cookie, and returns user identity", async () => {
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.role).toBe("viewer");
      expect(res.body.user.password_hash).toBeUndefined();

      // Verify session cookie was set
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toMatch(/trustvault\.sid/);
      expect(cookies[0]).toMatch(/HttpOnly/i);
      expect(cookies[0]).toMatch(/SameSite=Lax/i);
    });

    it("returns generic 401 for incorrect password (no enumeration)", async () => {
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password: "incorrect-password-123" });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid email or password" });
    });

    it("returns generic 401 for non-existent account with dummy verify execution", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: "nobody-exists-here-999@example.com",
          password: "some-arbitrary-password-123",
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid email or password" });
    });

    it("returns generic 401 for disabled account (does not reveal account existence or status)", async () => {
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      const regRes = await request(app)
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const userId = regRes.body.user.id;
      // Disable the account directly in the database
      await pool.query(`UPDATE public.users SET status = 'disabled' WHERE id = $1`, [userId]);

      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      expect(res.status).toBe(401);
      // Generic error indistinguishable from wrong password / non-existent user
      expect(res.body).toEqual({ error: "Invalid email or password" });
    });

    it("rejects login request with unexpected fields", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: "test@example.com",
          password: "password123456",
          extraField: "not-allowed",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });
  });

  describe("Session Lifecycle, Protection, and Revocation", () => {
    it("provides session fixation protection by issuing a new session ID upon login", async () => {
      const agent = request.agent(app);

      // 1. Obtain an anonymous session by requesting a CSRF token
      const csrfRes = await agent.get("/api/auth/csrf-token");
      const initialCookie = csrfRes.headers["set-cookie"]?.[0];
      expect(initialCookie).toBeDefined();

      // 2. Register and login with the existing agent
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      await agent
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const loginRes = await agent
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const postLoginCookie = loginRes.headers["set-cookie"]?.[0];
      expect(postLoginCookie).toBeDefined();

      // Session ID must change upon authentication to prevent session fixation attacks
      const getSid = (cookieStr: string) => cookieStr.split(";")[0];
      expect(getSid(initialCookie!)).not.toBe(getSid(postLoginCookie!));
    });

    it("allows authenticated user to access GET /api/auth/me", async () => {
      const agent = request.agent(app);
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      await agent
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      await agent
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const meRes = await agent.get("/api/auth/me");
      expect(meRes.status).toBe(200);
      expect(meRes.body.user).toBeDefined();
      expect(meRes.body.user.email).toBe(email);
      expect(meRes.body.user.role).toBe("viewer");
    });

    it("rejects unauthenticated requests to GET /api/auth/me with 401", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Authentication required" });
    });

    it("destroys session on logout and prevents cookie replay attacks", async () => {
      const agent = request.agent(app);
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      await agent
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const loginRes = await agent
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const sessionCookie = loginRes.headers["set-cookie"]?.[0];

      // Logout
      const logoutRes = await agent
        .post("/api/auth/logout")
        .set("Origin", TRUSTED_ORIGIN);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.message).toBe("Logged out successfully");

      // Attempting to access protected route with agent (cookie was cleared) returns 401
      const meRes = await agent.get("/api/auth/me");
      expect(meRes.status).toBe(401);

      // Attempting to replay the old session cookie manually returns 401
      const replayRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", sessionCookie!);

      expect(replayRes.status).toBe(401);
    });

    it("immediately denies access if an authenticated account is disabled in DB", async () => {
      const agent = request.agent(app);
      const email = uniqueEmail();
      const password = "valid-user-password-123";
      createdTestEmails.push(email);

      const regRes = await agent
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const userId = regRes.body.user.id;

      await agent
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      // First check succeeds
      const initialMe = await agent.get("/api/auth/me");
      expect(initialMe.status).toBe(200);

      // Now disable user account in the database
      await pool.query(`UPDATE public.users SET status = 'disabled' WHERE id = $1`, [userId]);

      // Next request must fail with 403 Forbidden promptly
      const disabledMe = await agent.get("/api/auth/me");
      expect(disabledMe.status).toBe(403);
      expect(disabledMe.body).toEqual({ error: "Account is disabled" });
    });
  });

  describe("Password Changes and Multi-Session Invalidation", () => {
    it(
      "updates password and revokes all other concurrent active sessions",
      async () => {
        const email = uniqueEmail();
        const oldPassword = "initial-password-123";
        const newPassword = "new-secure-password-456";
        createdTestEmails.push(email);

        await request(app)
          .post("/api/auth/register")
          .set("Origin", TRUSTED_ORIGIN)
          .send({ email, password: oldPassword });

        // Session A (e.g. desktop)
        const agentA = request.agent(app);
        await agentA
          .post("/api/auth/login")
          .set("Origin", TRUSTED_ORIGIN)
          .send({ email, password: oldPassword });

        // Session B (e.g. mobile)
        const agentB = request.agent(app);
        await agentB
          .post("/api/auth/login")
          .set("Origin", TRUSTED_ORIGIN)
          .send({ email, password: oldPassword });

        // Both sessions are currently valid
        expect((await agentA.get("/api/auth/me")).status).toBe(200);
        expect((await agentB.get("/api/auth/me")).status).toBe(200);

        // Obtain CSRF token for Session A
        const csrfRes = await agentA.get("/api/auth/csrf-token");
        const csrfToken = csrfRes.body.csrfToken;

        // Session A changes password
        const changeRes = await agentA
          .post("/api/auth/change-password")
          .set("Origin", TRUSTED_ORIGIN)
          .set("x-csrf-token", csrfToken)
          .send({
            currentPassword: oldPassword,
            newPassword,
          });

        expect(changeRes.status).toBe(200);
        expect(changeRes.body.message).toBe("Password changed successfully");

        // Session A remains valid
        const meA = await agentA.get("/api/auth/me");
        expect(meA.status).toBe(200);

        // Session B MUST NOW BE REVOKED / INVALIDATED
        const meB = await agentB.get("/api/auth/me");
        expect(meB.status).toBe(401);

        // Login with old password fails
        const failLogin = await request(app)
          .post("/api/auth/login")
          .set("Origin", TRUSTED_ORIGIN)
          .send({ email, password: oldPassword });
        expect(failLogin.status).toBe(401);

        // Login with new password succeeds
        const successLogin = await request(app)
          .post("/api/auth/login")
          .set("Origin", TRUSTED_ORIGIN)
          .send({ email, password: newPassword });
        expect(successLogin.status).toBe(200);
      },
      25000 // 25s timeout for multiple Argon2id operations + remote DB roundtrips
    );

    it("rejects password change if current password is incorrect", async () => {
      const email = uniqueEmail();
      const password = "user-password-123";
      createdTestEmails.push(email);

      const agent = request.agent(app);
      await agent
        .post("/api/auth/register")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      await agent
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({ email, password });

      const csrfRes = await agent.get("/api/auth/csrf-token");
      const csrfToken = csrfRes.body.csrfToken;

      const res = await agent
        .post("/api/auth/change-password")
        .set("Origin", TRUSTED_ORIGIN)
        .set("x-csrf-token", csrfToken)
        .send({
          currentPassword: "wrong-current-password",
          newPassword: "brand-new-password-123",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Current password is incorrect");
    });
  });
});
