/**
 * TrustVault — Automated Test Database Fail-Closed Guard.
 *
 * Prevents automated tests from executing against development or production databases.
 * Tests requiring a database MUST be pointed to an isolated, dedicated test database
 * explicitly designated for testing (e.g., via TEST_DATABASE_URL).
 *
 * Security considerations:
 * - Credentials and connection strings are NEVER printed or leaked in error messages.
 * - Fails closed: If any doubt exists regarding whether the database is a test database,
 *   the test run is aborted immediately.
 */

export interface TestDatabaseValidation {
  isSafe: boolean;
  reason?: string;
}

/**
 * Cloud database provider domains that must never be written to by automated tests
 * without explicit confirmation and dedicated test database naming.
 */
const CLOUD_DB_HOST_SUFFIXES = [
  "supabase.co",
  "supabase.com",
  "supabase.in",
  "rds.amazonaws.com",
  "neon.tech",
  "cockroachlabs.cloud",
  "railway.app",
  "render.com",
  "cloud.timescale.com",
  "aivencloud.com",
];

/**
 * Evaluates whether a PostgreSQL connection string represents a safe, isolated test database.
 */
export function validateTestDatabaseUrl(url: string | undefined): TestDatabaseValidation {
  if (!url || typeof url !== "string" || url.trim() === "") {
    return {
      isSafe: false,
      reason:
        "No test database configured. Integration tests requiring a database are refused execution to prevent accidental writes to development or production databases. Configure TEST_DATABASE_URL in .env.test or your environment to point to an isolated test database.",
    };
  }

  // Parse connection URL
  let parsed: URL;
  try {
    // Normalise postgres:// to postgresql:// if needed for URL parser
    const normalized = url.startsWith("postgres://") ? url.replace("postgres://", "postgresql://") : url;
    parsed = new URL(normalized);
  } catch {
    return {
      isSafe: false,
      reason: "Invalid database connection string format.",
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase().replace(/^\//, "");
  const searchParams = parsed.searchParams;

  // 1. Never allow the primary development/production DATABASE_URL in tests unless explicitly marked
  if (process.env.PRIMARY_DATABASE_URL && url === process.env.PRIMARY_DATABASE_URL) {
    return {
      isSafe: false,
      reason:
        "The configured test database matches the primary development/production DATABASE_URL. Automated tests are strictly forbidden from writing to the primary database.",
    };
  }

  // 2. Check for remote cloud provider hostnames
  const isCloudProvider = CLOUD_DB_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );

  if (isCloudProvider) {
    const isExplicitlyConfirmed = process.env.TRUSTVAULT_TEST_DB_CONFIRMED === "true";
    const hasTestInName = pathname.includes("test");

    if (!isExplicitlyConfirmed || !hasTestInName) {
      return {
        isSafe: false,
        reason:
          "Database host indicates a remote cloud database provider. Automated tests are refused execution against remote cloud infrastructure without explicit test confirmation (database name containing 'test' and TRUSTVAULT_TEST_DB_CONFIRMED=true).",
      };
    }
  }

  // 3. Test designation requirements:
  // Must satisfy at least one explicit test indicator
  const hasTestInPath = pathname.includes("test");
  const hasTestQueryParam = searchParams.get("trustvault_test") === "true";
  const isLocalHost = ["localhost", "127.0.0.1", "::1", "postgres-test", "pg-test"].includes(hostname);
  const isExplicitEnvAllow = process.env.TRUSTVAULT_ALLOW_TEST_DB === "true";

  if (hasTestInPath || hasTestQueryParam || (isLocalHost && (hasTestInPath || isExplicitEnvAllow))) {
    return { isSafe: true };
  }

  return {
    isSafe: false,
    reason:
      "Database is not explicitly identified as a test database. The database name must contain 'test' (e.g. trustvault_test), include 'trustvault_test=true' in query parameters, or specify TRUSTVAULT_ALLOW_TEST_DB=true on a local PostgreSQL instance.",
  };
}

/**
 * Throws a descriptive fail-closed error if the database URL is not explicitly a test database.
 */
export function assertTestDatabase(url: string | undefined): void {
  const result = validateTestDatabaseUrl(url);
  if (!result.isSafe) {
    throw new Error(`[FAIL-CLOSED GUARD] ${result.reason}`);
  }
}
