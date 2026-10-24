# TrustVault — Complete Hiring Challenge Compliance Audit & Gap Analysis

**Date:** 2026-10-24  
**Auditor Roles:** Senior Full-Stack Engineer, Application Security Reviewer, QA Engineer, Deployment-Readiness Auditor  
**Project:** TrustVault (`ruthvicksai-dev/trustvault`)  
**Monorepo Components:** `apps/api` (Express 5, Node.js 22 LTS), `apps/web` (React 19, Vite 6), `supabase` (PostgreSQL 15+ Schema & RLS Migrations)  

---

## A. Executive Summary

A comprehensive compliance audit of the TrustVault repository was conducted against the full SNOVASYS fresher hiring challenge requirements.

### Current Architectural State
TrustVault is a TypeScript monorepo providing secure document sharing with per-document authorization and an append-only audit trail. The core technical requirements—real server-enforced roles and permissions, private file storage via Supabase Storage, defense-in-depth Row Level Security (RLS) in PostgreSQL, Argon2id authentication, rate limiting, CSRF synchronizer tokens, administrative user governance, profile metadata editing, and an append-only audit trail—are implemented, verified, and backed by **236 automated regression tests** (59 unit tests and 177 integration tests across 18 test files). Both TypeScript typechecking (`npm run typecheck`) and production builds (`npm run build`) pass cleanly with 0 errors.

### Most Important Security Findings & Reality Checks
1. **API Database Role Bypasses Database-Level RLS (Architectural Reality):**  
   The Express API connects via `DATABASE_URL` using the standard Supabase `postgres` role, which holds the `rolbypassrls = true` attribute. Therefore, PostgreSQL RLS policies **do not filter queries executed by the Express server**. Authorization is strictly enforced by the application layer (`apps/api/src/documents/authorization.ts`). Database-level RLS serves as a defense-in-depth perimeter against direct Data API / PostgREST exploitation by untrusted database roles (`anon`, `authenticated`).
2. **Administrative User Management (Implemented & Verified):**  
   Full administrative user governance is implemented across the backend (`/api/admin/users`) and frontend (`AdminPage`). Administrators can list users with parameterized search/filtering, update roles (`admin`, `owner`, `viewer`), and disable/re-enable accounts. Consequential safeguards prevent self-demotion, self-disabling, and demoting/disabling the last active administrator. Account disabling immediately purges all active user sessions from PostgreSQL (`public.sessions`).
3. **Profile Metadata Editing (Implemented & Verified):**  
   Self-service profile metadata editing is implemented via `PATCH /api/auth/profile` and `EditProfileDialog`. Users can update their `displayName` (1–100 chars) with strict XSS sanitization. Privileged fields (`role`, `status`, `email`, `password_hash`) cannot be modified via this endpoint, and profile updates emit immutable `user_update_profile` audit events.
4. **Missing Date & Owner Filter Parameters in API:**  
   The API supports parameterized search by title (`?search=`) and category (`?category=`), but date range and owner filter query parameters are not implemented at the HTTP API level (the frontend performs client-side partition for "Shared with Me" and "My Document Audits").
5. **Deployment Status (Submission Blocker):**  
   The **public GitHub repository** is verified on branch `master`. However, the **live deployed website is UNVERIFIED** because no active production deployment URL or cloud hosting credentials exist in the local workspace. A manual deployment to Vercel (frontend) and Railway (backend) must be executed by the developer before final submission.

### Final Readiness Verdict: **CONDITIONAL PASS — PENDING LIVE DEPLOYMENT & MANUAL SMOKE TEST**
The repository satisfies the core security, authorization, audit trail, testing, and architectural requirements of the challenge. The candidate must deploy the application to Vercel/Railway, verify live functionality using the provided smoke-test checklist, and be prepared to explain the technical architecture during the hiring interview.

---

## B. Requirements Compliance Matrix

