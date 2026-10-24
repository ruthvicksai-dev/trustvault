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

### Role & Permission Matrix

| Role / Capability | `viewer` | `owner` | `admin` |
|:---|:---:|:---:|:---:|
| **Public Registration Default** | ✅ Yes | ❌ No | ❌ No |
| **View Shared Documents** | ✅ If granted | ✅ If granted | ✅ If granted |
| **Download Document Content** | ✅ If granted | ✅ If granted | ✅ If granted |
| **Upload / Create Documents** | ❌ Forbidden (403) | ✅ Allowed | ✅ Allowed |
| **Edit Document Metadata** | ❌ (Unless `edit` grant) | ✅ If owner | ❌ (Unless `edit` grant) |
| **Soft-Delete Documents** | ❌ Forbidden | ✅ If owner | ❌ Forbidden (Least Privilege) |
| **Share Document / Manage Grants** | ❌ Forbidden | ✅ If owner | ❌ Forbidden |
| **View Document Audit Trail** | ❌ Forbidden (403) | ✅ If owner | ❌ (Unless owner) |
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
│   │   │   ├── audit/           # Append-only audit service and routes
│   │   │   ├── auth/            # Argon2id hashing, session middleware, CSRF
│   │   │   ├── db/              # Pool configuration, fail-closed test guard
│   │   │   ├── documents/       # Centralized authorization, lifecycle, storage
│   │   │   ├── app.ts           # Express application configuration
│   │   │   ├── config.ts        # Environment schema and production assertions
│   │   │   └── server.ts        # HTTP server entrypoint
│   │   ├── tests/
│   │   │   ├── integration/     # End-to-end API & RLS integration tests (155 tests)
│   │   │   └── unit/            # Isolated in-memory unit tests (54 tests)
│   │   ├── Dockerfile           # Alpine container specification for API deployment
│   │   └── package.json
│   └── web/                     # React 19 + Vite Frontend SPA
│       ├── src/                 # UI components, pages, authentication context
│       ├── vite.config.ts       # Reverse proxy configuration to API
│       └── package.json
├── docs/                        # Complete Technical Documentation
│   ├── ARCHITECTURE.md          # System architecture, lifecycles, sequence diagrams
│   ├── API.md                   # Complete REST API reference specification
│   ├── DATABASE.md              # Database schema, constraints, RLS policies
│   ├── TESTING.md               # Testing guide, test database guards, test results
│   ├── DEPLOYMENT.md            # Production deployment guide (Vercel, Railway, Supabase)
│   ├── SECURITY.md              # Security policy, checklist, responsible disclosure
│   └── rls-audit-report.md      # Row Level Security implementation and audit report
├── supabase/
│   └── migrations/              # Declarative SQL schema and RLS migrations
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

## 7. Testing & Verification

TrustVault includes a comprehensive, verified test suite with zero external dependencies required for unit testing.

```powershell
# Run the entire test suite (209 automated tests)
npm test

# Run isolated in-memory unit tests (no database required)
npm run test:unit

# Run full integration and RLS regression tests (requires test database)
npm run test:integration

# Typecheck both API and Web workspaces
npm run typecheck

# Full production build verification
npm run build
```

### Test Database Configuration & Fail-Closed Guard
To execute database integration tests:
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

## 8. Deployment Overview

- **Backend API:** Packaged via [`apps/api/Dockerfile`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/Dockerfile) and ready for deployment to **Railway** or any container runtime.
- **Frontend SPA:** Built via `npm run build:web` and optimized for static edge deployment on **Vercel**.
- **PostgreSQL & Storage:** Hosted on **Supabase** with private bucket isolation (`trustvault-private`).

For complete, step-by-step production deployment instructions, safe environment variable templates, and troubleshooting, refer to [`docs/DEPLOYMENT.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DEPLOYMENT.md).

---

## 9. Troubleshooting & FAQ

### 1. `docker-compose.yml` does not start PostgreSQL
- **Explanation:** The repository's `docker-compose.yml` specifies only the `trustvault-api` container service. It does not spin up a database. You must provide a running PostgreSQL instance (local or Supabase) and supply its URI in `DATABASE_URL`.

### 2. `CRITICAL SECURITY ERROR: SESSION_SECRET must be set and provide at least 32 characters`
- **Explanation:** In production mode (`NODE_ENV=production`), the application halts startup if `SESSION_SECRET` is missing or has fewer than 32 characters of entropy. Provide a 64-character random hex string.

### 3. Integration tests fail: "FATAL TEST DATABASE SAFETY GUARD TRIGGERED"
- **Explanation:** The test database URI does not contain the word `test`. Change the database name in `TEST_DATABASE_URL` to `trustvault_test` to protect real data from accidental deletion.

### 4. Railway Free Tier Notice
- **Explanation:** Free or starter tiers on Railway may spin down idle containers. When testing on free tiers, allow 15–30 seconds for container cold starts on the first request.

---

## 10. Complete Documentation Index

For in-depth technical analysis, consult the dedicated documentation files:

| Document | Description |
|:---|:---|
| [`docs/ARCHITECTURE.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/ARCHITECTURE.md) | Architectural design, component responsibilities, trust boundaries, lifecycle sequence diagrams, and invariants. |
| [`docs/API.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/API.md) | Exhaustive REST API specification with request schemas, responses, status codes, and authorization rules. |
| [`docs/DATABASE.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DATABASE.md) | Complete PostgreSQL schema, constraints, indexes, RLS policies, and database connection role analysis. |
| [`docs/TESTING.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/TESTING.md) | Comprehensive testing guide, fail-closed guards, test organization, and verified 209 passing tests. |
| [`docs/DEPLOYMENT.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DEPLOYMENT.md) | Production deployment guide for Vercel, Railway, and Supabase with safe environment variable references. |
| [`docs/SECURITY.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/SECURITY.md) | Operational security guidelines, secret management standards, checklist, and responsible disclosure. |
| [`THREATS.md`](file:///c:/Users/ruthv/Projects/trustvault/THREATS.md) | Comprehensive security threat model, threat matrices (Phases 4–9), and architectural residual risk analysis. |
| [`PROMPTS.md`](file:///c:/Users/ruthv/Projects/trustvault/PROMPTS.md) | Chronological development log, technical decisions, and phase-by-phase implementation history. |
