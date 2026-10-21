import {
  hash as argon2Hash,
  verify as argon2Verify,
  parseOptions,
  Algorithm,
  type Options as ArgonOptions,
} from "@node-rs/argon2";

/**
 * Password Policy Constants
 * Based on NIST SP 800-63B guidance:
 * - Minimum length: 12 characters to ensure sufficient entropy.
 * - Maximum length: 128 characters to mitigate denial-of-service via oversized inputs.
 * - Unicode and spaces are permitted without truncation.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Reviewed Argon2id Parameters
 *
 * Conforms to OWASP Password Storage Cheat Sheet recommendations for Argon2id:
 * - Algorithm: Argon2id (hybrid resistant to both side-channel and GPU TMTO attacks)
 * - Memory cost: 19,456 KiB (19 MiB)
 * - Time cost: 2 passes / iterations
 * - Parallelism: 1 thread
 * - Output length: 32 bytes
 *
 * Benchmarking Guide:
 * To benchmark on a target production host:
 * ```ts
 * const t0 = performance.now();
 * await hashPassword("benchmark-sample-password-1234");
 * const durationMs = performance.now() - t0;
 * console.log(`Argon2id duration: ${durationMs.toFixed(2)}ms`);
 * ```
 * Recommended target: 200ms – 500ms on the production CPU. If dedicated server memory allows,
 * memoryCost can be scaled up to 65,536 KiB (64 MiB) with 3 iterations.
 */
export const ARGON2_CONFIG: Readonly<ArgonOptions> = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

/**
 * Concurrency limiter for password hashing operations to prevent CPU/memory exhaustion DoS.
 */
class HashConcurrencyLimiter {
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      throw new Error("RATE_LIMIT_CONCURRENCY: Server busy processing authentication requests");
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
}

const concurrencyLimiter = new HashConcurrencyLimiter(10);

/**
 * Pre-generated dummy Argon2id hash for constant-work dummy verification.
 * Used when an account does not exist or is disabled, mitigating username enumeration
 * via timing discrepancies.
 * Note: Network latency and CPU jitter mean execution time is not mathematically constant,
 * but this eliminates the coarse ~50-100ms timing differential of skipping Argon2id.
 */
export const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$4VwHOD8aQe7p0h9oI7yYqw$bA1O9XJ7hP2m8W3q6V5u4T1s0R9q8P7o6N5m4L3k2J1";

/**
 * Validate password string length and basic validity before invoking expensive hashing.
 */
export function validatePasswordInput(password: unknown): { valid: boolean; error?: string } {
  if (typeof password !== "string") {
    return { valid: false, error: "Password must be a string" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`,
    };
  }
  return { valid: true };
}

/**
 * Hashes a plaintext password using Argon2id with bounded concurrency.
 */
export async function hashPassword(password: string): Promise<string> {
  const check = validatePasswordInput(password);
  if (!check.valid) {
    throw new Error(check.error);
  }

  return concurrencyLimiter.run(async () => {
    return argon2Hash(password, ARGON2_CONFIG);
  });
}

/**
 * Safely verifies a plaintext password against a stored Argon2 hash.
 * Handles corrupt, missing, or malformed hashes safely without throwing.
 */
export async function verifyPassword(storedHash: string, passwordAttempt: string): Promise<boolean> {
  if (
    !storedHash ||
    typeof storedHash !== "string" ||
    !storedHash.startsWith("$argon2") ||
    typeof passwordAttempt !== "string" ||
    passwordAttempt.length > MAX_PASSWORD_LENGTH
  ) {
    return false;
  }

  return concurrencyLimiter.run(async () => {
    try {
      return await argon2Verify(storedHash, passwordAttempt);
    } catch {
      // Safe failure: any malformed/unsupported hash format fails gracefully
      return false;
    }
  });
}

/**
 * Checks whether an existing hash was computed with older/weaker parameters
 * and should be upgraded during login.
 */
export function checkNeedsRehash(storedHash: string): boolean {
  try {
    const parsed = parseOptions(storedHash);
    return (
      parsed.algorithm !== Algorithm.Argon2id ||
      parsed.memoryCost < (ARGON2_CONFIG.memoryCost ?? 19456) ||
      parsed.timeCost < (ARGON2_CONFIG.timeCost ?? 2)
    );
  } catch {
    return true;
  }
}
