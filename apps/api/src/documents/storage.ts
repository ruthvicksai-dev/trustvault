import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config.js";
import crypto from "node:crypto";

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
export function generateSecureStorageKey(mimeType: string): string {
  const uuid = crypto.randomUUID();
  const safeExt = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  return `${uuid}.${safeExt}`;
}

export interface StorageDriver {
  upload(storageKey: string, content: Buffer, mimeType: string): Promise<void>;
  download(storageKey: string): Promise<{ data: Buffer; mimeType?: string }>;
  delete(storageKey: string): Promise<void>;
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
}

/**
 * In-memory storage driver for rapid, isolated unit testing without external network dependencies.
 */
export class InMemoryStorageDriver implements StorageDriver {
  private store = new Map<string, { data: Buffer; mimeType: string }>();

  async upload(storageKey: string, content: Buffer, mimeType: string): Promise<void> {
    this.store.set(storageKey, { data: Buffer.from(content), mimeType });
  }

  async download(storageKey: string): Promise<{ data: Buffer; mimeType?: string }> {
    const entry = this.store.get(storageKey);
    if (!entry) {
      throw new Error("Storage download error: File not found in storage");
    }
    return { data: entry.data, mimeType: entry.mimeType };
  }

  async delete(storageKey: string): Promise<void> {
    this.store.delete(storageKey);
  }

  clear(): void {
    this.store.clear();
  }
}

// Default driver uses Supabase in production and development, or can be overridden in tests
let currentDriver: StorageDriver = new SupabaseStorageDriver();

export function setStorageDriver(driver: StorageDriver): void {
  currentDriver = driver;
}

export function getStorageDriver(): StorageDriver {
  return currentDriver;
}
