# TrustVault — Architecture & System Design

**Document Version:** 1.0.0  
**Target Environment:** Node.js 22+ (Express 5 backend), React 19 (Vite SPA), PostgreSQL 15+ (Supabase)  
**Status:** Implemented & Verified in Local Test Environment

---

## 1. System Overview

TrustVault is a secure, multi-tenant document-sharing platform engineered around zero-trust authorization, cryptographic defense-in-depth, and an immutable access audit trail. It addresses the critical vulnerability where applications inadvertently leak confidential files across tenant boundaries through insecure direct object references (IDOR), stale permission grants, or over-privileged administrative roles.

```mermaid
flowchart TD
    subgraph Client Tier
        Browser["React 19 SPA (Vite)\nOrigin: FRONTEND_ORIGIN"]
        ExternalClient["Direct Client / API Consumer\n(PostgREST / Untrusted)"]
    end

    subgraph Perimeter & Transport Security
        HTTPS["TLS 1.3 Termination / Reverse Proxy"]
        CorsHelmet["CORS Allowlist & Helmet Security Headers"]
        OriginGuard["Origin / Referer CSRF Validation"]
        RateLimiter["IP-Based & Concurrency Rate Limiters"]
    end

    subgraph Application Tier [Express 5 Backend API]
        SessionAuth["Session Guard (requireAuth)\nArgon2id + connect-pg-simple"]
        CSRFMiddleware["Synchronizer Token Guard (requireCsrfToken)"]
        CentralAuth["Centralized Document Authorization Engine\n(authorizeDocumentAccess)"]
        AuditService["Audit Trail Service\n(recordAuditEvent + Sanitizer)"]
        StorageManager["Storage Driver Interface\n(SupabaseStorageDriver / InMemory)"]
    end

    subgraph Data Tier [PostgreSQL 15+]
        AppRole["Role: postgres (BYPASSRLS = true)\nMediated exclusively by Express"]
        RestrictedRole["Roles: anon / authenticated (BYPASSRLS = false)\nSubject to Row Level Security"]
        RLS["PostgreSQL RLS & FORCE Policies"]
        Tables[("public.users\npublic.documents\npublic.document_grants\npublic.audit_events\npublic.sessions")]
    end

    subgraph Storage Tier [Private Object Storage]
        PrivateBucket["Supabase Storage Bucket: trustvault-private\n(public: false, UUIDv4 Object Keys)"]
    end

    Browser -->|HTTPS + Credentials| HTTPS
    ExternalClient -.->|Direct PostgREST API| HTTPS
    HTTPS --> CorsHelmet --> OriginGuard --> RateLimiter
    RateLimiter --> SessionAuth --> CSRFMiddleware --> CentralAuth

    CentralAuth -->|Parameterized SQL| AppRole
    AuditService -->|Append-Only Inserts| AppRole
    AppRole --> Tables

    ExternalClient -.->|Direct Data API| RestrictedRole
    RestrictedRole -->|Filtered by Policies| RLS
    RLS --> Tables

    CentralAuth -->|Authorize Read/Write| StorageManager
    StorageManager -->|Server-Mediated Streaming\nSUPABASE_SECRET_KEY| PrivateBucket
```

---

## 2. Core Architectural Responsibilities

