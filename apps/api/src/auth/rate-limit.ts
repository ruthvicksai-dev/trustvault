import { rateLimit } from "express-rate-limit";

/**
 * Rate Limiting Configuration
 *
 * Defense-in-depth against credential stuffing, brute force, and password spraying.
 *
 * Architecture note for production multi-instance deployments:
 * When running multiple API instances behind a load balancer, replace the default
 * MemoryStore with a shared distributed store (such as `rate-limit-redis` with Redis,
 * or a PostgreSQL-backed store) to share rate-limiting state across nodes.
 */

const isTest = process.env.NODE_ENV === "test";

// Stricter rate limiting for login to mitigate brute force & credential stuffing
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // Max 10 attempts per IP per 15 minutes
  standardHeaders: "draft-7",
  legacyHeaders: false,
  statusCode: 429,
  message: {
    error: "Too many login attempts. Please try again later.",
  },
  skip: (req) => isTest && req.headers["x-enforce-rate-limit"] !== "true",
});

// Registration rate limiting to mitigate account creation spam
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // Max 5 registrations per IP per hour
  standardHeaders: "draft-7",
  legacyHeaders: false,
  statusCode: 429,
  message: {
    error: "Too many accounts created from this IP. Please try again later.",
  },
  skip: (req) => isTest && req.headers["x-enforce-rate-limit"] !== "true",
});

// General auth endpoint protection
export const generalAuthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  statusCode: 429,
  message: {
    error: "Too many requests. Please slow down.",
  },
  skip: (req) => isTest && req.headers["x-enforce-rate-limit"] !== "true",
});
