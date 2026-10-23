import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateTestDatabaseUrl, assertTestDatabase } from "../../src/db/guard.js";

describe("Test Database Fail-Closed Guard (Unit)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TRUSTVAULT_TEST_DB_CONFIRMED;
    delete process.env.TRUSTVAULT_ALLOW_TEST_DB;
    delete process.env.PRIMARY_DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Rejection of Insecure or Production Configurations", () => {
    it("refuses execution if no database URL is provided", () => {
      const res = validateTestDatabaseUrl(undefined);
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain("No test database configured");

      expect(() => assertTestDatabase(undefined)).toThrow(/\[FAIL-CLOSED GUARD\]/);
    });

    it("refuses execution if URL matches primary production/development database", () => {
      process.env.PRIMARY_DATABASE_URL = "postgresql://postgres:secret@db.project.supabase.co:5432/postgres";

      const res = validateTestDatabaseUrl("postgresql://postgres:secret@db.project.supabase.co:5432/postgres");
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain("matches the primary development/production DATABASE_URL");
    });

    it("refuses execution against unconfirmed Supabase cloud database hosts", () => {
      const res = validateTestDatabaseUrl("postgresql://postgres:secret@db.xyz.supabase.co:5432/postgres");
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain("remote cloud database provider");
    });

    it("refuses execution against AWS RDS cloud database hosts without test confirmation", () => {
      const res = validateTestDatabaseUrl("postgresql://admin:secret@prod.xyz.us-east-1.rds.amazonaws.com:5432/production");
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain("remote cloud database provider");
    });

    it("refuses execution against local database if database name does not indicate test", () => {
      const res = validateTestDatabaseUrl("postgresql://postgres:postgres@localhost:5432/production_replica");
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain("Database is not explicitly identified as a test database");
    });
  });

  describe("Acceptance of Designated Test Databases", () => {
    it("accepts local database with 'test' in the database name", () => {
      const res = validateTestDatabaseUrl("postgresql://postgres:postgres@localhost:5432/trustvault_test");
      expect(res.isSafe).toBe(true);
      expect(() => assertTestDatabase("postgresql://postgres:postgres@localhost:5432/trustvault_test")).not.toThrow();
    });

    it("accepts 127.0.0.1 database with query parameter 'trustvault_test=true'", () => {
      const res = validateTestDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:5432/disposable?trustvault_test=true");
      expect(res.isSafe).toBe(true);
      expect(() => assertTestDatabase("postgresql://postgres:postgres@127.0.0.1:5432/disposable?trustvault_test=true")).not.toThrow();
    });

    it("accepts local database when TRUSTVAULT_ALLOW_TEST_DB=true is explicitly set", () => {
      process.env.TRUSTVAULT_ALLOW_TEST_DB = "true";
      const res = validateTestDatabaseUrl("postgresql://postgres:postgres@localhost:5432/custom_local");
      expect(res.isSafe).toBe(true);
    });

    it("accepts remote cloud test database only when name contains 'test' AND TRUSTVAULT_TEST_DB_CONFIRMED=true", () => {
      process.env.TRUSTVAULT_TEST_DB_CONFIRMED = "true";
      const res = validateTestDatabaseUrl("postgresql://postgres:secret@db.xyz.supabase.co:5432/trustvault_test");
      expect(res.isSafe).toBe(true);
      expect(() => assertTestDatabase("postgresql://postgres:secret@db.xyz.supabase.co:5432/trustvault_test")).not.toThrow();
    });
  });
});
