# TrustVault

TrustVault is a secure document-sharing platform featuring per-document authorization, robust server-side session authentication, and an immutable access audit trail.

---

## Architecture Overview

TrustVault is organized as an npm workspace monorepo:

- **`apps/api`**: Express 5 backend with PostgreSQL connection pooling, Argon2id password hashing, server-side session management (`connect-pg-simple`), strict CORS, Helmet security headers, and CSRF protection.
- **`apps/web`**: React + Vite frontend SPA.
- **`supabase/`**: Declarative schema migrations and Supabase configuration.

---

## Environment Configuration

Copy `.env.example` to `.env` in the repository root:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Description | Example / Default |
|:---|:---|:---|
| `NODE_ENV` | Runtime environment (`development`, `test`, `production`) | `development` |
| `PORT` | API server listen port | `4000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:...@...:5432/postgres` |
| `SUPABASE_URL` | Supabase API URL | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase server-side service role key | (Secret) |
| `FRONTEND_ORIGIN` | Allowed client origin for CORS & CSRF validation | `http://localhost:5173` |
| `SESSION_SECRET` | Cryptographic secret for signing session cookies (min 32 chars) | (64-char hex string) |
| `SUPABASE_STORAGE_BUCKET` | Storage bucket for private encrypted files | `trustvault-private` |
| `TRUST_PROXY` | Reverse proxy trust configuration (`false`, `true`, or subnet CIDR) | `false` |

---

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Verify Database Connectivity

```bash
npm run db:check --workspace=apps/api
```

### 3. Run the Development Server

```bash
npm run dev:api
```

The API will be available at `http://localhost:4000`.

---

## Authentication API Reference

All authentication endpoints are mounted under `/api/auth`.

### `GET /api/auth/csrf-token`
- **Description:** Issues or retrieves a session-bound, cryptographically random CSRF token.
- **Authentication:** None required.
- **Response (200 OK):**
  ```json
  { "csrfToken": "4f1a...64-char-hex" }
  ```

### `POST /api/auth/register`
- **Description:** Creates a new user account with the least-privileged `viewer` role.
- **Authentication:** None required.
- **Rate Limit:** 5 registrations per hour per IP.
- **Input Validation:**
  - `email`: Valid email, max 255 chars, normalized to lowercase.
  - `password`: String, min 12 characters, max 128 characters.
  - Strict schema: Client-supplied `role`, `status`, or extraneous fields are rejected with HTTP 400.
- **Response (201 Created):**
  ```json
  {
    "message": "Registration successful. Please log in.",
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "role": "viewer",
      "status": "active",
      "createdAt": "2026-10-21T..."
    }
  }
  ```

### `POST /api/auth/login`
- **Description:** Authenticates user credentials, provides enumeration-resistant responses, mitigates timing attacks via Argon2id dummy verification, regenerates session ID to prevent fixation, and issues a session cookie.
- **Authentication:** None required.
- **Rate Limit:** 10 attempts per 15 minutes per IP.
- **Response (200 OK):**
  ```json
  {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "role": "viewer",
      "status": "active"
    }
  }
  ```
- **Error Response (401 Unauthorized):**
  ```json
  { "error": "Invalid email or password" }
  ```
  *(Identical response and execution timing for unknown accounts, incorrect passwords, and disabled accounts).*

### `GET /api/auth/me`
- **Description:** Returns the current authenticated user identity verified against the authoritative database.
- **Authentication:** Valid session cookie required.
- **Response (200 OK):**
  ```json
  {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "role": "viewer",
      "status": "active"
    }
  }
  ```

### `POST /api/auth/logout`
- **Description:** Destroys the server-side session in PostgreSQL and clears the client-side session cookie.
- **Authentication:** Valid session cookie required.
- **Response (200 OK):**
  ```json
  { "message": "Logged out successfully" }
  ```

### `POST /api/auth/change-password`
- **Description:** Authenticated password update requiring current password verification. Updates to a fresh Argon2id hash and revokes all other concurrent active sessions for the user.
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Input:**
  - `currentPassword`: Required.
  - `newPassword`: Min 12 chars, max 128 chars.
- **Response (200 OK):**
  ```json
  { "message": "Password changed successfully" }
  ```

---

## Document Authorization API Reference

