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

## Security Controls Summary

- **Password Hashing:** Argon2id with reviewed OWASP parameters (19 MiB memory, 2 passes, 1 thread). Bounded concurrency limiter (max 10 concurrent hashes).
- **Password Policy:** NIST SP 800-63B aligned (min 12, max 128 chars, full Unicode and whitespace support, no silent truncation).
- **Session Security:** Server-side sessions backed by PostgreSQL `public.sessions`. Session fixation protection (`req.session.regenerate()`), 8-hour idle timeout, 24-hour absolute expiration, `HttpOnly`, `SameSite=Lax`, and `__Host-` cookie name in production.
- **Account Disablement & Invalidation:** Authoritative real-time DB lookup on every request. Immediate 403 on disabled accounts. Password change deletes all other user sessions.
- **CSRF Protection:** Strict `Origin` and `Referer` validation against `FRONTEND_ORIGIN` on all state-changing methods + synchronizer token (`x-csrf-token`) on protected operations.
- **CORS:** Restrictive CORS allowlist matching only `FRONTEND_ORIGIN`. Credentialed access without wildcard reflection.

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