| Tier | Component | Technology | Primary Responsibilities |
|:---|:---|:---|:---|
| **Frontend** | `apps/web` | React 19, Vite, Tailwind CSS v4, Base UI, React Router v7 | - Responsive user interface for authentication, document management, grant sharing, and audit log inspection.<br>- Client-side state management, CSRF token attachment (`x-csrf-token`), and secure cookie transmission.<br>- Never stores or evaluates business-critical authorization rules; mirrors server state. |
| **API Backend** | `apps/api` | Express 5, Node.js 22+, TypeScript, Zod | - Centralized authentication, session management, and CSRF defense.<br>- Parameterized authorization decisions independently of frontend parameters.<br>- File validation: magic byte verification, MIME detection, and streaming size limits.<br>- Mediated storage streaming: clients never receive direct storage credentials or public URLs.<br>- Append-only audit trail generation and metadata redaction. |
| **Database** | `supabase/` | PostgreSQL 15+ | - Authoritative persistence for users, documents, grants, sessions, and audit logs.<br>- Relational constraints: unique email index, single active grant index, and cascade safeguards.<br>- Defense-in-depth: Row Level Security (RLS) policies on all tables for non-bypass roles (`anon`, `authenticated`).<br>- Isolated `SECURITY DEFINER` helper functions with pinned `search_path = public`. |
| **Object Storage** | Supabase Storage | S3-compatible private bucket (`trustvault-private`) | - Binary file payload storage using unguessable server-generated UUIDv4 keys.<br>- Strictly private configuration (`public: false`); zero direct client access policies.<br>- Upload compensation and orphaned object reconciliation. |

---

## 3. Trust Boundaries & Security Enclaves

### Trust Boundary 1: Client to API Gateway
- **Assumption:** The web browser and all incoming network traffic are completely untrusted. Attackers may forge HTTP headers, tamper with request bodies, craft direct API calls, or replay expired sessions.
- **Enforcement:**
  - Strict CORS origin allowlist (`FRONTEND_ORIGIN`).
  - Origin / Referer validation (`validateOrigin`) on all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`).
  - Session-bound synchronizer CSRF tokens (`requireCsrfToken`) verified with constant-time equality checks (`crypto.timingSafeEqual`).
  - Strict input schemas (`zod`) that reject extra fields (`.strict()`).
  - Rate limiting on authentication and file transfer endpoints.

### Trust Boundary 2: Express API to Database
- **Implementation Reality:** The Express API connects via a standard pooled database role (`postgres`) which holds the PostgreSQL `BYPASSRLS` attribute.
- **Architectural Consequence:** Database-level RLS does **not** evaluate queries issued by the Express backend. The backend is the authoritative security gateway and must explicitly enforce parameterized authorization on every query.
- **RLS Perimeter:** Database RLS acts as a secondary defense-in-depth perimeter against direct connections (such as PostgREST APIs exposed on port 54321/443, leaked restricted-role credentials, or potential future microservices operating under `anon` or `authenticated` roles).

### Trust Boundary 3: API Backend to Private Object Storage
- **Assumption:** Object storage must never be exposed to public web traffic.
- **Enforcement:**
  - The storage bucket (`trustvault-private`) is marked strictly private (`public: false`).
  - Clients never receive signed URLs, bucket tokens, or storage keys.
  - The backend streams files to and from storage using the server-held `SUPABASE_SECRET_KEY` only after verifying per-document permissions in PostgreSQL.
  - Storage keys are cryptographically random UUIDs (`crypto.randomUUID().ext`), eliminating path traversal and key enumeration.

---

## 4. Authentication & Session Lifecycle

TrustVault implements server-side, stateful session authentication backed by PostgreSQL (`connect-pg-simple`), completely independent of Supabase Auth.

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Browser
    participant API as Express API (/api/auth)
    participant Argon as Argon2id Engine
    participant DB as PostgreSQL (public.users & sessions)

    Note over User,DB: 1. Registration Flow
    User->>API: POST /api/auth/register { email, password }
    API->>API: Validate input (email format, 12-128 chars)
    API->>Argon: hashPassword(password, Argon2id config)
    Argon-->>API: $argon2id$v=19$m=19456,t=2,p=1$...
    API->>DB: INSERT INTO public.users (role='viewer', status='active')
    DB-->>API: 201 Created (id, email, role, status)
    API-->>User: 201 Created (redirect to login)

    Note over User,DB: 2. Authentication Flow
    User->>API: POST /api/auth/login { email, password }
    API->>DB: SELECT id, password_hash, role, status FROM public.users WHERE lower(email) = $1
    alt User Found & Active
        API->>Argon: verifyPassword(hash, password)
    else User Not Found or Disabled
        API->>Argon: verifyPassword(DUMMY_HASH, password) [Timing Normalization]
        API-->>User: 401 Unauthorized ("Invalid email or password")
    end
    API->>API: req.session.regenerate() [Fixation Defense]
    API->>DB: INSERT INTO public.sessions (sid, sess, expire)
    API-->>User: 200 OK + Set-Cookie: __Host-trustvault.sid (HttpOnly, Secure, SameSite=Lax)

    Note over User,DB: 3. Authenticated Request
    User->>API: GET /api/documents (Cookie: __Host-trustvault.sid)
    API->>DB: Read session from public.sessions WHERE sid = $sid AND expire > now()
    API->>DB: SELECT status, updated_at FROM public.users WHERE id = $session.userId
    API->>API: Verify session age < 24h & passwordUpdatedAt >= user.updated_at
    API-->>User: 200 OK (Authorized Document List)
```

