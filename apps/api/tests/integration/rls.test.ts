import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../src/db/pool.js";
import { TestFixtureTracker, generateTestEmail, ensureTestDatabaseAvailable } from "../helpers/test-db.js";
import pg from "pg";

/**
 * TrustVault — Row Level Security (RLS) Regression Test Suite
 *
 * Verifies that database-level Row Level Security policies enforce:
 * 1. Default-deny on direct unauthorized database access (no leakage of sessions, user hashes, or documents).
 * 2. Cross-tenant isolation (Owner A cannot see or mutate Owner B's documents).
 * 3. Proper enforcement of per-document grants (read vs edit).
 * 4. Immediate revocation (revoked grant instantly revokes direct database access).
 * 5. Privilege escalation defense (users cannot elevate role to admin via direct SQL).
 * 6. Audit trail confidentiality and append-only tamper resistance (no UPDATE or DELETE).
 */

describe("TrustVault — Row Level Security (RLS) Integration Suite", () => {
  const tracker = new TestFixtureTracker();

  // Test identities
  let ownerAId: string;
  let ownerBId: string;
  let viewerId: string;
  let adminId: string;

  let docAId: string;
  let docBId: string;

  beforeAll(async () => {
    ensureTestDatabaseAvailable();

    // 1. Ensure restricted test role exists with NOBYPASSRLS
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustvault_restricted_tester') THEN
          CREATE ROLE trustvault_restricted_tester WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO trustvault_restricted_tester;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trustvault_restricted_tester;
    `);

    // 2. Seed test users (as privileged pool connection)
    const emailOwnerA = generateTestEmail("owner-a");
    const emailOwnerB = generateTestEmail("owner-b");
    const emailViewer = generateTestEmail("viewer");
    const emailAdmin = generateTestEmail("admin");

    const resA = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, '$argon2id$v=19$m=19456,t=2,p=1$fakehashA', 'owner', 'active')
       RETURNING id`,
      [emailOwnerA]
    );
    ownerAId = resA.rows[0].id;
    tracker.trackUser(ownerAId, emailOwnerA);

    const resB = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, '$argon2id$v=19$m=19456,t=2,p=1$fakehashB', 'owner', 'active')
       RETURNING id`,
      [emailOwnerB]
    );
    ownerBId = resB.rows[0].id;
    tracker.trackUser(ownerBId, emailOwnerB);

    const resViewer = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, '$argon2id$v=19$m=19456,t=2,p=1$fakehashV', 'viewer', 'active')
       RETURNING id`,
      [emailViewer]
    );
    viewerId = resViewer.rows[0].id;
    tracker.trackUser(viewerId, emailViewer);

    const resAdmin = await pool.query(
      `INSERT INTO public.users (email, password_hash, role, status)
       VALUES ($1, '$argon2id$v=19$m=19456,t=2,p=1$fakehashAdm', 'admin', 'active')
       RETURNING id`,
      [emailAdmin]
    );
    adminId = resAdmin.rows[0].id;
    tracker.trackUser(adminId, emailAdmin);

    // 3. Seed test documents
    const docResA = await pool.query(
      `INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes)
       VALUES ($1, 'Document A Secret', 'Finance', 'doc-a-key.pdf', 'application/pdf', 1024)
       RETURNING id`,
      [ownerAId]
    );
    docAId = docResA.rows[0].id;
    tracker.trackDocument(docAId);

    const docResB = await pool.query(
      `INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes)
       VALUES ($1, 'Document B Confidential', 'Legal', 'doc-b-key.pdf', 'application/pdf', 2048)
       RETURNING id`,
      [ownerBId]
    );
    docBId = docResB.rows[0].id;
    tracker.trackDocument(docBId);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  /**
   * Helper: Runs queries inside a transaction as a restricted non-BYPASSRLS role
   * simulating direct database or PostgREST access.
   */
  async function runAsRestrictedUser<T = any>(
    userId: string | null,
    fn: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE trustvault_restricted_tester");
      if (userId) {
        await client.query("SELECT set_config('trustvault.current_user_id', $1, true)", [userId]);
      } else {
        await client.query("SELECT set_config('trustvault.current_user_id', '', true)");
      }
      const result = await fn(client);
      await client.query("ROLLBACK");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /* ── 1. Direct Unauthorized Database Access (Default Deny) ─────────────── */

  describe("1. Direct Unauthorized Database Access (Default Deny)", () => {
    it("denies unauthenticated restricted clients from reading public.sessions", async () => {
      // Seed a session as privileged role
      const sessId = `test_sess_${Date.now()}`;
      await pool.query(
        `INSERT INTO public.sessions (sid, sess, expire)
         VALUES ($1, $2, now() + interval '1 day')`,
        [sessId, JSON.stringify({ userId: ownerAId })]
      );

      try {
        const rows = await runAsRestrictedUser(null, async (client) => {
          const res = await client.query("SELECT * FROM public.sessions WHERE sid = $1", [sessId]);
          return res.rows;
        });

        // Default deny: 0 rows returned
        expect(rows).toHaveLength(0);
      } finally {
        await pool.query("DELETE FROM public.sessions WHERE sid = $1", [sessId]);
      }
    });

    it("denies unauthenticated restricted clients from reading user password hashes", async () => {
      const rows = await runAsRestrictedUser(null, async (client) => {
        const res = await client.query("SELECT id, email, password_hash FROM public.users");
        return res.rows;
      });

      // No unauthenticated access to users
      expect(rows).toHaveLength(0);
    });

    it("denies unauthenticated restricted clients from reading any documents", async () => {
      const rows = await runAsRestrictedUser(null, async (client) => {
        const res = await client.query("SELECT * FROM public.documents");
        return res.rows;
      });

      expect(rows).toHaveLength(0);
    });

    it("denies unauthenticated restricted clients from reading audit events", async () => {
      const rows = await runAsRestrictedUser(null, async (client) => {
        const res = await client.query("SELECT * FROM public.audit_events");
        return res.rows;
      });

      expect(rows).toHaveLength(0);
    });
  });

  /* ── 2. Cross-Tenant Isolation & Document Authorization ─────────────────── */

  describe("2. Cross-Tenant Isolation & Document Authorization", () => {
    it("allows document owner to read their own documents, but denies reading other users' documents", async () => {
      const rowsA = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query("SELECT id, title, owner_id FROM public.documents");
        return res.rows;
      });

      // Owner A can only see docAId, never docBId
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].id).toBe(docAId);
      expect(rowsA[0].owner_id).toBe(ownerAId);

      const rowsB = await runAsRestrictedUser(ownerBId, async (client) => {
        const res = await client.query("SELECT id, title, owner_id FROM public.documents");
        return res.rows;
      });

      // Owner B can only see docBId, never docAId
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].id).toBe(docBId);
      expect(rowsB[0].owner_id).toBe(ownerBId);
    });

    it("prevents Owner A from updating Owner B's document", async () => {
      const updatedCount = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "UPDATE public.documents SET title = 'Hacked by A' WHERE id = $1",
          [docBId]
        );
        return res.rowCount;
      });

      // RLS filters out docBId, so 0 rows are updated
      expect(updatedCount).toBe(0);

      // Verify original title is intact
      const checkRes = await pool.query("SELECT title FROM public.documents WHERE id = $1", [docBId]);
      expect(checkRes.rows[0].title).toBe("Document B Confidential");
    });

    it("prevents Owner A from deleting or soft-deleting Owner B's document", async () => {
      const deletedCount = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "DELETE FROM public.documents WHERE id = $1",
          [docBId]
        );
        return res.rowCount;
      });

      expect(deletedCount).toBe(0);

      const softDeleteCount = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "UPDATE public.documents SET deleted_at = now() WHERE id = $1",
          [docBId]
        );
        return res.rowCount;
      });

      expect(softDeleteCount).toBe(0);

      // Verify docBId was not soft deleted
      const checkRes = await pool.query("SELECT deleted_at FROM public.documents WHERE id = $1", [docBId]);
      expect(checkRes.rows[0].deleted_at).toBeNull();
    });

    it("hides soft-deleted documents from standard queries", async () => {
      // Create and soft-delete a document for Owner A
      const softDocRes = await pool.query(
        `INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes, deleted_at)
         VALUES ($1, 'Soft Deleted Doc', 'General', 'soft-del.pdf', 'application/pdf', 512, now())
         RETURNING id`,
        [ownerAId]
      );
      const softDocId = softDocRes.rows[0].id;
      tracker.trackDocument(softDocId);

      const rows = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query("SELECT id FROM public.documents WHERE id = $1", [softDocId]);
        return res.rows;
      });

      // Soft-deleted document is filtered out by RLS
      expect(rows).toHaveLength(0);
    });
  });

  /* ── 3. Grant Permissions & Sharing Lifecycle ───────────────────────────── */

  describe("3. Grant Permissions & Sharing Lifecycle", () => {
    it("allows active 'read' grantee to view the document, but forbids updating metadata", async () => {
      // Owner A grants 'read' access to Viewer
      const grantRes = await pool.query(
        `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by)
         VALUES ($1, $2, 'read', $3)
         RETURNING id`,
        [docAId, viewerId, ownerAId]
      );
      const grantId = grantRes.rows[0].id;

      try {
        // 1. Viewer can now select docAId
        const viewRows = await runAsRestrictedUser(viewerId, async (client) => {
          const res = await client.query("SELECT id, title FROM public.documents WHERE id = $1", [docAId]);
          return res.rows;
        });
        expect(viewRows).toHaveLength(1);
        expect(viewRows[0].id).toBe(docAId);

        // 2. Viewer cannot update metadata with 'read' grant
        const updateCount = await runAsRestrictedUser(viewerId, async (client) => {
          const res = await client.query(
            "UPDATE public.documents SET title = 'Unauthorized Tamper' WHERE id = $1",
            [docAId]
          );
          return res.rowCount;
        });
        expect(updateCount).toBe(0);

        // Verify title unchanged
        const check = await pool.query("SELECT title FROM public.documents WHERE id = $1", [docAId]);
        expect(check.rows[0].title).toBe("Document A Secret");
      } finally {
        await pool.query("DELETE FROM public.document_grants WHERE id = $1", [grantId]);
      }
    });

    it("allows active 'edit' grantee to update metadata, but forbids soft-deletion or ownership transfer", async () => {
      // Owner A grants 'edit' access to Viewer
      const grantRes = await pool.query(
        `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by)
         VALUES ($1, $2, 'edit', $3)
         RETURNING id`,
        [docAId, viewerId, ownerAId]
      );
      const grantId = grantRes.rows[0].id;

      try {
        // 1. Edit grantee can update title
        const updateTitleCount = await runAsRestrictedUser(viewerId, async (client) => {
          const res = await client.query(
            "UPDATE public.documents SET title = 'Updated By Edit Grantee' WHERE id = $1",
            [docAId]
          );
          return res.rowCount;
        });
        expect(updateTitleCount).toBe(1);

        // 2. Edit grantee CANNOT transfer ownership to themselves
        await expect(
          runAsRestrictedUser(viewerId, async (client) => {
            await client.query(
              "UPDATE public.documents SET owner_id = $1 WHERE id = $2",
              [viewerId, docAId]
            );
          })
        ).rejects.toThrow(); // RLS WITH CHECK violation

        // 3. Edit grantee CANNOT soft-delete the document
        await expect(
          runAsRestrictedUser(viewerId, async (client) => {
            await client.query(
              "UPDATE public.documents SET deleted_at = now() WHERE id = $1",
              [docAId]
            );
          })
        ).rejects.toThrow(); // RLS WITH CHECK violation

        // Reset title
        await pool.query("UPDATE public.documents SET title = 'Document A Secret' WHERE id = $1", [docAId]);
      } finally {
        await pool.query("DELETE FROM public.document_grants WHERE id = $1", [grantId]);
      }
    });

    it("denies grantee access immediately upon revocation", async () => {
      // Create an active grant
      const grantRes = await pool.query(
        `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by)
         VALUES ($1, $2, 'read', $3)
         RETURNING id`,
        [docAId, viewerId, ownerAId]
      );
      const grantId = grantRes.rows[0].id;

      try {
        // Verify grantee can see document before revocation
        const beforeRows = await runAsRestrictedUser(viewerId, async (client) => {
          const res = await client.query("SELECT id FROM public.documents WHERE id = $1", [docAId]);
          return res.rows;
        });
        expect(beforeRows).toHaveLength(1);

        // Revoke the grant (revoked_at = now())
        await pool.query("UPDATE public.document_grants SET revoked_at = now() WHERE id = $1", [grantId]);

        // Verify grantee is immediately denied after revocation
        const afterRows = await runAsRestrictedUser(viewerId, async (client) => {
          const res = await client.query("SELECT id FROM public.documents WHERE id = $1", [docAId]);
          return res.rows;
        });
        expect(afterRows).toHaveLength(0);
      } finally {
        await pool.query("DELETE FROM public.document_grants WHERE id = $1", [grantId]);
      }
    });

    it("prevents non-owners from creating or revoking grants on documents they do not own", async () => {
      // Viewer attempts to grant access to Owner B on Owner A's document
      await expect(
        runAsRestrictedUser(viewerId, async (client) => {
          await client.query(
            `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by)
             VALUES ($1, $2, 'read', $3)`,
            [docAId, ownerBId, viewerId]
          );
        })
      ).rejects.toThrow(); // RLS WITH CHECK violation
    });
  });

  /* ── 4. Privilege Escalation Prevention on Users ───────────────────────── */

  describe("4. Privilege Escalation Prevention on Users", () => {
    it("allows user to read only their own user record", async () => {
      const rows = await runAsRestrictedUser(viewerId, async (client) => {
        const res = await client.query("SELECT id, email, role FROM public.users");
        return res.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(viewerId);
      expect(rows[0].role).toBe("viewer");
    });

    it("prevents viewer from modifying their role to 'admin' via direct SQL", async () => {
      await expect(
        runAsRestrictedUser(viewerId, async (client) => {
          await client.query(
            "UPDATE public.users SET role = 'admin' WHERE id = $1",
            [viewerId]
          );
        })
      ).rejects.toThrow(); // RLS WITH CHECK violation

      // Verify role remained 'viewer'
      const check = await pool.query("SELECT role FROM public.users WHERE id = $1", [viewerId]);
      expect(check.rows[0].role).toBe("viewer");
    });
  });

  /* ── 5. Audit Trail Confidentiality & Tamper Resistance ────────────────── */

  describe("5. Audit Trail Confidentiality & Tamper Resistance", () => {
    let auditEventId: string;

    beforeAll(async () => {
      const res = await pool.query(
        `INSERT INTO public.audit_events (actor_id, document_id, action, outcome, reason, metadata)
         VALUES ($1, $2, 'download_content', 'success', null, '{"sizeBytes": 1024}'::jsonb)
         RETURNING id`,
        [ownerAId, docAId]
      );
      auditEventId = res.rows[0].id;
    });

    afterAll(async () => {
      if (auditEventId) {
        await pool.query("DELETE FROM public.audit_events WHERE id = $1", [auditEventId]);
      }
    });

    it("allows document owner to query audit logs for their own document", async () => {
      const rows = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "SELECT id, action, outcome FROM public.audit_events WHERE document_id = $1",
          [docAId]
        );
        return res.rows;
      });

      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some((r) => r.id === auditEventId)).toBe(true);
    });

    it("prevents other users from querying audit logs of documents they do not own", async () => {
      const rows = await runAsRestrictedUser(ownerBId, async (client) => {
        const res = await client.query(
          "SELECT id FROM public.audit_events WHERE document_id = $1",
          [docAId]
        );
        return res.rows;
      });

      // Filtered out by RLS
      expect(rows).toHaveLength(0);
    });

    it("strictly forbids UPDATE operations on audit_events (append-only enforcement)", async () => {
      const updatedCount = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "UPDATE public.audit_events SET reason = 'Tampered' WHERE id = $1",
          [auditEventId]
        );
        return res.rowCount;
      });

      // 0 rows updated because no UPDATE policy exists (default deny)
      expect(updatedCount).toBe(0);

      // Verify record unchanged
      const check = await pool.query("SELECT reason FROM public.audit_events WHERE id = $1", [auditEventId]);
      expect(check.rows[0].reason).toBeNull();
    });

    it("strictly forbids DELETE operations on audit_events for non-privileged roles", async () => {
      const deletedCount = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "DELETE FROM public.audit_events WHERE id = $1",
          [auditEventId]
        );
        return res.rowCount;
      });

      // 0 rows deleted because no DELETE policy exists (default deny)
      expect(deletedCount).toBe(0);

      // Verify record still exists
      const check = await pool.query("SELECT id FROM public.audit_events WHERE id = $1", [auditEventId]);
      expect(check.rows).toHaveLength(1);
    });
  });
});
