import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const apiDir = resolve(__dirname, "..");

const isTest = process.env.NODE_ENV === "test";

if (isTest) {
  // In test environment, prioritize .env.test if present
  const rootTestEnv = resolve(rootDir, ".env.test");
  const apiTestEnv = resolve(apiDir, ".env.test");
  if (existsSync(rootTestEnv)) {
    config({ path: rootTestEnv });
  } else if (existsSync(apiTestEnv)) {
    config({ path: apiTestEnv });
  }
} else {
  // In development and production, load root .env
  config({ path: resolve(rootDir, ".env") });
  if (process.env.DATABASE_URL) {
    process.env.PRIMARY_DATABASE_URL = process.env.DATABASE_URL;
  }
}

// In test mode, strictly use TEST_DATABASE_URL to protect production/development databases
const databaseUrl = isTest
  ? (process.env.TEST_DATABASE_URL || "")
  : (process.env.DATABASE_URL || "");

const rawSessionSecret = process.env.SESSION_SECRET || "";
const sessionSecret = rawSessionSecret || (isTest ? "test-secret-with-minimum-32-chars-for-entropy-and-safety" : "");

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 4000,
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || "",
  SUPABASE_URL: isTest ? (process.env.TEST_SUPABASE_URL || "http://127.0.0.1:54321") : (process.env.SUPABASE_URL || ""),
  SUPABASE_SECRET_KEY: isTest ? (process.env.TEST_SUPABASE_SECRET_KEY || "dummy-test-key") : (process.env.SUPABASE_SECRET_KEY || ""),
  SUPABASE_STORAGE_BUCKET: isTest ? (process.env.TEST_STORAGE_BUCKET || "trustvault-test-isolated") : (process.env.SUPABASE_STORAGE_BUCKET || "trustvault-private"),
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
