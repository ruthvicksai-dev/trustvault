# TrustVault — Production Deployment Guide

This guide describes the recommended production deployment architecture, environment configurations, and operational procedures for TrustVault. It is based directly on the application source code in [`apps/api`](file:///c:/Users/ruthv/Projects/trustvault/apps/api) and [`apps/web`](file:///c:/Users/ruthv/Projects/trustvault/apps/web).

---

## 1. Production Architecture Overview

TrustVault is composed of four production components:

```
┌─────────────────────────────────┐
│     Client Web Browser          │
└──────────────┬──────────────────┘
               │ HTTPS (Cookies, CSRF Token)
               ▼
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│   Frontend SPA (Vercel)         │       │   Backend API (Render)          │
│   • React 19 + Vite 6           │──────▶│   • Node.js 22 + Express 5      │
│   • Static Edge CDN             │       │   • apps/api/Dockerfile         │
└─────────────────────────────────┘       └───────┬─────────────────┬───────┘
                                                  │                 │
                           PostgreSQL Connection  │                 │ S3 / Storage API
                                                  ▼                 ▼
                               ┌──────────────────────┐  ┌──────────────────────┐
                               │ Supabase PostgreSQL  │  │ Supabase Storage     │
                               │ • RLS Enforced       │  │ • Private Bucket     │
                               │ • Append-Only Audit  │  │   (trustvault-       │
                               │ • PostgreSQL Session │  │    private)          │
                               └──────────────────────┘  └──────────────────────┘
```

1. **Frontend Web Application:** Deployed to **Vercel** (`https://trustvault-omega.vercel.app`) as a static Single-Page Application (SPA) with automatic edge API proxying.
2. **Backend API Service:** Deployed to **Render** as a containerized Web Service (`https://trustvault-api-l22c.onrender.com`) using [`apps/api/Dockerfile`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/Dockerfile).
3. **Primary Database:** **Supabase PostgreSQL** (pooled SSL connection on port 6543) for relational data, session storage, and append-only audit events.
4. **Private Document Storage:** **Supabase Storage** with a dedicated private bucket (`trustvault-private`).

---

## 2. Infrastructure Provisioning

### A. Supabase (Database & Private Storage)
1. **Create Project:** Provision a new Supabase project in your desired cloud region.
2. **Retrieve Connection Details:**
   - Database Connection String (`DATABASE_URL`): Obtain the PostgreSQL connection string from **Project Settings $\rightarrow$ Database**. For containerized APIs, the Transaction Pooler (port 6543) or Session Pooler (port 5432) can be used. Ensure SSL is enabled (`sslmode=require`).
   - API Credentials: Copy the Project URL (`SUPABASE_URL`) and the **Service Role Secret Key** (`SUPABASE_SECRET_KEY`) from **Project Settings $\rightarrow$ API**.
3. **Provision Private Storage Bucket:**
   - Navigate to **Storage $\rightarrow$ Buckets $\rightarrow$ New Bucket**.
   - Bucket Name: `trustvault-private`
   - **Public Bucket:** **DISABLE** (Leave unchecked). The bucket must be strictly private.
   - Allowed MIME Types / Size Limits: Configure 10 MiB limit if desired.
4. **Apply Database Migrations:**
   Execute migrations in order via Supabase CLI:
   ```bash
   supabase link --project-ref your-project-id
   supabase db push
   ```
   *(See [`docs/DATABASE.md`](file:///c:/Users/ruthv/Projects/trustvault/docs/DATABASE.md) for migration details).*

---

### B. Backend API Deployment (Render)
The backend is packaged via Docker in a monorepo setup and is live in production:

1. **Service Specifications:**
   - **Service Name:** `trustvault-api` (Live URL: `https://trustvault-api-l22c.onrender.com`)
   - **Runtime:** `Docker`
   - **Branch:** `master`
   - **Dockerfile Path:** `./apps/api/Dockerfile`
   - **Docker Context:** `.` (repository root context required for monorepo workspace dependencies)
2. **Health Check & Port Configuration:**
   - **Health Check Path:** `/health`
   - Render exposes the container via an edge reverse proxy and terminates TLS. Traffic is routed internally to port `4000` (or Render's injected `$PORT`).
3. **Environment Variables Configuration (See Section 3):**
   - Configured in Render under the **Environment** tab (`NODE_ENV=production`, `TRUST_PROXY=1`, `DATABASE_URL`, `SUPABASE_*`, `SESSION_SECRET`, `FRONTEND_ORIGIN`).

> [!NOTE]
> **Render Free Tier Spin-Down:**
> Render's free tier spins down inactive web services after 15 minutes of inactivity. When testing on free tiers, allow 30–50 seconds for container cold starts on the first request. The service responds with HTTP 200 once warmed up.

---

### C. Frontend Web Deployment (Vercel)
The web client is a Vite-based SPA deployed to **Vercel** at **`https://trustvault-omega.vercel.app`**:

1. **Project Setup in Vercel:**
   - Connect the GitHub repository (`trustvault`).
   - **Root Directory:** Select `apps/web`.
   - **Framework Preset:** Vite.
2. **Build & Output Settings:**
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Install Command:** `npm install`
3. **SPA Routing & Edge API Reverse-Proxy Configuration:**
   The [`apps/web/vercel.json`](file:///c:/Users/ruthv/Projects/trustvault/apps/web/vercel.json) configuration handles both client-side SPA route rewrites and transparent edge proxying to the Render API backend:
   ```json
   {
     "$schema": "https://openapi.vercel.sh/vercel.json",
     "rewrites": [
       {
         "source": "/api/:path*",
         "destination": "https://trustvault-api-l22c.onrender.com/api/:path*"
       },
       {
         "source": "/(.*)",
         "destination": "/index.html"
       }
     ]
   }
   ```

> [!TIP]
> **Architectural Advantages of Vercel Edge API Rewrite:**
> 1. **Single-Origin Cookie Security:** Because `/api/*` is proxied through the same domain as the frontend, modern browser restrictions on third-party cross-site cookies (e.g., Apple Safari ITP, Google Chrome third-party cookie phaseouts) are completely bypassed.
> 2. **`__Host-` Cookie Prefix Compliance:** Production session cookies (`__Host-trustvault.sid`) are stored with full `Path=/`, `Secure`, and `HttpOnly` flags without cross-site friction.
> 3. **Elimination of Preflight Overhead:** Browser requests to `/api/*` match the frontend domain origin, avoiding CORS preflight `OPTIONS` network latency.
> 4. **Deep Routing Preservation:** All client-side routes (e.g. `/documents`, `/overview`, `/admin`) correctly fall back to `/index.html` without 404 errors.

---

## 3. Environment Variables Reference

### Backend API Variables (`apps/api` on Render)

| Variable Name | Required | Example / Production Value | Purpose & Security Constraints |
|:---|:---|:---|:---|
| `NODE_ENV` | **Yes** | `production` | Enables strict security assertions, cookie hardening (`__Host-` prefix, `Secure`), and stack trace suppression. |
| `PORT` | Optional | `4000` | HTTP port for Express server (default `4000`). Render injects `$PORT` automatically. |
| `DATABASE_URL` | **Yes** | `postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require` | Connection string to authoritative PostgreSQL database. Must have credentials protected. |
| `SUPABASE_URL` | **Yes** | `https://[PROJECT-ID].supabase.co` | Base URL of Supabase project. |
| `SUPABASE_SECRET_KEY` | **Yes** | `eyJh...[SERVICE_ROLE_KEY]` | Privileged Supabase service-role secret key. Must NEVER be exposed to the client or committed to git. |
| `SUPABASE_STORAGE_BUCKET` | Optional | `trustvault-private` | Private storage bucket name (defaults to `trustvault-private`). |
| `FRONTEND_ORIGIN` | **Yes** | `https://trustvault-omega.vercel.app` | Exact production frontend URL. Used for CORS allowlist and CSRF Origin validation. Wildcards forbidden. |
| `SESSION_SECRET` | **Yes** | `c8f1e9b2a7d4c6e8f0a2b4d6e8c0a2b4d6e8f0a2b4c6e8d0` | Random string with **at least 32 characters of entropy**. The server will crash on boot if shorter than 32 chars in production. |
| `TRUST_PROXY` | **Yes** | `1` | Enables Express proxy trust (`1` or `true`) when running behind Render's reverse proxy, ensuring correct protocol detection for secure cookies. |
| `ENABLE_DEMO_ACCOUNTS` | Optional | `true` | Required if provisioning evaluator demo accounts on the evaluation deployment. |
| `DEMO_ADMIN_PASSWORD` | Optional | `your_secure_admin_password_min_12_chars` | Password for synthetic demo admin account ($\ge 12$ chars). |
| `DEMO_OWNER_PASSWORD` | Optional | `your_secure_owner_password_min_12_chars` | Password for synthetic demo owner account ($\ge 12$ chars). |
| `DEMO_VIEWER_PASSWORD` | Optional | `your_secure_viewer_password_min_12_chars` | Password for synthetic demo viewer account ($\ge 12$ chars). |
| `DEMO_ENV_CONFIRMATION` | Production Only | `true` | Required confirmation flag when executing demo provisioning against production (`NODE_ENV=production`). |

### Frontend Variables (`apps/web` on Vercel)

| Variable Name | Required | Example Value | Purpose |
|:---|:---|:---|:---|
| `VITE_API_URL` | Optional | *(Omitted when using Vercel reverse proxy rewrite)* or `https://trustvault-api-l22c.onrender.com` | Base URL of production backend API on Render. When omitted, the frontend uses relative URLs (`/api/...`) proxied by `apps/web/vercel.json`. |

---

## 4. Production Security Hardening

### 1. Cookie Hardening & Proxy Trust
In production (`NODE_ENV=production`), the session middleware activates maximum browser protections:
- **Cookie Name:** Automatically prefixed as `__Host-trustvault.sid`.
- **`Secure` Flag:** Enforced. Browsers will only transmit the cookie over HTTPS.
- **`HttpOnly` Flag:** Enforced. Prevents client-side scripts from reading the session cookie.
- **`SameSite=Lax`:** Mitigates cross-site request forgery while preserving top-level navigation.
- **`TRUST_PROXY=1`:** Because Render terminates TLS at its edge reverse proxy, setting `TRUST_PROXY=1` ensures Express recognizes the forwarded `X-Forwarded-Proto: https` header and does not reject or downgrade secure cookies.

### 2. CORS & CSRF Allowlist
- Cross-Origin Resource Sharing (`CORS`) validates incoming `Origin` against `FRONTEND_ORIGIN`. If an unauthorized domain makes a request with credentials, CORS headers are omitted.
- State-changing endpoints (`POST`, `PATCH`, `DELETE`) validate `Origin` / `Referer` headers and require the `x-csrf-token` header.

### 3. Helmet Security Headers
Helmet applies the following defensive HTTP headers by default:
- `Content-Security-Policy: default-src 'self'; ...`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

---

## 5. Deployment Verification & Live Smoke Tests

The production services are live and verified:

1. **Live Health Probe (`https://trustvault-api-l22c.onrender.com/health`):**
   ```bash
   curl -i https://trustvault-api-l22c.onrender.com/health
   ```
   *Verified Live Output:*
   ```http
   HTTP/1.1 200 OK
   content-type: application/json; charset=utf-8
   strict-transport-security: max-age=31536000; includeSubDomains
   x-content-type-options: nosniff
   x-frame-options: SAMEORIGIN
   x-render-origin-server: Render

   {"status":"ok","service":"trustvault-api","timestamp":"2026-10-25T03:48:08.051Z"}
   ```

2. **Live CSRF Token & Secure Cookie Probe (`/api/auth/csrf-token`):**
   ```bash
   curl -i https://trustvault-api-l22c.onrender.com/api/auth/csrf-token
   ```
   *Verified Live Output:*
   ```http
   HTTP/1.1 200 OK
   Set-Cookie: __Host-trustvault.sid=s%3A...; Path=/; Expires=...; HttpOnly; Secure; SameSite=Lax
   ratelimit: limit=100, remaining=99, reset=900
   content-type: application/json; charset=utf-8

   {"csrfToken":"53f1bb177e0d7db99c88a55291252e1618f583bb5d49fd13df3fa39bdc22f998"}
   ```

3. **Live Vercel Edge API Proxy Probe (`https://trustvault-omega.vercel.app/api/auth/csrf-token`):**
   ```bash
   curl -i https://trustvault-omega.vercel.app/api/auth/csrf-token
   ```
   *Verified Live Output:*
   ```http
   HTTP/1.1 200 OK
   Server: Vercel
   X-Render-Origin-Server: Render
   Set-Cookie: __Host-trustvault.sid=s%3A...; Path=/; Expires=...; HttpOnly; Secure; SameSite=Lax
   content-type: application/json; charset=utf-8

   {"csrfToken":"90fc9ace3129198971f84e5de7aae4a40c125ea85d03ad59f81381a5a7828207"}
   ```

4. **Database Connectivity:**
   Verified user authentication, session creation in `public.sessions`, and immutable event recording in `public.audit_events`.
5. **Private Storage Upload & Download:**
   - Uploaded document binaries are stored in the private Supabase bucket `trustvault-private` using random UUID storage keys.
   - Authorized downloads stream with sanitizing RFC 6266 / RFC 5987 `Content-Disposition` headers.
6. **Direct Storage Access Denied:**
   Direct anonymous HTTP requests to Supabase storage objects return `HTTP 400` / `404 Access Denied`, confirming private bucket isolation.

---

## 6. Troubleshooting Common Deployment Failures

### 1. Server Exits on Startup: "CRITICAL SECURITY ERROR: SESSION_SECRET must be set and provide at least 32 characters"
- **Cause:** `SESSION_SECRET` is missing or has fewer than 32 characters.
- **Fix:** Generate a secure random string (e.g. `openssl rand -hex 32`) and update the environment variable in Render.

### 2. Frontend Receives 401 Unauthorized Immediately After Login
- **Cause:** Secure cookie is not being stored by browser because `TRUST_PROXY` is `false` or connection is plain HTTP.
- **Fix:** Ensure `TRUST_PROXY=1` is set in Render and both frontend and backend are accessed over `https://`.

### 3. CORS Error in Browser Console
- **Cause:** `FRONTEND_ORIGIN` does not match the exact URL of the Vercel frontend (including protocol and port, without trailing slash).
- **Fix:** Update `FRONTEND_ORIGIN` in Render to match your exact Vercel domain (`https://trustvault-omega.vercel.app`), or rely on the `apps/web/vercel.json` edge API rewrite to proxy `/api/*` directly from the frontend domain.

### 4. Database Connection Pool Exhaustion
- **Cause:** Serverless or ephemeral containers opening too many concurrent connections to Supabase.
- **Fix:** Ensure `DATABASE_URL` connects via Supabase Transaction Pooler (port 6543) rather than direct session port (5432).
