# TrustVault — Automated Testing & Verification Guide

This document details the test architecture, test suite organization, environment isolation mechanisms, fail-closed database guards, and verified test execution results for TrustVault.

---

## 1. Test Suite Architecture & Verification Baseline

TrustVault features a layered automated test suite developed with **Vitest 3** and **Supertest**. Tests are divided into isolated unit tests (which run in-memory without database access) and end-to-end integration tests (which execute against an isolated PostgreSQL test database).

### Current Verification Status (Verified October 24, 2026)
- **Total Test Files:** 18 passed (18)
- **Total Automated Tests:** 236 passed (236)
- **Failures / Skipped Tests:** 0
- **TypeScript Typecheck:** 0 errors across API and Web workspaces
- **Production Build:** 100% clean compilation for API (`tsc`) and Web (`vite build`)

```
Test Distribution:
├── Unit Test Suites (9 files, 59 tests)
│   ├── apply-test-migration.test.ts (5 tests)
│   ├── argon2.test.ts (10 tests)
│   ├── cookie-security.test.ts (1 test)
│   ├── csrf.test.ts (8 tests)
│   ├── file-validator.test.ts (13 tests)
│   ├── guard.test.ts (9 tests)
│   ├── health.test.ts (2 tests)
│   ├── reconciliation.test.ts (5 tests)
│   └── sanitizer.test.ts (6 tests)
└── Integration Test Suites (9 files, 177 tests)
    ├── admin.test.ts (15 tests)
    ├── audit.test.ts (14 tests)
    ├── auth.test.ts (20 tests)
    ├── authorization.test.ts (23 tests)
    ├── lifecycle.test.ts (47 tests)
    ├── profile.test.ts (7 tests)
    ├── rate-limit.test.ts (2 tests)
    ├── rls.test.ts (24 tests)
    └── security.test.ts (25 tests)
```

---

## 2. Test Execution Commands

