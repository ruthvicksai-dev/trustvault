import { describe, it, expect } from "vitest";
import { sanitizeAuditMetadata, ALLOWED_METADATA_KEYS } from "../../src/audit/service.js";

describe("Audit Metadata Sanitizer (Unit)", () => {
  it("allows permissible metadata keys and values", () => {
    const input = {
      email: "test@vault.test",
      role: "viewer",
      actionFilter: "auth_login",
      sizeBytes: 1048576,
    };

    const result = sanitizeAuditMetadata(input);
    expect(result).toEqual({
      email: "test@vault.test",
      role: "viewer",
      actionFilter: "auth_login",
      sizeBytes: 1048576,
    });
  });

  it("strips keys not present in ALLOWED_METADATA_KEYS", () => {
    const input = {
      email: "user@example.com",
      arbitraryInternalData: "sensitive-info",
      creditCardNumber: "4111-2222-3333-4444",
    };

    const result = sanitizeAuditMetadata(input);
    expect(result).toEqual({
      email: "user@example.com",
    });
    expect((result as any).arbitraryInternalData).toBeUndefined();
    expect((result as any).creditCardNumber).toBeUndefined();
  });

  it("redacts credential-shaped values from allowed fields", () => {
    const input = {
      reason: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID5eeBQOsXdBNY5cfP7CQq-KKJTAGdrPGQGwufjtu",
    };

    const result = sanitizeAuditMetadata(input);
    expect(result.reason).toBe("[REDACTED]");
  });

  it("redacts Argon2 password hashes from reason field", () => {
    const input = {
      reason: "$argon2id$v=19$m=19456,t=2,p=1$fakeHashValueHere",
    };

    const result = sanitizeAuditMetadata(input);
    expect(result.reason).toBe("[REDACTED]");
  });

  it("prevents prototype pollution attempts", () => {
    const maliciousJson = JSON.parse('{"__proto__": {"polluted": true}, "email": "safe@vault.test"}');
    const result = sanitizeAuditMetadata(maliciousJson);

    expect(result.email).toBe("safe@vault.test");
    expect((result as any).polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("bounds long string values to prevent denial of service", () => {
    const longString = "A".repeat(1000);
    const result = sanitizeAuditMetadata({ reason: longString });

    expect(typeof result.reason).toBe("string");
    expect((result.reason as string).length).toBeLessThanOrEqual(503); // 500 + "..."
    expect((result.reason as string).endsWith("...")).toBe(true);
  });
});
