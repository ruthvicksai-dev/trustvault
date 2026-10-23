import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config.js";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { recordAuditEvent } from "../audit/service.js";

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be configured on the server");
    }
    supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return supabaseClient;
}

/**
 * Generates an unguessable, cryptographically secure storage key.
 * Prevents path traversal and guarantees that clients cannot choose or predict keys.
 */
export function generateSecureStorageKey(extension: string): string {
  const uuid = crypto.randomUUID();
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `${uuid}.${safeExt}`;
}

export interface StorageObjectInfo {
  name: string;
  createdAt?: Date | null;
}

export interface StorageDriver {
  upload(storageKey: string, content: Buffer, mimeType: string): Promise<void>;
  download(storageKey: string): Promise<{ data: Buffer; mimeType?: string }>;
  delete(storageKey: string): Promise<void>;
  verifyBucket(): Promise<{ verified: boolean; isPrivate: boolean; error?: string }>;
  listObjects?(options?: { limit?: number; offset?: number }): Promise<StorageObjectInfo[]>;
  listKeys?(): Promise<string[]>;
}

/**
 * Supabase Storage Driver for production and integration use.
 * Keeps bucket strictly private; credentials remain exclusively on the server.
 */
export class SupabaseStorageDriver implements StorageDriver {
  private bucket: string;

  constructor(bucket: string = env.SUPABASE_STORAGE_BUCKET) {
    this.bucket = bucket;
  }

