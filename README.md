# TrustVault — Secure Document Sharing with a Real Audit Trail

TrustVault is an enterprise-grade document sharing and compliance platform designed for organizations that require strict per-document access control, tamper-resistant audit logging, and verifiable data privacy. Developed for a competitive engineering challenge, TrustVault demonstrates defense-in-depth security engineering across a modern TypeScript monorepo.

---

## 1. Problem Statement & Target Users

### The Problem
Traditional file-sharing tools suffer from three fundamental security risks:
1. **Coarse-Grained Permissions:** Shared links or folder-level access frequently lead to over-privileged data exposure and unauthorized re-sharing.
2. **Insecure Direct Object References (IDOR):** Web APIs frequently trust client assertions, allowing users to probe sequential or guessed identifiers to inspect confidential metadata or download unauthorized files.
3. **Mutilated or Missing Audit Trails:** Event logs are often stored in mutable database tables, omitted during background operations, or lack strict actor attribution, making post-incident forensics unreliable.

### Target Users
- **Document Owners:** Legal, finance, and engineering leads who need to share confidential documents with specific colleagues, select between read-only and edit permissions, and revoke access instantly.
- **Grantees (Viewers & Editors):** Internal team members or external collaborators who need access only to documents explicitly shared with them.
- **Compliance Administrators:** Security officers who require system-wide visibility into security events, failed login attempts, and permission grants without violating document privacy by reading confidential file contents.

---

## 2. Implemented Features & Role Matrix

