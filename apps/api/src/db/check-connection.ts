import "dotenv/config";
import { pool } from "./pool.js";

async function main() {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS username,
        now() AS server_time
    `);

    console.log("Supabase PostgreSQL connection successful!");
    console.log({
      database: result.rows[0].database,
      username: result.rows[0].username,
      serverTime: result.rows[0].server_time,
    });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown connection error";

  console.error("Database connection failed:", message);
  process.exitCode = 1;
});