All document endpoints are mounted under `/api/documents` and enforce server-side session authentication (`requireAuth`). State-changing requests (`POST`, `PATCH`, `DELETE`) require Origin/Referer validation and session-bound CSRF tokens (`x-csrf-token`).

### Authorization Rules
- **Document Owners:** Can list, read metadata, stream content, update permitted metadata (`title`, `category`), soft-delete their own documents, and manage grants (list, create, update, revoke).
- **Users with `read` Grant:** Can view metadata and download/stream content. Cannot edit metadata, soft-delete, or manage grants.
- **Users with `edit` Grant:** Can view metadata, stream content, and update permitted metadata (`title`, `category`). Cannot soft-delete or manage grants.
- **Administrators:** Do **not** automatically bypass authorization or gain access to private document contents without an explicit grant.
- **Disabled Users:** Denied immediately at the authentication barrier.
- **Anti-Enumeration:** Requests for non-existent, soft-deleted, or unauthorized documents return uniform `404 Not Found` responses to prevent resource discovery and IDOR scanning.
- **Immediate Revocation:** Every authorization check queries authoritative database state in real time.

### `GET /api/documents`
- **Description:** Lists only documents the caller owns or has an active grant for. Supports search and category filtering at the SQL query level.
- **Authentication:** Valid session required.
- **Query Parameters:**
  - `search` (optional string): case-insensitive title search.
  - `category` (optional string): exact category match.
  - `limit` (optional integer, default 50, max 100).
  - `offset` (optional integer, default 0).
- **Response (200 OK):**
  ```json
  {
    "documents": [
      {
        "id": "uuid",
        "title": "Q3 Financials",
        "category": "Finance",
        "mimeType": "text/plain",
        "sizeBytes": 1024,
        "createdAt": "2026-10-22T...",
        "updatedAt": "2026-10-22T...",
        "isOwner": true,
        "permission": "owner"
      }
    ],
    "pagination": { "total": 1, "limit": 50, "offset": 0 }
  }
  ```

