import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";

const isTest = process.env.NODE_ENV === "test";

function shouldSkip(req: Request): boolean {
  if (isTest && !req.headers["x-enforce-rate-limit"]) {
    return true;
  }
  return false;
}

/**
 * Rate limiter for document uploads: 20 uploads per 15 minutes per IP.
 */
export const documentUploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Upload rate limit exceeded. Please wait before uploading more documents.",
  },
  skip: shouldSkip,
});

/**
 * Rate limiter for document downloads: 100 downloads per 15 minutes per IP.
 */
export const documentDownloadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Download rate limit exceeded. Please wait before downloading more documents.",
  },
  skip: shouldSkip,
});

/**
 * Bounded concurrency limiter for upload processing.
 * Limits concurrent file processing to 10 active tasks to prevent CPU/memory exhaustion.
 */
let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 10;

export function acquireUploadSlot(): boolean {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return false;
  }
  activeUploads++;
  return true;
}

export function releaseUploadSlot(): void {
  activeUploads = Math.max(0, activeUploads - 1);
}

export function uploadConcurrencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!acquireUploadSlot()) {
    res.status(429).json({
      error: "Server busy processing uploads. Please retry shortly.",
    });
    return;
  }

  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseUploadSlot();
    }
  };

  res.on("finish", release);
  res.on("close", release);
  res.on("error", release);

  next();
}
