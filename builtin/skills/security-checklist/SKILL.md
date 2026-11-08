---
name: security-checklist
description: OWASP Top 10 oriented checklist with concrete sinks, greps, and fixes. Read when running /security, reviewing code that handles input, auth, files, shell, SQL, crypto, secrets, or uploads, or before shipping a new endpoint.
---

# Security checklist

Scanner and grep hits are **leads**. A finding needs a traced path from an untrusted source (request params/body/headers, files, env set by users, messages, third-party responses) to a sink, with no effective guard on the way.

## A01 Broken access control
- Every route/handler has the same auth middleware as its siblings; compare the route table. Admin routes check role server-side.
- Object access checks ownership/tenant: `find(id)` → `find({ id, ownerId: user.id })`. IDOR is the most common real-world bug.
- No authorization decisions based only on client-side state, hidden fields, or JWT claims that were not verified.
- CORS: no `Access-Control-Allow-Origin: *` with credentials; no reflected origin without an allowlist.
- CSRF protection on cookie-authenticated state-changing requests (SameSite plus token where needed).

## A02 Cryptographic failures
- Passwords: argon2id, scrypt, or bcrypt. Never MD5/SHA-1/SHA-256 alone.
- Tokens, IDs, nonces: CSPRNG (`crypto.randomBytes`, `crypto.randomUUID`, `secrets`), never `Math.random`/`random`.
- AEAD (AES-GCM, ChaCha20-Poly1305) with unique nonces; no ECB; no hardcoded keys or IVs.
- TLS verification never disabled (`rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`).
- Sensitive data encrypted at rest where required; not logged.

## A03 Injection
| Kind | Sinks to grep | Fix |
|---|---|---|
| SQL | string concat/template into `query(`, `raw(`, `execute(` | parameterized queries / ORM bindings |
| Shell | `exec(`, `execSync(`, `spawn(..., {shell:true})`, `subprocess(..., shell=True)`, `os.system` | argv arrays, no shell; allowlist args |
| Code | `eval(`, `new Function(`, `vm.runIn*`, `pickle.loads`, unsafe `yaml.load` | remove; safe parsers (`yaml.safe_load`) |
| NoSQL | user objects passed as Mongo filters (`$where`, `$ne` injection) | schema-validate, cast types |
| Template/XSS | `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `|safe`, `{{{ }}}` | auto-escaping, sanitize (DOMPurify) |
| LDAP/XPath/Header | unescaped input into filters or headers (CRLF) | library escaping |

## A04 Insecure design
- Rate limits on login, signup, password reset, OTP, expensive endpoints.
- Business-logic abuse: negative quantities, replayed coupons, race conditions on balances (use transactions/row locks/idempotency keys).
- Account recovery cannot bypass MFA; reset tokens are single-use and expire.

## A05 Security misconfiguration
- Debug modes, stack traces, and verbose errors off in production.
- Security headers: CSP, HSTS, `X-Content-Type-Options: nosniff`, frame-ancestors.
- Default credentials, sample apps, open admin consoles, permissive cloud bucket policies.
- XML parsers with external entities disabled (XXE).

## A06 Vulnerable components
- Run the ecosystem audit (`npm/pnpm/bun audit`, `pip-audit`, `cargo audit`, `govulncheck`, `osv-scanner`).
- For each advisory, check reachability: is the vulnerable function imported and called?
- Lockfile committed; no wildcard versions for security-relevant deps; watch for typosquats in new deps.

## A07 Identification and authentication failures
- JWT: signature verified with a pinned algorithm; `none` rejected; `exp`/`aud`/`iss` checked; no `decode` used as `verify`.
- Sessions: rotated on login, invalidated on logout and password change, `HttpOnly; Secure; SameSite` cookies.
- Constant-time comparison for secrets and tokens.
- No user enumeration via different error messages or timing.

## A08 Software and data integrity failures
- Webhooks verify signatures (HMAC with constant-time compare) and timestamps.
- No deserialization of untrusted data into objects with behavior.
- CI: actions pinned, no untrusted code run with secrets (e.g., `pull_request_target` checking out PR code).

## A09 Logging and monitoring failures
- Auth failures, permission denials, and admin actions are logged with actor and target.
- Logs never contain passwords, tokens, full card numbers, or secrets; redact at the logger.

## A10 SSRF
- Outbound requests with user-influenced URLs: scheme allowlist, host allowlist, resolve-then-check against private ranges (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254.169.254, ::1, fc00::/7), and re-check on redirects.

## Also check
- **Path traversal:** user input in `path.join`, `open`, `sendFile`, archive extraction (zip slip). Resolve then verify the result stays under the base dir.
- **Uploads:** size limits, content-type sniffing, store outside web root, randomized names, no execution.
- **ReDoS:** nested quantifiers on user input (`(a+)+`), unbounded regex on large strings.
- **Secrets:** none in code, configs, Dockerfiles, CI logs, or git history; `.env*` ignored.
- **Prototype pollution (JS):** deep merge of user JSON into objects; `__proto__`/`constructor` keys.
- **LLM/agent features:** untrusted content reaching tool calls or system prompts (prompt injection); model output rendered as HTML or executed.

## Reporting a finding
`[severity] title — CWE-n — source path:line → sink path:line — evidence quote — exploit sketch — fix in the project's idiom — regression test idea`. Severity = exploitability x impact, adjusted for reachability and existing controls.

Adapted from the ruflo-security-audit plugin (MIT, ruvnet), agentic-qe `security-testing` (MIT), agency-agents "Application Security Engineer" (MIT), and the OWASP Top 10 (2021).
