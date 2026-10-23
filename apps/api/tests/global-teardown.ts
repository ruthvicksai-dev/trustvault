import { pool } from "../src/db/pool.js";
import { env } from "../src/config.js";

/**
 * Global Vitest teardown hook.
 * Executes automatically after test suites finish to ensure zero orphaned test records.
 */
export async function teardown() {
  if (!env.DATABASE_URL) {
    return;
  }

  try {
    const testDomains = ["%@vault.test", "%@example.com"];

    // Delete test grants
    await pool.query(
      `DELETE FROM public.document_grants
       WHERE user_id IN (SELECT id FROM public.users WHERE email LIKE ANY($1))
          OR granted_by IN (SELECT id FROM public.users WHERE email LIKE ANY($1))
          OR document_id IN (SELECT id FROM public.documents WHERE owner_id IN (SELECT id FROM public.users WHERE email LIKE ANY($1)))`,
      [testDomains]
    );

    // Delete test documents
    await pool.query(
      `DELETE FROM public.documents
       WHERE owner_id IN (SELECT id FROM public.users WHERE email LIKE ANY($1))`,
      [testDomains]
    );

    // Delete test sessions
    await pool.query(
      `DELETE FROM public.sessions
       WHERE (sess::jsonb)->>'userId' IN (SELECT id::text FROM public.users WHERE email LIKE ANY($1))`,
      [testDomains]
    );

    // Delete test audit events
    await pool.query(
      `DELETE FROM public.audit_events
       WHERE actor_id IN (SELECT id FROM public.users WHERE email LIKE ANY($1))
          OR (metadata->>'emailAttempted') LIKE ANY($1)
          OR (metadata->>'email') LIKE ANY($1)`,
      [testDomains]
    );

    // Delete test users
    await pool.query(
      `DELETE FROM public.users
       WHERE email LIKE ANY($1)`,
      [testDomains]
    );
  } catch (err) {
    console.error("Global test teardown database cleanup warning:", err);
  }
}