### Authentication Invariants
1. **Password Hashing:** Passwords are hashed using Argon2id with OWASP parameters: 19 MiB memory cost, 2 iterations, 1 parallelism, 32-byte salt/digest. Concurrency is throttled to 10 simultaneous operations to prevent CPU exhaustion DoS.
2. **Enumeration Resistance:** Login failures execute dummy verification against a pre-computed hash (`DUMMY_HASH`) to normalize execution time between existing and non-existing accounts. Error responses are strictly uniform: `{"error": "Invalid email or password"}`.
3. **Session Fixation Prevention:** Calling `req.session.regenerate()` upon login replaces the unauthenticated session ID with a cryptographically fresh ID.
4. **Cookie Security:** In production, the session cookie uses the `__Host-` prefix, enforcing `Secure`, `HttpOnly`, `SameSite=Lax`, and `path=/` without a domain scope.
5. **Session Invalidation:**
   - **Idle Timeout:** 8 hours of inactivity (`rolling: true` resets on active requests).
   - **Absolute Timeout:** 24 hours from initial creation (`ABSOLUTE_SESSION_TIMEOUT_MS`).
   - **Password Rotation:** Changing passwords deletes all concurrent sessions from `public.sessions` (`(sess::jsonb)->>'userId' = $userId AND sid != $currentSid`).
   - **Account Disablement:** Every authenticated request queries the database to confirm `status = 'active'`; disabled accounts are terminated immediately.

---

## 5. Centralized Document Authorization Model

