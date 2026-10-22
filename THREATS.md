# TrustVault — Security & Threat Model

This document outlines the security architecture, threat model, implemented controls, residual risks, and deployment requirements for TrustVault.

---

## 1. Authentication & Session Threat Matrix (Phase 4)

| Threat ID | Threat Category | Threat Description | Implemented Mitigation | Verification Status |
|:---|:---|:---|:---|:---|
| **T-AUTH-01** | **Brute-Force & Credential Stuffing** | Attacker attempts automated password guessing against user accounts. | - Rate limiting on `/api/auth/login` (10 requests / 15 min per IP).<br>- Generic error messages for unknown account, incorrect password, and disabled accounts.<br>- NIST SP 800-63B password policy (min 12 chars). | ✅ Verified with automated tests in `tests/rate-limit.test.ts` and `tests/auth.test.ts`. |
| **T-AUTH-02** | **Account Enumeration / Timing Attacks** | Attacker measures server response time or error codes to discover registered emails. | - Constant generic response: `{"error": "Invalid email or password"}` (401).<br>- Constant-work dummy verification via pre-computed Argon2id hash (`DUMMY_HASH`) executed when account does not exist or is disabled.<br>- Safe duplicate email response on registration. | ✅ Verified with automated tests in `tests/auth.test.ts`. |
| **T-AUTH-03** | **Privilege Escalation via Registration** | Attacker injects `"role": "admin"` or `"role": "owner"` into registration payload. | - Strict Zod schema (`.strict()`) rejects unexpected body attributes.<br>- Database insert hardcodes `role = 'viewer'` and `status = 'active'`. | ✅ Verified with automated tests in `tests/auth.test.ts`. |
| **T-AUTH-04** | **Hash Cracking & Offline Attacks** | Attacker extracts database dumps and attempts GPU-accelerated cracking. | - Argon2id algorithm (hybrid TMTO and side-channel resistant).<br>- OWASP-calibrated parameters: 19 MiB memory cost, 2 iterations, 1 parallelism, 32-byte salt/digest.<br>- Automatic `needsRehash` detection on login for seamless algorithm upgrades. | ✅ Verified with automated tests in `tests/argon2.test.ts`. |
| **T-AUTH-05** | **Password Hashing DoS (CPU/Memory Exhaustion)** | Attacker floods login or registration with oversized strings or parallel requests to consume CPU cores. | - Input validation bounds password between 12 and 128 characters *before* calling Argon2id.<br>- Bounded concurrency limiter (semaphore, max 10 concurrent hashes) returning HTTP 429 when overloaded.<br>- 1MB JSON body size limit. | ✅ Verified in `src/auth/argon2.ts` and `tests/argon2.test.ts`. |
| **T-AUTH-06** | **Session Fixation** | Attacker traps a victim into authenticating with a pre-set session identifier. | - `req.session.regenerate()` is executed upon successful authentication.<br>- Old session identifier is discarded and replaced before sending the response cookie. | ✅ Verified with automated test in `tests/auth.test.ts`. |
| **T-AUTH-07** | **Session Hijacking & Cookie Theft** | Attacker intercepts or accesses the session cookie via XSS or network eavesdropping. | - `HttpOnly` flag prevents client-side JavaScript access.<br>- `SameSite=Lax` mitigates cross-site cookie transmission.<br>- `Secure` flag enforced in production environments.<br>- `__Host-` cookie prefix enforced in production over HTTPS.<br>- Helmet security headers configured. | ✅ Verified in `src/auth/session.ts` and `tests/auth.test.ts`. |
| **T-AUTH-08** | **Stale / Zombie Session Access** | Attacker retains access using an old session after password change or account disablement. | - Authoritative database verification: `requireAuth` queries `public.users` on every authenticated request.<br>- Disabled accounts (`status = 'disabled'`) are rejected immediately with HTTP 403.<br>- Multi-session invalidation: Password change deletes all other sessions from `public.sessions` (`DELETE FROM public.sessions WHERE (sess::jsonb)->>'userId' = $1 AND sid != $currentSid`).<br>- Server-side absolute expiration (24h) and idle expiration (8h). | ✅ Verified with automated tests in `tests/auth.test.ts`. |
| **T-AUTH-09** | **Cross-Site Request Forgery (CSRF)** | Malicious third-party website tricks an authenticated user's browser into executing state-changing actions. | - Defense-in-depth: Strict `Origin` and `Referer` allowlist validation on all state-changing methods (`POST`, `PUT`, `PATCH`, `DELETE`).<br>- Session-bound synchronizer token (`x-csrf-token`) validated using constant-time comparison (`crypto.timingSafeEqual`).<br>- Strict CORS allowlist (`FRONTEND_ORIGIN`). Wildcards forbidden with credentials. | ✅ Verified with automated tests in `tests/csrf.test.ts`. |

