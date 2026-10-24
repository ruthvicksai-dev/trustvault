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

    // 1. Ensure restricted test roles exist with NOBYPASSRLS
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustvault_restricted_tester') THEN
          CREATE ROLE trustvault_restricted_tester WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO trustvault_restricted_tester, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trustvault_restricted_tester, authenticated;
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
    fn: (client: pg.PoolClient) => Promise<T>,
    role: string = "trustvault_restricted_tester"
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
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

    it("denies anon role from executing SECURITY DEFINER helper functions, but allows authenticated role", async () => {
      // 1. Anon is denied EXECUTE
      const clientAnon = await pool.connect();
      try {
        await clientAnon.query("BEGIN");
        await clientAnon.query("SET LOCAL ROLE anon");
        await expect(
          clientAnon.query("SELECT public.is_document_owner($1, $2)", [docAId, ownerAId])
        ).rejects.toThrow(/permission denied for function/);
        await clientAnon.query("ROLLBACK");
      } catch (err) {
        await clientAnon.query("ROLLBACK");
        throw err;
      } finally {
        clientAnon.release();
      }

      // 2. Authenticated role has EXECUTE
      const clientAuth = await pool.connect();
      try {
        await clientAuth.query("BEGIN");
        await clientAuth.query("SET LOCAL ROLE authenticated");
        await clientAuth.query("SELECT set_config('trustvault.current_user_id', $1, true)", [ownerAId]);
        const res = await clientAuth.query("SELECT public.is_document_owner($1, $2)", [docAId, ownerAId]);
        expect(res.rows[0].is_document_owner).toBe(true);
        await clientAuth.query("ROLLBACK");
      } catch (err) {
        await clientAuth.query("ROLLBACK");
        throw err;
      } finally {
        clientAuth.release();
      }
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

    it("allows document owner to complete ownership transfer and soft-delete via UPDATE", async () => {
      // 1. Owner A creates and soft-deletes a document via UPDATE
      const docRes = await pool.query(
        `INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes)
         VALUES ($1, 'Soft Delete Test Doc', 'General', 'sd-test.pdf', 'application/pdf', 1024)
         RETURNING id`,
        [ownerAId]
      );
      const testDocId = docRes.rows[0].id;
      tracker.trackDocument(testDocId);

      await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query(
          "UPDATE public.documents SET deleted_at = now() WHERE id = $1 RETURNING id, deleted_at",
          [testDocId]
        );
        expect(res.rowCount).toBe(1);

        // Within query flow, soft-deleted doc is filtered out from standard queries
        const viewRows = await client.query("SELECT id FROM public.documents WHERE id = $1", [testDocId]);
        expect(viewRows.rows).toHaveLength(0);
      });

      // 2. Owner A transfers ownership of a document to Owner B via UPDATE
      const xferDocRes = await pool.query(
        `INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes)
         VALUES ($1, 'Transfer Test Doc', 'General', 'xfer-test.pdf', 'application/pdf', 1024)
         RETURNING id`,
        [ownerAId]
      );
      const xferDocId = xferDocRes.rows[0].id;
      tracker.trackDocument(xferDocId);

      const clientTransfer = await pool.connect();
      try {
        await clientTransfer.query("BEGIN");
        await clientTransfer.query("SET LOCAL ROLE trustvault_restricted_tester");
        await clientTransfer.query("SELECT set_config('trustvault.current_user_id', $1, true)", [ownerAId]);
        const res = await clientTransfer.query(
          "UPDATE public.documents SET owner_id = $1 WHERE id = $2",
          [ownerBId, xferDocId]
        );
        expect(res.rowCount).toBe(1);
        await clientTransfer.query("COMMIT");
      } catch (e) {
        await clientTransfer.query("ROLLBACK");
        throw e;
      } finally {
        clientTransfer.release();
      }

      // Verify new owner can see it, and previous owner cannot
      const bRows = await runAsRestrictedUser(ownerBId, async (client) => {
        const res = await client.query("SELECT id FROM public.documents WHERE id = $1", [xferDocId]);
        return res.rows;
      });
      expect(bRows).toHaveLength(1);

      const aRows = await runAsRestrictedUser(ownerAId, async (client) => {
        const res = await client.query("SELECT id FROM public.documents WHERE id = $1", [xferDocId]);
        return res.rows;
      });
      expect(aRows).toHaveLength(0);
    });

    it("prevents non-service roles (authenticated and tester) from modifying storage_key, mime_type, or size_bytes via trigger", async () => {
      for (const role of ["trustvault_restricted_tester", "authenticated"]) {
        // Modifying storage_key throws exception
        await expect(
          runAsRestrictedUser(ownerAId, async (client) => {
            await client.query("UPDATE public.documents SET storage_key = 'hacked.pdf' WHERE id = $1", [docAId]);
          }, role)
        ).rejects.toThrow(/immutable for non-service roles/);

        // Modifying mime_type throws exception
        await expect(
          runAsRestrictedUser(ownerAId, async (client) => {
            await client.query("UPDATE public.documents SET mime_type = 'application/evil' WHERE id = $1", [docAId]);
          }, role)
        ).rejects.toThrow(/immutable for non-service roles/);

        // Modifying size_bytes throws exception
        await expect(
          runAsRestrictedUser(ownerAId, async (client) => {
            await client.query("UPDATE public.documents SET size_bytes = 999999 WHERE id = $1", [docAId]);
          }, role)
        ).rejects.toThrow(/immutable for non-service roles/);

        // Modifying permitted field (title) succeeds
        const updateTitleCount = await runAsRestrictedUser(ownerAId, async (client) => {
          const res = await client.query("UPDATE public.documents SET title = 'Updated Valid Title' WHERE id = $1", [docAId]);
          return res.rowCount;
        }, role);
        expect(updateTitleCount).toBe(1);
      }
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

    it("prevents unauthenticated direct user insertion (account creation strictly server-side)", async () => {
      const email = generateTestEmail("anon-create");
      await expect(
        runAsRestrictedUser(null, async (client) => {
          await client.query(
            `INSERT INTO public.users (email, password_hash, role, status)
             VALUES ($1, 'fakehash', 'viewer', 'active')`,
            [email]
          );
        })
      ).rejects.toThrow(); // RLS WITH CHECK violation
    });

    it("allows admin to create user records via direct SQL", async () => {
      const email = generateTestEmail("admin-create");
      const res = await runAsRestrictedUser(adminId, async (client) => {
        const r = await client.query(
          `INSERT INTO public.users (email, password_hash, role, status)
           VALUES ($1, 'fakehash', 'viewer', 'active')
           RETURNING id`,
          [email]
        );
        return r.rows[0];
      });

      expect(res.id).toBeDefined();
      tracker.trackUser(res.id, email);
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

    it("enforces audit event insertion rules (actor matching, document access, and unauthenticated rejection)", async () => {
      const createdIds: string[] = [];
      try {
        // 1. Document owner inserting audit event for their document succeeds
        const ownerAudit = await runAsRestrictedUser(ownerAId, async (client) => {
          const res = await client.query(
            `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
             VALUES ($1, $2, 'document_read', 'success')
             RETURNING id`,
            [ownerAId, docAId]
          );
          return res.rows[0];
        });
        expect(ownerAudit.id).toBeDefined();
        createdIds.push(ownerAudit.id);

        // 2. Non-admin actor inserting with non-null actor_id and NULL document_id succeeds
        const loginAuditCount = await runAsRestrictedUser(ownerAId, async (client) => {
          const res = await client.query(
            `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
             VALUES ($1, NULL, 'user_login', 'success')`,
            [ownerAId]
          );
          return res.rowCount;
        });
        expect(loginAuditCount).toBe(1);

        // 3. Client inserting with NULL actor_id fails (authenticated client forbidden from inserting null actor)
        await expect(
          runAsRestrictedUser(ownerAId, async (client) => {
            await client.query(
              `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
               VALUES (NULL, $1, 'document_read', 'success')`,
              [docAId]
            );
          })
        ).rejects.toThrow();

        // 4. Admin client inserting with NULL actor_id fails (client null-actor rejection applies to admin clients too)
        await expect(
          runAsRestrictedUser(adminId, async (client) => {
            await client.query(
              `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
               VALUES (NULL, NULL, 'admin_action', 'success')`
            );
          })
        ).rejects.toThrow();

        // 5. Admin client inserting with non-null actor_id succeeds
        const adminAuditCount = await runAsRestrictedUser(adminId, async (client) => {
          const res = await client.query(
            `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
             VALUES ($1, NULL, 'admin_audit_log', 'success')`,
            [adminId]
          );
          return res.rowCount;
        });
        expect(adminAuditCount).toBe(1);

        // 6. Direct insert by authenticated role succeeds when matching auth.uid()
        const authDirectRes = await runAsRestrictedUser(ownerAId, async (client) => {
          const res = await client.query(
            `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
             VALUES ($1, $2, 'authenticated_direct', 'success')
             RETURNING id`,
            [ownerAId, docAId]
          );
          return res.rows[0];
        }, "authenticated");
        expect(authDirectRes.id).toBeDefined();
        createdIds.push(authDirectRes.id);

        // 7. Server-only role (pool connection) can insert system writes with NULL actor_id
        const sysRes = await pool.query(
          `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
           VALUES (NULL, NULL, 'system_startup_healthcheck', 'success')
           RETURNING id`
        );
        expect(sysRes.rows[0].id).toBeDefined();
        createdIds.push(sysRes.rows[0].id);

        // 8. Actor inserting audit event for a document they DO NOT own or have grant for fails
        await expect(
          runAsRestrictedUser(ownerBId, async (client) => {
            await client.query(
              `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
               VALUES ($1, $2, 'document_read', 'success')`,
              [ownerBId, docAId]
            );
          })
        ).rejects.toThrow();

        // 9. Actor attempting to spoof another actor_id fails
        await expect(
          runAsRestrictedUser(ownerAId, async (client) => {
            await client.query(
              `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
               VALUES ($1, $2, 'document_read', 'success')`,
              [ownerBId, docAId]
            );
          })
        ).rejects.toThrow();

        // 10. Unauthenticated actor (null user) inserting audit event fails
        await expect(
          runAsRestrictedUser(null, async (client) => {
            await client.query(
              `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
               VALUES (NULL, NULL, 'anon_action', 'success')`
            );
          })
        ).rejects.toThrow();

        // 11. Direct insert as anon role is rejected (table-level / RLS denial)
        await expect(
          runAsRestrictedUser(null, async (client) => {
            await client.query(
              `INSERT INTO public.audit_events (actor_id, document_id, action, outcome)
               VALUES (NULL, NULL, 'anon_action', 'success')`
            );
          }, "anon")
        ).rejects.toThrow();
      } finally {
        if (createdIds.length > 0) {
          await pool.query(
            "DELETE FROM public.audit_events WHERE id = ANY($1::bigint[])",
            [createdIds]
          );
        }
      }
    });
  });
});
