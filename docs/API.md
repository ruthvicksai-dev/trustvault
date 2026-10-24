# TrustVault — REST API Reference Specification

This document provides the definitive specification of all HTTP endpoints registered in the TrustVault Express API (`apps/api`). Every endpoint, parameter, schema, status code, and authorization rule documented here directly reflects the source code in [`apps/api/src`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src).

---

## 1. Architectural Principles & Security Invariants

### Independent Server-Side Authorization
The TrustVault server enforces all access control and permission checks independently of client-side visibility or frontend UI state:
- **Zero Frontend Trust:** The server never trusts client assertions regarding user identity, ownership, grant state, or role.
- **Authoritative Database Lookups:** Every authenticated request verifies the user's active status against `public.users` in PostgreSQL. If an account is disabled, the session is rejected with HTTP 401/403 regardless of cookie validity.
- **Centralized Document Gatekeeper:** Document metadata, download streams, updates, and deletions pass through `authorizeDocumentAccess()` ([`apps/api/src/documents/authorization.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts)). Grantees cannot delete or share documents.
- **Anti-Enumeration Responses:** Requests for documents that do not exist, have been soft-deleted, or belong to other users without an active grant return uniform `HTTP 404 Not Found` (`{"error": "Document not found"}`). The API never discloses whether a document ID exists to an unauthorized caller.
- **Cache Prevention:** All sensitive document and audit endpoints emit:
  ```http
  Cache-Control: private, no-store, no-cache, must-revalidate
  Pragma: no-cache
  ```

### Cross-Site Request Forgery (CSRF) & State-Changing Requests
All state-changing endpoints (`POST`, `PATCH`, `DELETE`) require:
1. **Origin/Referer Verification:** Validated by `validateOrigin` ([`apps/api/src/auth/middleware.ts`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/auth/middleware.ts)) against `FRONTEND_ORIGIN`.
2. **Synchronizer Token:** Validated by `requireCsrfToken` against the session-bound token using constant-time comparison (`crypto.timingSafeEqual`). The token must be sent in the `x-csrf-token` HTTP header.

### Global Error & Rate Limiting Norms
- **Malformed JSON:** HTTP 400 (`{"error": "Malformed JSON payload in request body"}`).
- **Oversized Body:** HTTP 413 (`{"error": "Request payload exceeds maximum permitted size"}`).
- **Rate Limit Exceeded:** HTTP 429 (`{"error": "Too many requests. Please retry later."}`).
- **Concurrency Saturation:** HTTP 429 (`{"error": "Server busy processing requests. Please retry shortly."}`).
- **Internal Errors:** HTTP 500 (`{"error": "Internal server error"}`). Internal database error messages and stack traces are suppressed in all environments.

---

## 2. API Endpoints Summary

| Method | Endpoint | Auth | Required Permission / Role | CSRF Token | Rate Limited |
|:---|:---|:---|:---|:---|:---|
| `GET` | `/health` | Public | None | No | No |
| `GET` | `/api/auth/csrf-token` | Public | None | No | Auth Limiter |
| `POST` | `/api/auth/register` | Public | None (creates `viewer`) | No | Auth + Register Limiter |
| `POST` | `/api/auth/login` | Public | None | No | Auth + Login Limiter |
| `POST` | `/api/auth/logout` | Authenticated | Any active user | No | Auth Limiter |
| `GET` | `/api/auth/me` | Authenticated | Any active user | No | Auth Limiter |
| `POST` | `/api/auth/change-password` | Authenticated | Any active user | **Required** | Auth Limiter |
| `PATCH` | `/api/auth/profile` | Authenticated | Any active user | **Required** | Auth Limiter |
| `GET` | `/api/admin/users` | Authenticated | Role `admin` ONLY | No | No |
| `GET` | `/api/admin/users/:id` | Authenticated | Role `admin` ONLY | No | No |
| `PATCH` | `/api/admin/users/:id/role` | Authenticated | Role `admin` ONLY | **Required** | No |
| `PATCH` | `/api/admin/users/:id/status` | Authenticated | Role `admin` ONLY | **Required** | No |
| `PATCH` | `/api/admin/users/:id` | Authenticated | Role `admin` ONLY | **Required** | No |
| `GET` | `/api/documents` | Authenticated | Active user (`owner`, `admin`, `viewer`) | No | No |
| `POST` | `/api/documents` | Authenticated | Role `owner` or `admin` | **Required** | Upload Limiter + Concurrency |
| `GET` | `/api/documents/:id` | Authenticated | Document Owner OR Active Grantee (`read` or `edit`) | No | No |
| `GET` | `/api/documents/:id/download` | Authenticated | Document Owner OR Active Grantee (`read` or `edit`) | No | Download Limiter |
| `PATCH` | `/api/documents/:id` | Authenticated | Document Owner OR Active Grantee (`edit`) | **Required** | No |
| `DELETE` | `/api/documents/:id` | Authenticated | Document Owner ONLY | **Required** | No |
| `GET` | `/api/documents/:id/grants` | Authenticated | Document Owner ONLY | No | No |
| `POST` | `/api/documents/:id/grants` | Authenticated | Document Owner ONLY | **Required** | No |
| `PATCH` | `/api/documents/:id/grants/:grantId` | Authenticated | Document Owner ONLY | **Required** | No |
| `DELETE` | `/api/documents/:id/grants/:grantId` | Authenticated | Document Owner ONLY | **Required** | No |
| `GET` | `/api/documents/:id/audit` | Authenticated | Document Owner ONLY | No | No |
| `*` | `/api/documents/:id/audit` | Authenticated | None (Method Not Allowed) | No | No |
| `GET` | `/api/audit` | Authenticated | Role `admin` ONLY | No | No |
| `*` | `/api/audit` | Authenticated | None (Method Not Allowed) | No | No |

---

## 3. System & Health Endpoints

### `GET /health`
Liveness and readiness health probe.

- **Authentication:** Public (None).
- **Responses:**
  - `200 OK`:
    ```json
    {
      "status": "ok",
      "service": "trustvault-api",
      "timestamp": "2026-10-24T12:00:00.000Z"
    }
    ```

---

## 4. Authentication Endpoints (`/api/auth`)

Mounted at `/api/auth`. All endpoints apply `generalAuthRateLimiter` (100 requests / 15 minutes per IP).

### `GET /api/auth/csrf-token`
Issues a cryptographically random, session-bound CSRF token (32 bytes hex).

- **Authentication:** Public.
- **Request Parameters:** None.
- **Response `200 OK`:**
  ```json
  {
    "csrfToken": "4f8a2b1c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a"
  }
  ```

---

### `POST /api/auth/register`
Public user registration. Enforces strict schema parsing and always assigns role `viewer` and status `active`. Self-assignment of `admin` or `owner` is strictly rejected.

- **Authentication:** Public.
- **Rate Limit:** `registerRateLimiter` (5 attempts / 15 minutes per IP).
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `email` | `string` | Valid email, max 255 chars, lowercased |
  | `password` | `string` | Min 12 chars, max 128 chars |
  *Note: Zod `.strict()` schema rejects any additional fields.*
- **Responses:**
  - `201 Created`:
    ```json
    {
      "message": "Registration successful. Please log in.",
      "user": {
        "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "email": "user@example.com",
        "role": "viewer",
        "status": "active",
        "createdAt": "2026-10-24T12:00:00.000Z"
      }
    }
    ```
  - `400 Bad Request`:
    ```json
    {
      "error": "Validation error",
      "details": [{ "field": "password", "message": "Password must be at least 12 characters" }]
    }
    ```
  - `409 Conflict`:
    ```json
    {
      "error": "An account with this email address already exists"
    }
    ```
  - `429 Too Many Requests`:
    ```json
    {
      "error": "Too many registration attempts. Please try again later."
    }
    ```

---

### `POST /api/auth/login`
Authenticates user credentials using Argon2id. Mitigates user enumeration and side-channel timing attacks by running a dummy hash calculation (`DUMMY_HASH`) if the email is not found or the account is disabled. Regenerates session ID upon successful login (`req.session.regenerate`).

- **Authentication:** Public.
- **Rate Limit:** `loginRateLimiter` (10 attempts / 15 minutes per IP).
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `email` | `string` | Valid email, max 255 chars |
  | `password` | `string` | Min 1 char, max 128 chars |
- **Responses:**
  - `200 OK` (Sets `Set-Cookie: trustvault.sid` or `__Host-trustvault.sid`):
    ```json
    {
      "user": {
        "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "email": "user@example.com",
        "role": "owner",
        "status": "active"
      }
    }
    ```
  - `401 Unauthorized`:
    ```json
    {
      "error": "Invalid email or password"
    }
    ```
  - `429 Too Many Requests`:
    ```json
    {
      "error": "Too many login attempts. Please try again later."
    }
    ```

---

### `POST /api/auth/logout`
Destroys the server-side session in `public.sessions` and clears the session cookie with matching attributes.

- **Authentication:** Required (`requireAuth`).
- **CSRF Token:** Not required (safe session termination).
- **Responses:**
  - `200 OK` (Clears session cookie):
    ```json
    {
      "message": "Logged out successfully"
    }
    ```
  - `401 Unauthorized`: If no valid session is present.

---

### `GET /api/auth/me`
Retrieves current authenticated user identity directly verified from PostgreSQL.

- **Authentication:** Required (`requireAuth`).
- **Responses:**
  - `200 OK`:
    ```json
    {
      "user": {
        "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "email": "user@example.com",
        "role": "owner",
        "status": "active"
      }
    }
    ```
  - `401 Unauthorized`: If unauthenticated or session expired.

---

### `POST /api/auth/change-password`
Validates current password, updates the stored Argon2id hash, and invalidates all other active sessions for this user in `public.sessions`.

- **Authentication:** Required (`requireAuth`).
- **CSRF Token:** Required (`requireCsrfToken`).
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `currentPassword` | `string` | String, 1–128 chars |
  | `newPassword` | `string` | Min 12 chars, max 128 chars |
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "Password changed successfully"
    }
    ```
  - `400 Bad Request`:
    ```json
    {
      "error": "Current password is incorrect"
    }
    ```
  - `403 Forbidden`: If CSRF token is missing or invalid.

---

### `PATCH /api/auth/profile`
Updates the authenticated user's profile metadata (`displayName`). Operating strictly on the session-authenticated user, client attempts to pass a target user ID or modify privileged fields (`role`, `status`, `password_hash`, `email`) are rejected.

- **Authentication:** Required (`requireAuth`).
- **CSRF Token:** Required (`requireCsrfToken`).
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `displayName` | `string \| null` | Optional/nullable. 1–100 chars, no script tags or HTML entities |
- **Security Protections:**
  - Strict input validation rejecting script/HTML injections.
  - Prevents role, status, or email modification via `.strict()` Zod schema.
  - Generates immutable `user_update_profile` audit log event with actor attribution.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "Profile updated successfully",
      "user": {
        "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "email": "user@example.com",
        "role": "owner",
        "status": "active",
        "displayName": "Alice Smith"
      }
    }
    ```
  - `400 Bad Request`: Validation error or illegal tags in `displayName`.
  - `401 Unauthorized`: If unauthenticated.
  - `403 Forbidden`: If CSRF token is missing or invalid.

---

## 5. Documents Endpoints (`/api/documents`)

Mounted at `/api/documents`. All endpoints require authentication (`requireAuth`) and emit `Cache-Control: private, no-store`.

### `GET /api/documents`
Lists accessible documents for the authenticated user. Returns documents owned by the user or shared with the user via an active, non-revoked grant. Never returns soft-deleted documents (`deleted_at IS NOT NULL`).

- **Authentication:** Required.
- **Query Parameters:**
  | Parameter | Type | Default | Description |
  |:---|:---|:---|:---|
  | `search` | `string` | None | Filters document title case-insensitively (`ILIKE %search%`) |
  | `category` | `string` | None | Exact match on category |
  | `limit` | `integer` | 50 | Bounded between 1 and 100 |
  | `offset` | `integer` | 0 | Pagination offset |
- **Responses:**
  - `200 OK`:
    ```json
    {
      "documents": [
        {
          "id": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
          "title": "Quarterly Financial Audit",
          "category": "Finance",
          "mimeType": "application/pdf",
          "sizeBytes": 1048576,
          "createdAt": "2026-10-24T10:00:00.000Z",
          "updatedAt": "2026-10-24T10:00:00.000Z",
          "isOwner": true,
          "permission": "owner"
        }
      ],
      "pagination": {
        "total": 1,
        "limit": 50,
        "offset": 0
      }
    }
    ```

---

### `POST /api/documents`
Creates a new document with strict upload validation. Supports both `multipart/form-data` and `application/json` (base64 or text) payloads.
- **Allowed Roles:** `owner` and `admin`. Role `viewer` receives `HTTP 403 Forbidden`.
- **Authentication:** Required.
- **CSRF Token:** Required.
- **Rate Limit & Concurrency:** `documentUploadRateLimiter` (20 uploads / 15 min per IP) and `uploadConcurrencyMiddleware` (max 10 concurrent uploads across server).
- **Allowed Formats:** PDF (`application/pdf`), PNG (`image/png`), JPEG (`image/jpeg`), WebP (`image/webp`), Plain Text (`text/plain`), Markdown (`text/markdown`), CSV (`text/csv`), JSON (`application/json`), Word (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`), Excel (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
- **File Validation Rules:**
  - Magic byte inspection verifies initial bytes match declared format.
  - Rejects DOS MZ executables (`MZ`) and ELF binaries (`\x7FELF`).
  - Text files rejected if containing null bytes or active script tags (`<script>`, `<?php`, `#!/bin/`).
  - Maximum size: 10 MiB (`10,485,760 bytes`). Empty files (0 bytes) rejected.
- **Payload 1: `multipart/form-data`:**
  - Form field `title`: 1–200 characters.
  - Form field `category`: 1–100 characters.
  - File field `file`: binary stream.
- **Payload 2: `application/json`:**
  ```json
  {
    "title": "Security Architecture Specification",
    "category": "Architecture",
    "mimeType": "application/pdf",
    "filename": "spec.pdf",
    "content": "JVBERi0xLjQKJeLjz9MKMSAwIG9iago..."
  }
  ```
- **Responses:**
  - `201 Created`:
    ```json
    {
      "message": "Document uploaded successfully",
      "document": {
        "id": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
        "title": "Security Architecture Specification",
        "category": "Architecture",
        "mimeType": "application/pdf",
        "sizeBytes": 1048576,
        "createdAt": "2026-10-24T12:00:00.000Z",
        "updatedAt": "2026-10-24T12:00:00.000Z",
        "isOwner": true,
        "permission": "owner"
      }
    }
    ```
  - `400 Bad Request`: Validation failure (empty file, invalid MIME type, title missing).
  - `403 Forbidden`: `{"error": "Forbidden: viewers cannot create documents"}`.
  - `413 Payload Too Large`: File exceeds 10 MiB.
  - `415 Unsupported Media Type`: Non-allowlisted format or content-type mismatch.

---

### `GET /api/documents/:id`
Retrieves document metadata. Protected by centralized authorization (`authorizeDocumentAccess`).

- **Authentication:** Required.
- **Authorization:** Document Owner OR Grantee with active `read` or `edit` grant.
- **Path Parameters:**
  - `id`: Document UUID.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "document": {
        "id": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
        "title": "Quarterly Financial Audit",
        "category": "Finance",
        "mimeType": "application/pdf",
        "sizeBytes": 1048576,
        "createdAt": "2026-10-24T10:00:00.000Z",
        "updatedAt": "2026-10-24T10:00:00.000Z",
        "isOwner": false,
        "permission": "read"
      }
    }
    ```
  - `404 Not Found`: Anti-enumeration response if document does not exist, is soft-deleted, or user has no access.

---

### `GET /api/documents/:id/download`
Downloads document content. Verifies authorization against PostgreSQL, then securely retrieves binary content from the private storage driver and streams to client.

- **Authentication:** Required.
- **Authorization:** Document Owner OR Grantee with active `read` or `edit` grant.
- **Rate Limit:** `documentDownloadRateLimiter` (30 downloads / 15 min per IP).
- **Headers Emitted:**
  - `Content-Type`: Document MIME type (e.g. `application/pdf`).
  - `Content-Disposition`: `attachment; filename="<sanitized>"; filename*=UTF-8''<encoded>`.
  - `Content-Length`: Exact byte count.
  - `X-Content-Type-Options: nosniff`.
  - `Cache-Control: private, no-store, no-cache, must-revalidate`.
- **Responses:**
  - `200 OK`: Binary file stream.
  - `404 Not Found`: Anti-enumeration response if unauthorized or document not found.
  - `500 Internal Server Error`: `{"error": "Failed to download document content"}` if storage cluster is unreachable.

---

### `PATCH /api/documents/:id`
Updates document metadata (`title` and/or `category`).

- **Authentication:** Required.
- **CSRF Token:** Required.
- **Authorization:** Document Owner OR Grantee with active `edit` grant. Grantees with `read` grant receive `HTTP 403 Forbidden`.
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `title` | `string` (optional) | 1–200 characters |
  | `category` | `string` (optional) | 1–100 characters |
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "Document updated successfully",
      "document": {
        "id": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
        "title": "Updated Audit Report 2026",
        "category": "Compliance",
        "mimeType": "application/pdf",
        "sizeBytes": 1048576,
        "createdAt": "2026-10-24T10:00:00.000Z",
        "updatedAt": "2026-10-24T12:05:00.000Z",
        "isOwner": true,
        "permission": "owner"
      }
    }
    ```
  - `403 Forbidden`: `{"error": "Forbidden: 'edit' permission required"}` (if user has only `read` grant).
  - `404 Not Found`: If unauthorized or document not found.

