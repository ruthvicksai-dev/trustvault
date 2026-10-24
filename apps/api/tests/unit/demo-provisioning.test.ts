import { describe, it, expect, vi } from "vitest";
import { validateDemoConfig, SYNTHETIC_DEMO_PDF_BUFFER } from "../../src/db/provision-demo.js";

describe("Demo Provisioning Engine — Unit Tests & Security Guards", () => {
  it("fails closed when ENABLE_DEMO_ACCOUNTS is not set (disabled by default)", () => {
    const res = validateDemoConfig({});
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain("disabled by default");
    expect(res.config).toBeUndefined();
  });

  it("fails closed when ENABLE_DEMO_ACCOUNTS is explicitly 'false'", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "false",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain("disabled by default");
  });

  it("fails closed in production environment without explicit confirmation", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      NODE_ENV: "production",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain("production environment is blocked without explicit confirmation");
  });

  it("permits production provisioning only when DEMO_ENV_CONFIRMATION=true", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      NODE_ENV: "production",
      DEMO_ENV_CONFIRMATION: "true",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(true);
    expect(res.config?.isProduction).toBe(true);
    expect(res.config?.productionConfirmed).toBe(true);
  });

  it("fails closed when DEMO_ADMIN_PASSWORD is missing or shorter than 12 characters", () => {
    const resShort = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_ADMIN_PASSWORD: "short",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(resShort.isValid).toBe(false);
    expect(resShort.reason).toContain("DEMO_ADMIN_PASSWORD");
    expect(resShort.reason).toContain("at least 12 characters");

    const resMissing = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(resMissing.isValid).toBe(false);
    expect(resMissing.reason).toContain("DEMO_ADMIN_PASSWORD");
  });

  it("fails closed when DEMO_OWNER_PASSWORD is missing or shorter than 12 characters", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "tiny",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain("DEMO_OWNER_PASSWORD");
  });

  it("fails closed when DEMO_VIEWER_PASSWORD is missing or shorter than 12 characters", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "",
    });
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain("DEMO_VIEWER_PASSWORD");
  });

  it("never includes passwords in validation failure reason strings", () => {
    const secretAdmin = "SecretP@ssword1!";
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_ADMIN_PASSWORD: secretAdmin,
      DEMO_OWNER_PASSWORD: "short",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(false);
    expect(res.reason).not.toContain(secretAdmin);
  });

  it("uses default synthetic email addresses if custom emails are omitted", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(true);
    expect(res.config?.accounts.admin.email).toBe("admin@trustvault.local");
    expect(res.config?.accounts.owner.email).toBe("owner@trustvault.local");
    expect(res.config?.accounts.viewer.email).toBe("viewer@trustvault.local");
  });

  it("supports custom synthetic email addresses when provided", () => {
    const res = validateDemoConfig({
      ENABLE_DEMO_ACCOUNTS: "true",
      DEMO_ADMIN_EMAIL: "eval-admin@demo.internal",
      DEMO_OWNER_EMAIL: "eval-owner@demo.internal",
      DEMO_VIEWER_EMAIL: "eval-viewer@demo.internal",
      DEMO_ADMIN_PASSWORD: "ValidAdminPassword123!",
      DEMO_OWNER_PASSWORD: "ValidOwnerPassword123!",
      DEMO_VIEWER_PASSWORD: "ValidViewerPassword123!",
    });
    expect(res.isValid).toBe(true);
    expect(res.config?.accounts.admin.email).toBe("eval-admin@demo.internal");
    expect(res.config?.accounts.owner.email).toBe("eval-owner@demo.internal");
    expect(res.config?.accounts.viewer.email).toBe("eval-viewer@demo.internal");
  });

  it("provides valid synthetic PDF buffer starting with canonical PDF magic bytes", () => {
    expect(SYNTHETIC_DEMO_PDF_BUFFER).toBeInstanceOf(Buffer);
    expect(SYNTHETIC_DEMO_PDF_BUFFER.length).toBeGreaterThan(100);
    expect(SYNTHETIC_DEMO_PDF_BUFFER.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
