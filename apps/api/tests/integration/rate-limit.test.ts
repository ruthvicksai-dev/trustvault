import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";

const TRUSTED_ORIGIN = "http://localhost:5173";

describe("Rate Limiting & Abuse Controls", () => {
  const registeredEmails: string[] = [];

  afterAll(async () => {
    if (registeredEmails.length > 0) {
      await pool.query(
        "DELETE FROM public.audit_events WHERE actor_id IN (SELECT id FROM public.users WHERE email = ANY($1))",
        [registeredEmails]
      );
      await pool.query(
        "DELETE FROM public.users WHERE email = ANY($1)",
        [registeredEmails]
      );
    }
  });

  it(
    "enforces login rate limiting when limit is reached",
    async () => {
      // Attempt 12 logins with x-enforce-rate-limit: true
      let hitRateLimit = false;

      for (let i = 0; i < 12; i++) {
        const res = await request(app)
          .post("/api/auth/login")
          .set("Origin", TRUSTED_ORIGIN)
          .set("x-enforce-rate-limit", "true")
          .send({
            email: "ratelimit-probe@example.com",
            password: "some-password-123",
          });

        if (res.status === 429) {
          hitRateLimit = true;
          expect(res.body.error).toContain("Too many login attempts");
          break;
        }
      }

      expect(hitRateLimit).toBe(true);
    },
    15000 // 15s timeout to account for sequential Argon2id dummy verifies
  );

  it(
    "enforces registration rate limiting when limit is reached",
    async () => {
      let hitRateLimit = false;

      for (let i = 0; i < 8; i++) {
        const testEmail = `ratelimit-reg-${Date.now()}-${i}@example.com`;
        registeredEmails.push(testEmail);

        const res = await request(app)
          .post("/api/auth/register")
          .set("Origin", TRUSTED_ORIGIN)
          .set("x-enforce-rate-limit", "true")
          .send({
            email: testEmail,
            password: "valid-password-1234",
          });

        if (res.status === 429) {
          hitRateLimit = true;
          expect(res.body.error).toContain("Too many accounts created");
          break;
        }
      }

      expect(hitRateLimit).toBe(true);
    },
    15000 // 15s timeout
  );
});
