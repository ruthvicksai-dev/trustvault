import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireCsrfToken } from "../auth/middleware.js";
import { recordAuditEvent } from "../audit/service.js";
import {
  authorizeDocumentAccess,
  isValidUuid,
} from "./authorization.js";
import {
  generateSecureStorageKey,
  getStorageDriver,
} from "./storage.js";
import {
  createDocumentSchema,
  updateDocumentSchema,
  createGrantSchema,
  updateGrantSchema,
} from "./schemas.js";

export const documentsRouter = Router();

function getParamString(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] ?? "";
  return val ?? "";
}

// Enforce authentication on all document operations
documentsRouter.use(requireAuth);

/**
 * GET /api/documents
 * List accessible documents (owned by user OR granted via active grant).
 * Supports parameterized SQL search & category filtering.
 * Never returns soft-deleted documents or unauthorized records.
 */
documentsRouter.get("/", async (req: Request, res: Response) => {
  const user = req.user!;
  const { search, category, limit = "50", offset = "0" } = req.query;

  const parsedLimit = Math.min(Math.max(1, parseInt(String(limit), 10) || 50), 100);
  const parsedOffset = Math.max(0, parseInt(String(offset), 10) || 0);

  try {
    const conditions: string[] = ["d.deleted_at IS NULL"];
    const params: unknown[] = [user.id];
    let paramIndex = 2;

    // Accessible documents: owned OR active grant
    conditions.push(
      `(d.owner_id = $1 OR EXISTS (
        SELECT 1 FROM public.document_grants dg
        WHERE dg.document_id = d.id
          AND dg.user_id = $1
          AND dg.revoked_at IS NULL
      ))`
    );

    if (typeof search === "string" && search.trim().length > 0) {
      conditions.push(`d.title ILIKE $${paramIndex}`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    if (typeof category === "string" && category.trim().length > 0) {
      conditions.push(`d.category = $${paramIndex}`);
      params.push(category.trim());
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    // Count query for pagination metadata (reflects only authorized records)
    const countResult = await pool.query(
      `SELECT count(*)::int AS total
       FROM public.documents d
       WHERE ${whereClause}`,
      params
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Data query
    params.push(parsedLimit, parsedOffset);
    const dataQuery = `
      SELECT
        d.id,
        d.title,
        d.category,
        d.mime_type,
        d.size_bytes,
        d.created_at,
        d.updated_at,
        (d.owner_id = $1) AS is_owner,
        dg.permission AS grant_permission
      FROM public.documents d
      LEFT JOIN public.document_grants dg
        ON dg.document_id = d.id
        AND dg.user_id = $1
        AND dg.revoked_at IS NULL
      WHERE ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const dataResult = await pool.query(dataQuery, params);

    const documents = dataResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isOwner: row.is_owner,
      permission: row.is_owner ? "owner" : row.grant_permission,
    }));

    await recordAuditEvent({
      actorId: user.id,
      action: "list_documents",
      outcome: "success",
      metadata: { count: documents.length, total },
    });

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.json({
      documents,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset,
      },
    });
  } catch (error) {
    console.error("List documents error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to retrieve documents" });
  }
});

/**
 * POST /api/documents
 * Create document. Sets owner_id strictly from server-side authenticated identity.
 * Only 'owner' or 'admin' roles may create documents; 'viewer' role is forbidden.
 */
documentsRouter.post("/", requireCsrfToken, async (req: Request, res: Response) => {
  const user = req.user!;

  if (user.role === "viewer") {
    await recordAuditEvent({
      actorId: user.id,
      action: "create_document",
      outcome: "denied",
      reason: "Viewers are not permitted to create documents",
    });
    res.status(403).json({ error: "Forbidden: viewers cannot create documents" });
    return;
  }

  try {
    const input = createDocumentSchema.parse(req.body);
    const contentBuffer = Buffer.from(input.content, "utf8");
    const sizeBytes = contentBuffer.byteLength;

    const storageKey = generateSecureStorageKey(input.mimeType);

    // Upload to secure server-controlled storage
    await getStorageDriver().upload(storageKey, contentBuffer, input.mimeType);

    // Persist document record with server-enforced ownership; clean up storage object on failure
    let result;
    try {
      result = await pool.query(
        `INSERT INTO public.documents (
          owner_id,
          title,
          category,
          storage_key,
          mime_type,
          size_bytes
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, title, category, mime_type, size_bytes, created_at, updated_at`,
        [user.id, input.title, input.category, storageKey, input.mimeType, sizeBytes]
      );
    } catch (dbError) {
      // Compensating action: clean up the uploaded storage object if database persistence fails
      try {
        await getStorageDriver().delete(storageKey);
      } catch (cleanupError) {
        console.error(
          "Storage cleanup failed after database error:",
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        );
      }
      throw dbError; // Preserve the original failure
    }

    const doc = result.rows[0];

    await recordAuditEvent({
      actorId: user.id,
      documentId: doc.id,
      action: "create_document",
      outcome: "success",
      metadata: { title: doc.title, category: doc.category, sizeBytes },
    });

    res.status(201).json({
      message: "Document created successfully",
      document: {
        id: doc.id,
        title: doc.title,
        category: doc.category,
        mimeType: doc.mime_type,
        sizeBytes: Number(doc.size_bytes),
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        isOwner: true,
        permission: "owner",
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

    console.error("Create document error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to create document" });
  }
});

/**
 * GET /api/documents/:id
 * Read document metadata. Protected by centralized authorization.
 */
documentsRouter.get("/:id", async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "read_metadata",
  });

  if (!auth.authorized || !auth.document) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  const doc = auth.document;
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.json({
    document: {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      mimeType: doc.mime_type,
      sizeBytes: doc.size_bytes,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      isOwner: auth.isOwner,
      permission: auth.isOwner ? "owner" : auth.grantPermission,
    },
  });
});

/**
 * GET /api/documents/:id/download
 * Download document content. Streams authorized content from storage.
 */
documentsRouter.get("/:id/download", async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "read_content",
  });

  if (!auth.authorized || !auth.document) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  const doc = auth.document;

  try {
    const file = await getStorageDriver().download(doc.storage_key);

    await recordAuditEvent({
      actorId: user.id,
      documentId: doc.id,
      action: "download_content",
      outcome: "success",
    });

    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(doc.title)}"`
    );
    res.setHeader("Content-Length", file.data.byteLength);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(file.data);
  } catch (error) {
    console.error("Storage download error:", error instanceof Error ? error.message : error);
    await recordAuditEvent({
      actorId: user.id,
      documentId: doc.id,
      action: "download_content",
      outcome: "failure",
      reason: "Storage retrieval error",
    });
    res.status(500).json({ error: "Failed to download document content" });
  }
});

/**
 * PATCH /api/documents/:id
 * Update permitted document metadata (title, category).
 * Requires ownership OR active 'edit' grant.
 */
documentsRouter.patch("/:id", requireCsrfToken, async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "edit_metadata",
  });

  if (!auth.authorized || !auth.document) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  try {
    const input = updateDocumentSchema.parse(req.body);

    const updates: string[] = ["updated_at = now()"];
    const params: unknown[] = [documentId];
    let paramIndex = 2;

    if (input.title !== undefined) {
      updates.push(`title = $${paramIndex}`);
      params.push(input.title);
      paramIndex++;
    }

    if (input.category !== undefined) {
      updates.push(`category = $${paramIndex}`);
      params.push(input.category);
      paramIndex++;
    }

    const updateQuery = `
      UPDATE public.documents
      SET ${updates.join(", ")}
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, title, category, mime_type, size_bytes, created_at, updated_at
    `;

    const result = await pool.query(updateQuery, params);

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const updated = result.rows[0];

    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action: "update_document",
      outcome: "success",
      metadata: { fieldsUpdated: Object.keys(input) },
    });

    res.json({
      message: "Document updated successfully",
      document: {
        id: updated.id,
        title: updated.title,
        category: updated.category,
        mimeType: updated.mime_type,
        sizeBytes: Number(updated.size_bytes),
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        isOwner: auth.isOwner,
        permission: auth.isOwner ? "owner" : auth.grantPermission,
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

    console.error("Update document error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to update document" });
  }
});

/**
 * DELETE /api/documents/:id
 * Soft delete document. Restricted strictly to document owner.
 */
documentsRouter.delete("/:id", requireCsrfToken, async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "soft_delete",
  });

  if (!auth.authorized) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  try {
    // Atomic soft-delete predicate verifying ownership and un-deleted status
    const result = await pool.query(
      `UPDATE public.documents
       SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [documentId, user.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action: "delete_document",
      outcome: "success",
    });

    res.json({ message: "Document deleted successfully" });
  } catch (error) {
    console.error("Delete document error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

/* ── Grant Management Endpoints ────────────────────────────────────────────── */

/**
 * GET /api/documents/:id/grants
 * List active and historical grants for the document.
 * Restricted strictly to document owner.
 */
documentsRouter.get("/:id/grants", async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "manage_grants",
  });

  if (!auth.authorized) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT
        dg.id,
        dg.document_id,
        dg.user_id,
        u.email AS user_email,
        dg.permission,
        dg.granted_by,
        dg.created_at,
        dg.revoked_at,
        (dg.revoked_at IS NULL) AS is_active
       FROM public.document_grants dg
       JOIN public.users u ON u.id = dg.user_id
       WHERE dg.document_id = $1
       ORDER BY dg.created_at DESC`,
      [documentId]
    );

    const grants = result.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      userId: row.user_id,
      userEmail: row.user_email,
      permission: row.permission,
      grantedBy: row.granted_by,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      isActive: row.is_active,
    }));

    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action: "list_grants",
      outcome: "success",
      metadata: { count: grants.length },
    });

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.json({ grants });
  } catch (error) {
    console.error("List grants error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to list document grants" });
  }
});