---

### `DELETE /api/documents/:id`
Soft-deletes a document (`deleted_at = now()`).
- **Authentication:** Required.
- **CSRF Token:** Required.
- **Authorization:** Document Owner ONLY. Grantees (even with `edit` permission) receive `HTTP 403 Forbidden`.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "Document deleted successfully"
    }
    ```
  - `403 Forbidden`: `{"error": "Forbidden: only the document owner may perform this action"}`.
  - `404 Not Found`: If document does not exist, is already deleted, or caller has no access.

---

## 6. Document Grants & Sharing Endpoints (`/api/documents/:id/grants`)

All grant management operations are restricted strictly to the **document owner**. Grantees and administrators without ownership receive `HTTP 403 Forbidden` or `HTTP 404 Not Found`.

### `GET /api/documents/:id/grants`
Lists all access grants (active and revoked) for a specific document.

- **Authentication:** Required.
- **Authorization:** Document Owner ONLY.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "grants": [
        {
          "id": "c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f",
          "documentId": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
          "userId": "e5f6a7b8-c9d0-1e2f-3a4b-5c6d7e8f9a0b",
          "userEmail": "auditor@example.com",
          "permission": "read",
          "grantedBy": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "createdAt": "2026-10-24T11:00:00.000Z",
          "revokedAt": null,
          "isActive": true
        }
      ]
    }
    ```

