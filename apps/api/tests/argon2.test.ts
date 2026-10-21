import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  validatePasswordInput,
  checkNeedsRehash,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  DUMMY_HASH,
} from "../src/auth/argon2.js";

describe("Argon2id Password Security", () => {
  it("hashes and verifies a valid password", async () => {
    const password = "correct-horse-battery-staple";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

    const valid = await verifyPassword(hash, password);
    expect(valid).toBe(true);

    const invalid = await verifyPassword(hash, "wrong-password-attempt");
    expect(invalid).toBe(false);
  });

  describe("Password Policy & Input Validation", () => {
    it("enforces minimum length of 12 characters", () => {
      expect(validatePasswordInput("short123456").valid).toBe(false);
      expect(validatePasswordInput("123456789012").valid).toBe(true);
      expect(validatePasswordInput("123456789012").error).toBeUndefined();
    });

    it("enforces maximum length of 128 characters", () => {
      const oversized = "a".repeat(129);
      const exactMax = "a".repeat(128);
      expect(validatePasswordInput(oversized).valid).toBe(false);
      expect(validatePasswordInput(exactMax).valid).toBe(true);
    });

    it("rejects non-string inputs", () => {
      expect(validatePasswordInput(null).valid).toBe(false);
      expect(validatePasswordInput(undefined).valid).toBe(false);
      expect(validatePasswordInput(123456789012).valid).toBe(false);
      expect(validatePasswordInput({}).valid).toBe(false);
    });

    it("supports passwords with whitespace and Unicode characters without truncation", async () => {
      const unicodePassword = "🔒 Sécüré P@sswørd 2026! 日本語 🚀";
      expect(validatePasswordInput(unicodePassword).valid).toBe(true);

      const hash = await hashPassword(unicodePassword);
      expect(await verifyPassword(hash, unicodePassword)).toBe(true);
      expect(await verifyPassword(hash, unicodePassword.slice(0, -2))).toBe(false);
    });

    it("throws when hashing invalid passwords", async () => {
      await expect(hashPassword("short")).rejects.toThrow(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`
      );
      await expect(hashPassword("a".repeat(129))).rejects.toThrow(
        `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`
      );
    });
  });

  describe("Safe Verification and Malformed Hashes", () => {
    it("safely returns false for malformed or corrupt hashes without throwing", async () => {
      expect(await verifyPassword("not-a-hash", "some-password")).toBe(false);
      expect(await verifyPassword("$argon2id$corrupt$data", "some-password")).toBe(false);
      expect(await verifyPassword("", "some-password")).toBe(false);
      expect(await verifyPassword(null as any, "some-password")).toBe(false);
      expect(await verifyPassword(undefined as any, "some-password")).toBe(false);
    });

    it("safely handles oversized password attempts without crashing", async () => {
      const hash = await hashPassword("valid-password-123");
      const oversized = "x".repeat(200);
      expect(await verifyPassword(hash, oversized)).toBe(false);
    });
  });

  describe("Dummy Hash for Timing Mitigation", () => {
    it("verifies against the precomputed dummy hash without error", async () => {
      expect(DUMMY_HASH).toMatch(/^\$argon2id\$/);
      const result = await verifyPassword(DUMMY_HASH, "random-attempt-password");
      expect(result).toBe(false);
    });
  });

  describe("Needs Rehash Detection", () => {
    it("detects when a hash needs rehash or is up-to-date", async () => {
      const currentHash = await hashPassword("up-to-date-password");
      expect(checkNeedsRehash(currentHash)).toBe(false);

      // Malformed or older format triggers rehash
      expect(checkNeedsRehash("invalid-format")).toBe(true);
      // Older Argon2i hash
      expect(checkNeedsRehash("$argon2i$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$dGVzdA")).toBe(true);
    });
  });
});
