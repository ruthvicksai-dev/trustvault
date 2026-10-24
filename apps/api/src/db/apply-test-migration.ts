import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "./guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../../..");

/**
 * Resolves TEST_DATABASE_URL from process.env or .env.test file.
 * Throws if neither is configured.
 */
export function resolveTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL.trim().length > 0) {
    return process.env.TEST_DATABASE_URL.trim();
  }

  const testEnvPath = resolve(rootDir, ".env.test");
  if (existsSync(testEnvPath)) {
    const testEnvContent = readFileSync(testEnvPath, "utf-8");
    const testEnvLine = testEnvContent
      .split(/\r?\n/)
      .find((l) => l.startsWith("TEST_DATABASE_URL="));

    if (testEnvLine) {
      return testEnvLine
        .slice(testEnvLine.indexOf("=") + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim();
    }
  }

  throw new Error(
    "Cannot locate isolated test database configuration. Provide TEST_DATABASE_URL environment variable or create .env.test."
  );
}

export async function applyTestMigration(customPool?: pg.Pool): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();

  // Enforce repository fail-closed security guard
  assertTestDatabase(testUrl);

  console.log("Applying migrations to test database:", testUrl.replace(/:[^:@]+@/, ":***@"));

  const pool = customPool || new pg.Pool({ connectionString: testUrl });
  const client = await pool.connect();
  try {
    // 1. Check if base schema exists (e.g. public.users table)
    const checkTable = await client.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'users'
    `);

    if (checkTable.rows.length === 0) {
      console.log("Applying base schema migration: 20261020161159_create_trustvault_schema.sql");
      const baseSql = readFileSync(
        resolve(rootDir, "supabase/migrations/20261020161159_create_trustvault_schema.sql"),
        "utf-8"
      );
      await client.query("BEGIN");
      await client.query(baseSql);
      await client.query("COMMIT");
      console.log("Base schema migration applied successfully.");
    } else {
      console.log("Base schema already present in test database. Skipping initial table creation.");
    }

    // 2. Apply RLS migration (idempotent definition)
    console.log("Applying RLS migration: 20261024103000_enable_row_level_security.sql");
    const rlsSql = readFileSync(
      resolve(rootDir, "supabase/migrations/20261024103000_enable_row_level_security.sql"),
      "utf-8"
    );
    await client.query("BEGIN");
    await client.query(rlsSql);
    await client.query("COMMIT");
    console.log("RLS migration applied successfully to test database.");

    // 3. Apply user display_name schema extension (idempotent)
    const displayNameMigrationPath = resolve(rootDir, "supabase/migrations/20261024120000_add_user_display_name.sql");
    if (existsSync(displayNameMigrationPath)) {
      console.log("Applying display_name migration: 20261024120000_add_user_display_name.sql");
      const displayNameSql = readFileSync(displayNameMigrationPath, "utf-8");
      await client.query("BEGIN");
      await client.query(displayNameSql);
      await client.query("COMMIT");
      console.log("Display name migration applied successfully to test database.");
    }
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    if (!customPool) {
      await pool.end();
    }
  }
}

// Execute if run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  applyTestMigration().catch((err) => {
    console.error("Execution error:", err);
    process.exit(1);
  });
}