---

### `POST /api/documents/:id/grants`
Shares a document with another user by email. Prevents self-granting, duplicate active grants, and granting to disabled accounts.

- **Authentication:** Required.
- **CSRF Token:** Required.
- **Authorization:** Document Owner ONLY.
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `email` | `string` | Valid recipient email |
  | `permission` | `string` | Must be `'read'` or `'edit'` |
- **Responses:**
  - `201 Created`:
    ```json
    {
      "message": "Access granted successfully",
      "grant": {
        "id": "c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f",
        "documentId": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
        "userId": "e5f6a7b8-c9d0-1e2f-3a4b-5c6d7e8f9a0b",
        "recipientEmail": "auditor@example.com",
        "permission": "read",
        "grantedBy": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "createdAt": "2026-10-24T12:10:00.000Z"
      }
    }
    ```
  - `400 Bad Request`: Cannot grant to document owner, or cannot grant to a disabled account.
  - `404 Not Found`: Recipient email does not exist in `public.users`.
  - `409 Conflict`: An active grant already exists for this recipient.

---

### `PATCH /api/documents/:id/grants/:grantId`
Modifies an active grant's permission level (`'read'` $\leftrightarrow$ `'edit'`).

- **Authentication:** Required.
- **CSRF Token:** Required.
- **Authorization:** Document Owner ONLY.
- **Request Body (`application/json`):**
  | Field | Type | Validation Rules |
  |:---|:---|:---|
  | `permission` | `string` | Must be `'read'` or `'edit'` |
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "Grant updated successfully",
      "grant": {
        "id": "c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f",
        "documentId": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
        "userId": "e5f6a7b8-c9d0-1e2f-3a4b-5c6d7e8f9a0b",
        "permission": "edit",
        "grantedBy": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "createdAt": "2026-10-24T11:00:00.000Z",
        "revokedAt": null
      }
    }
    ```
  - `404 Not Found`: Active grant not found or already revoked.

---

### `DELETE /api/documents/:id/grants/:grantId`
Revokes an active access grant immediately (`revoked_at = now()`).
- **Authentication:** Required.
- **CSRF Token:** Required.
- **Authorization:** Document Owner ONLY.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "Grant revoked successfully"
    }
    ```
  - `404 Not Found`: Active grant not found or already revoked.

