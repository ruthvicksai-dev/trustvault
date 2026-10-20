import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config.js";

export const app = express();

/* ── Security middleware ─────────────────────────────────────────────────── */

app.use(helmet());

const allowedOrigin = env.FRONTEND_ORIGIN;

app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

/* ── Routes ──────────────────────────────────────────────────────────────── */

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "trustvault-api",
    timestamp: new Date().toISOString(),
  });
});

/* ── Fallback & error handling ───────────────────────────────────────────── */

// 404 for unmatched routes
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler — never leak secrets or stack traces in production
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err.message);
    res.status(500).json({
      error:
        env.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
    });
  }
);
