import { env } from "../config.js";
import { assertTestDatabase } from "./guard.js";
import pg from "pg";

const { Pool } = pg;

function createDatabasePool(): pg.Pool {
  const isTest = env.NODE_ENV === "test";

  if (isTest) {
    if (!env.DATABASE_URL) {
      // In test mode without TEST_DATABASE_URL configured:
      // Return a fail-closed stub so unit tests can import routes/app without requiring a database,
      // and can mock pool.query with vi.spyOn where needed.
      const failClosedQuery = () => {
        throw new Error(
          "[FAIL-CLOSED GUARD] No test database configured. Integration tests requiring a database are refused execution to prevent accidental writes to development or production databases. Please configure TEST_DATABASE_URL in .env.test."
        );
      };

      const stub: any = {
        query: failClosedQuery,
        connect: failClosedQuery,
        on: () => stub,
        end: () => Promise.resolve(),
      };
      return stub as pg.Pool;
    }

    // Explicit test database validation
    assertTestDatabase(env.DATABASE_URL);
  } else {
    if (!env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not configured");
    }
  }

  const p = new Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });

  p.on("error", (error: any) => {
    console.error(
      "Unexpected idle PostgreSQL connection error:",
      error.message
    );
  });

  return p;
}

export const pool = createDatabasePool();