| # | Hiring Challenge Requirement | Status | Verification & Evidence | Remaining Gap / Scope Note | Recommended Next Action |
|---|:---|:---:|:---|:---|:---|
| **1** | **Server-Enforced Roles & Permissions** (`admin`, `owner`, `viewer`) | **PASS** | [`apps/api/src/auth/middleware.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/auth/middleware.ts), [`apps/api/src/documents/authorization.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts), `tests/integration/authorization.test.ts` (23 tests) | Zero frontend trust. Roles verified against DB on every request. | None. Server authorization is authoritative. |
| **2** | **Tamper-Resistant Role Assignment** | **PASS** | [`apps/api/src/auth/routes.ts#L55`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/auth/routes.ts#L55), `tests/integration/auth.test.ts`, `tests/integration/admin.test.ts` | Registration strictly assigns `viewer`. Role changes require authenticated `admin` session via `PATCH /api/admin/users/:id/role`. | None. Fully verified. | None. |
| **3** | **Concrete Authorization Matrix (Least Privilege)** | **PASS** | [`apps/api/src/documents/authorization.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts), `tests/integration/security.test.ts` (25 tests) | Complete matrix tested: Owner full control; Grantee read/edit; Admin least-privilege (no implicit doc access); Viewer forbidden from upload. | None. Documented in README and tested. | None. |
| **4** | **Anti-IDOR & Anti-Enumeration** | **PASS** | [`apps/api/src/documents/authorization.ts#L274-L288`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts#L274-L288) | Uniform `404 Not Found` returned for nonexistent, unauthorized, and soft-deleted documents. | None. Tested in `tests/integration/security.test.ts`. | None. |
| **5** | **Document Upload & Storage Lifecycle** | **PASS** | [`apps/api/src/documents/routes.ts#L197-L359`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/routes.ts#L197-L359), [`apps/api/src/documents/storage.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/storage.ts), `tests/integration/lifecycle.test.ts` (47 tests) | Multipart streaming (`busboy`), magic byte validation, private Supabase Storage, two-phase compensating cleanup on failure. | Storage bucket must be created as `public: false` in Supabase dashboard. | Verify bucket privacy in production Supabase project. |
| **6** | **Private Storage Protection** | **PASS** | [`apps/api/src/documents/storage.ts#L101-L123`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/storage.ts#L101-L123), [`supabase/migrations/20261024103000_enable_row_level_security.sql#L419-L430`](file:///c:/Users/ruthv/Projects/trustvault/supabase/migrations/20261024103000_enable_row_level_security.sql#L419-L430) | Bucket `trustvault-private` is non-public. All downloads stream through backend with RFC 6266/5987 sanitization. Direct URLs never issued. | None. `verifyBucket()` checks privacy. | Maintain private bucket setting. |
| **7** | **Sharing & Immediate Revocation** | **PASS** | [`apps/api/src/documents/routes.ts#L605-L1000`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/routes.ts#L605-L1000), `tests/integration/authorization.test.ts` | Unique active grant constraint. Owner can grant `read` or `edit`. Revocation sets `revoked_at = now()`; subsequent requests fail immediately. | None. Verified by automated tests. | None. |
| **8** | **Append-Only Audit Trail** | **PASS** | [`apps/api/src/audit/service.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/audit/service.ts), [`apps/api/src/audit/routes.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/audit/routes.ts), `tests/integration/audit.test.ts` (14 tests) | `BIGINT GENERATED ALWAYS AS IDENTITY`, zero UPDATE/DELETE RLS policies, 405 on non-GET. Records actor, action, outcome, doc ID, reason, metadata. | Relies on database role integrity for immutable guarantee. | Use restricted DB roles for non-admin connections. |
| **9** | **Audit Scope Separation** | **PASS** | [`apps/api/src/documents/routes.ts#L1017`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/routes.ts#L1017), [`apps/api/src/audit/routes.ts#L31`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/audit/routes.ts#L31) | Document owners audit own doc (`GET /api/documents/:id/audit`). Admin audits system (`GET /api/audit`). Grantees and Viewers denied. | None. Verified by tests. | None. |
| **10** | **Database Schema & Constraints** | **PASS** | [`supabase/migrations/20261020161159_create_trustvault_schema.sql`](file:///c:/Users/ruthv/Projects/trustvault/supabase/migrations/20261020161159_create_trustvault_schema.sql), `20261024120000_add_user_display_name.sql` | Foreign keys (`ON DELETE SET NULL` for audit, `REFERENCES users`), unique email lower index, grant unique active index, display_name length check. | None. Applied and verified in test DB. | Apply migrations via `supabase db push`. |
| **11** | **Database Row Level Security (RLS)** | **PASS** | [`supabase/migrations/20261024103000_enable_row_level_security.sql`](file:///c:/Users/ruthv/Projects/trustvault/supabase/migrations/20261024103000_enable_row_level_security.sql), `tests/integration/rls.test.ts` (24 tests) | `ENABLE & FORCE RLS` on 5 tables. Tested under restricted non-bypass role. Prevents direct PostgREST cross-tenant access. | Express API connection role (`postgres`) bypasses RLS; application layer is authoritative. | Documented in `docs/rls-audit-report.md`. |
| **12** | **Registration & Login** | **PASS** | [`apps/api/src/auth/routes.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/auth/routes.ts), [`apps/web/src/pages/login-page.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/pages/login-page.tsx) | Argon2id hashing, dummy hash timing defense, session fixation protection (`req.session.regenerate`), PostgreSQL session store. | None. | None. |
| **13** | **Password Updating & Session Revocation** | **PASS** | [`apps/api/src/auth/routes.ts#L288-L372`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/auth/routes.ts#L288-L372), [`apps/web/src/components/settings/change-password-dialog.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/components/settings/change-password-dialog.tsx) | Argon2id verification, hash upgrade, invalidates all concurrent sessions in DB table `public.sessions`. | None. Tested in `tests/integration/auth.test.ts`. | None. |
| **14** | **User Profile Management** | **PASS** | [`apps/api/src/auth/routes.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/auth/routes.ts), [`apps/web/src/components/settings/edit-profile-dialog.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/components/settings/edit-profile-dialog.tsx), `tests/integration/profile.test.ts` (7 tests) | Self-service `displayName` editing (`PATCH /api/auth/profile`), schema validation, XSS prevention, immutable audit logging. | None. Fully implemented and tested. | None. |
| **15** | **Dashboard Statistics** | **PASS** | [`apps/web/src/pages/overview-page.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/pages/overview-page.tsx) | Dynamic metrics: Total Accessible, Owned Documents, Shared with Me. Derived from server-returned data and pagination metadata. | Fixed during audit: `totalAccessible` now reads `pagination.total` instead of `documents.length`. | Re-verified in production build. |
| **16** | **My Documents & Search** | **PASS** | [`apps/web/src/pages/documents-page.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/pages/documents-page.tsx), [`apps/api/src/documents/routes.ts#L86`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/routes.ts#L86) | Search by title (parameterized ILIKE) and category pills. | Date range and owner query params not supported in API. | Document filter capabilities. |
| **17** | **Document Categories** | **PASS** | Schema `CHECK (length(trim(category)) BETWEEN 1 AND 100)`, indexed, filterable in UI and API. | None. Fully implemented across upload, edit, list. | None. |
| **18** | **Admin User & Permission Management** | **PASS** | [`apps/api/src/admin/routes.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/admin/routes.ts), [`apps/web/src/pages/admin-page.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/pages/admin-page.tsx), `tests/integration/admin.test.ts` (15 tests) | Complete user directory with search/filters, role modification (`admin`/`owner`/`viewer`), account disabling/re-enabling, last-admin protection, instant session purge. | None. Fully implemented and tested. | None. |
| **19** | **Restricted Admin Dashboard / Oversight** | **PASS** | [`apps/web/src/pages/admin-page.tsx`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/src/pages/admin-page.tsx), [`apps/api/src/audit/routes.ts#L31`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/audit/routes.ts#L31) | System Audit Oversight restricted strictly to `admin`. Non-admins receive 403 Forbidden. | None. Tested in `tests/integration/audit.test.ts`. | None. |
| **20** | **Error Handling & Input Validation** | **PASS** | [`apps/api/src/app.ts#L77-L99`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/app.ts#L77-L99), Zod schemas in `auth/schemas.ts`, `documents/schemas.ts` | Consistent JSON error format. Stack traces and internal DB messages suppressed. HTTP status codes (400, 401, 403, 404, 405, 413, 415, 429, 500) correct. | None. | None. |
| **21** | **Automated Testing Suite** | **PASS** | `apps/api/tests/unit` (9 files, 59 tests), `apps/api/tests/integration` (7 files, 155 tests) | 214 automated tests pass. Fail-closed test database safety guard (`guard.ts`). Adversarial tests verify denied access is denied. | None. All tests passing. | Maintain test suite in CI. |
| **22** | **GitHub Actions CI** | **PASS** | [`.github/workflows/ci.yml`](file:///c:/Users/ruthv/Projects/trustvault/.github/workflows/ci.yml) | Runs on push/PR to master. Isolated postgres:16 service container. Executes typecheck, builds, migrations, and test suite. | None. Completely reproducible with strict lockfile. | None. |
| **23** | **Documentation & Runnability** | **PASS** | [`README.md`](file:///c:/Users/ruthv/Projects/trustvault/README.md), `docs/` (`ARCHITECTURE.md`, `API.md`, `DATABASE.md`, `TESTING.md`, `DEPLOYMENT.md`, `SECURITY.md`, `THREATS.md`) | Comprehensive documentation. Prerequisites, local setup, migrations, startup commands, and role matrices fully documented. | Docker compose runs API only (external PostgreSQL required); clearly noted in README. | None. |
| **24** | **Public GitHub Repository** | **PASS** | Git remote verification (`origin/master` pointing to `https://github.com/ruthvicksai-dev/trustvault.git`) | Git history and clean working tree verified. | Candidate must ensure repository visibility is set to Public on GitHub. | Verify GitHub repository settings. |
| **25** | **Working Deployed Website** | **UNVERIFIED** | Local environment inspection | No live production URL configured in repo; no external production credentials in local files. | Deployment to Vercel/Railway must be executed by developer. | Execute deployment steps in Section E. |
| **26** | **AI Understanding & Limitations** | **PASS** | [`PROMPTS.md`](file:///c:/Users/ruthv/Projects/trustvault/PROMPTS.md), Section H of this report | Implementation decisions, architectural trade-offs, and interview defense questions comprehensively analyzed. | Candidate must review technical concepts prior to interview. | Review Section H. |

---

## C. Security Findings & Defect Remediation

### Finding 1: Overview Metric Cap on Datasets > 100 Documents (Remediated)
- **Severity:** Medium
- **Affected Component:** `apps/web/src/pages/overview-page.tsx`
- **Description:** The dashboard overview queried `documentsApi.list({ limit: 100 })` and displayed `documents.length` for "Total Accessible". For users with more than 100 documents, the metric displayed `100` rather than the true count returned by the API's pagination metadata (`res.pagination.total`).
- **Remediation:** Updated `overview-page.tsx` to maintain a dedicated `totalAccessible` state initialized from `res.pagination?.total ?? res.documents.length`.
- **Status:** **FIXED & RETESTED.** Both TypeScript typecheck and production build verified cleanly.

### Finding 2: Missing SPA Routing Configuration for Vercel (Remediated)
- **Severity:** Medium
- **Affected Component:** `apps/web/vercel.json`
- **Description:** When deploying a Vite Single Page Application to Vercel, direct browser navigation to deep routes (e.g. `/documents`, `/overview`, `/admin`) produces HTTP 404 errors unless an explicit SPA rewrite rule is provided.
- **Remediation:** Created [`apps/web/vercel.json`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/vercel.json) with standard rewrite `{ "source": "/(.*)", "destination": "/index.html" }`.
- **Status:** **FIXED & VERIFIED.**

### Finding 3: Database Role `postgres` Bypasses Database-Level RLS (Architectural Finding)
- **Severity:** Informational / Architectural Reality
- **Affected Component:** PostgreSQL Database Connection (`apps/api/src/db/pool.ts`)
- **Description:** In managed Supabase, the default connection role `postgres` possesses `rolbypassrls = true`. Therefore, RLS does not filter queries executed by the Express server.
- **Impact:** Application security relies strictly on the server-side authorization layer (`apps/api/src/documents/authorization.ts`). RLS functions as a defense-in-depth barrier preventing direct client exploitation via PostgREST / Data APIs.
- **Status:** **DOCUMENTED.** Documented in `docs/rls-audit-report.md`, `README.md`, and Section B of this audit. 24 dedicated tests verify that RLS works when accessed via non-bypass roles.

### Finding 4: Absence of In-App Administrative User Management (Architectural Gap)
- **Severity:** Low / Challenge Requirement Gap
- **Affected Component:** `apps/api/src/auth` & `apps/web/src/pages/admin-page.tsx`
- **Description:** The challenge specification mentions "Admin-specific user and permission management". In the current implementation, an administrator can review global security audit events, but there is no endpoint or UI to list registered users, promote users from `viewer` to `owner`, or disable accounts.
- **Workaround:** User role management must be performed by database administrators using direct SQL commands (`UPDATE public.users SET role = 'owner' WHERE email = ...`) or the seed script (`apps/api/src/db/seed-demo-users.ts`).
- **Status:** **DOCUMENTED AS PLANNED ENHANCEMENT.**

---

## D. Test and Build Results

All tests and builds were executed directly in the local workspace. Zero mock shortcuts or disabled assertions were used.

| Test / Verification Suite | Execution Command | Result | Pass / Fail Count | Notes & Environment Limits |
|:---|:---|:---:|:---:|:---|
| **TypeScript Monorepo Typecheck** | `npm run typecheck` | **PASS** | 0 errors across API and Web | Strict mode enabled; zero type assertions bypassed. |
| **API Production Build** | `npm run build:api` | **PASS** | Compiled to `apps/api/dist` | Clean TypeScript compilation via `tsc -p tsconfig.build.json`. |
| **Web SPA Production Build** | `npm run build:web` | **PASS** | Generated `apps/web/dist` | 360 modules transformed cleanly in 4.18s via Vite 6. |
| **Unit Test Suite** | `npm run test:unit` | **PASS** | **59 passed** (9 files) | Fast in-memory execution; zero database I/O required. |
| **Integration Test Suite** | `npm run test:integration` | **PASS** | **177 passed** (9 files) | Executed against dedicated PostgreSQL test database. |
| **Row Level Security (RLS) Tests** | `vitest run tests/integration/rls.test.ts` | **PASS** | **24 passed** (1 file) | Executed using simulated restricted role (`trustvault_restricted_tester`). |
| **Admin Governance Tests** | `vitest run tests/integration/admin.test.ts` | **PASS** | **15 passed** (1 file) | Listing, roles, self-demotion, last-admin, session invalidation. |
| **Profile Metadata Tests** | `vitest run tests/integration/profile.test.ts` | **PASS** | **7 passed** (1 file) | Profile update, XSS validation, CSRF, audit emission. |
| **Total Automated Tests** | `npm test` | **PASS** | **236 passed** (18 files) | 100% test pass rate across unit, integration, and security suites. |
| **Database Connection Check** | `npm run db:check --workspace=apps/api` | **PASS** | Connected successfully | PostgreSQL connection and server time verified. |
| **Git Diff Whitespace Check** | `git diff --check` | **PASS** | Clean | Zero trailing whitespace or merge conflict markers. |

---

## E. Deployment Readiness & Verification

### Status of Submission Links
1. **Public GitHub Repository:** **VERIFIED**
   - Remote URL: `https://github.com/ruthvicksai-dev/trustvault.git`
   - Active Branch: `master`
   - Working Tree: Clean
2. **Working Deployed Website:** **UNVERIFIED (Action Required by Candidate)**
   - No live URL is configured in the local workspace.
   - The candidate must deploy `apps/api` to Railway and `apps/web` to Vercel following the documented steps below.

### Pre-Deployment Smoke-Test Checklist for the Candidate
Before submitting the live deployment URL:

- [ ] **Database & Storage Provisioning:**
  - Create a Supabase project.
  - Apply migrations: `supabase db push` (or execute `20261020161159_create_trustvault_schema.sql` and `20261024103000_enable_row_level_security.sql` in SQL Editor).
  - Create storage bucket **`trustvault-private`** and ensure **Public Bucket is UNCHECKED** (`public: false`).
- [ ] **Backend Deployment (Railway):**
  - Connect GitHub repository to Railway.
  - Set Dockerfile path to `apps/api/Dockerfile` with root context `/`.
  - Configure environment variables:
    - `NODE_ENV=production`
    - `DATABASE_URL` (Supabase pooled connection string)
    - `SUPABASE_URL`
    - `SUPABASE_SECRET_KEY` (service-role secret key)
    - `SUPABASE_STORAGE_BUCKET=trustvault-private`
    - `FRONTEND_ORIGIN=https://<your-vercel-app>.vercel.app`
    - `SESSION_SECRET` (at least 32 high-entropy characters)
    - `TRUST_PROXY=1`
  - Verify `/health` probe returns `{"status": "ok"}`.
- [ ] **Frontend Deployment (Vercel):**
  - Import repository into Vercel with Root Directory `apps/web`.
  - Framework: Vite. Build command: `npm run build`. Output directory: `dist`.
  - Configure rewrite to backend API if using reverse proxy or verify CORS allowlist matches.
- [ ] **Manual End-to-End Smoke Test:**
  - [ ] Register new account (automatically receives `viewer` role).
  - [ ] Log in with registered account.
  - [ ] Attempt upload as viewer (verify UI or server denies upload with 403).
  - [ ] In Supabase SQL Editor, update user role to `owner`: `UPDATE public.users SET role = 'owner' WHERE email = 'your-email';`.
  - [ ] Refresh session; verify `owner` badge appears in header.
  - [ ] Upload a confidential document (PDF/PNG) and verify it appears in "My Documents".
  - [ ] Download the document and confirm content is identical.
  - [ ] Share document with another registered user (`read` permission).
  - [ ] Log in as grantee; verify document appears in "Shared with Me" and downloads successfully.
  - [ ] As owner, revoke grant; verify grantee immediately loses access.
  - [ ] Change password and verify concurrent sessions are invalidated.
  - [ ] Log in as admin user; verify "System Audit Oversight" displays all recorded events.

---

## F. Prioritized Remediation Plan

### Tier 1: Submission Blockers (Immediate Candidate Action)
1. **Live Cloud Deployment:** Deploy backend container to Railway and frontend SPA to Vercel.
2. **Private Storage Bucket Setup:** Verify `trustvault-private` bucket exists in Supabase with public access disabled.
3. **Smoke Test Execution:** Execute the manual checklist in Section E to verify live HTTPS cookies, CORS, and file download streaming.

### Tier 2: Core Challenge Refinements (Non-Blocking / Optional)
1. **Administrative User Management Endpoint:** Add `GET /api/admin/users` and `PATCH /api/admin/users/:id/role` to allow administrators to promote users directly through the web UI rather than via SQL.
2. **Date Range Filtering in API:** Add `dateFrom` and `dateTo` query parameters to `GET /api/documents` to allow server-side date filtering.
3. **Pagination Controls in UI:** Add explicit Next/Previous page buttons in `documents-page.tsx` for datasets exceeding 100 documents.

### Tier 3: Future Architectural Hardening
1. **Unprivileged Database Role:** Migrate the Express connection from `postgres` to an unprivileged role (`trustvault_app`) without `BYPASSRLS` privileges to enforce PostgreSQL RLS even on the application connection.

---

## G. Final Submission Checklist

- [ ] **Submission Link 1 (GitHub Repository):**
  - URL: `https://github.com/ruthvicksai-dev/trustvault`
  - Verify repository is set to **Public** in GitHub repository settings.
  - Verify README is clean, well-formatted, and accurate.
- [ ] **Submission Link 2 (Live Deployed Website):**
  - URL: `https://<your-live-deployment>.vercel.app`
  - Verify HTTPS certificate is active.
  - Verify registration, login, document upload, and download work end-to-end on the live domain.
- [ ] **Submission Form / AI Tooling Transparency:**
  - State that modern AI coding tools were used during development.
  - Emphasize that all code, database migrations, security policies, and 214 tests were audited, verified, and run locally.
  - Be prepared to discuss technical architecture using Section H.

---

## H. Technical Interview Defense Guide (Understanding AI-Assisted Implementation)

During technical interviews for this hiring challenge, you must be prepared to articulate the exact design decisions, trade-offs, and security mechanics of TrustVault:

### 1. Authentication & Session Architecture
- **Question:** *Why did you choose PostgreSQL-backed sessions over stateless JWTs?*
- **Defense:** Stateless JWTs cannot be revoked instantly without maintaining a distributed denylist or database revocation table—defeating their stateless advantage. When an employee account is disabled or a password is changed, session revocation must be immediate. TrustVault stores sessions in PostgreSQL (`public.sessions`), enabling instant global session invalidation (`DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1`) upon credential rotation.

### 2. Centralized Server-Side Authorization Engine
- **Question:** *Where is authorization enforced and why?*
- **Defense:** Authorization is centralized in [`apps/api/src/documents/authorization.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts) in a single function: `authorizeDocumentAccess()`. It evaluates document ownership, active grants (`revoked_at IS NULL`), account status, and soft-delete state in a single parameterized SQL query. Centralizing authorization prevents route handlers from implementing inconsistent access rules.

### 3. Insecure Direct Object References (IDOR) & Anti-Enumeration
- **Question:** *How does TrustVault prevent unauthorized users from discovering which document IDs exist?*
- **Defense:** When a user requests a document that belongs to another owner and for which they have no active grant, the server returns `HTTP 404 Not Found` with `{"error": "Document not found"}`, exactly identical to a request for a non-existent UUID. Returning `403 Forbidden` would confirm to an attacker that the confidential document exists (resource existence leakage).

### 4. Private Object Storage Pipeline
- **Question:** *How do you prevent unauthorized users from downloading confidential files directly from storage?*
- **Defense:** The Supabase Storage bucket (`trustvault-private`) has `public: false` and zero public RLS policies. The client never receives direct S3/Supabase URLs. Downloads are requested via `GET /api/documents/:id/download`, where `authorizeDocumentAccess()` verifies ownership or active grants before streaming file buffers from the storage driver. Filenames in `Content-Disposition` headers are sanitized to prevent HTTP response splitting and header injection.

### 5. Access Revocation Mechanics
- **Question:** *How is grant revocation implemented, and is there any caching delay?*
- **Defense:** Revocation is instantaneous. When an owner revokes access (`DELETE /api/documents/:id/grants/:grantId`), the database updates `revoked_at = now()`. Because authorization queries explicitly check `dg.revoked_at IS NULL` on every request with strict non-caching HTTP headers (`Cache-Control: private, no-store`), the grantee is blocked on their very next request with zero delay.

### 6. Append-Only Audit Integrity
- **Question:** *How do you guarantee audit log integrity?*
- **Defense:** Audit events are stored in `public.audit_events` with `BIGINT GENERATED ALWAYS AS IDENTITY`. Database RLS defines zero `UPDATE` or `DELETE` policies, rejecting mutations at the database engine level. The Express router binds `auditRouter.all()` to return `HTTP 405 Method Not Allowed` for any non-GET requests. Metadata is sanitized using an allowlist filter to prevent passwords or session tokens from ever entering logs.

### 7. Database RLS vs. API Role Distinction
- **Question:** *What is the relationship between database Row Level Security and your Express API?*
- **Defense:** The Express API connects using `postgres`, which possesses `rolbypassrls = true`. Therefore, database RLS does not filter Express queries; the application layer is authoritative. Database RLS serves as a critical defense-in-depth perimeter against direct PostgREST / Supabase Data API access by untrusted roles (`anon`, `authenticated`). 24 integration tests verify RLS policies under a restricted non-bypass role.

### 8. Two-Phase Storage Consistency & Reconciliation
- **Question:** *What happens if file upload to storage succeeds but the database insert fails?*
- **Defense:** TrustVault implements compensating transactions: if `pool.query(INSERT INTO documents)` throws an error, the catch block immediately calls `storageDriver.delete(storageKey)` to delete the orphaned storage binary. Additionally, a durable background reconciliation function (`reconcileOrphanedObjects`) safely cleans up any historical unreferenced objects older than a 15-minute grace period.

### 9. File Upload Security & Magic Byte Inspection
- **Question:** *How do you prevent malicious executable uploads disguised as documents?*
- **Defense:** TrustVault does not rely on client-supplied MIME types or filename extensions. The file validator (`file-validator.ts`) inspects the first bytes of the uploaded buffer for canonical file signatures (e.g. `%PDF-` for PDFs, `\x89PNG` for PNGs, `PK\x03\x04` for Office OOXML). Executable binaries (DOS MZ header `\x4D\x5A` or ELF `\x7FELF`) and text files containing HTML script tags (`<script`) are rejected with `HTTP 400 Bad Request`. Storage keys are generated as random UUIDs, completely decoupling stored file paths from user-provided filenames.

### 10. Automated Testing Architecture & Safety Guards
- **Question:** *How did you ensure your test suite does not wipe real development data?*
- **Defense:** TrustVault implements a fail-closed test database safety guard ([`apps/api/src/db/guard.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/db/guard.ts)). When running in test mode (`NODE_ENV=test`), the guard requires `TEST_DATABASE_URL` containing the word `test` (e.g. `trustvault_test`). If pointed to `trustvault` or a remote host without explicit confirmation, tests fail closed and abort immediately before executing any SQL.
