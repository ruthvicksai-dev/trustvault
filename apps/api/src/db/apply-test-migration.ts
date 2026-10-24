import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "./guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../../..");

// Ensure we only read TEST_DATABASE_URL
const testEnvPath = resolve(rootDir, ".env.test");
if (!existsSync(testEnvPath)) {
  throw new Error(".env.test does not exist. Cannot locate isolated test database configuration.");
}

const testEnvContent = readFileSync(testEnvPath, "utf-8");
const testUrl = testEnvContent
  .split(/\r?\n/)
  .find((l) => l.startsWith("TEST_DATABASE_URL="))
  ?.split("=")[1]
  ?.trim();

// Enforce repository fail-closed security guard
assertTestDatabase(testUrl);

console.log("Applying RLS migration to test database:", testUrl!.replace(/:[^:@]+@/, ":***@"));

const migrationSql = readFileSync(
  resolve(rootDir, "supabase/migrations/20261024103000_enable_row_level_security.sql"),
  "utf-8"
);

const pool = new pg.Pool({ connectionString: testUrl });

export async function applyTestMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migrationSql);
    await client.query("COMMIT");
    console.log("RLS migration applied successfully to test database.");
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Execute if run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  applyTestMigration().catch((err) => {
    console.error("Execution error:", err);
    process.exit(1);
  });
}
