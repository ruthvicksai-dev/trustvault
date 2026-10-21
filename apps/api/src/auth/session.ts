import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { env } from "../config.js";

const PgSession = connectPgSimple(session);

export function createSessionMiddleware(pool: Pool = defaultPool) {
  const isProd = env.NODE_ENV === "production";

  // RFC 6265bis: __Host- prefix requires Secure, path=/, and NO domain attribute
  const cookieName = isProd ? "__Host-trustvault.sid" : "trustvault.sid";

  const store = new PgSession({
    pool,
    tableName: "sessions",
    schemaName: "public",
    createTableIfMissing: false, // Schema is strictly managed via migrations
    pruneSessionInterval: 60 * 15, // Periodically clean up expired sessions (every 15 min)
  });

  // Log store errors gracefully
  store.on("error", (err) => {
    console.error("PostgreSQL Session Store error:", err.message);
  });

  return session({
    store,
    name: cookieName,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Idle expiration: resets cookie maxAge on active requests
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000, // 8-hour idle session timeout
    },
  });
}