### `POST /api/documents`
- **Description:** Uploads, validates, and creates a new document. Supports streaming `multipart/form-data` uploads (with bounded memory and temporary-file cleanup) as well as `application/json` payloads. Server-side validation inspects file magic bytes, enforces maximum file sizes, and generates unguessable UUID storage keys. Sets `owner_id` strictly from authenticated session identity. Restricted to `owner` and `admin` roles (`viewer` role receives HTTP 403).
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Rate Limits & Concurrency:** 20 uploads / 15 min per IP; bounded concurrency semaphore (max 10 active concurrent uploads).
- **File Validation Policies:**
  - **Maximum File Size:** 10 MiB (`10485760` bytes) enforced during streaming and before DB persistence. Empty files (0 bytes) rejected with HTTP 400. Files exceeding limit rejected with HTTP 413 Payload Too Large.
  - **Allowlisted MIME Types:** `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX).
  - **Content Inspection:** Detects magic byte signatures (PDF `%PDF-`, PNG `\x89PNG`, JPEG `\xFF\xD8\xFF`, WebP `RIFF..WEBP`, Office `PK\x03\x04`). Rejects executable binaries (DOS MZ, ELF) and embedded active script tags (`<script>`, `<?php`). Never trusts client-declared `Content-Type` or file extensions.
  - **`application/octet-stream` Policy:** `application/octet-stream` is treated strictly as an undeclared/generic MIME type and is NEVER permitted as the final document MIME type. Uploads declaring `application/octet-stream` are inspected for genuine magic byte signatures; if the content independently matches an allowlisted format (e.g., PDF or PNG), it is accepted under that verified format. If the content cannot be verified against the allowlist, the upload is rejected with HTTP 400 Bad Request.
  - **JSON Document Validation:** JSON files of any size up to 10 MiB are validated for syntactic correctness. If a document is declared as `application/json` or uploaded with a `.json` extension, it must parse successfully as valid JSON; malformed JSON is rejected with HTTP 400 Bad Request.
  - **Filename Validation & Rejection:** Filenames containing null bytes (`\0`) or invalid ASCII control characters (`[\x00-\x1f\x7f]`) are rejected immediately with HTTP 400 Bad Request. Malicious inputs are not silently normalized or stripped. Storage keys are generated exclusively on the server using cryptographically random UUIDv4 and verified extensions; client filenames are never used for storage paths or filesystem operations.
- **Payload Options:**
  - **Option A (`multipart/form-data`):**
    - `title`: String (1-200 chars).
    - `category`: String (1-100 chars).
    - `file`: File binary stream (attached file part). Temporary files are created with owner-only mode `0600` and `wx` exclusive flags, flushed before reading, and cleaned up across all failure paths.
  - **Option B (`application/json`):**
    - `title`: String (1-200 chars).
    - `category`: String (1-100 chars).
    - `content`: Non-empty text or base64 string.
    - `mimeType`: String (optional, default `text/plain`).
    - `filename`: String (optional, max 255 chars, rejects null bytes/control chars).
- **Consistency & Failure Recovery:**
  - Storage upload occurs before database insertion.
  - If database insertion fails after storage upload succeeds, a compensating delete immediately purges the uploaded object from storage.
  - If compensating cleanup fails, a `storage_cleanup_failed` audit event is logged with the unguessable storage key for offline reconciliation, while preserving the original database error.
  - A durable reconciliation function (`reconcileOrphanedObjects`) safely paginates through storage objects in configurable batches (default 100). If listing or pagination fails at any point, reconciliation aborts immediately without deleting any files.
  - *Reconciliation Race Prevention:* To protect in-flight uploads whose database transactions have not yet committed, reconciliation enforces a 15-minute grace period (`gracePeriodMs: 900000`). Any object created within the grace window is preserved. Remaining race conditions are limited to transactions stalled longer than the grace period.
- **Response (201 Created):**
  ```json
  {
    "message": "Document created successfully",
    "document": {
      "id": "uuid",
      "title": "Q3 Financials",
      "category": "Finance",
      "mimeType": "application/pdf",
      "sizeBytes": 1048576,
      "createdAt": "2026-10-22T...",
      "updatedAt": "2026-10-22T...",
      "isOwner": true,
      "permission": "owner"
    }
  }
  ```

### `GET /api/documents/:id`
- **Description:** Returns document metadata. Requires ownership or an active grant. Returns 404 for unauthorized callers.
- **Authentication:** Valid session cookie required.
- **Security & Cache Headers Enforced:**
  - `Cache-Control: private, no-store, no-cache, must-revalidate` (instructs browsers and intermediary proxies not to persist confidential metadata in HTTP caches)
  - `Pragma: no-cache`
- **Response (200 OK):**
  ```json
  {
    "document": {
      "id": "uuid",
      "title": "Q3 Financials",
      "category": "Finance",
      "mimeType": "application/pdf",
      "sizeBytes": 1048576,
      "createdAt": "2026-10-22T...",
      "updatedAt": "2026-10-22T...",
      "isOwner": false,
      "permission": "read"
    }
  }
  ```

### `GET /api/documents/:id/download`
- **Description:** Streams authorized document bytes directly through a server-mediated streaming pipeline. Never exposes internal storage keys, credentials, or signed URLs.
- **Authentication:** Valid session cookie required.
- **Rate Limits:** 100 downloads / 15 min per IP.
- **Security & Cache Headers Enforced:**
  - `Content-Type: <validated_mime_type>`
  - `Content-Disposition: attachment; filename="<sanitized_ascii>"; filename*=UTF-8''<rfc5987_encoded>` (RFC 6266 / RFC 5987 compliant header encoding preventing HTTP response splitting and header injection)
  - `Content-Length: <size_bytes>`
  - `Cache-Control: private, no-store, no-cache, must-revalidate` (prevents client-side disk, shared proxy, and browser cache persistence)
  - `Pragma: no-cache`
  - `X-Content-Type-Options: nosniff` (mitigates MIME-sniffing execution attacks)
  - *Client-Side Caching Guarantees & Limitations:* HTTP cache-control headers prevent intermediary proxy and browser cache persistence; however, they cannot prevent a user from explicitly saving a downloaded file to their local filesystem, taking screenshots, or retain copies that have already been transferred to an untrusted client device.
- **Response (200 OK):** Binary stream or text content.

### `PATCH /api/documents/:id`
- **Description:** Updates permitted document metadata (`title`, `category`). Requires document ownership OR active `edit` grant.
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Input:**
  - `title` (optional string, 1-200 chars).
  - `category` (optional string, 1-100 chars).
- **Response (200 OK):**
  ```json
  {
    "message": "Document updated successfully",
    "document": { ... }
  }
  ```

### `DELETE /api/documents/:id`
- **Description:** Soft-deletes a document (`deleted_at = now()`). Restricted strictly to document owner.
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Response (200 OK):**
  ```json
  { "message": "Document deleted successfully" }
  ```

### `GET /api/documents/:id/grants`
- **Description:** Lists all active and historical revoked grants for the document. Restricted strictly to document owner.
- **Authentication:** Valid session cookie required.
- **Response (200 OK):**
  ```json
  {
    "grants": [
      {
        "id": "uuid",
        "documentId": "uuid",
        "userId": "uuid",
        "userEmail": "colleague@example.com",
        "permission": "read",
        "grantedBy": "uuid",
        "createdAt": "2026-10-22T...",
        "revokedAt": null,
        "isActive": true
      }
    ]
  }
  ```

### `POST /api/documents/:id/grants`
- **Description:** Grants access to a user via email lookup. Validates recipient status (`active`), prevents duplicate active grants (409 Conflict), disallows self-granting, and safely supports re-granting after revocation while preserving historical audit rows. Restricted strictly to document owner.
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Input:**
  - `email`: Recipient email address.
  - `permission`: `"read"` or `"edit"`.
- **Response (201 Created):**
  ```json
  {
    "message": "Access granted successfully",
    "grant": { ... }
  }
  ```

### `PATCH /api/documents/:id/grants/:grantId`
- **Description:** Updates an active grant's permission (`read` <-> `edit`). Restricted strictly to document owner.
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Input:**
  - `permission`: `"read"` or `"edit"`.
- **Response (200 OK):**
  ```json
  { "message": "Grant updated successfully", "grant": { ... } }
  ```

### `DELETE /api/documents/:id/grants/:grantId`
- **Description:** Immediately revokes access (`revoked_at = now()`). Subsequent requests by grantee are denied immediately without cache delay. Restricted strictly to document owner.
- **Authentication:** Valid session cookie required.
- **Headers:** `x-csrf-token: <csrfToken>` required.
- **Response (200 OK):**
  ```json
  { "message": "Grant revoked successfully" }
  ```

---

## Security Controls Summary

- **Password Hashing:** Argon2id with reviewed OWASP parameters (19 MiB memory, 2 passes, 1 thread). Bounded concurrency limiter (max 10 concurrent hashes).
- **Password Policy:** NIST SP 800-63B aligned (min 12, max 128 chars, full Unicode and whitespace support, no silent truncation).
- **Session Security:** Server-side sessions backed by PostgreSQL `public.sessions`. Session fixation protection (`req.session.regenerate()`), 8-hour idle timeout, 24-hour absolute expiration, `HttpOnly`, `SameSite=Lax`, and `__Host-` cookie name in production.
- **Account Disablement & Invalidation:** Authoritative real-time DB lookup on every request. Immediate 403 on disabled accounts. Password change deletes all other user sessions.
- **CSRF Protection:** Strict `Origin` and `Referer` validation against `FRONTEND_ORIGIN` on all state-changing methods + synchronizer token (`x-csrf-token`) on protected operations.
- **CORS:** Restrictive CORS allowlist matching only `FRONTEND_ORIGIN`. Credentialed access without wildcard reflection.
- **Document Authorization:** Centralized engine evaluating ownership, active grants (`read` vs `edit`), soft deletion, and administrator boundary in single parameterized queries.
- **Anti-Enumeration & Safe Responses:** Uniform 404 responses for inaccessible or non-existent documents prevent resource enumeration.
- **Immediate Revocation:** Authorization decisions are evaluated in real-time against PostgreSQL with no long-lived token/session grant caches.
- **Storage Boundary:** Private Supabase Storage bucket (`trustvault-private`) with server-controlled UUID storage keys. Downloads streamed strictly through authenticated, authorized endpoints.
- **Audit Logging:** Append-oriented logging in `public.audit_events` recording actions, outcomes, and actors without leaking document contents or secrets.

---

## Testing & Verification

Run the automated test suite:

```bash
# Run all tests across workspaces
npm test

# Run API test suite directly
npm run test --workspace=apps/api

# Type-check TypeScript code
npm run typecheck

# Production build verification
npm run build
```