  async upload(storageKey: string, content: Buffer, mimeType: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage
      .from(this.bucket)
      .upload(storageKey, content, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Storage upload error: ${error.message}`);
    }
  }

  async download(storageKey: string): Promise<{ data: Buffer; mimeType?: string }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(this.bucket)
      .download(storageKey);

    if (error || !data) {
      throw new Error(`Storage download error: ${error?.message || "File not found"}`);
    }

    const arrayBuffer = await data.arrayBuffer();
    return {
      data: Buffer.from(arrayBuffer),
      mimeType: data.type,
    };
  }

  async delete(storageKey: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage
      .from(this.bucket)
      .remove([storageKey]);

    if (error) {
      throw new Error(`Storage delete error: ${error.message}`);
    }
  }

  async verifyBucket(): Promise<{ verified: boolean; isPrivate: boolean; error?: string }> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.storage.listBuckets();
      if (error) {
        return { verified: false, isPrivate: false, error: error.message };
      }
      const bucket = data.find((b) => b.name === this.bucket || b.id === this.bucket);
      if (!bucket) {
        return {
          verified: false,
          isPrivate: false,
          error: `Bucket '${this.bucket}' not found in Supabase project`,
        };
      }
      return {
        verified: true,
        isPrivate: bucket.public === false,
      };
    } catch (err: any) {
      return { verified: false, isPrivate: false, error: err?.message || "Verification failed" };
    }
  }

  async listObjects(options?: { limit?: number; offset?: number }): Promise<StorageObjectInfo[]> {
    const supabase = getSupabaseClient();
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const { data, error } = await supabase.storage.from(this.bucket).list("", {
      limit,
      offset,
      sortBy: { column: "created_at", order: "asc" },
    });
    if (error) {
      throw new Error(`Storage list error: ${error.message}`);
    }
    return (data || []).map((item) => {
      let createdAt: Date | null = null;
      if (item.created_at) {
        const d = new Date(item.created_at);
        if (!isNaN(d.getTime())) {
          createdAt = d;
        }
      }
      return {
        name: item.name,
        createdAt,
      };
    });
  }

  async listKeys(): Promise<string[]> {
    const objects = await this.listObjects({ limit: 100, offset: 0 });
    return objects.map((item) => item.name);
  }
}

/**
 * In-memory storage driver for rapid, isolated unit testing without external network dependencies.
 */
export class InMemoryStorageDriver implements StorageDriver {
  private store = new Map<string, { data: Buffer; mimeType: string; createdAt?: Date | null }>();
  public simulateUploadError: Error | null = null;
  public simulateDownloadError: Error | null = null;
  public simulateDeleteError: Error | null = null;
  public simulateListError: Error | null = null;

  async upload(storageKey: string, content: Buffer, mimeType: string): Promise<void> {
    if (this.simulateUploadError) {
      throw this.simulateUploadError;
    }
    this.store.set(storageKey, {
      data: Buffer.from(content),
      mimeType,
      createdAt: new Date(),
    });
  }

  setCreatedAt(storageKey: string, date: Date | null): void {
    const entry = this.store.get(storageKey);
    if (entry) {
      entry.createdAt = date;
    }
  }

  async download(storageKey: string): Promise<{ data: Buffer; mimeType?: string }> {
    if (this.simulateDownloadError) {
      throw this.simulateDownloadError;
    }
    const entry = this.store.get(storageKey);
    if (!entry) {
      throw new Error("Storage download error: File not found in storage");
    }
    return { data: entry.data, mimeType: entry.mimeType };
  }

  async delete(storageKey: string): Promise<void> {
    if (this.simulateDeleteError) {
      throw this.simulateDeleteError;
    }
    this.store.delete(storageKey);
  }

  async verifyBucket(): Promise<{ verified: boolean; isPrivate: boolean }> {
    return { verified: true, isPrivate: true };
  }

  async listObjects(options?: { limit?: number; offset?: number }): Promise<StorageObjectInfo[]> {
    if (this.simulateListError) {
      throw this.simulateListError;
    }
    const all = Array.from(this.store.entries()).map(([name, entry]) => ({
      name,
      createdAt: entry.createdAt ?? null,
    }));
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? all.length;
    return all.slice(offset, offset + limit);
  }

  async listKeys(): Promise<string[]> {
    const objects = await this.listObjects();
    return objects.map((item) => item.name);
  }

  has(storageKey: string): boolean {
    return this.store.has(storageKey);
  }

  clear(): void {
    this.store.clear();
    this.simulateUploadError = null;
    this.simulateDownloadError = null;
    this.simulateDeleteError = null;
    this.simulateListError = null;
  }
}

// Default driver: Always use InMemoryStorageDriver in test mode to guarantee zero remote storage calls
let currentDriver: StorageDriver = env.NODE_ENV === "test"
  ? new InMemoryStorageDriver()
  : new SupabaseStorageDriver();

export function setStorageDriver(driver: StorageDriver): void {
  currentDriver = driver;
}

export function getStorageDriver(): StorageDriver {
  return currentDriver;
}

export interface ReconcileOptions {
  batchSize?: number;
  gracePeriodMs?: number;
  maxScanned?: number;
}

/**
 * Durable reconciliation mechanism for orphaned storage objects.
 * Safely iterates all pages using pagination, accounts for in-flight uploads with a grace period,
 * and ensures that listing/pagination failures abort without triggering destructive deletions.
 *
 * Guarantees and Invariants:
 * 1. Safe pagination: Collects objects across pages; if any page fails, reconciliation aborts immediately with 0 deletions.
 * 2. In-flight race mitigation: Any object younger than gracePeriodMs (default 15 minutes) is preserved.
 * 3. Indeterminate age preservation: Any object with unknown, null, or invalid createdAt is skipped during deletion.
 * 4. Scan budget control: Each request is bounded to remaining budget, and truncation is explicitly recorded if budget is exhausted.
 * 5. Idempotent & non-destructive: Pre-checks database before deleting; deletes only unreferenced orphans.
 */
export async function reconcileOrphanedObjects(
  driver: StorageDriver = getStorageDriver(),
  dbPool: Pick<typeof pool, "query"> = pool,
  options: ReconcileOptions = {}
): Promise<{ scanned: number; reconciled: string[]; errors: string[] }> {
  const result = {
    scanned: 0,
    reconciled: [] as string[],
    errors: [] as string[],
  };

  if (!driver.listObjects && !driver.listKeys) {
    return result;
  }

  const batchSize = options.batchSize ?? 100;
  const gracePeriodMs = options.gracePeriodMs ?? 15 * 60 * 1000; // 15-minute default grace period
  const maxScanned = options.maxScanned ?? 10000;
  const now = Date.now();

  // Phase 1: Retrieve candidate objects across pages bounded by maxScanned budget safely.
  // If any page retrieval fails, we abort without deleting any objects.
  const allObjects: StorageObjectInfo[] = [];
  let offset = 0;
  let reachedEnd = false;

  try {
    while (allObjects.length < maxScanned) {
      const remainingBudget = maxScanned - allObjects.length;
      const requestLimit = Math.min(batchSize, remainingBudget);

      let page: StorageObjectInfo[];
      if (driver.listObjects) {
        page = await driver.listObjects({ limit: requestLimit, offset });

        if (page.length === 0) {
          reachedEnd = true;
          break;
        }

        const remaining = maxScanned - allObjects.length;
        const itemsToAppend = page.slice(0, remaining);
        allObjects.push(...itemsToAppend);

        offset += page.length;
      } else {
        const rawKeys = await driver.listKeys!();
        const remaining = maxScanned - allObjects.length;
        const keysToAppend = rawKeys.slice(0, remaining);
        page = keysToAppend.map((k) => ({ name: k, createdAt: null }));

        allObjects.push(...page);

        if (rawKeys.length > remaining) {
          reachedEnd = false;
        } else {
          reachedEnd = true;
        }
        break;
      }
    }

    // Record truncation if scan budget was exhausted before reaching the end of the listing
    if (!reachedEnd && allObjects.length >= maxScanned) {
      const truncationNotice = `Scan budget exhausted (${maxScanned} objects scanned). Reconciliation inventory may be truncated; additional reconciliation cycles required.`;
      result.errors.push(truncationNotice);
      console.warn(truncationNotice);
    }
  } catch (listErr: any) {
    // ABORT: Failed inventory operation must NEVER trigger deletions
    const errMsg = `Inventory retrieval failed during pagination at offset ${offset}: ${listErr?.message || listErr}`;
    result.errors.push(errMsg);
    console.error(errMsg);
    return result;
  }

  result.scanned = allObjects.length;

  // Phase 2: Check each candidate object against grace period and database
  for (const obj of allObjects) {
    try {
      // Review Comment Fix: If createdAt is missing, null, or invalid, we cannot verify its age.
      // Preserve the object during destructive reconciliation to prevent deleting in-flight or indeterminate uploads.
      if (!obj.createdAt || isNaN(obj.createdAt.getTime())) {
        continue;
      }

      // Finding B: Prevent reconciliation races.
      // Do NOT delete objects created within the grace period (in-flight uploads).
      const objectAgeMs = now - obj.createdAt.getTime();
      if (objectAgeMs < gracePeriodMs) {
        continue; // In-flight upload grace window; preserve object
      }

      // Check PostgreSQL: Is this key associated with any document record?
      const dbRes = await dbPool.query(
        "SELECT id FROM public.documents WHERE storage_key = $1",
        [obj.name]
      );

      if (dbRes.rows.length === 0) {
        // Orphan detected: no document record references this key
        await driver.delete(obj.name);
        result.reconciled.push(obj.name);

        await recordAuditEvent({
          action: "reconcile_orphan_deleted",
          outcome: "success",
          metadata: { storageKey: obj.name, ageMs: objectAgeMs },
          client: dbPool,
        });
      }
    } catch (err: any) {
      result.errors.push(`Failed to reconcile key ${obj.name}: ${err?.message || err}`);
    }
  }

  return result;
}