---

## 2. Document Authorization & Access Control Threat Matrix (Phase 5)

| Threat ID | Threat Category | Threat Description | Implemented Mitigation | Verification Status |
|:---|:---|:---|:---|:---|
| **T-DOC-01** | **Insecure Direct Object References (IDOR)** | Attacker guesses or modifies document UUIDs or grant IDs to read metadata, download contents, or modify records belonging to other users. | - Centralized authorization engine (`authorizeDocumentAccess`) validates ownership or active grant via parameterized SQL on every request.<br>- Anti-enumeration safe response: Inaccessible or non-existent documents return uniform `404 Not Found` without disclosing resource existence.<br>- Download stream protected behind identical authorization checks. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |
| **T-DOC-02** | **Privilege Escalation via Grant Tampering** | Attacker self-assigns `edit` permission, grants permissions to themselves, creates documents as `viewer`, or assigns arbitrary `owner_id`. | - Strict Zod schemas reject client-supplied `owner_id`, `id`, `storage_key`, or extra fields.<br>- Document creation restricts role to `owner` or `admin` (`viewer` receives HTTP 403).<br>- Only the document owner may create, update, or revoke grants.<br>- Grantees with `read` permission cannot edit metadata or delete documents.<br>- Grantees cannot share documents or modify grants. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |
| **T-DOC-03** | **Stale / Zombie Grant Access** | Attacker retains access to document metadata or downloads after their access grant has been revoked. | - Real-time database lookup checks `revoked_at IS NULL` on every request with zero caching in sessions or long-lived tokens.<br>- Revocation sets `revoked_at = now()` atomically; subsequent requests are denied immediately. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |
| **T-DOC-04** | **Cross-Tenant Disclosure via Search & Pagination** | Attacker discovers unauthorized document titles, categories, or counts via search queries, filtering, or pagination metadata. | - SQL query predicates enforce `d.deleted_at IS NULL AND (d.owner_id = $userId OR EXISTS (SELECT 1 FROM document_grants dg WHERE dg.document_id = d.id AND dg.user_id = $userId AND dg.revoked_at IS NULL))` on both data and count queries.<br>- Caller never receives unauthorized records. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |
| **T-DOC-05** | **Storage Access Boundary Bypass** | Attacker accesses documents directly from storage using predictable object keys, or frontend leaks storage credentials. | - Supabase Storage bucket (`trustvault-private`) is strictly private.<br>- Privileged `SUPABASE_SECRET_KEY` remains exclusively on the server.<br>- Server generates cryptographically random UUID-based storage keys; client never supplies or sees storage keys.<br>- Downloads are streamed through authenticated server routes after database authorization. | ✅ Verified in `src/documents/storage.ts` and `tests/authorization.test.ts`. |
| **T-DOC-06** | **Administrative Boundary Violation** | Administrator role automatically bypasses document privacy and accesses confidential user files without explicit authorization. | - Least privilege: Role `admin` does not confer automatic read, download, or edit rights on user documents without an explicit grant or ownership.<br>- All document routes require ownership or active grant regardless of administrative role. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |
| **T-DOC-07** | **Soft-Deletion Bypass** | Attacker accesses or restores deleted document metadata or content. | - Centralized authorization checks `deleted_at IS NULL` on all operations.<br>- Soft-deleted documents fail closed with uniform 404 responses for owners and grantees. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |
| **T-DOC-08** | **Grant Concurrency Race Conditions** | Concurrent requests create duplicate active grants or leave grant states inconsistent. | - Database transactions with row-level locks (`SELECT ... FOR UPDATE`) check for active grants before insertion.<br>- Partial unique index `document_grants_one_active_idx` enforces single active grant at database level; conflicts return HTTP 409 Conflict. | ✅ Verified with automated tests in `tests/authorization.test.ts`. |

