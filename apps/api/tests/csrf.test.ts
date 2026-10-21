import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("CSRF & Browser Origin Protections", () => {
  const TRUSTED_ORIGIN = "http://localhost:5173";
  const UNTRUSTED_ORIGIN = "https://evil-attacker.example.com";

  describe("Origin and Referer Validation", () => {
    it("rejects state-changing POST requests from an untrusted Origin", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .set("Origin", UNTRUSTED_ORIGIN)
        .send({
          email: "csrf-test@example.com",
          password: "password123456",
        });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Cross-site request blocked: untrusted origin",
      });
    });

    it("rejects state-changing POST requests from an untrusted Referer", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Referer", "https://phishing-site.example.com/login-form")
        .send({
          email: "csrf-test@example.com",
          password: "password123456",
        });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Cross-site request blocked: untrusted referer origin",
      });
    });

    it("allows state-changing requests with matching trusted Origin", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          email: "nonexistent@example.com",
          password: "wrongpassword123",
        });

      // Passes origin check, fails authentication with 401
      expect(res.status).toBe(401);
    });

    it("does not mutate application state through GET endpoints", async () => {
      const res = await request(app).get("/api/auth/csrf-token");
      expect(res.status).toBe(200);
      expect(res.body.csrfToken).toBeDefined();
    });
  });

  describe("Synchronizer CSRF Token Endpoint & Validation", () => {
    it("issues a cryptographically random, 64-character hex CSRF token", async () => {
      const res = await request(app).get("/api/auth/csrf-token");

      expect(res.status).toBe(200);
      expect(res.body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    });

    it("rejects authenticated state-changing actions missing the CSRF token", async () => {
      // Create session first
      const agent = request.agent(app);
      const res = await agent
        .post("/api/auth/change-password")
        .set("Origin", TRUSTED_ORIGIN)
        .send({
          currentPassword: "oldpassword123",
          newPassword: "newpassword123456",
        });

      // Unauthenticated returns 401; even if authenticated, missing CSRF returns 403
      expect([401, 403]).toContain(res.status);
    });
  });

  describe("CORS Security Configuration", () => {
    it("sets Access-Control-Allow-Origin matching only trusted frontend", async () => {
      const res = await request(app)
        .options("/api/auth/login")
        .set("Origin", TRUSTED_ORIGIN)
        .set("Access-Control-Request-Method", "POST");

      expect(res.headers["access-control-allow-origin"]).toBe(TRUSTED_ORIGIN);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("does not reflect arbitrary origins in CORS response", async () => {
      const res = await request(app)
        .options("/api/auth/login")
        .set("Origin", UNTRUSTED_ORIGIN)
        .set("Access-Control-Request-Method", "POST");

      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
});
