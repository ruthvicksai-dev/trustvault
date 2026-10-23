import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";

describe("Session Cookie Security Flags (Unit)", () => {
  it("enforces HttpOnly, SameSite=Lax, and Path=/ on session cookies", async () => {
    // Calling GET /api/auth/csrf-token touches the session and emits the session cookie
    const res = await request(app).get("/api/auth/csrf-token");
    expect(res.status).toBe(200);

    const rawCookies = res.headers["set-cookie"];
    expect(rawCookies).toBeDefined();
    const cookieList = Array.isArray(rawCookies) ? rawCookies : [rawCookies].filter(Boolean);
    expect(cookieList.length).toBeGreaterThan(0);

    const sessionCookie = cookieList.find((c) => typeof c === "string" && c.includes("trustvault.sid"));
    expect(sessionCookie).toBeDefined();

    // Verify critical RFC 6265 cookie security attributes
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
  });
});
