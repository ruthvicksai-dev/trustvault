import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { pool } from "../db/pool.js";
import { env } from "../config.js";
import { recordAuditEvent } from "../audit/service.js";
import {
  hashPassword,
  verifyPassword,
  checkNeedsRehash,
  DUMMY_HASH,
} from "./argon2.js";
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
} from "./schemas.js";
import {
  loginRateLimiter,
  registerRateLimiter,
  generalAuthRateLimiter,
} from "./rate-limit.js";
import {
  requireAuth,
  requireCsrfToken,
  getOrCreateCsrfToken,
} from "./middleware.js";

export const authRouter = Router();

// Apply general rate limiting across auth endpoints
authRouter.use(generalAuthRateLimiter);

/**
 * GET /api/auth/csrf-token
 * Issues a cryptographically random, session-bound CSRF token.
 */
authRouter.get("/csrf-token", (req: Request, res: Response) => {
  const token = getOrCreateCsrfToken(req);
  res.json({ csrfToken: token });
});

/**
 * POST /api/auth/register
 * Public registration endpoint with strict schema validation.
 * Role is strictly assigned to 'viewer'. No privileged role self-assignment permitted.
 */
authRouter.post("/register", registerRateLimiter, async (req: Request, res: Response) => {
  let attemptedEmail: string | undefined;
  try {
    const input = registerSchema.parse(req.body);
    attemptedEmail = input.email;
    const passwordHash = await hashPassword(input.password);

    const result = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, $2, 'viewer', 'active')
       RETURNING id, email, role, status, created_at`,
      [input.email, passwordHash]
    );

    const user = result.rows[0];

    await recordAuditEvent({
      actorId: user.id,
      action: "auth_register",
      outcome: "success",
      metadata: { email: user.email, role: user.role },
    });

    res.status(201).json({
      message: "Registration successful. Please log in.",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
      },
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    // PostgreSQL unique constraint violation (users_email_lower_unique)
    if (error.code === "23505") {
      await recordAuditEvent({
        action: "auth_register",
        outcome: "denied",
        reason: "An account with this email address already exists",
        metadata: attemptedEmail ? { emailAttempted: attemptedEmail } : undefined,
      });
      res.status(409).json({ error: "An account with this email address already exists" });
      return;
    }

    if (error.message?.startsWith("RATE_LIMIT_CONCURRENCY")) {
      res.status(429).json({ error: "Server busy processing requests. Please retry shortly." });
      return;
    }

    console.error("Registration error:", error.message);
    res.status(500).json({ error: "Unable to complete registration. Please try again." });
  }
});

/**
 * POST /api/auth/login
 * Authenticates user credentials with enumeration-resistant generic failure
 * and dummy Argon2id execution to mitigate timing attacks.
 */
authRouter.post("/login", loginRateLimiter, async (req: Request, res: Response) => {
  try {
    const input = loginSchema.parse(req.body);

    const result = await pool.query(
      `SELECT id, email, password_hash, role, status, updated_at
       FROM public.users
       WHERE lower(email) = $1`,
      [input.email]
    );

    const user = result.rows[0];

    // If user does not exist or is disabled:
    // Execute dummy verification to normalize timing differences and return generic 401
    if (!user) {
      await verifyPassword(DUMMY_HASH, input.password);
      await recordAuditEvent({
        action: "auth_login",
        outcome: "denied",
        reason: "Invalid email or password",
        metadata: { emailAttempted: input.email },
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      await verifyPassword(DUMMY_HASH, input.password);
      await recordAuditEvent({
        actorId: user.id,
        action: "auth_login",
        outcome: "denied",
        reason: "Account is disabled",
        metadata: { email: user.email },
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const isValid = await verifyPassword(user.password_hash, input.password);
    if (!isValid) {
      await recordAuditEvent({
        actorId: user.id,
        action: "auth_login",
        outcome: "denied",
        reason: "Invalid email or password",
        metadata: { emailAttempted: input.email },
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Upgrade hash in background if parameters have become obsolete
    if (checkNeedsRehash(user.password_hash)) {
      hashPassword(input.password)
        .then((newHash) => {
          pool.query("UPDATE public.users SET password_hash = $1 WHERE id = $2", [newHash, user.id]);
        })
        .catch((err) => {
          console.error("Background password rehash error:", err.message);
        });
    }

    // Session Fixation Protection: Regenerate session ID upon successful authentication
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("Session regeneration error:", regenErr);
        res.status(500).json({ error: "Authentication failed due to session error" });
        return;
      }

      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.createdAt = Date.now();
      req.session.passwordUpdatedAt = user.updated_at ? new Date(user.updated_at).getTime() : Date.now();
      getOrCreateCsrfToken(req);

      // Persist session before responding to client
      req.session.save(async (saveErr) => {
        if (saveErr) {
          console.error("Session store persistence error:", saveErr);
          res.status(500).json({ error: "Failed to establish authenticated session" });
          return;
        }

        await recordAuditEvent({
          actorId: user.id,
          action: "auth_login",
          outcome: "success",
          metadata: { email: user.email, role: user.role },
        });

        res.json({
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            status: user.status,
          },
        });
      });
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    if (error.message?.startsWith("RATE_LIMIT_CONCURRENCY")) {
      res.status(429).json({ error: "Server busy processing authentication. Please retry shortly." });
      return;
    }

    console.error("Login unexpected error:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/auth/logout
 * Destroys the server-side session and clears the session cookie with matching attributes.
 */
authRouter.post("/logout", requireAuth, (req: Request, res: Response) => {
  const isProd = env.NODE_ENV === "production";
  const cookieName = isProd ? "__Host-trustvault.sid" : "trustvault.sid";
  const userId = req.user?.id;

  req.session.destroy(async (err) => {
    if (err) {
      console.error("Session destruction error:", err);
      res.status(500).json({ error: "Failed to terminate session" });
      return;
    }

    if (userId) {
      await recordAuditEvent({
        actorId: userId,
        action: "auth_logout",
        outcome: "success",
      });
    }

    res.clearCookie(cookieName, {
      path: "/",
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
    });

    res.json({ message: "Logged out successfully" });
  });
});

/**
 * GET /api/auth/me
 * Returns authenticated user identity derived securely from current database state.
 */
authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

/**
 * POST /api/auth/change-password
 * Requires authentication and CSRF token.
 * Validates current password, updates to new Argon2id hash, and invalidates all other concurrent sessions.
 */
authRouter.post("/change-password", requireAuth, requireCsrfToken, async (req: Request, res: Response) => {
  try {
    const input = changePasswordSchema.parse(req.body);
    const userId = req.user!.id;

    // Retrieve current stored hash
    const userResult = await pool.query(
      `SELECT password_hash FROM public.users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const isCurrentValid = await verifyPassword(userResult.rows[0].password_hash, input.currentPassword);
    if (!isCurrentValid) {
      await recordAuditEvent({
        actorId: userId,
        action: "auth_change_password",
        outcome: "denied",
        reason: "Current password is incorrect",
      });
      res.status(400).json({ error: "Current password is incorrect" });
      return;
    }

    const newHash = await hashPassword(input.newPassword);

    // Update password hash and updated_at timestamp
    const updateResult = await pool.query(
      `UPDATE public.users
       SET password_hash = $1, updated_at = now()
       WHERE id = $2
       RETURNING updated_at`,
      [newHash, userId]
    );

    const newUpdatedAt = updateResult.rows[0].updated_at;

    // Multi-session revocation: Invalidate all other active sessions for this user in PostgreSQL
    const currentSid = req.sessionID;
    await pool.query(
      `DELETE FROM public.sessions
       WHERE (sess::jsonb)->>'userId' = $1 AND sid != $2`,
      [userId, currentSid]
    );

    // Update current session's password timestamp
    req.session.passwordUpdatedAt = new Date(newUpdatedAt).getTime();
    req.session.save(async (saveErr) => {
      if (saveErr) {
        console.error("Session update error after password change:", saveErr);
      }

      await recordAuditEvent({
        actorId: userId,
        action: "auth_change_password",
        outcome: "success",
        metadata: { sessionsRevoked: true },
      });

      res.json({ message: "Password changed successfully" });
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: "Validation error",
        details: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    console.error("Password change error:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});