---

## 7. Audit Trail Endpoints

### `GET /api/documents/:id/audit`
Retrieves the complete audit trail for a specific document.
- **Authentication:** Required.
- **Authorization:** Document Owner ONLY.
- **Access Decisions:**
  - Document Owner: `200 OK` with events.
  - Active Grantee: `403 Forbidden` (`{"error": "Forbidden: only the document owner may view audit records"}`).
  - Non-owner / unauthorized: `404 Not Found` (anti-enumeration).
- **Query Parameters:**
  - `limit`: Integer (1–100, default 50).
  - `offset`: Integer (default 0).
- **Responses:**
  - `200 OK`:
    ```json
    {
      "events": [
        {
          "id": "1042",
          "actorId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "documentId": "7b8c9d0e-1f2a-4b5c-8d9e-0f1a2b3c4d5e",
          "action": "download_content",
          "outcome": "success",
          "reason": null,
          "metadata": { "mimeType": "application/pdf", "sizeBytes": 1048576 },
          "occurredAt": "2026-10-24T12:15:00.000Z"
        }
      ],
      "pagination": { "total": 1, "limit": 50, "offset": 0 }
    }
    ```
- **Append-Only Protection (`POST`, `PUT`, `PATCH`, `DELETE`):**
  - All non-GET methods return `HTTP 405 Method Not Allowed`:
    ```json
    {
      "error": "Method Not Allowed: audit events are append-only"
    }
    ```