All commands are defined in root and workspace [`package.json`](file:///c:/Users/ruthv/Projects/trustvault/package.json) files. Run them from the project root:

### Primary Test Commands
```bash
# Run entire test suite (Unit + Integration)
npm test

# Run unit tests only (Fast, in-memory, no database required)
npm run test:unit

# Run integration tests only (Requires dedicated test database)
npm run test:integration

# Typecheck all workspaces (apps/api and apps/web)
npm run typecheck

# Full production build (API tsc + Web vite)
npm run build
```

### Database Utilities (Workspace Commands)
```bash
# Verify test database connection and schema status
npm run db:check --workspace=apps/api

# Apply database migrations to the isolated test database
npm run db:migrate:test --workspace=apps/api
```

---

## 3. Test Database Isolation & Fail-Closed Guard

To ensure automated integration tests can never accidentally wipe, mutate, or leak data from a development or production database, TrustVault enforces a strict **fail-closed test database guard** in [`apps/api/src/db/guard.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/db/guard.ts).

### Guard Rules & Invariants
1. **Mandatory Environment Variable:** In test mode (`NODE_ENV=test`), `TEST_DATABASE_URL` must be explicitly configured. `DATABASE_URL` is completely ignored.
2. **Database Name Requirement:** The database name in the connection URI **must contain the word `test`** (e.g. `postgresql://.../trustvault_test`). If it points to `trustvault` or any non-test database, the guard throws an immediate fatal error:
   ```
   FATAL TEST DATABASE SAFETY GUARD TRIGGERED: Refusing to run tests against database 'trustvault'.
   Automated tests require a dedicated test database whose name contains 'test'.
   ```
3. **Remote Host Guard:** If `TEST_DATABASE_URL` points to an external/cloud host (anything other than `localhost`, `127.0.0.1`, or `::1`), it strictly requires the confirmation flag:
   ```env
   TRUSTVAULT_TEST_DB_CONFIRMED=true
   ```
4. **In-Memory Stub for Unit Tests:** When unit tests run without a database configured, `apps/api/src/db/pool.ts` returns a fail-closed stub. Any accidental query attempt throws immediately, guaranteeing unit tests never perform unintended external I/O.

---

## 4. Test Environment Configuration (`.env.test`)

To run integration tests, create a `.env.test` file in the repository root by copying [`.env.test.example`](file:///c:/Users/ruthv/Projects/trustvault/.env.test.example):

```env
# Dedicated disposable/local test database connection string
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trustvault_test

# Confirmation flag required only when running tests against dedicated cloud test databases
# TRUSTVAULT_TEST_DB_CONFIRMED=true

# Isolated test storage bucket (in-memory driver is used by default in tests)
TEST_STORAGE_BUCKET=trustvault-test-isolated
```

> [!WARNING]
> Never copy your production database URL into `.env.test`. The test suite drops and recreates test tables during test execution.

---

## 5. Detailed Test Suite Organization

### Unit Tests (`apps/api/tests/unit`)
These tests validate isolated algorithms, security helpers, and parsers:

1. **`argon2.test.ts` (10 tests):** Verifies password hashing parameters, OWASP-compliant memory cost (19 MiB), side-channel resistant verification, `checkNeedsRehash` detection, and dummy verification.
2. **`cookie-security.test.ts` (1 test):** Verifies that session cookies enforce `HttpOnly`, `SameSite=Lax`, and `__Host-` prefixing in production.
3. **`csrf.test.ts` (8 tests):** Verifies cryptographically secure CSRF token issuance, timing-safe equality verification, and origin allowlist validation.
4. **`file-validator.test.ts` (13 tests):** Validates magic byte signatures (PDF, PNG, JPEG, WebP, Office OOXML), script tag detection in text files, DOS MZ/ELF executable rejection, and size boundaries.
5. **`guard.test.ts` (9 tests):** Validates the fail-closed database guard against malformed URLs, non-test database names, production hostnames, and missing parameters.
6. **`health.test.ts` (2 tests):** Validates the `/health` liveness probe.
7. **`reconciliation.test.ts` (5 tests):** Unit tests the orphan storage reconciliation algorithm, pagination boundaries, and scan budget limits (`maxScanned`).
8. **`sanitizer.test.ts` (6 tests):** Validates strict allowlist filtering for audit metadata, preventing secret or credential leakage.

---

### Integration Tests (`apps/api/tests/integration`)
These tests spin up the Express API application via Supertest and execute end-to-end workflows against PostgreSQL:

1. **`auth.test.ts` (20 tests):**
   - User registration with role restriction (strict `viewer` assignment).
   - Password authentication with Argon2id and session fixation protection (`regenerate`).
   - Anti-enumeration generic errors on failed logins.
   - Session termination and multi-session revocation on password change.
   - Disabled account enforcement (`status = 'disabled'`).
2. **`authorization.test.ts` (23 tests):**
   - Centralized document access decisions (`authorizeDocumentAccess`).
   - Owner full permissions vs grantee permissions (`read` vs `edit`).
   - Anti-enumeration 404 responses for nonexistent, unauthorized, and soft-deleted documents.
   - Prevention of self-granting and duplicate active grants.
3. **`lifecycle.test.ts` (47 tests):**
   - Multipart file upload streaming and storage persistence.
   - In-memory and Supabase storage driver operations.
   - Compensating deletion upon database failure (two-phase consistency).
   - Orphan storage reconciliation logic and grace periods.
   - Download streaming with RFC 6266/5987 header sanitization.
4. **`audit.test.ts` (14 tests):**
   - Append-only audit log persistence across all authentication and document events.
   - Strict server-side `actor_id` attribution from session.
   - HTTP 405 Method Not Allowed on mutation attempts.
   - Document-level audit access (owner only) vs system audit access (admin only).
5. **`security.test.ts` (25 tests):**
   - Global error handler JSON syntax interception (400) and payload limit enforcement (413).
   - Absolute session timeout (24 hours) and idle timeout (8 hours).
   - SQL injection resistance on parameterized search and filter queries.
   - Concurrent revocation race condition handling.
6. **`rate-limit.test.ts` (2 tests):**
   - IP-based rate limiting on sensitive authentication and upload endpoints.
7. **`rls.test.ts` (24 tests):**
   - Dedicated Row Level Security regression test suite. See Section 6 for full details.

---

## 6. Row Level Security (RLS) Regression Suite

The RLS test suite in [`apps/api/tests/integration/rls.test.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/tests/integration/rls.test.ts) verifies PostgreSQL database-level security policies independently of application middleware.

### Test Isolation Mechanism
Because the standard test runner connects with the `postgres` superuser (which has `BYPASSRLS`), the RLS suite executes queries inside transactions that temporarily switch database roles using:
```sql
SET LOCAL ROLE trustvault_restricted_tester;
SET LOCAL trustvault.current_user_id = '<user-uuid>';
```
This guarantees that PostgreSQL RLS policies are rigorously evaluated by the PostgreSQL engine.

### Verified Security Properties (24 Tests)
1. **Default Deny:** Unauthenticated / anonymous database connections cannot read any rows from `users`, `documents`, `document_grants`, `audit_events`, or `sessions`.
2. **User Isolation:** An active user can only SELECT their own user row. Admin users can view all users.
3. **Privilege Escalation Prevention:** An active user cannot update their own `role` from `viewer` to `admin` or `owner`.
4. **Document Access Boundaries:**
   - Owners can SELECT their active documents.
   - Grantees with active grants can SELECT documents shared with them.
   - Non-owners without grants cannot SELECT other users' documents.
   - Soft-deleted documents (`deleted_at IS NOT NULL`) are invisible to SELECT queries.
5. **Document Mutation Controls:**
   - Only users with role `owner` or `admin` can INSERT documents. Viewers cannot insert documents.
   - Edit grantees can update `title` and `category`, but cannot soft-delete or transfer ownership.
   - Non-owners cannot DELETE documents.
6. **Immutable Storage Columns:**
   - Any attempt by a non-service role to modify `storage_key`, `mime_type`, or `size_bytes` via SQL UPDATE triggers error `42501` (`trg_documents_immutable_columns`).
7. **Grant Management Restrictions:**
   - Only document owners can INSERT, UPDATE, or DELETE grants for their documents.
   - Users cannot grant permissions to themselves.
8. **Append-Only Audit Log Enforcement:**
   - Regular users cannot UPDATE or DELETE rows in `public.audit_events` (0 rows affected or permission denied).
   - Document owners can only read audit events for documents they own.
   - Admins can read all audit events.
9. **Session Isolation:**
   - Direct SELECT or modification of `public.sessions` is blocked for all non-superusers.

---

## 7. Troubleshooting Test Failures

### Issue: "FATAL TEST DATABASE SAFETY GUARD TRIGGERED"
- **Cause:** `TEST_DATABASE_URL` is pointing to a database that does not have `test` in its name.
- **Fix:** Update `.env.test` so the database name is `trustvault_test` or append `?trustvault_test=true`.

### Issue: "relation 'public.users' does not exist"
- **Cause:** Migrations have not been applied to the test database.
- **Fix:** Run the test migration script:
  ```bash
  npm run db:migrate:test --workspace=apps/api
  ```

### Issue: "role 'trustvault_restricted_tester' does not exist"
- **Cause:** The RLS migration created the fallback role, but connection lacks privileges to switch roles.
- **Fix:** The test suite automatically creates and drops necessary session roles when run with superuser privileges on local PostgreSQL. Ensure your test connection has `CREATEROLE` privileges.

### Issue: Storage Provider Timeouts during Integration Tests
- **Cause:** Network latency if connecting to a remote Supabase instance.
- **Fix:** Integration tests automatically mock or isolate storage operations using the in-memory driver unless `TEST_STORAGE_BUCKET` is configured with valid cloud credentials.

---

## 8. Continuous Integration (GitHub Actions Pipeline)

TrustVault's automated CI pipeline is configured in [`.github/workflows/ci.yml`](file:///c:/Users/ruthv/Projects/trustvault/.github/workflows/ci.yml).

### Pipeline Triggers & Concurrency
- **Triggers:**
  - `push` to branch `master`.
  - `pull_request` targeting `master`.
  - Manual execution via `workflow_dispatch`.
- **Concurrency Control:**
  - Redundant pull request builds are automatically cancelled when new commits are pushed (`cancel-in-progress: true` for PRs).
  - Pushes to `master` run to completion without interruption.
- **Permissions:** Strictly read-only (`permissions: contents: read`).

### Ephemeral Database Provisioning
The CI workflow provisions an isolated, disposable PostgreSQL service container:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: trustvault_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 5s
      --health-timeout 5s
      --health-retries 5
```

### CI Job Step Sequence
1. **Repository Checkout:** Uses `actions/checkout@v4`.
2. **Node.js Environment:** Uses `actions/setup-node@v4` with Node.js 22 LTS and automatic npm dependency caching based on `package-lock.json`.
3. **Reproducible Installation:** Executes `npm ci`.
4. **Workspace Verification:** Executes `npm ls --depth=0` to confirm tree integrity.
5. **TypeScript Compilation Check:** Executes `npm run typecheck` (`tsc --noEmit` across `@trustvault/api` and `@trustvault/web`).
6. **Production Build:** Executes `npm run build` (`build:api` and `build:web`).
7. **Database Migration Runner:** Executes `npm run db:migrate:test --workspace=apps/api`.
   - Resolves `TEST_DATABASE_URL` directly from the CI environment.
   - Validates the database URL against `assertTestDatabase(testUrl)`.
   - Checks if `public.users` exists. On the fresh CI container, applies base schema [`20261020161159_create_trustvault_schema.sql`](file:///c:/Users/ruthv/Projects/trustvault/supabase/migrations/20261020161159_create_trustvault_schema.sql) and idempotent RLS migration [`20261024103000_enable_row_level_security.sql`](file:///c:/Users/ruthv/Projects/trustvault/supabase/migrations/20261024103000_enable_row_level_security.sql).
8. **Automated Test Suite:** Executes `npm test` (all 16 test files, 214 tests).

### Security Guarantees in CI
- **Zero Production Access:** No production credentials, Supabase API keys, or production database URLs exist in the CI environment.
- **Fail-Closed Guard Verified:** If `TEST_DATABASE_URL` were missing or pointed to a production URL, the job would immediately abort.
- **In-Memory Storage:** The test environment runs with `InMemoryStorageDriver`, ensuring no external S3/Supabase storage buckets are contacted.

