import { pool } from "../db/pool.js";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEventParams {
  actorId?: string | null;
  documentId?: string | null;
  action: string;
  outcome: AuditOutcome;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records an immutable audit log entry in public.audit_events.
 *
 * Security considerations:
 * - Confidential document contents, raw bytes, passwords, and secrets are NEVER recorded.
 * - Parameterized SQL prevents SQL injection.
 * - Fail-safe: Audit failure is logged to stderr but does not crash the server-side flow.
 */
export async function recordAuditEvent(params: AuditEventParams): Promise<void> {
  try {
    const {
      actorId = null,
      documentId = null,
      action,
      outcome,
      reason = null,
      metadata = {},
    } = params;

    // Filter metadata to prevent accidental inclusion of sensitive attributes
    const sanitizedMetadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (
        [
          "password",
          "secret",
          "token",
          "hash",
          "content",
          "buffer",
          "cookie",
        ].some((sensitive) => key.toLowerCase().includes(sensitive))
      ) {
        sanitizedMetadata[key] = "[REDACTED]";
      } else {
        sanitizedMetadata[key] = value;
      }
    }

    await pool.query(
      `INSERT INTO public.audit_events (
        actor_id,
        document_id,
        action,
        outcome,
        reason,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        actorId,
        documentId,
        action,
        outcome,
        reason,
        JSON.stringify(sanitizedMetadata),
      ]
    );
  } catch (error) {
    console.error(
      "Failed to record audit event:",
      error instanceof Error ? error.message : error
    );
  }
}