---

### `GET /api/audit`
Administrative system audit trail. Provides high-level security event oversight across all users and documents without exposing confidential document content.

- **Authentication:** Required.
- **Authorization:** Role `admin` ONLY (`requireRole(['admin'])`).
- **Decisions:** Non-admins (`owner`, `viewer`) receive `HTTP 403 Forbidden` (`{"error": "Forbidden: insufficient role permissions"}`).
- **Query Parameters:**
  | Parameter | Type | Validation | Description |
  |:---|:---|:---|:---|
  | `action` | `string` | Clean string | Exact action match (e.g. `auth_login`, `create_document`) |
  | `outcome` | `string` | `'success' \| 'denied' \| 'failure'` | Exact outcome match |
  | `actorId` | `string` | UUID format | Filter by acting user |
  | `documentId` | `string` | UUID format | Filter by affected document |
  | `limit` | `integer` | 1–100 (default 50) | Pagination limit |
  | `offset` | `integer` | $\ge 0$ (default 0) | Pagination offset |
- **Responses:**
  - `200 OK`:
    ```json
    {
      "events": [
        {
          "id": "1043",
          "actorId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "documentId": null,
          "action": "auth_login",
          "outcome": "success",
          "reason": null,
          "metadata": { "email": "admin@example.com", "role": "admin" },
          "occurredAt": "2026-10-24T12:20:00.000Z"
        }
      ],
      "pagination": { "total": 1, "limit": 50, "offset": 0 }
    }
    ```
  - `403 Forbidden`: If user role is `owner` or `viewer`.