All document operations are mediated by the centralized authorization service: [authorizeDocumentAccess](file:///c:/Users/ruthv/Projects/trustvault/apps/api/src/documents/authorization.ts).

```mermaid
flowchart TD
    Start["Client Requests Document Action\n(read_metadata, read_content, edit_metadata, soft_delete, manage_grants)"] --> UUIDCheck{"Valid UUIDv4 format?"}
    UUIDCheck -- No --> Deny404["404 Not Found\n(Anti-Enumeration)"]
    UUIDCheck -- Yes --> StatusCheck{"User status = 'active'?"}
    StatusCheck -- No --> Deny403["403 Forbidden\n(Account Disabled)"]
    StatusCheck -- Yes --> QueryDB["Query PostgreSQL:\nDocument + Active Grant (LEFT JOIN)\nWHERE id = $docId"]

    QueryDB --> Exists{"Document exists\nand deleted_at IS NULL?"}
    Exists -- No --> Deny404

    Exists -- Yes --> IsOwner{"Is user the document owner?\n(owner_id = user.id)"}
    IsOwner -- Yes --> AllowOwner["200 OK Authorized\n(Full Owner Authority)"]

    IsOwner -- No --> HasGrant{"Has active grant?\n(revoked_at IS NULL)"}
    HasGrant -- No --> Deny404

    HasGrant -- Yes --> GrantType{"Grant Permission Type"}
    GrantType -- "'read'" --> ActionRead{"Action in [read_metadata, read_content]?"}
    ActionRead -- Yes --> AllowGrantee["200 OK Authorized (Read-Only)"]
    ActionRead -- No --> DenyGrantee403["403 Forbidden\n('edit' or owner permission required)"]

    GrantType -- "'edit'" --> ActionEdit{"Action in [read_metadata, read_content, edit_metadata]?"}
    ActionEdit -- Yes --> AllowEditor["200 OK Authorized (Editor)"]
    ActionEdit -- No --> DenyEditor403["403 Forbidden\n(Only owner may soft_delete or manage_grants)"]
```

### Authorization Rules Matrix

| Role / Actor | Read Metadata | Stream Download | Edit Metadata | Soft Delete | Share / Revoke Grants | Query Audit Trail |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Document Owner** | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed (Document Scope) |
| **Active `edit` Grantee** | ✅ Allowed | ✅ Allowed | ✅ Allowed | ❌ Forbidden (403) | ❌ Forbidden (403) | ❌ Forbidden (403) |
| **Active `read` Grantee** | ✅ Allowed | ✅ Allowed | ❌ Forbidden (403) | ❌ Forbidden (403) | ❌ Forbidden (403) | ❌ Forbidden (403) |
| **Revoked Grantee** | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 |
| **Unrelated User** | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 | ❌ Uniform 404 |
| **System Administrator** | ❌ Uniform 404* | ❌ Uniform 404* | ❌ Uniform 404* | ❌ Uniform 404* | ❌ Uniform 404* | ✅ Allowed (System Scope) |

*\*Administrator Privacy Boundary:* TrustVault strictly enforces separation of concerns. The `admin` role provides system oversight of operational audit logs (`GET /api/audit`), but does **not** grant automatic backdoor read or download access to private documents. Admins require explicit document ownership or an active grant like any other user.

---

## 6. Document Upload & Lifecycle Architecture

Document creation involves a coordinated two-phase transaction across Supabase Storage and PostgreSQL.

```mermaid
sequenceDiagram
    autonumber
    actor User as Document Owner
    participant API as Express API (/api/documents)
    participant Validator as File & Magic Byte Validator
    participant Storage as Supabase Storage (trustvault-private)
    participant DB as PostgreSQL (documents & audit_events)

    User->>API: POST /api/documents (multipart/form-data: title, category, file)
    API->>API: Verify session & check role IN ('owner', 'admin')
    API->>API: Check upload rate limit (20/15m) & concurrency semaphore (max 10)
    API->>Validator: Stream to temp file (max 10 MiB, owner mode 0600)
    Validator->>Validator: Inspect magic bytes (detect genuine MIME type)
    Validator->>Validator: Check forbidden signatures (reject MZ, ELF, <script>)
    Validator-->>API: Verified Buffer & Canonical Extension

    API->>Storage: upload(storageKey = randomUUID.ext, buffer, mimeType)
    alt Storage Upload Fails
        Storage-->>API: Error (cluster timeout)
        API-->>User: 500 Internal server error
    else Storage Upload Succeeds
        Storage-->>API: Upload OK
        API->>DB: INSERT INTO public.documents (owner_id, title, category, storage_key, ...)
        alt Database Insert Succeeds
            DB-->>API: Document Record Created
            API->>DB: INSERT INTO public.audit_events (action='document_create', outcome='success')
            API-->>User: 201 Created (id, title, category, sizeBytes)
        else Database Insert Fails
            DB-->>API: Error (connection failure)
            Note over API,Storage: Compensating Deletion (Rollback)
            API->>Storage: delete(storageKey)
            alt Compensating Delete Succeeds
                Storage-->>API: Deleted
            else Double Fault
                Storage-->>API: Delete Failed
                API->>DB: INSERT INTO public.audit_events (action='storage_cleanup_failed', outcome='failure')
            end
            API-->>User: 500 Internal server error
        end
    end
```

### Storage Invariants & File Validation
1. **Magic Byte Verification:** The server inspects initial binary headers (`detectMimeTypeFromBuffer`) for approved signatures:
   - PDF: `%PDF-` (`0x25 0x50 0x44 0x46 0x2D`)
   - PNG: `0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A`
   - JPEG: `0xFF 0xD8 0xFF`
   - WebP: `RIFF` ... `WEBP`
   - Office OOXML (DOCX/XLSX): `PK\x03\x04`
2. **Generic MIME Disallowance:** Declaring `application/octet-stream` is forbidden unless the underlying binary independently matches an allowlisted signature.
3. **Executable Rejection:** Rejects DOS `MZ` executables, Unix `\x7FELF` binaries, and active web scripts (`<script>`, `<?php`, `#!/bin/`) within text payloads.
4. **Size Bounds:** Strictly bounded to 10 MiB (`MAX_DOCUMENT_FILE_SIZE`). Empty files (0 bytes) are rejected with HTTP 400; files exceeding 10 MiB are terminated during streaming with HTTP 413.
5. **Orphan Reconciliation:** The utility `reconcileOrphanedObjects` scans storage buckets using pagination. It preserves objects younger than a 15-minute grace period (`gracePeriodMs`) to prevent race conditions with in-flight uploads, aborting immediately without deletions if pagination fails.

---

## 7. Download Streaming Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User as Owner / Grantee
    participant API as Express API (/api/documents/:id/download)
    participant Auth as Authorization Service
    participant Storage as Storage Driver
    participant Audit as Audit Service

    User->>API: GET /api/documents/:id/download
    API->>Auth: authorizeDocumentAccess(user, id, "read_content")
    Auth-->>API: Authorized (isOwner=true OR grant='read'/'edit')
    API->>Storage: download(document.storage_key)
    Storage-->>API: Buffer + MIME type
    API->>API: Sanitize filename for Content-Disposition (RFC 6266 / RFC 5987)
    API->>API: Set Cache-Control: private, no-store, no-cache, must-revalidate
    API->>API: Set X-Content-Type-Options: nosniff
    API->>Audit: recordAuditEvent(action='document_download', outcome='success')
    API-->>User: 200 OK + Stream File Attachment
```

---

## 8. Sharing & Grant Revocation Lifecycle

Sharing permissions are represented in PostgreSQL table `public.document_grants`.

1. **Owner Exclusivity:** Only the document owner can grant permissions (`POST /api/documents/:id/grants`), modify permissions (`PATCH /api/documents/:id/grants/:grantId`), or revoke access (`DELETE /api/documents/:id/grants/:grantId`).
2. **Grant Concurrency Safety:** Table `public.document_grants` contains a partial unique index:
   ```sql
   CREATE UNIQUE INDEX document_grants_one_active_idx
       ON public.document_grants (document_id, user_id)
       WHERE revoked_at IS NULL;
   ```
   This guarantees that at most one active grant can exist per user/document pair. Attempting to create duplicate active grants fails closed with HTTP 409 Conflict.
3. **Immediate Revocation:** Revoking a grant sets `revoked_at = now()` atomically. Subsequent authorization requests fail immediately with HTTP 404 anti-enumeration responses, with zero stale token caching.

---

## 9. Audit Trail Architecture & Tamper Resistance

Every security-sensitive operation across authentication, document access, sharing, and administration emits an event into `public.audit_events`.

### Implemented Guarantees
- **Append-Only Application Layer:** No `PUT`, `PATCH`, or `DELETE` endpoints exist for audit records. Non-GET requests to audit routes return HTTP 405 Method Not Allowed.
- **Server-Derived Attribution:** Authenticated events derive `actor_id` strictly from `req.user.id`. Client payloads cannot forge actor identities or timestamps (`occurred_at = now()`).
- **Metadata Sanitization:** The service allowlists permitted keys (`ALLOWED_METADATA_KEYS`), redacts credential-shaped strings (Bearer tokens, JWTs, password assignments, Argon2 hashes), and bounds text values to 500 characters.
- **Transactional Atomicity:** Mutating operations pass the active database client and `throwOnError: true` to ensure the business action rolls back if audit logging fails.

### Architectural Limitations
- **Database Superuser Boundary:** The database role used by Express (`postgres`) has table privileges. Append-only guarantees are enforced by application code and RLS policies (0 update/delete policies), but a database superuser or direct SQL console operator could theoretically execute raw SQL deletions. Cryptographic Merkle audit trees (RFC 6962) or external WORM storage are required for mathematical proof against privileged database administrators.

---

## 10. Multi-Tenant Architecture & Boundary Evaluation

TrustVault implements a **user-centric document tenancy model** with explicit per-document discretionary access control (DAC), rather than an organization- or workspace-level tenancy model.

### Multi-Tenancy Boundary Audit Findings

| Audit Question | System Reality | Architectural Details |
|:---|:---|:---|
| **1. Is there an organization or tenant entity?** | **No** | The schema contains `users`, `documents`, `document_grants`, `audit_events`, and `sessions`. There are no `organizations`, `tenants`, or `workspaces` tables. |
| **2. Can users belong to different organizations?** | **No** | Users register with an email address. There are no organization membership tables, domain-based tenant partitions, or multi-tenant user hierarchies. |
| **3. Are documents associated with a tenant?** | **User-Level Only** | Documents belong to an `owner_id` (a user UUID in `public.users`). The owner is the sole authority over the document enclave. |
| **4. Are document grants constrained by tenant boundaries?** | **Platform-Wide** | Any document owner can grant permissions (`read` or `edit`) to any registered user by their email address. |
| **5. Can an owner share a document with a user outside their intended tenant?** | **By Design** | Because tenants are user-centric enclaves, sharing is discretionary per document. There are no cross-organization boundary constraints. |
| **6. Can an admin see all users and documents?** | **Users: Yes; Documents: No** | Admins can list all users and audit logs. However, admins do **not** have implicit read or download access to documents they do not own. Zero-knowledge document isolation is preserved. |
| **7. Does storage access enforce tenant and document permissions?** | **Yes** | Storage objects are stored in private buckets (`public: false`) with random UUID keys. Direct storage access is blocked; downloads stream exclusively through server authorization. |
| **8. Can identifiers be substituted to access resources (IDOR)?** | **No** | Every document operation executes `authorizeDocumentAccess`. Non-owners without active grants receive uniform `HTTP 404 Not Found` responses. |

### Product & Migration Assessment
Introducing an organization-level tenant model would require a breaking database migration (`ALTER TABLE documents ADD COLUMN organization_id UUID NOT NULL`), an organizations table, tenant invitation workflows, and a complete rewrite of grant constraints and RLS policies. The current user-enclave model achieves complete document-level isolation, zero-knowledge administration, and strict IDOR prevention without unnecessary schema complexity.

---

## 11. Administrative User Governance & Session Lifecycle

Administrative user management is exposed via `/api/admin/users` and enforced independently on the server.

### Role Transition Rules
- Supported application roles: `admin`, `owner`, `viewer`.
- Public registration strictly assigns role `viewer` (`least privilege`).
- Role transitions are performed exclusively by authenticated administrators via `PATCH /api/admin/users/:id/role`.
- **Self-Demotion Safeguard:** An administrator cannot change their own role via the admin interface (`HTTP 400 Bad Request`).
- **Last-Admin Safeguard:** To prevent accidental lockout, the server queries active administrators before applying role or status modifications. If only one active administrator remains, demoting or disabling that administrator is rejected (`HTTP 400 Bad Request`).

### Account Disabling & Immediate Session Revocation
When an administrator disables an account via `PATCH /api/admin/users/:id/status` (`status: "disabled"`):
1. **Database Status Update:** `public.users.status` transitions from `'active'` to `'disabled'`.
2. **Server-Side Session Purge:** The server executes an immediate multi-session invalidation:
   ```sql
   DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1
   ```
3. **Subsequent API Enforcement:** Any subsequent request presenting an existing session cookie is rejected with `HTTP 401 Unauthorized` (session destroyed). If a session was cached in memory, `requireAuth` queries PostgreSQL and rejects non-active users with `HTTP 403 Forbidden` (`"Account disabled"`).
4. **Data Preservation:** Disabling an account preserves all owned documents, active grants, and historical audit events intact.
5. **Audit Trail:** Disabling and re-enabling actions emit immutable `admin_change_status` audit events with actor attribution.
