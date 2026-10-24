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
│   Frontend SPA (Vercel)         │       │   Backend API (Railway)         │
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

1. **Frontend Web Application:** Deployed to **Vercel** as a static Single-Page Application (SPA).
2. **Backend API Service:** Deployed to **Railway** as a containerized Node.js service using [`apps/api/Dockerfile`](file:///c:/Users/ruthv/Projects/trustvault/apps/api/Dockerfile).
3. **Primary Database:** **Supabase PostgreSQL** (or self-hosted PostgreSQL 15+) for relational data, session storage, and append-only audit events.
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

### B. Backend API Deployment (Railway)
The backend is packaged via Docker in a monorepo setup.

1. **Create New Project on Railway:**
   - Select **Deploy from GitHub repo**.
   - Choose the `trustvault` repository.
2. **Configure Service Settings:**
   - **Root Directory:** Leave as `/` (repository root context is required by `COPY apps/api/package.json ./apps/api/package.json`).
   - **Dockerfile Path:** `apps/api/Dockerfile`
   - **Port:** `4000` (or Railway's `$PORT`).
3. **Configure Health Check:**
   - **Healthcheck Path:** `/health`
   - **Healthcheck Timeout:** 10 seconds.
4. **Configure Environment Variables (See Section 3).**

> [!NOTE]
> **Railway Free Tier Considerations:** Railway's trial/starter tier provides ephemeral execution credits and will put inactive containers to sleep. For continuous availability and predictable rate limiting, ensure adequate credits or deploy to an always-on paid container tier.

---

### C. Frontend Web Deployment (Vercel)
The web client is a Vite-based SPA.

1. **Import Project into Vercel:**
   - Connect your GitHub repository.
   - **Root Directory:** Select `apps/web`.
   - **Framework Preset:** Vite.
2. **Build & Output Settings:**
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Install Command:** `npm install`
3. **SPA Routing Configuration:**
   Add a `vercel.json` in `apps/web` (or configure via project settings) to ensure client-side routing works for direct URLs (e.g. `/documents`, `/overview`, `/admin`):
   ```json
   {
     "rewrites": [
       { "source": "/(.*)", "destination": "/index.html" }
     ]
   }
   ```
4. **Configure Environment Variables:**
   - `VITE_API_URL`: Set to your production Railway backend domain (e.g. `https://trustvault-api-production.up.railway.app`).

---

## 3. Environment Variables Reference

### Backend API Variables (`apps/api`)

| Variable Name | Required | Example / Safe Placeholder | Purpose & Security Constraints |
|:---|:---|:---|:---|
| `NODE_ENV` | **Yes** | `production` | Enables strict security assertions, cookie hardening (`__Host-` prefix, `Secure`), and stack trace suppression. |
| `PORT` | Optional | `4000` | HTTP port for Express server (default `4000`). Injected automatically by Railway. |
| `DATABASE_URL` | **Yes** | `postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require` | Connection string to authoritative PostgreSQL database. Must have credentials protected. |
| `SUPABASE_URL` | **Yes** | `https://[PROJECT-ID].supabase.co` | Base URL of Supabase project. |
| `SUPABASE_SECRET_KEY` | **Yes** | `eyJh...[SERVICE_ROLE_KEY]` | Privileged Supabase service-role secret key. Must NEVER be exposed to the client or committed to git. |
| `SUPABASE_STORAGE_BUCKET` | Optional | `trustvault-private` | Private storage bucket name (defaults to `trustvault-private`). |
| `FRONTEND_ORIGIN` | **Yes** | `https://trustvault.vercel.app` | Exact production frontend URL. Used for CORS allowlist and CSRF Origin validation. Wildcards forbidden. |
| `SESSION_SECRET` | **Yes** | `c8f1e9b2a7d4c6e8f0a2b4d6e8c0a2b4d6e8f0a2b4c6e8d0` | Random string with **at least 32 characters of entropy**. The server will crash on boot if shorter than 32 chars in production. |
| `TRUST_PROXY` | **Yes** | `1` | Enables Express proxy trust (`1` or `true`) when running behind Railway's reverse proxy, ensuring correct protocol detection for secure cookies. |

### Frontend Variables (`apps/web`)

| Variable Name | Required | Example Placeholder | Purpose |
|:---|:---|:---|:---|
| `VITE_API_URL` | Optional | `https://trustvault-api-production.up.railway.app` | Base URL of production backend API if not using reverse-proxy path routing. |

---

## 4. Production Security Hardening

### 1. Cookie Hardening & Proxy Trust
In production (`NODE_ENV=production`), the session middleware activates maximum browser protections:
- **Cookie Name:** Automatically prefixed as `__Host-trustvault.sid`.
- **`Secure` Flag:** Enforced. Browsers will only transmit the cookie over HTTPS.
- **`HttpOnly` Flag:** Enforced. Prevents client-side scripts from reading the session cookie.
- **`SameSite=Lax`:** Mitigates cross-site request forgery.
- **`TRUST_PROXY=1`:** Because Railway terminates TLS at its reverse proxy, setting `TRUST_PROXY=1` ensures Express recognizes the forwarded `X-Forwarded-Proto: https` header and does not reject or downgrade secure cookies.

### 2. CORS & CSRF Allowlist
- Cross-Origin Resource Sharing (`CORS`) validates incoming `Origin` against `FRONTEND_ORIGIN`. If an unauthorized domain makes a request with credentials, CORS headers are omitted.
- State-changing endpoints (`POST`, `PATCH`, `DELETE`) validate `Origin` / `Referer` headers and require the `x-csrf-token` header.

### 3. Helmet Security Headers
Helmet applies the following defensive HTTP headers by default:
- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security` (HSTS)

---

## 5. Deployment Verification Checklist

After deploying the services, execute this smoke test sequence:

1. **Health Probe:**
   ```bash
   curl -i https://your-api.railway.app/health
   ```
   *Expected:* HTTP `200 OK` with `{"status": "ok", "service": "trustvault-api"}`.
2. **CSRF Token Fetch:**
   ```bash
   curl -i https://your-api.railway.app/api/auth/csrf-token
   ```
   *Expected:* HTTP `200 OK` returning `{"csrfToken": "..."}`.
3. **Database Connectivity:**
   Attempt a login or registration through the deployed frontend. Verify that a user row is created in `public.users` and an audit event is appended in `public.audit_events`.
4. **Private Storage Upload & Download:**
   - Upload a test document (e.g. sample PDF).
   - Verify that the file appears in the `trustvault-private` Supabase bucket with a UUID key.
   - Verify that downloading the document streams the original bytes with correct headers (`Content-Disposition: attachment; filename=...`).
5. **Direct Storage Access Denied:**
   Attempt to access the uploaded file URL directly in a browser:
   `https://[PROJECT-ID].supabase.co/storage/v1/object/public/trustvault-private/[STORAGE_KEY]`
   *Expected:* HTTP `400` or `404` / `Access Denied`. Direct public access must be impossible.

---

## 6. Troubleshooting Common Deployment Failures

### 1. Server Exits on Startup: "CRITICAL SECURITY ERROR: SESSION_SECRET must be set and provide at least 32 characters"
- **Cause:** `SESSION_SECRET` is missing or has fewer than 32 characters.
- **Fix:** Generate a secure random string (e.g. `openssl rand -hex 32`) and update the environment variable in Railway.

### 2. Frontend Receives 401 Unauthorized Immediately After Login
- **Cause:** Secure cookie is not being stored by browser because `TRUST_PROXY` is `false` or connection is plain HTTP.
- **Fix:** Ensure `TRUST_PROXY=1` is set in Railway and both frontend and backend are accessed over `https://`.

### 3. CORS Error in Browser Console
- **Cause:** `FRONTEND_ORIGIN` does not match the exact URL of the Vercel frontend (including protocol and port, without trailing slash).
- **Fix:** Update `FRONTEND_ORIGIN` in Railway to match your exact Vercel domain (e.g. `https://trustvault.vercel.app`).

### 4. Database Connection Pool Exhaustion
- **Cause:** Serverless or ephemeral containers opening too many concurrent connections to Supabase.
- **Fix:** Ensure `DATABASE_URL` connects via Supabase Transaction Pooler (port 6543) rather than direct session port (5432).
