/**
 * TrustVault — Demo Accounts & Evaluation Provisioning Runner
 *
 * Safe wrapper delegating to provision-demo.ts.
 * Supports default evaluation credentials when environment variables are not explicitly set.
 */
import { runDemoCli } from "./provision-demo.js";

// Provide standard evaluation demo credentials by default for zero-friction evaluator access
process.env.ENABLE_DEMO_ACCOUNTS = process.env.ENABLE_DEMO_ACCOUNTS ?? "true";
process.env.DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? "AdminDemo2026!";
process.env.DEMO_OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? "OwnerDemo2026!";
process.env.DEMO_VIEWER_PASSWORD = process.env.DEMO_VIEWER_PASSWORD ?? "ViewerDemo2026!";

runDemoCli().catch((err) => {
  console.error("Demo seeding failed:", err.message);
  process.exit(1);
});
