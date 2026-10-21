import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Walk up to the monorepo root to find .env
// From apps/api/src/config.ts → ../../.. → project root
config({ path: resolve(__dirname, "../../../.env") });

const rawSessionSecret = process.env.SESSION_SECRET || "";
const isTest = process.env.NODE_ENV === "test";
const sessionSecret = rawSessionSecret || (isTest ? "test-secret-with-minimum-32-chars-for-entropy-and-safety" : "");

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 4000,
  DATABASE_URL: process.env.DATABASE_URL || "",
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || "",
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || "trustvault-private",
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  SESSION_SECRET: sessionSecret,
  TRUST_PROXY: process.env.TRUST_PROXY || "false",
} as const;

// Production security assertion
if (env.NODE_ENV === "production") {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("CRITICAL SECURITY ERROR: SESSION_SECRET must be set and provide at least 32 characters of entropy in production");
  }
  if (!env.DATABASE_URL) {
    throw new Error("CRITICAL CONFIGURATION ERROR: DATABASE_URL must be configured");
  }
}
