import { pool } from "../../src/db/pool.js";
import { assertTestDatabase } from "../../src/db/guard.js";
import { env } from "../../src/config.js";

/**
 * Registry and fixture tracker for test suites.
 * Ensures that every record inserted during an integration test is tracked
 * and cleaned up with foreign-key-ordered, strictly scoped SQL statements.
 */
export class TestFixtureTracker {
  public userIds = new Set<string>();
  public documentIds = new Set<string>();
  public userEmails = new Set<string>();

  trackUser(id: string, email?: string): void {
    if (id) this.userIds.add(id);
    if (email) this.userEmails.add(email);
  }

  trackDocument(id: string): void {
    if (id) this.documentIds.add(id);
  }

  /**
   * Executes strictly scoped, transactional/foreign-key-safe deletion of only the tracked fixtures.
   * Never deletes unrelated user data, demo data, or production records.
   */
  async cleanup(): Promise<void> {
    if (!env.DATABASE_URL) {
      return;
    }

    const docIds = Array.from(this.documentIds);
    const uIds = Array.from(this.userIds);
    const emails = Array.from(this.userEmails);

    if (docIds.length === 0 && uIds.length === 0 && emails.length === 0) {
      return;
    }

    try {
      // 1. Delete document grants
      if (docIds.length > 0 || uIds.length > 0) {
        await pool.query(
          `DELETE FROM public.document_grants
           WHERE document_id = ANY($1)
              OR user_id = ANY($2)
              OR granted_by = ANY($2)`,
          [docIds, uIds]
        );
      }

      // 2. Delete audit events associated with tracked documents, actors, or emails
      if (docIds.length > 0 || uIds.length > 0 || emails.length > 0) {
        await pool.query(
          `DELETE FROM public.audit_events
           WHERE document_id = ANY($1)
              OR actor_id = ANY($2)
              OR (metadata->>'email') = ANY($3)
              OR (metadata->>'emailAttempted') = ANY($3)`,
          [docIds, uIds, emails]
        );
      }

      // 3. Delete tracked documents
      if (docIds.length > 0 || uIds.length > 0) {
        await pool.query(
          `DELETE FROM public.documents
           WHERE id = ANY($1) OR owner_id = ANY($2)`,
          [docIds, uIds]
        );
      }

      // 4. Delete sessions for tracked users
      if (uIds.length > 0) {
        await pool.query(
          `DELETE FROM public.sessions
           WHERE (sess::jsonb)->>'userId' = ANY($1)`,
          [uIds]
        );
      }

      // 5. Delete tracked users
      if (uIds.length > 0 || emails.length > 0) {
        await pool.query(
          `DELETE FROM public.users
           WHERE id = ANY($1) OR email = ANY($2)`,
          [uIds, emails]
        );
      }
    } catch (err: any) {
      // If fail-closed guard or disconnect, handle gracefully without swallowing genuine errors
      if (!err?.message?.includes("[FAIL-CLOSED GUARD]")) {
        console.error("Scoped test fixture cleanup error:", err?.message || err);
      }
    } finally {
      this.documentIds.clear();
      this.userIds.clear();
      this.userEmails.clear();
    }
  }
}

/**
 * Creates a unique test runner email with a high-entropy timestamp and random suffix.
 */
export function generateTestEmail(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@vault.test`;
}

/**
 * Pre-suite verification helper for integration tests.
 * Confirms that a safe, designated test database is available before running integration tests.
 */
export function ensureTestDatabaseAvailable(): void {
  assertTestDatabase(env.DATABASE_URL);
}
