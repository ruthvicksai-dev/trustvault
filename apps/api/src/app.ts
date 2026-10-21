import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config.js";
import { createSessionMiddleware } from "./auth/session.js";
import { validateOrigin } from "./auth/middleware.js";
import { authRouter } from "./auth/routes.js";
import "./auth/types.js";

export const app = express();

/* ── Proxy Trust ─────────────────────────────────────────────────────────── */
// Restrict proxy trust unless explicitly enabled for a known reverse proxy
if (env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
} else if (env.TRUST_PROXY && env.TRUST_PROXY !== "false") {
  app.set("trust proxy", env.TRUST_PROXY);
} else {
  app.set("trust proxy", false);
}

/* ── Security headers & CORS ─────────────────────────────────────────────── */

app.use(helmet());

const allowedOrigin = env.FRONTEND_ORIGIN;

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server or curl)
      if (!origin || origin === allowedOrigin) {
        callback(null, true);
      } else {
        // Disallow untrusted origins — do not set Access-Control-Allow-Origin
        callback(null, false);
      }
    },
    credentials: true,
  })
);

// Mitigate Cross-Site Request Forgery across state-changing requests
app.use(validateOrigin);

// Bounded request body size to mitigate payload denial-of-service
app.use(express.json({ limit: "1mb" }));

/* ── Session Management ─────────────────────────────────────────────────── */

app.use(createSessionMiddleware());

/* ── Routes ──────────────────────────────────────────────────────────────── */

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "trustvault-api",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRouter);

/* ── Fallback & error handling ───────────────────────────────────────────── */

// 404 for unmatched routes
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler — never leak database details or stack traces
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled server error:", err.message);
    res.status(500).json({
      error:
        env.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
    });
  }
);
