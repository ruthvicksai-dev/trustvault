# TrustVault — Security Policy, Operating Procedures & Responsibilities

This document defines the operational security guidelines, trust boundaries, secret management standards, database role hardening roadmap, and responsible vulnerability disclosure policy for TrustVault.

For the threat matrix, attack scenarios, and mitigated threat IDs, refer to [`THREATS.md`](file:///c:/Users/ruthv/Projects/trustvault/THREATS.md). For database Row Level Security (RLS) policies and constraints, refer to [`docs/DATABASE.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DATABASE.md).

---

## 1. Security Assumptions & System Boundaries

### Trust Boundaries
1. **Client / Browser (Untrusted):**
   - The React frontend runs in an untrusted execution environment.
   - Any client code, local storage, memory, or HTTP headers can be inspected or modified by the user or malicious browser extensions.
   - **Rule:** The server never relies on the client to perform authorization, validate file types, enforce role restrictions, or check grant validity.
2. **Reverse Proxy / Edge (Semi-Trusted):**
   - When deployed behind Railway, Vercel, or AWS Application Load Balancers, TLS is terminated at the edge.
   - The Express application relies on forwarded headers (`X-Forwarded-Proto`, `X-Forwarded-For`) only when `TRUST_PROXY=1` is explicitly configured for known infrastructure.
3. **Application Server (Trusted):**
   - The Node.js Express process holds application secrets (`SESSION_SECRET`, `SUPABASE_SECRET_KEY`).
   - All authorization decisions, session verifications, and file validations execute here.
4. **Authoritative Database & Storage (Trusted Infrastructure):**
   - PostgreSQL stores all relational state and access grants.
   - Supabase Storage holds private document binaries. Direct anonymous client access to the storage bucket is strictly prohibited.

---

## 2. Authentication & Authorization Responsibilities

### Authentication Pipeline
- **Password Hashing:** Passwords are hashed using Argon2id ($m=19\text{ MiB}, t=2, p=1$). The server never stores plaintext passwords or weak hashes.
- **Session Tracking:** Authenticated sessions are stored server-side in `public.sessions` with absolute timeouts (24 hours) and idle timeouts (8 hours).
- **Session Revocation:** On password change, all other active sessions for that user ID are purged from PostgreSQL.
- **Account Disablement:** Account state (`status = 'disabled'`) is checked against the database on every authenticated request. Disabling an account immediately revokes access without waiting for session expiration.

### Authorization Pipeline
- **Document Access:** Handled exclusively by `authorizeDocumentAccess()` in [`apps/api/src/documents/authorization.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts).
- **Anti-Enumeration Invariant:** If a user requests a document that does not exist, has been soft-deleted (`deleted_at IS NOT NULL`), or belongs to another user without an active grant, the server uniformly responds with `HTTP 404 Not Found`.

---

## 3. Database Role Separation & `BYPASSRLS` Hardening Roadmap

### Current Architecture
- The Express API connects via `DATABASE_URL` using the standard `postgres` role.
- In managed Supabase / PostgreSQL, `postgres` possesses the `BYPASSRLS` attribute.
- **Security Reality:** The Express API relies on its own robust, parameterized server-side authorization layer (`authorizeDocumentAccess`). PostgreSQL RLS serves as defense-in-depth against direct client access (PostgREST / Supabase client).

### Recommended Hardening for Multi-Tenant Hardened Deployments
To enforce database RLS even when queries originate from the backend API, the application connection should be transitioned to a dedicated, unprivileged PostgreSQL role:

```sql
-- Create dedicated application role without superuser or bypassrls privileges
CREATE ROLE trustvault_app WITH LOGIN PASSWORD 'strong_unique_app_password' NOSUPERUSER NOBYPASSRLS;

-- Grant required schema access
GRANT USAGE ON SCHEMA public TO trustvault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trustvault_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trustvault_app;

-- Ensure RLS is enforced for this role
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;
```

---

## 4. Private Storage Configuration & Requirements

1. **Bucket Configuration:**
   - The Supabase Storage bucket **`trustvault-private`** must be configured with `public: false`.
   - Never make this bucket public or configure permissive bucket policies for `anon` or `authenticated` roles.
2. **Access Mediation:**
   - Clients must **never** receive direct upload or download URLs to the storage bucket.
   - File uploads and downloads must stream exclusively through `/api/documents` and `/api/documents/:id/download`.
3. **Secret Isolation:**
   - `SUPABASE_SECRET_KEY` must only exist in server-side environment variables. It must never be prefixed with `VITE_` or exposed in frontend source code.

---

## 5. Secret Management & Production Data Handling

### Environment Variable Standards
- Never commit `.env` or `.env.test` files containing real credentials to version control.
- In CI/CD pipelines (e.g. GitHub Actions), secrets must be injected through repository secret settings.
- `SESSION_SECRET` must provide at least 32 characters of high-entropy randomness. The server crashes on startup in production if this requirement is not met.

### Production Data Protection
- Production database dumps must be encrypted at rest.
- When seeding test environments, use synthesized mock data. Never copy production customer documents or password hashes into development environments.

---

## 6. Pre-Flight Security Verification Checklist

Before releasing updates or deploying to production, verify:

- [ ] **Tests Pass:** `npm test` runs cleanly (209 passing tests, 0 failures).
- [ ] **Typecheck Passes:** `npm run typecheck` produces 0 errors.
- [ ] **Build Completes:** `npm run build` compiles clean production bundles.
- [ ] **Fail-Closed Test Guard:** `TEST_DATABASE_URL` strictly points to a database containing `test` in its name.
- [ ] **Storage Bucket Private:** `trustvault-private` bucket is verified as non-public in Supabase.
- [ ] **No Secrets in Frontend:** The `apps/web` bundle contains no instances of `SUPABASE_SECRET_KEY` or `DATABASE_URL`.
- [ ] **CSRF Protection:** State-changing requests validate `Origin` and `x-csrf-token`.
- [ ] **Cache Prevention:** Sensitive endpoints emit `Cache-Control: private, no-store`.

---

## 7. Responsible Vulnerability Disclosure

If you discover a potential security vulnerability in TrustVault, please report it responsibly:
- **Contact:** Open a private security advisory on GitHub or email the project maintainer.
- **Information to Include:**
  - Description of the vulnerability and attack vector.
  - Step-by-step reproduction instructions or proof-of-concept payload.
  - Potential impact assessment.
- **Coordination:** Please allow reasonable time for remediation before public disclosure.