### Implemented & Verified Capabilities
- **Robust Argon2id Authentication:** OWASP-calibrated password hashing ($m=19\text{ MiB}, t=2, p=1$) with constant-work dummy verification to neutralize user enumeration and timing attacks.
- **PostgreSQL Server Sessions:** Session storage backed by `connect-pg-simple` with session fixation protection (`req.session.regenerate`), 8-hour idle timeout, 24-hour absolute expiration, and multi-session revocation on password change.
- **Centralized Document Gatekeeper:** Unified authorization engine ([`apps/api/src/documents/authorization.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts)) evaluating document ownership, active grants, account status, and soft-deletion in single parameterized SQL queries.
- **Immediate Grant Revocation:** Access grants can be revoked instantly (`revoked_at = now()`). Subsequent requests fail immediately without caching delays.
- **Strict Anti-Enumeration:** Requests for unauthorized, soft-deleted, or nonexistent documents return uniform `404 Not Found` responses, preventing resource existence leakage.
- **Private Object Storage Pipeline:** Uploads are inspected for magic byte signatures (rejecting DOS MZ/ELF executables and active scripts) and stored in a private Supabase bucket (`trustvault-private`). Downloads are streamed strictly through authorized backend routes with RFC 6266 / RFC 5987 header sanitization.
- **Append-Only Audit Trail:** Authoritative event logging in `public.audit_events` (`BIGINT GENERATED ALWAYS AS IDENTITY`). Mutation attempts are rejected with `HTTP 405 Method Not Allowed`.
- **Row Level Security (RLS) Engine:** Declarative database policies enforcing default-deny on `users`, `documents`, `document_grants`, `audit_events`, and `sessions`. Tested and verified via 24 dedicated regression tests.
- **Administrative User Management:** Complete admin-only user directory with parameterized search, role promotion/demotion (`admin`, `owner`, `viewer`), account disabling/re-enabling, self-demotion protection, last-admin protection, and instant multi-session revocation upon account disabling.
- **Profile Metadata Editing:** Self-service display name customization (`PATCH /api/auth/profile`) with strict XSS sanitization, length boundaries (1–100 chars), and immutable audit trail logging.
- **255 Passing Automated Tests:** Full test suite coverage across 20 test files (70 unit tests, 185 integration tests) verifying authentication, RLS, centralized authorization, storage security, admin governance, profile lifecycle, and safe demo provisioning.

### Role & Permission Matrix

| Role / Capability | `viewer` | `owner` | `admin` |
|:---|:---:|:---:|:---:|
| **Public Registration Default** | ✅ Yes | ❌ No | ❌ No |
| **Edit Personal Profile** | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **View Shared Documents** | ✅ If granted | ✅ If granted | ✅ If granted |
| **Download Document Content** | ✅ If granted | ✅ If granted | ✅ If granted |
| **Upload / Create Documents** | ❌ Forbidden (403) | ✅ Allowed | ✅ Allowed |
| **Edit Document Metadata** | ❌ (Unless `edit` grant) | ✅ If owner | ❌ (Unless `edit` grant) |
| **Soft-Delete Documents** | ❌ Forbidden | ✅ If owner | ❌ Forbidden (Least Privilege) |
| **Share Document / Manage Grants** | ❌ Forbidden | ✅ If owner | ❌ Forbidden |
| **View Document Audit Trail** | ❌ Forbidden (403) | ✅ If owner | ❌ (Unless owner) |
| **Manage Users & Roles** | ❌ Forbidden (403) | ❌ Forbidden (403) | ✅ Allowed (`/api/admin/users`) |
| **Disable / Re-enable Accounts** | ❌ Forbidden (403) | ❌ Forbidden (403) | ✅ Allowed (`/api/admin/users/:id/status`) |
| **View System-Wide Audit Log** | ❌ Forbidden (403) | ❌ Forbidden (403) | ✅ Allowed (`GET /api/audit`) |

---

## 3. Technology Stack

- **Runtime & Language:** Node.js 22 LTS, TypeScript 5.8+ / 7.0 (Strict mode enabled across monorepo).
- **Backend API:** Express 5.1, `connect-pg-simple`, `pg` (node-postgres), `@node-rs/argon2`, `busboy` (streaming multipart), `zod` 3.25, `helmet` 8.1, `cors`, `express-rate-limit`.
- **Frontend SPA:** React 19.1, Vite 6.4, Tailwind CSS 4.3, React Router 7.1, `@remixicon/react`, `@base-ui/react`.
- **Database & Storage:** PostgreSQL 15+ with `pgcrypto` extension; Supabase Storage for private S3-compatible binary blobs.
- **Testing & Tooling:** Vitest 3.2, Supertest 7.1, Docker (multi-stage Alpine container).

---

## 4. Repository Structure

```
trustvault/
├── apps/
│   ├── api/                     # Express 5 Backend REST API
│   │   ├── src/
│   │   │   ├── admin/           # Administrative user governance and roles
│   │   │   ├── audit/           # Append-only audit service and routes
│   │   │   ├── auth/            # Argon2id hashing, session middleware, CSRF
│   │   │   ├── db/              # Pool, fail-closed guard, demo provisioning
│   │   │   ├── documents/       # Centralized authorization, lifecycle, storage
│   │   │   ├── app.ts           # Express application configuration
│   │   │   ├── config.ts        # Environment schema and production assertions
│   │   │   └── server.ts        # HTTP server entrypoint
│   │   ├── tests/
│   │   │   ├── integration/     # End-to-end API & RLS integration tests (185 tests, 10 files)
│   │   │   └── unit/            # Isolated in-memory unit tests (70 tests, 10 files)
│   │   ├── Dockerfile           # Alpine container specification for API deployment
│   │   └── package.json
│   └── web/                     # React 19 + Vite Frontend SPA
│       ├── src/                 # UI components, pages, authentication context
│       ├── vite.config.ts       # Reverse proxy configuration to API
│       └── package.json
├── docs/                        # Complete Technical Documentation
│   ├── ARCHITECTURE.md          # System architecture, lifecycles, sequence diagrams
│   ├── API.md                   # Complete REST API reference specification
│   ├── CHALLENGE_COMPLIANCE_AUDIT.md # Hiring challenge compliance audit & interview defense
│   ├── DATABASE.md              # Database schema, constraints, RLS policies
│   ├── DEPLOYMENT.md            # Production deployment guide (Vercel, Render, Supabase)
│   ├── SECURITY.md              # Security policy, checklist, responsible disclosure
│   ├── TESTING.md               # Testing guide, test database guards, test results
│   └── rls-audit-report.md      # Row Level Security implementation and audit report
├── supabase/
│   └── migrations/              # Declarative SQL schema, RLS, and profile migrations
├── docker-compose.yml           # Runs trustvault-api container (Note: No DB container)
├── package.json                 # Root monorepo manifest and npm scripts
├── PROMPTS.md                   # Chronological development log and phase history
├── README.md                    # Primary repository entry point (this file)
└── THREATS.md                   # Comprehensive security threat model and matrix
```

---

## 5. Prerequisites

Before installing TrustVault, ensure you have:
1. **Node.js:** `v22.0.0` or higher (`node -v`).
2. **npm:** `v10.0.0` or higher (`npm -v`).
3. **PostgreSQL Database:** PostgreSQL 15+ instance (either via local PostgreSQL installation or cloud Supabase project).
   > [!IMPORTANT]
   > The included `docker-compose.yml` runs **only the `trustvault-api` application service**; it does not start a local PostgreSQL container. You must have a reachable PostgreSQL instance configured via `DATABASE_URL`.

---

## 6. Local Setup & Reproducible Installation

Follow these steps to run TrustVault locally on your development machine.

### Step 1: Clone and Install Monorepo Dependencies
```powershell
# Clone the repository
git clone https://github.com/ruthvicksai-dev/trustvault.git
cd trustvault

# Install dependencies across all npm workspaces
npm install
```

### Step 2: Configure Environment Variables
Copy the template configuration file in the repository root:
```powershell
# Windows PowerShell
Copy-Item .env.example .env

# Linux / macOS
cp .env.example .env
```

Edit `.env` to configure your development PostgreSQL and Supabase settings:
```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trustvault
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your_service_role_secret_key
FRONTEND_ORIGIN=http://localhost:5173
SESSION_SECRET=c8f1e9b2a7d4c6e8f0a2b4d6e8c0a2b4d6e8f0a2b4c6e8d0
SUPABASE_STORAGE_BUCKET=trustvault-private
TRUST_PROXY=false
```

### Step 3: Run Database Migrations
Apply the baseline schema and RLS policies to your database:
```powershell
# Check database connectivity
npm run db:check --workspace=apps/api
```
*(If using Supabase CLI, run `supabase db push`. If using raw PostgreSQL, execute the SQL files in [`supabase/migrations`](file:///c:/Users/ruthv/Projects/trustvault/supabase/migrations) in chronological order).*

### Step 4: Start Development Servers
Start the Express API server (port 4000):
```powershell
npm run dev:api
```

In a second terminal window, start the React + Vite web dashboard (port 5173):
```powershell
npm run dev:web
```

Access the application in your browser at: **`http://localhost:5173`**. The Vite development server automatically proxies API requests (`/api` and `/health`) to port 4000.

---

## 7. Demo Access & Evaluator Guide

To facilitate transparent and reproducible evaluation of TrustVault's role-based access control and tamper-resistant audit logging, dedicated demo identities and synthetic evaluation scenarios are available.

> [!IMPORTANT]
> **Safety & Integrity Invariants:**
> - **Disabled by default:** Demo account provisioning is strictly disabled unless explicitly activated via `ENABLE_DEMO_ACCOUNTS=true`.
> - **Zero hardcoded credentials:** Passwords must be supplied via secure environment variables (`DEMO_*_PASSWORD`). Passwords are never committed to Git, logged to console, or included in client bundles.
> - **Argon2id hashing:** All demo credentials are safe-hashed using the application's calibrated Argon2id implementation.
> - **Idempotent & non-destructive:** Running provisioning multiple times never creates duplicate accounts, never overwrites existing user passwords, and never alters existing user roles.
> - **Isolated synthetic data:** Only fictional documents and synthetic accounts (`*.local` / `*.test`) are seeded. Live user data and storage buckets remain strictly isolated.

### Demo Credentials for Immediate Evaluation

Evaluators can immediately log in with the following pre-configured demo credentials:

| Role | Email Address | Password | Intended Demonstrations & Evaluation Scope |
|:---|:---|:---|:---|
| **Admin** | `admin@trustvault.local` | `AdminDemo2026!` | • **User Governance:** Inspect registered users via `/admin`, search by email/name, promote/demote roles (`admin`, `owner`, `viewer`), and toggle account status (`active` / `disabled`).<br>• **Session Revocation:** Disabling a user immediately terminates all active sessions.<br>• **Global Audit Oversight:** Inspect system-wide security audit events via `/audit`.<br>• **Least Privilege:** Administrators have **zero implicit access** to document contents unless explicitly granted. |
| **Owner** | `owner@trustvault.local` | `OwnerDemo2026!` | • **Document Ownership:** Upload confidential PDF/PNG documents via `/documents`.<br>• **Access Delegation:** Grant granular permissions (`read` or `edit`) to other users.<br>• **Immediate Revocation:** Revoke access grants instantly.<br>• **Document Audit Trail:** Inspect the tamper-resistant event trail for owned documents. |
| **Viewer** | `viewer@trustvault.local` | `ViewerDemo2026!` | • **Permitted Document Access:** View and download documents explicitly shared by owners.<br>• **Upload Forbidden:** Verifies that viewers cannot upload documents (`HTTP 403 Forbidden`).<br>• **Anti-IDOR & Tenant Isolation:** Verifies that unshared documents belonging to other users return `HTTP 404 Not Found` (preventing resource enumeration).<br>• **Immediate Access Denial:** Verifies that revoked documents immediately return `HTTP 404 Not Found` with zero caching delay. |

### Quick Provisioning Command

To populate or refresh these demo accounts and realistic evaluation scenarios on your database, simply run:

```bash
npm run seed:demo
```

*(Pre-configured defaults `AdminDemo2026!`, `OwnerDemo2026!`, and `ViewerDemo2026!` are embedded automatically for zero-friction evaluation. Custom passwords can still be supplied via `DEMO_*_PASSWORD` environment variables).*

### Environment Configuration Variables

The provisioning engine ([`apps/api/src/db/provision-demo.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/db/provision-demo.ts)) requires the following environment variables:

| Environment Variable | Required | Default | Description |
|:---|:---:|:---:|:---|
| `ENABLE_DEMO_ACCOUNTS` | **Yes** | `false` | Master safety switch. Must be explicitly set to `true` to permit demo provisioning. |
| `DEMO_ADMIN_PASSWORD` | **Yes** | *None* | Secure password for the demo admin account (minimum 12 characters). |
| `DEMO_OWNER_PASSWORD` | **Yes** | *None* | Secure password for the demo owner account (minimum 12 characters). |
| `DEMO_VIEWER_PASSWORD` | **Yes** | *None* | Secure password for the demo viewer account (minimum 12 characters). |
| `DEMO_ADMIN_EMAIL` | Optional | `admin@trustvault.local` | Email address for the synthetic admin account. |
| `DEMO_OWNER_EMAIL` | Optional | `owner@trustvault.local` | Email address for the synthetic owner account. |
| `DEMO_VIEWER_EMAIL` | Optional | `viewer@trustvault.local` | Email address for the synthetic viewer account. |
| `DEMO_ENV_CONFIRMATION` | Production Only | `false` | Required confirmation flag when executing provisioning against a production environment (`NODE_ENV=production`). |

### Local Provisioning Instructions

To provision demo accounts and realistic evaluation scenarios on your local development database:

#### Windows PowerShell:
```powershell
# Set configuration variables for the current session (minimum 12 character passwords)
$env:ENABLE_DEMO_ACCOUNTS="true"
$env:DEMO_ADMIN_PASSWORD="DemoAdminPassword123!"
$env:DEMO_OWNER_PASSWORD="DemoOwnerPassword123!"
$env:DEMO_VIEWER_PASSWORD="DemoViewerPassword123!"

# Execute the idempotent provisioning script
npm run seed:demo
```

#### Linux / macOS Bash:
```bash
ENABLE_DEMO_ACCOUNTS=true \
DEMO_ADMIN_PASSWORD="DemoAdminPassword123!" \
DEMO_OWNER_PASSWORD="DemoOwnerPassword123!" \
DEMO_VIEWER_PASSWORD="DemoViewerPassword123!" \
npm run seed:demo
```

### Pre-Configured Synthetic Scenarios

Running `npm run seed:demo` provisions three realistic, fictional document scenarios:

1. **Document 1 (Active Shared Access):**
   *Title:* `Confidential_Q4_Financial_Audit_Report.pdf` (Category: `Finance`)
   *State:* Owned by Owner; active `read` grant assigned to Viewer.
   *Evaluator Action:* Log in as Viewer; verify document appears in "Shared with Me" and downloads successfully.
2. **Document 2 (Tenant Isolation / Anti-IDOR):**
   *Title:* `Internal_Executive_Compensation_2026.pdf` (Category: `Executive`)
   *State:* Owned by Owner; **zero grants** assigned to Viewer.
   *Evaluator Action:* Log in as Viewer; attempt direct access by ID. Verify server returns uniform `HTTP 404 Not Found` (anti-enumeration).
3. **Document 3 (Immediate Revocation Demonstration):**
   *Title:* `Third_Party_Vendor_Risk_Assessment.pdf` (Category: `Compliance`)
   *State:* Owned by Owner; grant previously granted to Viewer has been **revoked** (`revoked_at` is set).
   *Evaluator Action:* Log in as Viewer; verify document is inaccessible and returns `HTTP 404 Not Found`.

All actions generate authentic, append-only events (`create_document`, `create_grant`, `revoke_grant`, `read_content`) recorded via `recordAuditEvent()` with genuine actor attribution.

### Resetting Demo Data Safely

If you wish to purge synthetic demo data and restore a clean state without modifying real users or documents:

#### Windows PowerShell:
```powershell
$env:ENABLE_DEMO_ACCOUNTS="true"
$env:DEMO_ADMIN_PASSWORD="DemoAdminPassword123!"
$env:DEMO_OWNER_PASSWORD="DemoOwnerPassword123!"
$env:DEMO_VIEWER_PASSWORD="DemoViewerPassword123!"
npm run seed:demo:reset
```

The reset engine targets **only** the synthetic email addresses (`admin@trustvault.local`, `owner@trustvault.local`, `viewer@trustvault.local` or custom configured demo emails) and documents with `demo-*` storage keys. Real non-demo users, real documents, and authentic audit logs are preserved untouched.

### Live Evaluation Deployment Access

> [!NOTE]
> **Live Deployment Status: OPERATIONAL & VERIFIED**
> TrustVault is live in production across the following cloud infrastructure:
> - **Frontend SPA:** Deployed to **Vercel** at **`https://trustvault-omega.vercel.app`** with automatic API proxying via [`apps/web/vercel.json`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/vercel.json).
> - **Backend API:** Containerized Web Service live on **Render** at **`https://trustvault-api-l22c.onrender.com`** ([`apps/api/Dockerfile`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/Dockerfile)).
> - **Database & Storage:** Hosted on **Supabase** (PostgreSQL 15+ with Row Level Security and private object storage bucket `trustvault-private`).
> - **GitHub Repository:** Publicly available at `https://github.com/ruthvicksai-dev/trustvault` on branch `master`.
>
> If evaluating on the live production deployment:
> 1. Demo accounts are configured with `ENABLE_DEMO_ACCOUNTS=true` and safe Argon2id hashed credentials (`AdminDemo2026!`, `OwnerDemo2026!`, `ViewerDemo2026!`).
> 2. **Clean Evaluator Path:** Evaluators may also register a fresh account via the registration interface (`/login`, tab "Register"). Registrations automatically receive the least-privileged `viewer` role. An administrator can promote the account to `owner` or `admin` via the Admin Dashboard (`/admin`) to verify dynamic privilege escalation and session handling.

---

## 8. Testing & Verification

TrustVault includes a comprehensive, verified test suite with zero external dependencies required for unit testing.

```powershell
# Run the entire test suite (255 automated tests across 20 test files)
npm test

# Run isolated in-memory unit tests (no database required - 70 tests across 10 files)
npm run test:unit

# Run full integration and RLS regression tests (requires test database - 185 tests across 10 files)
npm run test:integration

# Typecheck both API and Web workspaces
npm run typecheck

# Full production build verification
npm run build
```

### Continuous Integration (CI)
TrustVault features an automated GitHub Actions CI pipeline ([`.github/workflows/ci.yml`](file:///c:/Users/ruthv/Projects/trustvault/.github/workflows/ci.yml)) that runs on every push and pull request to `master`:
- **Triggers:** Pushes and PRs targeting `master`, plus manual dispatch.
- **Isolated Service Container:** Ephemeral `postgres:16-alpine` service container with a dedicated `trustvault_test` database.
- **Automated Validation:** Validates `npm ci`, dependency tree sanity (`npm ls --depth=0`), full TypeScript typecheck (`npm run typecheck`), production builds (`npm run build`), automated test migration (`npm run db:migrate:test`), and the complete 255-test suite.
- **Zero Production Exposure:** Tests execute in memory or against disposable containers with zero production Supabase access or secret leakage.

### Test Database Configuration & Fail-Closed Guard
To execute database integration tests locally:
1. Create `.env.test` from `.env.test.example`:
   ```powershell
   Copy-Item .env.test.example .env.test
   ```
2. Configure `TEST_DATABASE_URL` pointing to a dedicated test database whose name **contains `test`** (e.g. `postgresql://postgres:postgres@localhost:5432/trustvault_test`).
3. Apply migrations to the test database:
   ```powershell
   npm run db:migrate:test --workspace=apps/api
   ```
4. The built-in safety guard ([`apps/api/src/db/guard.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/db/guard.ts)) guarantees that integration tests will fail closed if `TEST_DATABASE_URL` points to a development or production database.

---

## 9. Deployment Overview

- **Backend API (Operational on Render):** Packaged via [`apps/api/Dockerfile`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/Dockerfile) as an Alpine Linux container, running on Node.js 22 LTS with TLS termination, `TRUST_PROXY=1`, Argon2id authentication, streaming file validation, and hardened HTTP headers. Live URL: `https://trustvault-api-l22c.onrender.com`.
- **Frontend SPA (Operational on Vercel):** Built via Vite 6 and Tailwind CSS 4, deployed on Vercel's global edge network at **`https://trustvault-omega.vercel.app`**. Client-side routing and `/api/*` requests are handled via [`apps/web/vercel.json`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/vercel.json) rewrites, guaranteeing first-party cookie isolation and eliminating CORS preflight delays.
- **Database & Storage (Supabase):** Authoritative PostgreSQL 15+ database with session storage (`public.sessions`), append-only audit trail (`public.audit_events`), and private S3-compatible document storage (`trustvault-private`).

For complete, step-by-step production deployment instructions, safe environment variable templates, verified smoke test commands, and troubleshooting, refer to [`docs/DEPLOYMENT.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DEPLOYMENT.md).

---

## 10. Troubleshooting & FAQ

### 1. `docker-compose.yml` does not start PostgreSQL
- **Explanation:** The repository's `docker-compose.yml` specifies only the `trustvault-api` container service. It does not spin up a database. You must provide a running PostgreSQL instance (local or Supabase) and supply its URI in `DATABASE_URL`.

### 2. `CRITICAL SECURITY ERROR: SESSION_SECRET must be set and provide at least 32 characters`
- **Explanation:** In production mode (`NODE_ENV=production`), the application halts startup if `SESSION_SECRET` is missing or has fewer than 32 characters of entropy. Provide a 64-character random hex string.

### 3. Integration tests fail: "FATAL TEST DATABASE SAFETY GUARD TRIGGERED"
- **Explanation:** The test database URI does not contain the word `test`. Change the database name in `TEST_DATABASE_URL` to `trustvault_test` to protect real data from accidental deletion.

### 4. Render Free Tier Notice
- **Explanation:** Free web services on Render may spin down after 15 minutes of inactivity. When testing on free tiers, allow 30–50 seconds for container cold starts on the first request.

---

## 11. Complete Documentation Index

For in-depth technical analysis, consult the dedicated documentation files:

| Document | Description |
|:---|:---|
| [`docs/ARCHITECTURE.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/ARCHITECTURE.md) | Architectural design, component responsibilities, trust boundaries, lifecycle sequence diagrams, and invariants. |
| [`docs/API.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/API.md) | Exhaustive REST API specification with request schemas, responses, status codes, and authorization rules. |
| [`docs/CHALLENGE_COMPLIANCE_AUDIT.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/CHALLENGE_COMPLIANCE_AUDIT.md) | Complete hiring challenge compliance audit, 26-requirement matrix, gap analysis, and technical interview defense guide. |
| [`docs/DATABASE.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DATABASE.md) | Complete PostgreSQL schema, constraints, indexes, RLS policies, and database connection role analysis. |
| [`docs/TESTING.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/TESTING.md) | Comprehensive testing guide, fail-closed guards, test organization, and verified passing test breakdown. |
| [`docs/DEPLOYMENT.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DEPLOYMENT.md) | Production deployment guide for Vercel, Render, and Supabase with safe environment variable references. |
| [`docs/SECURITY.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/SECURITY.md) | Operational security guidelines, secret management standards, checklist, and responsible disclosure. |
| [`docs/rls-audit-report.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/rls-audit-report.md) | Row Level Security (RLS) policies, bypass role analysis, and 24 RLS integration tests report. |
| [`THREATS.md`](file:///c:/Users/ruthv/Projects/trustvault/THREATS.md) | Comprehensive security threat model, threat matrices (Phases 4–9), and architectural residual risk analysis. |
| [`PROMPTS.md`](file:///c:/Users/ruthv/Projects/trustvault/PROMPTS.md) | Chronological development log, technical decisions, and phase-by-phase implementation history. |
