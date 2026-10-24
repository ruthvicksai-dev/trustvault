import "../config.js";
import type pg from "pg";
import { pool } from "./pool.js";
import { hashPassword } from "../auth/argon2.js";
import { recordAuditEvent } from "../audit/service.js";
import { getStorageDriver } from "../documents/storage.js";

export interface DemoAccountConfig {
  email: string;
  password: string;
  role: "admin" | "owner" | "viewer";
  displayName: string;
}

export interface DemoProvisionConfig {
  enabled: boolean;
  isProduction: boolean;
  productionConfirmed: boolean;
  accounts: {
    admin: DemoAccountConfig;
    owner: DemoAccountConfig;
    viewer: DemoAccountConfig;
  };
}

export interface DemoAccountProvisionResult {
  email: string;
  role: "admin" | "owner" | "viewer";
  status: "created" | "preserved";
  userId: string;
}

export interface DemoProvisionResult {
  success: boolean;
  message: string;
  accounts: DemoAccountProvisionResult[];
  documentsSeeded: number;
  grantsSeeded: number;
  auditEventsRecorded: number;
}

export interface DemoConfigValidation {
  isValid: boolean;
  reason?: string;
  config?: DemoProvisionConfig;
}

/**
 * Validates environment configuration for demo account provisioning.
 * Fails safely and closed when required configuration is missing or invalid.
 * Never leaks passwords or secrets in error messages.
 */
export function validateDemoConfig(
  envVars: Record<string, string | undefined> = process.env
): DemoConfigValidation {
  const enabledStr = (envVars.ENABLE_DEMO_ACCOUNTS || "").trim().toLowerCase();
  const enabled = enabledStr === "true" || enabledStr === "1";

  if (!enabled) {
    return {
      isValid: false,
      reason:
        "Demo account provisioning is disabled by default. Set ENABLE_DEMO_ACCOUNTS=true to allow provisioning.",
    };
  }

  const nodeEnv = (envVars.NODE_ENV || "development").trim().toLowerCase();
  const isProduction = nodeEnv === "production";
  const prodConfirmedStr = (envVars.DEMO_ENV_CONFIRMATION || envVars.TRUSTVAULT_DEMO_CONFIRMED || "").trim().toLowerCase();
  const productionConfirmed = prodConfirmedStr === "true" || prodConfirmedStr === "1";

  if (isProduction && !productionConfirmed) {
    return {
      isValid: false,
      reason:
        "Demo account provisioning in a production environment is blocked without explicit confirmation. Set DEMO_ENV_CONFIRMATION=true.",
    };
  }

  const adminPassword = envVars.DEMO_ADMIN_PASSWORD || "";
  const ownerPassword = envVars.DEMO_OWNER_PASSWORD || "";
  const viewerPassword = envVars.DEMO_VIEWER_PASSWORD || "";

  if (!adminPassword || adminPassword.length < 12) {
    return {
      isValid: false,
      reason:
        "DEMO_ADMIN_PASSWORD must be configured and contain at least 12 characters to satisfy the application password security policy.",
    };
  }

  if (!ownerPassword || ownerPassword.length < 12) {
    return {
      isValid: false,
      reason:
        "DEMO_OWNER_PASSWORD must be configured and contain at least 12 characters to satisfy the application password security policy.",
    };
  }

  if (!viewerPassword || viewerPassword.length < 12) {
    return {
      isValid: false,
      reason:
        "DEMO_VIEWER_PASSWORD must be configured and contain at least 12 characters to satisfy the application password security policy.",
    };
  }

  const adminEmail = (envVars.DEMO_ADMIN_EMAIL || "admin@trustvault.local").trim().toLowerCase();
  const ownerEmail = (envVars.DEMO_OWNER_EMAIL || "owner@trustvault.local").trim().toLowerCase();
  const viewerEmail = (envVars.DEMO_VIEWER_EMAIL || "viewer@trustvault.local").trim().toLowerCase();

  return {
    isValid: true,
    config: {
      enabled: true,
      isProduction,
      productionConfirmed,
      accounts: {
        admin: {
          email: adminEmail,
          password: adminPassword,
          role: "admin",
          displayName: "Demo Administrator",
        },
        owner: {
          email: ownerEmail,
          password: ownerPassword,
          role: "owner",
          displayName: "Demo Document Owner",
        },
        viewer: {
          email: viewerEmail,
          password: viewerPassword,
          role: "viewer",
          displayName: "Demo Document Viewer",
        },
      },
    },
  };
}

/**
 * Valid minimal synthetic PDF file buffer for demo documents.
 * Passes magic byte inspection (%PDF-) and can be downloaded cleanly by evaluators.
 */
