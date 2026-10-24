import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole, requireCsrfToken } from "../auth/middleware.js";
import { recordAuditEvent } from "../audit/service.js";
import {
  updateUserRoleSchema,
  updateUserStatusSchema,
  updateUserAdminSchema,
} from "./schemas.js";

export const adminRouter = Router();

// Strict non-caching headers for administrative endpoints
adminRouter.use((_req: Request, res: Response, next) => {
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

// Require authenticated session AND 'admin' role on ALL administrative routes
adminRouter.use(requireAuth);
adminRouter.use(requireRole(["admin"]));

function getParamString(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] ?? "";
  return val ?? "";
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/users
 * Lists registered users with pagination and search/filter.
 * Restricted strictly to admins.
 * Never returns password_hash or session secrets.
 */
adminRouter.get("/users", async (req: Request, res: Response) => {
  const currentAdmin = req.user!;
  const { search, role, status, limit = "50", offset = "0" } = req.query;

  const parsedLimit = Math.min(Math.max(1, parseInt(String(limit), 10) || 50), 100);
  const parsedOffset = Math.max(0, parseInt(String(offset), 10) || 0);

  try {
    const conditions: string[] = ["1=1"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (typeof search === "string" && search.trim().length > 0) {
      conditions.push(`(u.email ILIKE $${paramIndex} OR (u.display_name IS NOT NULL AND u.display_name ILIKE $${paramIndex}))`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    if (typeof role === "string" && ["admin", "owner", "viewer"].includes(role.trim().toLowerCase())) {
      conditions.push(`u.role = $${paramIndex}`);
      params.push(role.trim().toLowerCase());
      paramIndex++;
    }

    if (typeof status === "string" && ["active", "disabled"].includes(status.trim().toLowerCase())) {
      conditions.push(`u.status = $${paramIndex}`);
      params.push(status.trim().toLowerCase());
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    const countResult = await pool.query(
      `SELECT count(*)::int AS total FROM public.users u WHERE ${whereClause}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    params.push(parsedLimit, parsedOffset);
    const dataResult = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.role,
         u.status,
         u.display_name AS "displayName",
         u.created_at AS "createdAt",
         u.updated_at AS "updatedAt"
       FROM public.users u
       WHERE ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    await recordAuditEvent({
      actorId: currentAdmin.id,
      action: "admin_list_users",
      outcome: "success",
      metadata: { count: dataResult.rows.length, total },
    });

    res.json({
      users: dataResult.rows,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset,
      },
    });
  } catch (error) {
    console.error("Admin list users error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to retrieve users" });
  }
});

/**
 * GET /api/admin/users/:id
 * Retrieve specific user details (without password_hash).
 */
adminRouter.get("/users/:id", async (req: Request, res: Response) => {
  const targetId = getParamString(req.params.id);
  if (!UUID_REGEX.test(targetId)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT
         id,
         email,
         role,
         status,
         display_name AS "displayName",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM public.users
       WHERE id = $1`,
      [targetId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error("Admin get user error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to retrieve user details" });
  }
});

/**
 * PATCH /api/admin/users/:id/role
 * Change a user's role. Prevents self-modification and prevents demoting the last admin.
 */
adminRouter.patch("/users/:id/role", requireCsrfToken, async (req: Request, res: Response) => {
  const currentAdmin = req.user!;
  const targetId = getParamString(req.params.id);

  if (!UUID_REGEX.test(targetId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const input = updateUserRoleSchema.parse(req.body);

    // Self-modification protection
    if (currentAdmin.id === targetId) {
      await recordAuditEvent({
        actorId: currentAdmin.id,
        action: "admin_change_role",
        outcome: "denied",
        reason: "Administrators cannot modify their own role",
        metadata: { targetUserId: targetId },
      });
      res.status(400).json({ error: "Administrators cannot modify their own role" });
      return;
    }

    // Retrieve target user
    const userResult = await pool.query(
      `SELECT id, email, role, status FROM public.users WHERE id = $1`,
      [targetId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const targetUser = userResult.rows[0];

    // Last-admin protection
    if (targetUser.role === "admin" && input.role !== "admin") {
      const adminCountResult = await pool.query(
        `SELECT count(*)::int AS count FROM public.users WHERE role = 'admin' AND status = 'active'`
      );
      const activeAdminCount = adminCountResult.rows[0]?.count || 0;
      if (activeAdminCount <= 1) {
        await recordAuditEvent({
          actorId: currentAdmin.id,
          action: "admin_change_role",
          outcome: "denied",
          reason: "Cannot demote the last active administrator",
          metadata: { targetUserId: targetId, attemptedRole: input.role },
        });
        res.status(400).json({ error: "Cannot demote the last active administrator" });
        return;
      }
    }

    const previousRole = targetUser.role;

    const updateResult = await pool.query(
      `UPDATE public.users
       SET role = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, email, role, status, display_name AS "displayName", updated_at AS "updatedAt"`,
      [input.role, targetId]
    );

    const updatedUser = updateResult.rows[0];

    await recordAuditEvent({
      actorId: currentAdmin.id,
      action: "admin_change_role",
      outcome: "success",
      metadata: {
        targetUserId: targetId,
        targetEmail: targetUser.email,
        previousRole,
        newRole: input.role,
      },
    });

    res.json({
      message: `User role updated successfully to ${input.role}`,
      user: updatedUser,
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
    console.error("Admin role change error:", error.message);
    res.status(500).json({ error: "Failed to update user role" });
  }
});

/**
 * PATCH /api/admin/users/:id/status
 * Change a user's account status (active vs disabled).
 * Disabling an account immediately revokes all active sessions in public.sessions.
 * Prevents self-disabling and disabling the last admin.
 */
adminRouter.patch("/users/:id/status", requireCsrfToken, async (req: Request, res: Response) => {
  const currentAdmin = req.user!;
  const targetId = getParamString(req.params.id);

  if (!UUID_REGEX.test(targetId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const input = updateUserStatusSchema.parse(req.body);

    // Self-disabling protection
    if (currentAdmin.id === targetId) {
      await recordAuditEvent({
        actorId: currentAdmin.id,
        action: "admin_change_status",
        outcome: "denied",
        reason: "Administrators cannot disable their own account",
        metadata: { targetUserId: targetId },
      });
      res.status(400).json({ error: "Administrators cannot disable their own account" });
      return;
    }

    // Retrieve target user
    const userResult = await pool.query(
      `SELECT id, email, role, status FROM public.users WHERE id = $1`,
      [targetId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const targetUser = userResult.rows[0];

    // Last-admin protection: cannot disable last active admin
    if (targetUser.role === "admin" && input.status === "disabled") {
      const adminCountResult = await pool.query(
        `SELECT count(*)::int AS count FROM public.users WHERE role = 'admin' AND status = 'active'`
      );
      const activeAdminCount = adminCountResult.rows[0]?.count || 0;
      if (activeAdminCount <= 1) {
        await recordAuditEvent({
          actorId: currentAdmin.id,
          action: "admin_change_status",
          outcome: "denied",
          reason: "Cannot disable the last active administrator",
          metadata: { targetUserId: targetId },
        });
        res.status(400).json({ error: "Cannot disable the last active administrator" });
        return;
      }
    }

    const previousStatus = targetUser.status;

    // Update status
    const updateResult = await pool.query(
      `UPDATE public.users
       SET status = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, email, role, status, display_name AS "displayName", updated_at AS "updatedAt"`,
      [input.status, targetId]
    );

    const updatedUser = updateResult.rows[0];

    // Multi-session revocation: If account is disabled, immediately purge all active sessions from PostgreSQL
    if (input.status === "disabled") {
      await pool.query(
        `DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1`,
        [targetId]
      );
    }

    await recordAuditEvent({
      actorId: currentAdmin.id,
      action: "admin_change_status",
      outcome: "success",
      metadata: {
        targetUserId: targetId,
        targetEmail: targetUser.email,
        previousStatus,
        newStatus: input.status,
        sessionsRevoked: input.status === "disabled",
      },
    });

    res.json({
      message: `User account status updated to ${input.status}`,
      user: updatedUser,
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
    console.error("Admin status change error:", error.message);
    res.status(500).json({ error: "Failed to update account status" });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Unified endpoint accepting { role?: UserRole, status?: UserStatus }.
 */
adminRouter.patch("/users/:id", requireCsrfToken, async (req: Request, res: Response) => {
  const currentAdmin = req.user!;
  const targetId = getParamString(req.params.id);

  if (!UUID_REGEX.test(targetId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const input = updateUserAdminSchema.parse(req.body);

    if (currentAdmin.id === targetId) {
      res.status(400).json({ error: "Administrators cannot modify their own role or status through the admin panel" });
      return;
    }

    const userResult = await pool.query(
      `SELECT id, email, role, status FROM public.users WHERE id = $1`,
      [targetId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const targetUser = userResult.rows[0];

    // Check last-admin constraints
    if (
      targetUser.role === "admin" &&
      ((input.role && input.role !== "admin") || input.status === "disabled")
    ) {
      const adminCountResult = await pool.query(
        `SELECT count(*)::int AS count FROM public.users WHERE role = 'admin' AND status = 'active'`
      );
      const activeAdminCount = adminCountResult.rows[0]?.count || 0;
      if (activeAdminCount <= 1) {
        res.status(400).json({ error: "Cannot demote or disable the last active administrator" });
        return;
      }
    }

    const newRole = input.role || targetUser.role;
    const newStatus = input.status || targetUser.status;

    const updateResult = await pool.query(
      `UPDATE public.users
       SET role = $1, status = $2, updated_at = now()
       WHERE id = $3
       RETURNING id, email, role, status, display_name AS "displayName", updated_at AS "updatedAt"`,
      [newRole, newStatus, targetId]
    );

    const updatedUser = updateResult.rows[0];

    if (input.status === "disabled") {
      await pool.query(
        `DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1`,
        [targetId]
      );
    }

    await recordAuditEvent({
      actorId: currentAdmin.id,
      action: "admin_update_user",
      outcome: "success",
      metadata: {
        targetUserId: targetId,
        targetEmail: targetUser.email,
        previousRole: targetUser.role,
        newRole,
        previousStatus: targetUser.status,
        newStatus,
      },
    });

    res.json({
      message: "User updated successfully",
      user: updatedUser,
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
    console.error("Admin update user error:", error.message);
    res.status(500).json({ error: "Failed to update user" });
  }
});
