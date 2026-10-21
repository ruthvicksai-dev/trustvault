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

## 2. Residual Risks & Incomplete Features (Release Blockers)

The following controls are planned but not yet implemented in Phase 4. They constitute **residual risks** and must be resolved before general production release:

1. **Multi-Factor Authentication (MFA / TOTP / WebAuthn):**
   - *Status:* Incomplete / release blocker for privileged roles.
   - *Risk:* Compromise of owner or admin passwords grants full access to documents without a second factor.
   - *Recommendation:* Implement TOTP/WebAuthn enrollment and enforcement for `admin` and `owner` roles in a future phase.

2. **Distributed Rate Limiting:**
   - *Status:* Single-instance in-memory rate limiting.
   - *Risk:* In a multi-instance containerized environment behind a load balancer, per-IP quotas are not shared across nodes.
   - *Requirement:* Deploy Redis or use PostgreSQL-backed rate-limiting stores (`rate-limit-redis`) in production.

3. **Self-Service Password Reset & Email Verification:**
   - *Status:* Omitted by design until transactional email infrastructure is provisioned.
   - *Risk:* Users cannot recover forgotten passwords without administrator intervention.
   - *Safety Decision:* Insecure placeholder recovery flows (such as logging tokens to stdout) were strictly rejected. Production deployment requires an email provider (e.g., AWS SES, SendGrid), time-limited single-use hashed tokens in a dedicated table, and rate-limited reset requests.

4. **HTTPS Boundary & Reverse Proxy:**
   - *Status:* External deployment requirement.
   - *Requirement:* Production deployment requires TLS termination at the ingress load balancer and strict `TRUST_PROXY` configuration matching known proxy CIDRs.