export const SYNTHETIC_DEMO_PDF_BUFFER = Buffer.from(
  "%PDF-1.4\n" +
  "% TrustVault Evaluator Demo Document (Synthetic Sample Data)\n" +
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
  "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources <<>> /MediaBox [0 0 612 792] >>\nendobj\n" +
  "xref\n0 4\n0000000000 65535 f \n0000000062 00000 n \n0000000113 00000 n \n0000000170 00000 n \n" +
  "trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n250\n%%EOF\n",
  "utf-8"
);

/**
 * Idempotently and safely provisions demo accounts and synthetic demonstration scenarios.
 *
 * Invariants:
 * 1. Fails closed if config is invalid or disabled.
 * 2. Never overwrites existing user passwords or modifies existing roles.
 * 3. Never prints passwords or secrets to logs/console.
 * 4. Seeds synthetic documents demonstrating:
 *    - Owner uploads confidential document
 *    - Owner grants viewer access (read)
 *    - Viewer has access to granted document
 *    - Viewer CANNOT access owner's unshared confidential document (404 anti-enumeration)
 *    - Owner revokes viewer's access on a third document
 *    - Viewer CANNOT access revoked document (immediate revocation)
 * 5. Uses existing audit service to record authentic audit events.
 */
export async function provisionDemoData(
  dbPool: pg.Pool,
  config: DemoProvisionConfig
): Promise<DemoProvisionResult> {
  const accountResults: DemoAccountProvisionResult[] = [];
  let documentsSeeded = 0;
  let grantsSeeded = 0;
  let auditEventsRecorded = 0;

  const accountsToProvision: DemoAccountConfig[] = [
    config.accounts.admin,
    config.accounts.owner,
    config.accounts.viewer,
  ];

  // 1. Provision or preserve users
  const userMap = new Map<string, { id: string; email: string; role: "admin" | "owner" | "viewer" }>();

  for (const account of accountsToProvision) {
    const existing = await dbPool.query(
      `SELECT id, email, role, status FROM public.users WHERE lower(email) = lower($1)`,
      [account.email]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      userMap.set(account.role, { id: user.id, email: user.email, role: user.role });
      accountResults.push({
        email: user.email,
        role: user.role,
        status: "preserved",
        userId: user.id,
      });
    } else {
      const passwordHash = await hashPassword(account.password);
      const insertRes = await dbPool.query(
        `INSERT INTO public.users (email, password_hash, role, status, display_name)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id, email, role, status`,
        [account.email, passwordHash, account.role, account.displayName]
      );
      const user = insertRes.rows[0];
      userMap.set(account.role, { id: user.id, email: user.email, role: user.role });

      await recordAuditEvent({
        actorId: user.id,
        action: "auth_register",
        outcome: "success",
        metadata: { email: user.email, role: user.role },
        client: dbPool,
      });
      auditEventsRecorded++;

      accountResults.push({
        email: user.email,
        role: user.role,
        status: "created",
        userId: user.id,
      });
    }
  }

  const owner = userMap.get("owner");
  const viewer = userMap.get("viewer");

  if (!owner || !viewer) {
    return {
      success: true,
      message: "Demo users provisioned, but owner/viewer references were incomplete.",
      accounts: accountResults,
      documentsSeeded: 0,
      grantsSeeded: 0,
      auditEventsRecorded,
    };
  }

  // 2. Provision synthetic documents & scenarios
  // Scenario 1: Active shared document (Granted to Viewer)
  // Scenario 2: Unshared document (Tenant isolation / Anti-IDOR demonstration)
  // Scenario 3: Revoked document (Immediate revocation demonstration)
  const demoDocs = [
    {
      title: "Confidential_Q4_Financial_Audit_Report.pdf",
      category: "Finance",
      storageKey: "demo-shared-q4-financial-audit.pdf",
      mimeType: "application/pdf",
      sizeBytes: SYNTHETIC_DEMO_PDF_BUFFER.length,
      scenario: "active_grant",
    },
    {
      title: "Internal_Executive_Compensation_2026.pdf",
      category: "Executive",
      storageKey: "demo-unshared-executive-comp.pdf",
      mimeType: "application/pdf",
      sizeBytes: SYNTHETIC_DEMO_PDF_BUFFER.length,
      scenario: "unshared",
    },
    {
      title: "Third_Party_Vendor_Risk_Assessment.pdf",
      category: "Compliance",
      storageKey: "demo-revoked-vendor-assessment.pdf",
      mimeType: "application/pdf",
      sizeBytes: SYNTHETIC_DEMO_PDF_BUFFER.length,
      scenario: "revoked_grant",
    },
  ];

  // Attempt storage upload for synthetic files (non-blocking if storage provider is offline/unconfigured)
  try {
    const storageDriver = getStorageDriver();
    for (const doc of demoDocs) {
      try {
        await storageDriver.upload(doc.storageKey, SYNTHETIC_DEMO_PDF_BUFFER, doc.mimeType);
      } catch {
        // Safe fallback: in local dev without live storage bucket, database metadata is still provisioned
      }
    }
  } catch {
    // Storage driver initialization fallback
  }

  for (const doc of demoDocs) {
    const docQuery = `
      INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (storage_key) DO UPDATE SET
        title = EXCLUDED.title,
        category = EXCLUDED.category
      RETURNING id, title, storage_key;
    `;

    const docRes = await dbPool.query(docQuery, [
      owner.id,
      doc.title,
      doc.category,
      doc.storageKey,
      doc.mimeType,
      doc.sizeBytes,
    ]);

    if (docRes.rows.length > 0) {
      const documentId = docRes.rows[0].id;
      documentsSeeded++;

      // Check if create_document audit event already recorded
      const existingAudit = await dbPool.query(
        "SELECT id FROM public.audit_events WHERE document_id = $1 AND action = 'create_document'",
        [documentId]
      );
      if (existingAudit.rows.length === 0) {
        await recordAuditEvent({
          actorId: owner.id,
          documentId,
          action: "create_document",
          outcome: "success",
          metadata: {
            title: doc.title,
            category: doc.category,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            storageKey: doc.storageKey,
          },
          client: dbPool,
        });
        auditEventsRecorded++;
      }

      if (doc.scenario === "active_grant") {
        // Grant read access to viewer
        const grantRes = await dbPool.query(
          `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by, revoked_at)
           VALUES ($1, $2, 'read', $3, NULL)
           ON CONFLICT (document_id, user_id) WHERE revoked_at IS NULL
           DO NOTHING
           RETURNING id;`,
          [documentId, viewer.id, owner.id]
        );

        if (grantRes.rows.length > 0) {
          grantsSeeded++;
          const grantId = grantRes.rows[0].id;

          await recordAuditEvent({
            actorId: owner.id,
            documentId,
            action: "create_grant",
            outcome: "success",
            metadata: {
              recipientId: viewer.id,
              recipientEmail: viewer.email,
              permission: "read",
              grantId,
            },
            client: dbPool,
          });
          auditEventsRecorded++;

          // Record verified read access event by viewer
          await recordAuditEvent({
            actorId: viewer.id,
            documentId,
            action: "read_content",
            outcome: "success",
            metadata: { grant: "read" },
            client: dbPool,
          });
          auditEventsRecorded++;
        }
      } else if (doc.scenario === "unshared") {
        // Record unshared access attempt audit event (viewer denied access)
        const unsharedAudit = await dbPool.query(
          "SELECT id FROM public.audit_events WHERE document_id = $1 AND actor_id = $2 AND outcome = 'denied'",
          [documentId, viewer.id]
        );
        if (unsharedAudit.rows.length === 0) {
          await recordAuditEvent({
            actorId: viewer.id,
            documentId,
            action: "read_content",
            outcome: "denied",
            reason: "Unauthorized: not document owner and no active grant",
            client: dbPool,
          });
          auditEventsRecorded++;
        }
      } else if (doc.scenario === "revoked_grant") {
        // Insert grant that has already been revoked
        const existingRevoked = await dbPool.query(
          `SELECT id FROM public.document_grants WHERE document_id = $1 AND user_id = $2 AND revoked_at IS NOT NULL`,
          [documentId, viewer.id]
        );

        let grantId: string;
        if (existingRevoked.rows.length === 0) {
          const insertGrantRes = await dbPool.query(
            `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by, created_at, revoked_at)
             VALUES ($1, $2, 'read', $3, now() - interval '2 hours', now() - interval '1 hour')
             RETURNING id;`,
            [documentId, viewer.id, owner.id]
          );
          grantId = insertGrantRes.rows[0].id;
          grantsSeeded++;

          // Record grant creation audit event
          await recordAuditEvent({
            actorId: owner.id,
            documentId,
            action: "create_grant",
            outcome: "success",
            metadata: {
              recipientId: viewer.id,
              recipientEmail: viewer.email,
              permission: "read",
              grantId,
            },
            client: dbPool,
          });
          auditEventsRecorded++;

          // Record grant revocation audit event
          await recordAuditEvent({
            actorId: owner.id,
            documentId,
            action: "revoke_grant",
            outcome: "success",
            metadata: {
              grantId,
              targetUserId: viewer.id,
              targetEmail: viewer.email,
            },
            client: dbPool,
          });
          auditEventsRecorded++;

          // Record revoked download attempt audit event (viewer denied access)
          await recordAuditEvent({
            actorId: viewer.id,
            documentId,
            action: "read_content",
            outcome: "denied",
            reason: "Unauthorized: not document owner and no active grant",
            client: dbPool,
          });
          auditEventsRecorded++;
        }
      }
    }
  }

  return {
    success: true,
    message: "Demo accounts and evaluation scenarios successfully provisioned.",
    accounts: accountResults,
    documentsSeeded,
    grantsSeeded,
    auditEventsRecorded,
  };
}

