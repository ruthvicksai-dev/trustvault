import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { env } from "../config.js";
import type { UserRole, AuthenticatedUser } from "./types.js";

// Absolute session lifetime: 24 hours regardless of activity
export const ABSOLUTE_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Validates Origin and Referer headers against the configured FRONTEND_ORIGIN.
 * Mitigates Cross-Site Request Forgery (CSRF) for all state-changing HTTP methods.
 */
export function validateOrigin(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  const stateChangingMethods = ["POST", "PUT", "PATCH", "DELETE"];

  if (!stateChangingMethods.includes(method)) {
    return next();
  }

  const origin = req.headers["origin"];
  const referer = req.headers["referer"];
  const allowedOrigin = env.FRONTEND_ORIGIN;

  if (origin) {
    if (origin !== allowedOrigin) {
      res.status(403).json({ error: "Cross-site request blocked: untrusted origin" });
      return;
    }
  } else if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (refererOrigin !== allowedOrigin) {
        res.status(403).json({ error: "Cross-site request blocked: untrusted referer origin" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Malformed referer header" });
      return;
    }
  }

  next();
}

/**
 * Generates or retrieves a cryptographically random, session-bound CSRF token.
 */
export function getOrCreateCsrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

/**
 * Synchronizer Token CSRF Protection Middleware
 * Requires a valid 'x-csrf-token' header matching req.session.csrfToken
 * on state-changing requests for authenticated endpoints.
 */
export function requireCsrfToken(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  const stateChangingMethods = ["POST", "PUT", "PATCH", "DELETE"];

  if (!stateChangingMethods.includes(method)) {
    return next();
  }

  const providedToken = req.headers["x-csrf-token"];
  const expectedToken = req.session?.csrfToken;

  if (!providedToken || typeof providedToken !== "string" || !expectedToken) {
    res.status(403).json({ error: "Missing or invalid CSRF token" });
    return;
  }

  // Constant-time comparison to prevent timing attacks on CSRF token validation
  try {
    const providedBuf = Buffer.from(providedToken, "utf8");
    const expectedBuf = Buffer.from(expectedToken, "utf8");

    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      res.status(403).json({ error: "Missing or invalid CSRF token" });
      return;
    }
  } catch {
    res.status(403).json({ error: "Missing or invalid CSRF token" });
    return;
  }

  next();
}

/**
 * Authentication Middleware
 * Enforces server-side session validity, absolute session timeout,
 * and queries the authoritative database to verify account existence and active status.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Enforce absolute session timeout
  if (req.session.createdAt && Date.now() - req.session.createdAt > ABSOLUTE_SESSION_TIMEOUT_MS) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Session expired" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, email, role, status, updated_at
       FROM public.users
       WHERE id = $1`,
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      req.session.destroy(() => {});
      res.status(401).json({ error: "User account no longer exists" });
      return;
    }

    const dbUser = result.rows[0];

    // Reject disabled accounts immediately
    if (dbUser.status !== "active") {
      req.session.destroy(() => {});
      res.status(403).json({ error: "Account is disabled" });
      return;
    }

    // Invalidate sessions issued before a password change / credential rotation
    if (req.session.passwordUpdatedAt && dbUser.updated_at) {
      const dbUpdatedMs = new Date(dbUser.updated_at).getTime();
      // Allow 1000ms clock skew buffer
      if (dbUpdatedMs - req.session.passwordUpdatedAt > 1000) {
        req.session.destroy(() => {});
        res.status(401).json({ error: "Session invalidated due to password change" });
        return;
      }
    }

    // Attach authenticated identity derived solely from the server-side database
    req.user = {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role as UserRole,
      status: dbUser.status,
    };

    next();
  } catch (error) {
    console.error("Authentication middleware database failure:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Authentication service unavailable" });
  }
}

/**
 * Role-Based Access Control Middleware Factory
 */
export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden: insufficient permissions" });
      return;
    }
    next();
  };
}
