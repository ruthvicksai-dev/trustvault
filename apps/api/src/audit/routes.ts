import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { recordAuditEvent } from "./service.js";

export const auditRouter = Router();

// Enforce strict non-caching headers across audit endpoints
auditRouter.use((_req: Request, res: Response, next) => {
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

// Require authentication for all audit endpoints
auditRouter.use(requireAuth);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/audit
 * Administrative oversight endpoint for system audit logs.
 * Restricted strictly to accounts with the 'admin' role.
 * Ordinary users ('owner', 'viewer') receive HTTP 403 Forbidden.
 *
 * Privacy Invariants:
 * - Administrators have system oversight of security events, but this endpoint
 *   does NOT disclose confidential document contents or bypass per-document grants.
 * - Supports filtering by action, outcome, actorId, and documentId.
 */
auditRouter.get("/", requireRole(["admin"]), async (req: Request, res: Response) => {
  const user = req.user!;
  const { action, outcome, actorId, documentId, limit = "50", offset = "0" } = req.query;

  const parsedLimit = Math.min(Math.max(1, parseInt(String(limit), 10) || 50), 100);
  const parsedOffset = Math.max(0, parseInt(String(offset), 10) || 0);

  try {
    const conditions: string[] = ["1=1"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (typeof action === "string" && action.trim().length > 0) {
      conditions.push(`action = $${paramIndex}`);
      params.push(action.trim().toLowerCase());
      paramIndex++;
    }

    if (
      typeof outcome === "string" &&
      (outcome === "success" || outcome === "denied" || outcome === "failure")
    ) {
      conditions.push(`outcome = $${paramIndex}`);
      params.push(outcome);
      paramIndex++;
    }

    if (typeof actorId === "string" && UUID_REGEX.test(actorId.trim())) {
      conditions.push(`actor_id = $${paramIndex}`);
      params.push(actorId.trim());
      paramIndex++;
    }

    if (typeof documentId === "string" && UUID_REGEX.test(documentId.trim())) {
      conditions.push(`document_id = $${paramIndex}`);
      params.push(documentId.trim());
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    const countQuery = `SELECT COUNT(*)::int AS total FROM public.audit_events WHERE ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = countResult.rows[0]?.total || 0;

    const dataQuery = `
      SELECT
        id::text,
        actor_id AS "actorId",
        document_id AS "documentId",
        action,
        outcome,
        reason,
        metadata,
        occurred_at AS "occurredAt"
      FROM public.audit_events
      WHERE ${whereClause}
      ORDER BY occurred_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const dataResult = await pool.query(dataQuery, [...params, parsedLimit, parsedOffset]);

    await recordAuditEvent({
      actorId: user.id,
      action: "read_audit_trail",
      outcome: "success",
      metadata: {
        count: dataResult.rows.length,
        total,
        scope: "system",
      },
    });

    res.json({
      events: dataResult.rows,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset,
      },
    });
  } catch (error) {
    console.error("Administrative audit query error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to retrieve audit records" });
  }
});

// Explicitly reject state-modifying requests on audit endpoints
auditRouter.all("/", (req: Request, res: Response) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed: audit events are append-only" });
  }
});

auditRouter.use((_req: Request, res: Response) => {
  res.status(405).json({ error: "Method Not Allowed: audit events are append-only" });
});