/**
 * POST /api/documents/:id/grants
 * Share document by creating a new grant.
 * Restricted strictly to document owner.
 * Prevents self-granting, duplicate active grants, and sharing to disabled accounts.
 */
documentsRouter.post("/:id/grants", requireCsrfToken, async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "manage_grants",
  });

  if (!auth.authorized) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  try {
    const input = createGrantSchema.parse(req.body);

    // Resolve recipient user from authoritative database
    const recipientResult = await pool.query(
      `SELECT id, email, status FROM public.users WHERE lower(email) = $1`,
      [input.email]
    );

    if (recipientResult.rows.length === 0) {
      res.status(404).json({ error: "Recipient user not found" });
      return;
    }

    const recipient = recipientResult.rows[0];

    // Cannot grant to disabled accounts
    if (recipient.status !== "active") {
      res.status(400).json({ error: "Cannot grant access to a disabled account" });
      return;
    }

    // Cannot grant to oneself (owner already has full authority)
    if (recipient.id === user.id) {
      res.status(400).json({ error: "Cannot grant access to the document owner" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check for existing active grant under lock to prevent race conditions
      const existingActive = await client.query(
        `SELECT id FROM public.document_grants
         WHERE document_id = $1 AND user_id = $2 AND revoked_at IS NULL
         FOR UPDATE`,
        [documentId, recipient.id]
      );

      if (existingActive.rows.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "An active grant already exists for this user" });
        return;
      }

      // Insert new active grant (preserves historical revoked grants if re-granting)
      const insertResult = await client.query(
        `INSERT INTO public.document_grants (
          document_id,
          user_id,
          permission,
          granted_by
        ) VALUES ($1, $2, $3, $4)
        RETURNING id, document_id, user_id, permission, granted_by, created_at, revoked_at`,
        [documentId, recipient.id, input.permission, user.id]
      );

      await client.query("COMMIT");

      const grant = insertResult.rows[0];

      await recordAuditEvent({
        actorId: user.id,
        documentId,
        action: "create_grant",
        outcome: "success",
        metadata: {
          recipientId: recipient.id,
          recipientEmail: recipient.email,
          permission: input.permission,
        },
      });

      res.status(201).json({
        message: "Access granted successfully",
        grant: {
          id: grant.id,
          documentId: grant.document_id,
          userId: grant.user_id,
          userEmail: recipient.email,
          permission: grant.permission,
          grantedBy: grant.granted_by,
          createdAt: grant.created_at,
          revokedAt: grant.revoked_at,
        },
      });
    } catch (txError: any) {
      await client.query("ROLLBACK").catch(() => {});

      // Unique constraint violation on document_grants_one_active_idx
      if (txError.code === "23505") {
        res.status(409).json({ error: "An active grant already exists for this user" });
        return;
      }

      throw txError;
    } finally {
      client.release();
    }
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

    console.error("Grant creation error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to grant access" });
  }
});