- **Append-Only Protection (`POST`, `PUT`, `PATCH`, `DELETE`):**
  - All non-GET methods return `HTTP 405 Method Not Allowed`:
    ```json
    {
      "error": "Method Not Allowed: audit events are append-only"
    }
    ```

---

## 7. Administrative User Management Endpoints (`/api/admin`)

Mounted at `/api/admin`. All administrative endpoints require authentication (`requireAuth`) and the `admin` role (`requireRole(['admin'])`). Requests from non-admin users (`owner`, `viewer`) are strictly rejected with `HTTP 403 Forbidden`.

### `GET /api/admin/users`
Lists registered users with pagination, role/status filtering, and parameterized search on email and display name.

- **Authentication:** Required.
- **Authorization:** Role `admin` ONLY (`requireRole(['admin'])`).
- **Query Parameters:**
  | Parameter | Type | Validation | Description |
  |:---|:---|:---|:---|
  | `search` | `string` | Safe string | Parameterized substring match on `email` or `display_name` |
  | `role` | `string` | `'admin' \| 'owner' \| 'viewer'` | Filter by exact role |
  | `status` | `string` | `'active' \| 'disabled'` | Filter by exact status |
  | `limit` | `integer` | 1–100 (default 50) | Pagination limit |
  | `offset` | `integer` | $\ge 0$ (default 0) | Pagination offset |