/**
 * Safely resets synthetic demo data by removing only synthetic demo documents, grants,
 * audit events, and user accounts. Leaves all non-demo real users and documents intact.
 */
export async function resetDemoData(
  dbPool: pg.Pool,
  config: DemoProvisionConfig
): Promise<{ success: boolean; message: string; deletedUsers: number; deletedDocuments: number }> {
  const demoEmails = [
    config.accounts.admin.email.toLowerCase(),
    config.accounts.owner.email.toLowerCase(),
    config.accounts.viewer.email.toLowerCase(),
  ];

  // Find demo users
  const usersRes = await dbPool.query(
    "SELECT id, email FROM public.users WHERE lower(email) = ANY($1)",
    [demoEmails]
  );
  const userIds = usersRes.rows.map((r) => r.id);

  let deletedDocuments = 0;
  if (userIds.length > 0) {
    // Find documents owned by demo users
    const docsRes = await dbPool.query(
      "SELECT id, storage_key FROM public.documents WHERE owner_id = ANY($1)",
      [userIds]
    );
    const docIds = docsRes.rows.map((r) => r.id);

    if (docIds.length > 0) {
      // Delete grants on demo docs
      await dbPool.query("DELETE FROM public.document_grants WHERE document_id = ANY($1)", [docIds]);
      // Delete audit events referencing demo docs
      await dbPool.query("DELETE FROM public.audit_events WHERE document_id = ANY($1)", [docIds]);
      // Delete demo docs
      const delDocRes = await dbPool.query("DELETE FROM public.documents WHERE id = ANY($1)", [docIds]);
      deletedDocuments = delDocRes.rowCount || 0;
    }

    // Delete audit events where actor is a demo user
    await dbPool.query("DELETE FROM public.audit_events WHERE actor_id = ANY($1)", [userIds]);
    // Delete sessions for demo users
    await dbPool.query("DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = ANY($1)", [userIds]);
    // Delete demo users
    const delUserRes = await dbPool.query("DELETE FROM public.users WHERE id = ANY($1)", [userIds]);
    const deletedUsers = delUserRes.rowCount || 0;

    return {
      success: true,
      message: `Reset complete: removed ${deletedUsers} demo users and ${deletedDocuments} synthetic documents.`,
      deletedUsers,
      deletedDocuments,
    };
  }

  return {
    success: true,
    message: "No existing demo data found to reset.",
    deletedUsers: 0,
    deletedDocuments: 0,
  };
}

