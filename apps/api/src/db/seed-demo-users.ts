import "../config.js";
import { pool } from "./pool.js";
import { hashPassword } from "../auth/argon2.js";

interface DemoAccount {
  email: string;
  password: string;
  role: "admin" | "owner" | "viewer";
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: "admin@trustvault.local",
    password: "AdminPassword123!",
    role: "admin",
  },
  {
    email: "owner@trustvault.local",
    password: "OwnerPassword123!",
    role: "owner",
  },
  {
    email: "viewer@trustvault.local",
    password: "ViewerPassword123!",
    role: "viewer",
  },
];

async function seed() {
  console.log("Seeding TrustVault demo accounts...");

  for (const account of DEMO_ACCOUNTS) {
    const passwordHash = await hashPassword(account.password);

    // Upsert demo user so it's idempotent
    const query = `
      INSERT INTO public.users (email, password_hash, role, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (lower(email))
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        status = 'active',
        updated_at = now()
      RETURNING id, email, role, status;
    `;

    const res = await pool.query(query, [account.email, passwordHash, account.role]);
    const user = res.rows[0];
    console.log(`✓ Seeded ${user.role.toUpperCase()}: ${user.email} (ID: ${user.id})`);
  }

  // Also seed a demo document owned by the owner user so overview has initial data
  const ownerRes = await pool.query("SELECT id FROM public.users WHERE lower(email) = 'owner@trustvault.local'");
  if (ownerRes.rows.length > 0) {
    const ownerId = ownerRes.rows[0].id;
    const docQuery = `
      INSERT INTO public.documents (owner_id, title, category, storage_key, mime_type, size_bytes)
      VALUES ($1, 'Q4 Security Audit & Compliance Plan.pdf', 'Security', 'demo-q4-security-audit.pdf', 'application/pdf', 1048576)
      ON CONFLICT (storage_key) DO NOTHING
      RETURNING id, title;
    `;
    const docRes = await pool.query(docQuery, [ownerId]);
    if (docRes.rows.length > 0) {
      console.log(`✓ Seeded sample document: "${docRes.rows[0].title}"`);
      // Grant read access to the viewer account
      const viewerRes = await pool.query("SELECT id FROM public.users WHERE lower(email) = 'viewer@trustvault.local'");
      if (viewerRes.rows.length > 0) {
        const viewerId = viewerRes.rows[0].id;
        await pool.query(
          `INSERT INTO public.document_grants (document_id, user_id, permission, granted_by)
           VALUES ($1, $2, 'read', $3)
           ON CONFLICT DO NOTHING;`,
          [docRes.rows[0].id, viewerId, ownerId]
        );
        console.log(`✓ Granted read access on sample document to viewer@trustvault.local`);
      }
    }
  }

  await pool.end();
  console.log("Demo accounts and sample data successfully seeded!");
}

seed().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