/**
 * PATCH /api/documents/:id/grants/:grantId
 * Modify an active grant's permission ('read' <-> 'edit').
 * Restricted strictly to document owner.
 */
documentsRouter.patch("/:id/grants/:grantId", requireCsrfToken, async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);
  const grantId = getParamString(req.params.grantId);

  if (!isValidUuid(grantId)) {
    res.status(404).json({ error: "Grant not found" });
    return;
  }

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "manage_grants",
  });

  if (!auth.authorized) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  try {
    const input = updateGrantSchema.parse(req.body);

    const result = await pool.query(
      `UPDATE public.document_grants
       SET permission = $1
       WHERE id = $2 AND document_id = $3 AND revoked_at IS NULL
       RETURNING id, document_id, user_id, permission, granted_by, created_at, revoked_at`,
      [input.permission, grantId, documentId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Active grant not found or already revoked" });
      return;
    }

    const grant = result.rows[0];

    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action: "update_grant",
      outcome: "success",
      metadata: { grantId, newPermission: input.permission },
    });

    res.json({
      message: "Grant updated successfully",
      grant: {
        id: grant.id,
        documentId: grant.document_id,
        userId: grant.user_id,
        permission: grant.permission,
        grantedBy: grant.granted_by,
        createdAt: grant.created_at,
        revokedAt: grant.revoked_at,
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

    console.error("Update grant error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to update grant" });
  }
});

