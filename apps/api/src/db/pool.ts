import { env } from "../config.js";
import pg from "pg";

const { Pool } = pg;

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on("error", (error: any) => {
  console.error(
    "Unexpected idle PostgreSQL connection error:",
    error.message
  );
});