---

---

## 3. Inherent Residual Risks (Architectural & Physical Limitations)

The following risks are inherent to distributed web applications and digital content delivery. They cannot be eliminated solely through application software controls and represent accepted operational boundaries:

### R-INH-01: Client-Side Document Copy & Screenshot Persistence (Limits of Revocation)
- **Risk Characterization:** Once an authorized user downloads or displays confidential document content in their browser, subsequent server-side grant revocation cannot retroactively delete local files, client OS swap/memory, or external screen captures from the recipient's device.
- **Enforced Mitigations:**
  - All document metadata, content download, and grant management endpoints enforce strict non-caching headers: `Cache-Control: no-store, no-cache, must-revalidate, private` and `Pragma: no-cache`.
  - Content streaming enforces `X-Content-Type-Options: nosniff` and content disposition attachments.
  - Downloads are routed exclusively through authenticated, authorized server streaming endpoints; no permanent or public signed URLs are ever issued.
- **Residual Risk Acceptance:** Accepted inherent boundary of digital file delivery. Enterprise environments requiring hardware-level content containment must deploy managed Mobile Device Management (MDM) / Data Loss Prevention (DLP) controls or evaluate client-side DRM.

### R-INH-02: Cloud Provider Storage-Level Operator Access
- **Risk Characterization:** Personnel with administrative access to the underlying cloud infrastructure (Supabase / AWS S3) could theoretically inspect raw storage volumes or database snapshots.
- **Enforced Mitigations:**
  - Storage buckets are strictly private (`trustvault-private`).
  - Storage credentials (`SUPABASE_SECRET_KEY`) reside exclusively on the backend server.
  - Storage object keys use unguessable UUIDs rather than identifiable user or document names.
- **Residual Risk Acceptance:** Accepted cloud provider infrastructure trust boundary. Client-side end-to-end encryption (E2EE) with client-held keys can be introduced in a future phase if zero-knowledge guarantees are required.

---

## 4. Actionable Release Blockers & Production Deployment Prerequisites

The following engineering and infrastructure controls are **mandatory release blockers**. Each must be satisfied before general production deployment:

| Blocker ID | Prerequisite | Risk if Unresolved | Actionable Implementation Path & Release Condition |
|:---|:---|:---|:---|
| **RB-01** | **Multi-Factor Authentication (MFA / TOTP)** | Credential stuffing or password compromise grants single-factor access to owner and admin accounts. | **Condition:** Mandatory RFC 6238 TOTP enrollment and login challenge verification for all accounts with `owner` and `admin` roles before production access is granted.<br>**Path:** Integrate an RFC 6238 compliant TOTP library (e.g., `otplib` or `@levminer/speakeasy`) with AES-256-GCM encrypted TOTP secret keys stored in PostgreSQL, accompanied by single-use recovery backup codes. Require TOTP challenge validation during login before establishing fully authorized sessions for privileged roles. |
| **RB-02** | **Distributed Rate Limiting** | Multi-instance container deployments behind a load balancer do not share in-memory quotas, weakening brute-force protections. | **Condition:** Centralized rate-limiting store shared across all API replicas.<br>**Path:** Provision managed Redis cluster and configure `rate-limit-redis` for `loginRateLimiter` and `registerRateLimiter`. |
| **RB-03** | **Production Transactional Email & Password Reset** | Legitimate users cannot recover forgotten passwords without manual database edits. Insecure placeholder flows risk token leaks. | **Condition:** Verified email delivery service with time-limited (15-min), single-use hashed reset tokens.<br>**Path:** Provision AWS SES / SendGrid, implement `password_reset_tokens` table with SHA-256 token hashing and rate limiting. |
| **RB-04** | **TLS Termination & Ingress Proxy Trust** | Man-in-the-middle interception of session cookies; spoofed `X-Forwarded-For` headers bypassing IP rate limits. | **Condition:** TLS 1.3 enforced at ingress with HSTS, and `TRUST_PROXY` strictly set to the known subnet CIDR of the load balancer.<br>**Path:** Configure ingress controller with TLS certificates and set `TRUST_PROXY=<ingress-cidr>` in production `.env`. |