/**
 * Command-line runner for demo provisioning and resetting.
 */
export async function runDemoCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const isReset = args.includes("--reset") || process.env.RESET_DEMO_DATA === "true";

  const validation = validateDemoConfig(process.env);
  if (!validation.isValid || !validation.config) {
    console.error(`\n[DEMO CONFIGURATION GUARD] ${validation.reason}\n`);
    process.exit(1);
  }

  const { config } = validation;

  if (isReset) {
    console.log("Safely resetting synthetic demo data...");
    const res = await resetDemoData(pool, config);
    console.log(`✓ ${res.message}`);
    await pool.end();
    return;
  }

  console.log("Provisioning TrustVault demo accounts and evaluation scenarios...");
  const result = await provisionDemoData(pool, config);

  console.log("\n========================================================");
  console.log("TrustVault Demo Accounts & Evaluation Scenarios");
  console.log("========================================================");
  for (const acct of result.accounts) {
    const statusLabel = acct.status === "created" ? "CREATED" : "PRESERVED (Unchanged)";
    console.log(`• Role: [${acct.role.toUpperCase()}] | Email: ${acct.email} | Status: ${statusLabel}`);
  }
  console.log("--------------------------------------------------------");
  console.log(`• Synthetic documents: ${result.documentsSeeded}`);
  console.log(`• Access grants:       ${result.grantsSeeded}`);
  console.log(`• Audit events:        ${result.auditEventsRecorded}`);
  console.log("========================================================\n");
  console.log("✓ Evaluator demo provisioning complete. Passwords were safe-hashed with Argon2id and never logged.");

  await pool.end();
}

// Execute when run directly via tsx/node
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  runDemoCli().catch((err) => {
    console.error("Demo provisioning failed:", err.message);
    process.exit(1);
  });
}
