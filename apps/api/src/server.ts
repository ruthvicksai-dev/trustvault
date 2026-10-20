import { env } from "./config.js";
import { app } from "./app.js";

const PORT = env.PORT;

const server = app.listen(PORT, () => {
  console.log(`TrustVault API listening on port ${PORT}`);
});

/* Graceful shutdown -------------------------------------------------------- */

function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down…`);
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
  // Force exit after 5 s if connections linger
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
