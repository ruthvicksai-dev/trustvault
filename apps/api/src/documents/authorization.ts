import { pool } from "../db/pool.js";
import { recordAuditEvent } from "../audit/service.js";
import type { AuthenticatedUser } from "../auth/types.js";

export type DocumentAction =
  | "read_metadata"
  | "read_content"
  | "edit_metadata"
  | "soft_delete"
  | "manage_grants";

export type GrantPermission = "read" | "edit";

export interface DocumentRecord {
  id: string;
  owner_id: string;
  title: string;
  category: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuthorizationResult {
  authorized: boolean;
  statusCode: 200 | 400 | 403 | 404 | 500;
  reason?: string;
  document?: DocumentRecord;
  isOwner?: boolean;
  grantPermission?: GrantPermission | null;
}

/**
 * Validates a standard UUID string format.
 */
export function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Centralized Document Authorization Service
 *
 * Enforces least-privilege document authorization against the authoritative PostgreSQL database.
 *
 * Rules:
 * 1. Document Owners:
 *    - Full access: read_metadata, read_content, edit_metadata, soft_delete, manage_grants.
 *    - Cannot access documents owned by other users without an explicit grant.
 * 2. Grantees:
 *    - 'read' grant: read_metadata, read_content.
 *    - 'edit' grant: read_metadata, read_content, edit_metadata.
 *    - Grantees CANNOT soft_delete or manage_grants.
 *    - Revoked grants (revoked_at IS NOT NULL) immediately revoke access.
 * 3. Administrators:
 *    - Role 'admin' does NOT confer automatic access to document content or metadata.
 * 4. Soft-deleted documents:
 *    - Treated as non-existent (404) for all standard operations.
 * 5. Anti-Enumeration & Safe Responses:
 *    - If document does not exist, is soft-deleted, or user has no ownership/grant,
 *      returns 404 ("Document not found") to avoid leaking resource existence.
 * 6. Disabled accounts:
 *    - Blocked prior to authorization in requireAuth.
 * 7. Fail closed:
 *    - Any database or unexpected error fails closed.
 */
export async function authorizeDocumentAccess(params: {
  user: AuthenticatedUser;
  documentId: string;
  action: DocumentAction;
  dbPool?: Pick<typeof pool, "query">;
  skipAuditOnSuccess?: boolean;
}): Promise<AuthorizationResult> {
  const { user, documentId, action, dbPool = pool, skipAuditOnSuccess = false } = params;

  // Fail closed on invalid UUID input
  if (!isValidUuid(documentId)) {
    return {
      authorized: false,
      statusCode: 404,
      reason: "Document not found",
    };
  }

  // Account status validation (defense-in-depth)
  if (user.status !== "active") {
    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action,
      outcome: "denied",
      reason: "Account is disabled",
    });
    return {
      authorized: false,
      statusCode: 403,
      reason: "Account is disabled",
    };
  }

  try {
    // Single parameterized SQL query retrieving document and current active grant state
    const query = `
      SELECT
        d.id,
        d.owner_id,
        d.title,
        d.category,
        d.storage_key,
        d.mime_type,
        d.size_bytes,
        d.created_at,
        d.updated_at,
        d.deleted_at,
        dg.permission AS grant_permission,
        dg.revoked_at AS grant_revoked_at
      FROM public.documents d
      LEFT JOIN public.document_grants dg
        ON dg.document_id = d.id
        AND dg.user_id = $2
        AND dg.revoked_at IS NULL
      WHERE d.id = $1
    `;

    const result = await dbPool.query(query, [documentId, user.id]);

    // Document does not exist in DB
    if (result.rows.length === 0) {
      await recordAuditEvent({
        actorId: user.id,
        documentId,
        action,
        outcome: "denied",
        reason: "Document not found",
      });
      return {
        authorized: false,
        statusCode: 404,
        reason: "Document not found",
      };
    }

    const row = result.rows[0];

    // Soft-deleted documents fail closed as not found
    if (row.deleted_at !== null) {
      await recordAuditEvent({
        actorId: user.id,
        documentId,
        action,
        outcome: "denied",
        reason: "Document has been deleted",
      });
      return {
        authorized: false,
        statusCode: 404,
        reason: "Document not found",
      };
    }

    const document: DocumentRecord = {
      id: row.id,
      owner_id: row.owner_id,
      title: row.title,
      category: row.category,
      storage_key: row.storage_key,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };

    const isOwner = row.owner_id === user.id;
    const activeGrant: GrantPermission | null = row.grant_permission || null;

    // 1. Owner evaluation
    if (isOwner) {
      // Owner has full authority on active document
      if (!skipAuditOnSuccess) {
        await recordAuditEvent({
          actorId: user.id,
          documentId,
          action,
          outcome: "success",
          metadata: { role: "owner" },
        });
      }
      return {
        authorized: true,
        statusCode: 200,
        document,
        isOwner: true,
        grantPermission: null,
      };
    }

    // 2. Grantee evaluation
    if (activeGrant) {
      // User has an active grant
      if (action === "read_metadata" || action === "read_content") {
        if (!skipAuditOnSuccess) {
          await recordAuditEvent({
            actorId: user.id,
            documentId,
            action,
            outcome: "success",
            metadata: { grant: activeGrant },
          });
        }
        return {
          authorized: true,
          statusCode: 200,
          document,
          isOwner: false,
          grantPermission: activeGrant,
        };
      }

      if (action === "edit_metadata") {
        if (activeGrant === "edit") {
          if (!skipAuditOnSuccess) {
            await recordAuditEvent({
              actorId: user.id,
              documentId,
              action,
              outcome: "success",
              metadata: { grant: "edit" },
            });
          }
          return {
            authorized: true,
            statusCode: 200,
            document,
            isOwner: false,
            grantPermission: "edit",
          };
        } else {
          // Has read grant, but lacks edit permission
          await recordAuditEvent({
            actorId: user.id,
            documentId,
            action,
            outcome: "denied",
            reason: "Insufficient grant permissions: edit permission required",
          });
          return {
            authorized: false,
            statusCode: 403,
            reason: "Forbidden: 'edit' permission required",
          };
        }
      }

      if (action === "soft_delete" || action === "manage_grants") {
        // Even edit grantees cannot delete or share documents
        await recordAuditEvent({
          actorId: user.id,
          documentId,
          action,
          outcome: "denied",
          reason: "Only the document owner may perform this action",
        });
        return {
          authorized: false,
          statusCode: 403,
          reason: "Forbidden: only the document owner may perform this action",
        };
      }
    }

    // 3. User is neither owner nor has active grant (including admin without grant)
    // Anti-enumeration: return 404 rather than 403
    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action,
      outcome: "denied",
      reason: "Unauthorized: not document owner and no active grant",
    });

    return {
      authorized: false,
      statusCode: 404,
      reason: "Document not found",
    };
  } catch (error) {
    console.error("Document authorization error:", error instanceof Error ? error.message : error);
    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action,
      outcome: "failure",
      reason: "Internal authorization failure",
    });
    return {
      authorized: false,
      statusCode: 500,
      reason: "Authorization service failure",
    };
  }
}