/**
 * DELETE /api/documents/:id/grants/:grantId
 * Revoke access immediately.
 * Restricted strictly to document owner.
 * Sets revoked_at = now() atomically. Subsequent requests are immediately denied.
 */
documentsRouter.delete("/:id/grants/:grantId", requireCsrfToken, async (req: Request, res: Response) => {
  const user = req.user!;
  const documentId = getParamString(req.params.id);
  const grantId = getParamString(req.params.grantId);

  if (!isValidUuid(grantId)) {
    res.status(404).json({ error: "Grant not found" });
    return;
  }

  const auth = await authorizeDocumentAccess({
    user,
    documentId,
    action: "manage_grants",
  });

  if (!auth.authorized) {
    res.status(auth.statusCode).json({ error: auth.reason });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE public.document_grants
       SET revoked_at = now()
       WHERE id = $1 AND document_id = $2 AND revoked_at IS NULL
       RETURNING id, document_id, user_id, permission, revoked_at`,
      [grantId, documentId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Active grant not found or already revoked" });
      return;
    }

    const grant = result.rows[0];

    await recordAuditEvent({
      actorId: user.id,
      documentId,
      action: "revoke_grant",
      outcome: "success",
      metadata: { grantId, recipientId: grant.user_id },
    });

    res.json({ message: "Grant revoked successfully" });
  } catch (error) {
    console.error("Revoke grant error:", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "Failed to revoke grant" });
  }
});
