import { pool } from "../db/pool.js";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEventParams {
  actorId?: string | null;
  documentId?: string | null;
  action: string;
  outcome: AuditOutcome;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  client?: Pick<typeof pool, "query">;
  throwOnError?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_REGEX = /^[a-z][a-z0-9_]{1,64}$/;

/**
 * Explicit allowlist of permissible metadata keys to prevent arbitrary user-controlled
 * JSON or accidental secrets from persisting in audit records.
 */
export const ALLOWED_METADATA_KEYS = new Set([
  "actionFilter",
  "ageMs",
  "category",
  "count",
  "email",
  "emailAttempted",
  "extension",
  "fieldsUpdated",
  "grant",
  "grantId",
  "mimeType",
  "newPermission",
  "outcomeFilter",
  "permission",
  "reason",
  "recipientEmail",
  "recipientId",
  "role",
  "scope",
  "sessionsRevoked",
  "sizeBytes",
  "storageKey",
  "title",
  "total",
]);

/**
 * Patterns matching credential-shaped string values (e.g., Bearer tokens,
 * JWTs, password assignments, session cookies, password hashes).
 * Avoids overly broad keywords that could match legitimate document titles or reasons.
 */
const CREDENTIAL_VALUE_PATTERNS = [
  /^bearer\s+[a-z0-9._~+/-]+=*$/i,
  /\bbearer\s+[a-z0-9._~+/-]{16,}/i,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
  /(?:password|passwd|secret|access_token|refresh_token|api_key|apikey)\s*[:=]\s*\S+/i,
  /(?:connect\.sid|sessionid)\s*[:=]\s*\S+/i,
  /^\$argon2[a-z]?\$/i,
  /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/,
];

/**
 * Sanitizes and validates metadata against the strict allowlist and redaction rules.
 * Enforces primitive types, strips unknown keys, and prevents object prototype pollution.
 */
export function sanitizeAuditMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    // 1. Enforce metadata key allowlist
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      continue;
    }

    // 2. Reject prototype pollution attempts
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }

    // 3. Sanitize values based on type
    if (typeof value === "string") {
      // Redact credential-shaped string values
      if (CREDENTIAL_VALUE_PATTERNS.some((p) => p.test(value))) {
        sanitized[key] = "[REDACTED]";
      } else {
        // Bound string length to 500 characters
        sanitized[key] = value.length > 500 ? value.substring(0, 500) + "..." : value;
      }
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) {
        sanitized[key] = value;
      }
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      // Only allow string arrays (e.g. fieldsUpdated: ["title", "category"])
      sanitized[key] = value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 50)
        .map((item) => (item.length > 100 ? item.substring(0, 100) : item));
    }
    // Drop all complex nested objects, functions, and symbols
  }

  return sanitized;
}

/**
 * Records an immutable audit log entry in public.audit_events.
 *
 * Security considerations:
 * - Confidential document contents, raw bytes, passwords, and secrets are NEVER recorded.
 * - Parameterized SQL prevents SQL injection.
 * - Server-derived timestamps (now()) and server-boundary validation on all fields.
 * - Transaction-aware: Accepts an optional database client to support atomic state+audit commits.
 * - When throwOnError is true (e.g. inside a database transaction), re-throws errors to trigger rollback.
 */
export async function recordAuditEvent(params: AuditEventParams): Promise<void> {
  const {
    actorId = null,
    documentId = null,
    action,
    outcome,
    reason = null,
    metadata = {},
    client = pool,
    throwOnError = false,
  } = params;

  try {
    // 1. Validate action format
    const normalizedAction = action.trim().toLowerCase();
    if (!ACTION_REGEX.test(normalizedAction)) {
      throw new Error(`Invalid audit action identifier: ${action}`);
    }

    // 2. Validate outcome
    if (outcome !== "success" && outcome !== "denied" && outcome !== "failure") {
      throw new Error(`Invalid audit outcome: ${outcome}`);
    }

    // 3. Validate actorId and documentId as valid UUIDs if provided
    const validActorId = actorId && UUID_REGEX.test(actorId) ? actorId : null;
    const validDocumentId = documentId && UUID_REGEX.test(documentId) ? documentId : null;

    // 4. Sanitize reason string (max 500 chars)
    const sanitizedReason = reason ? String(reason).trim().substring(0, 500) : null;

    // 5. Sanitize metadata via allowlist and redaction
    const sanitizedMetadata = sanitizeAuditMetadata(metadata);

    // 6. Execute parameterized INSERT
    await client.query(
      `INSERT INTO public.audit_events (
        actor_id,
        document_id,
        action,
        outcome,
        reason,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        validActorId,
        validDocumentId,
        normalizedAction,
        outcome,
        sanitizedReason,
        JSON.stringify(sanitizedMetadata),
      ]
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[SECURITY-AUDIT-FAILURE] Failed to record audit event (${action}/${outcome}):`, errorMsg);
    if (throwOnError) {
      throw error;
    }
  }
}