- **Data Minimization:** `password_hash`, internal session keys, and secrets are strictly excluded from output.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "users": [
        {
          "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "email": "user@example.com",
          "role": "owner",
          "status": "active",
          "displayName": "Alice Smith",
          "createdAt": "2026-10-24T10:00:00.000Z",
          "updatedAt": "2026-10-24T12:00:00.000Z"
        }
      ],
      "pagination": { "total": 1, "limit": 50, "offset": 0 }
    }
    ```
  - `403 Forbidden`: Non-admin callers.

---

### `GET /api/admin/users/:id`
Retrieves metadata for a specific user.

- **Authentication:** Required.
- **Authorization:** Role `admin` ONLY.
- **URL Parameters:** `id` (UUID format).
- **Responses:**
  - `200 OK`: `{"user": { ... }}`
  - `400 Bad Request`: Malformed UUID.
  - `404 Not Found`: User does not exist.

---

### `PATCH /api/admin/users/:id/role`
Updates a user's authorization role (`admin`, `owner`, `viewer`).

- **Authentication:** Required (`requireAuth`).
- **Authorization:** Role `admin` ONLY.
- **CSRF Token:** Required (`requireCsrfToken`).
- **Request Body (`application/json`):**
  ```json
  {
    "role": "owner"
  }
  ```
- **Security Invariants & Safeguards:**
  - **Self-Demotion Protection:** Administrators cannot modify their own role via the admin interface (`HTTP 400`).
  - **Last-Admin Protection:** Demoting the sole active administrator is strictly rejected with `HTTP 400` (`"Cannot demote the last active administrator"`).
  - **Audit Logging:** Emits `admin_change_role` audit record with acting admin ID, target user ID, previous role, and new role.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "User role updated successfully to owner",
      "user": { "id": "...", "email": "...", "role": "owner", ... }
    }
    ```
  - `400 Bad Request`: Self-demotion attempt, last admin demotion attempt, or invalid role value.
  - `403 Forbidden`: Missing CSRF token or non-admin caller.
  - `404 Not Found`: User does not exist.

---

### `PATCH /api/admin/users/:id/status`
Disables or re-enables a user account.

- **Authentication:** Required (`requireAuth`).
- **Authorization:** Role `admin` ONLY.
- **CSRF Token:** Required (`requireCsrfToken`).
- **Request Body (`application/json`):**
  ```json
  {
    "status": "disabled"
  }
  ```
- **Security Invariants & Safeguards:**
  - **Self-Disabling Protection:** Administrators cannot disable their own account (`HTTP 400`).
  - **Last-Admin Protection:** Disabling the sole active administrator is rejected with `HTTP 400`.
  - **Immediate Multi-Session Invalidation:** When an account is disabled, the server executes:
    ```sql
    DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1
    ```
    All active sessions across all devices are immediately destroyed. Subsequent requests with existing session cookies return `HTTP 401 Unauthorized`.
  - **Data Preservation:** Disabling an account never deletes documents, grants, or audit events.
  - **Audit Logging:** Emits `admin_change_status` audit record with previous status and new status.
- **Responses:**
  - `200 OK`:
    ```json
    {
      "message": "User account status updated successfully to disabled",
      "user": { "id": "...", "email": "...", "status": "disabled", ... }
    }
    ```
  - `400 Bad Request`: Self-disable attempt or last admin disable attempt.
  - `403 Forbidden`: Missing CSRF token or non-admin caller.

---

### `PATCH /api/admin/users/:id`
Administrative bulk metadata update (role, status, and/or display name).

- **Authentication:** Required (`requireAuth`).
- **Authorization:** Role `admin` ONLY.
- **CSRF Token:** Required (`requireCsrfToken`).
- **Request Body (`application/json`):**
  ```json
  {
    "role": "owner",
    "status": "active",
    "displayName": "Updated Name"
  }
  ```
- **Enforces:** Same self-modification and last-admin protections; purges sessions if status transition is `active` $\to$ `disabled`. Emits `admin_update_user` audit event.
