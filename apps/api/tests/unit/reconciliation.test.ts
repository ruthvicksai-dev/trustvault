import { describe, it, expect } from "vitest";
import {
  InMemoryStorageDriver,
  reconcileOrphanedObjects,
} from "../../src/documents/storage.js";

describe("Orphan Object Reconciliation (Unit - Mocked DB)", () => {
  it("reconciles orphaned storage objects when no database document record exists", async () => {
    const memoryStorage = new InMemoryStorageDriver();
    const orphanKey = "orphaned-object-uuid-test.pdf";
    await memoryStorage.upload(orphanKey, Buffer.from("%PDF-1.4\nOrphaned\n%%EOF"), "application/pdf");
    // Backdate to 30 mins ago so it is outside the default 15m grace period
    memoryStorage.setCreatedAt(orphanKey, new Date(Date.now() - 30 * 60 * 1000));
    expect(memoryStorage.has(orphanKey)).toBe(true);

    // Mock dbPool returning 0 rows (no document references this key)
    const mockDbPool = {
      query: async () => ({ rows: [] } as any),
    };

    const report = await reconcileOrphanedObjects(memoryStorage, mockDbPool);
    expect(report.scanned).toBe(1);
    expect(report.reconciled).toContain(orphanKey);
    expect(memoryStorage.has(orphanKey)).toBe(false);
  });

  it("safely paginates across multiple pages during reconciliation", async () => {
    const memoryStorage = new InMemoryStorageDriver();
    const orphanKeys: string[] = [];
    const pastDate = new Date(Date.now() - 30 * 60 * 1000);
    for (let i = 0; i < 12; i++) {
      const key = `multi-page-orphan-${i}-${Date.now()}.pdf`;
      orphanKeys.push(key);
      await memoryStorage.upload(key, Buffer.from("%PDF-1.4\nMultiPage\n%%EOF"), "application/pdf");
      memoryStorage.setCreatedAt(key, pastDate);
    }

    const mockDbPool = {
      query: async () => ({ rows: [] } as any),
    };

    const report = await reconcileOrphanedObjects(memoryStorage, mockDbPool, {
      batchSize: 4,
      gracePeriodMs: 0,
    });

    expect(report.scanned).toBeGreaterThanOrEqual(12);
    for (const key of orphanKeys) {
      expect(report.reconciled).toContain(key);
      expect(memoryStorage.has(key)).toBe(false);
    }
  });

  it("preserves storage objects that exist in database", async () => {
    const memoryStorage = new InMemoryStorageDriver();
    const validKey = "active-document-uuid.pdf";
    await memoryStorage.upload(validKey, Buffer.from("%PDF-1.4\nActiveDoc\n%%EOF"), "application/pdf");
    memoryStorage.setCreatedAt(validKey, new Date(Date.now() - 30 * 60 * 1000));

    // Mock dbPool returning a document row (referenced in DB)
    const mockDbPool = {
      query: async (sql: string, params: any[]) => {
        if (params?.[0] === validKey) {
          return { rows: [{ id: "doc-uuid-123" }] } as any;
        }
        return { rows: [] } as any;
      },
    };

    const report = await reconcileOrphanedObjects(memoryStorage, mockDbPool as any, { gracePeriodMs: 0 });
    expect(report.scanned).toBe(1);
    expect(report.reconciled).not.toContain(validKey);
    expect(memoryStorage.has(validKey)).toBe(true);
  });

  it("mitigates reconciliation races by preserving in-flight uploads within grace period", async () => {
    const memoryStorage = new InMemoryStorageDriver();
    const inFlightKey = `inflight-upload-${Date.now()}.pdf`;
    const oldOrphanKey = `old-orphan-${Date.now()}.pdf`;

    // 1. inFlightKey uploaded just now (0 minutes ago)
    await memoryStorage.upload(inFlightKey, Buffer.from("%PDF-1.4\nInFlight\n%%EOF"), "application/pdf");

    // 2. oldOrphanKey uploaded 30 minutes ago
    await memoryStorage.upload(oldOrphanKey, Buffer.from("%PDF-1.4\nOld\n%%EOF"), "application/pdf");
    memoryStorage.setCreatedAt(oldOrphanKey, new Date(Date.now() - 30 * 60 * 1000));

    const mockDbPool = {
      query: async () => ({ rows: [] } as any),
    };

    const report = await reconcileOrphanedObjects(memoryStorage, mockDbPool, {
      gracePeriodMs: 15 * 60 * 1000,
    });

    // In-flight upload preserved
    expect(report.reconciled).not.toContain(inFlightKey);
    expect(memoryStorage.has(inFlightKey)).toBe(true);

    // Old orphan purged
    expect(report.reconciled).toContain(oldOrphanKey);
    expect(memoryStorage.has(oldOrphanKey)).toBe(false);
  });

  it("aborts reconciliation and deletes zero objects if pagination fails", async () => {
    const memoryStorage = new InMemoryStorageDriver();
    const pastDate = new Date(Date.now() - 30 * 60 * 1000);
    const keys = ["fail-test-1.pdf", "fail-test-2.pdf"];
    for (const k of keys) {
      await memoryStorage.upload(k, Buffer.from("%PDF-1.4\nTest\n%%EOF"), "application/pdf");
      memoryStorage.setCreatedAt(k, pastDate);
    }

    memoryStorage.simulateListError = new Error("Storage cluster list timeout");

    const mockDbPool = {
      query: async () => ({ rows: [] } as any),
    };

    const report = await reconcileOrphanedObjects(memoryStorage, mockDbPool, { gracePeriodMs: 0 });
    memoryStorage.simulateListError = null;

    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.reconciled.length).toBe(0);
    for (const k of keys) {
      expect(memoryStorage.has(k)).toBe(true);
    }
  });
});
