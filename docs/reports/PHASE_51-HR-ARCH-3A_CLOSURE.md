# PHASE 51-HR-ARCH-3A — THE TOKEN CONTRACT SEAM

**PHASE: 51-HR-ARCH-3A**
**STATUS: COMPLETE — one verifier, one issuer, one policy, four ports bound by the runtime that
owns them. The combined runtime is behaviourally unchanged; a standalone HR runtime is now
reachable without one line of HR code changing.**

This phase implements the **token and authorization seam** of ADR-0006 §B/C/D. It does **not**
implement the ADR's delivery contracts (`platform.identity@v1`, `platform.audit@v1`), does not
extract HR into its own process, and does not turn on asymmetric trust in any environment — the
switch is key material, and no key material is configured here. What it does is remove the
*structural* reasons HR could not be extracted: one verification implementation instead of two,
authorization that reads a claim instead of Core's database, and a tenant that comes from a
verified claim instead of a per-request Core query.

Every figure below was re-derived from a command run on this machine for this phase.

---

## 1. THE PROBLEM, IN THE CODE THAT EXISTED

Before this phase the platform verified tokens **twice** and issued them **three ways**:

| Concern | Where it lived | Why that blocked extraction |
|---|---|---|
| Signature verification | `JwtStrategy` (HTTP) **and** `MessagingGateway` (WS handshake) | Two copies of the secret, audience, issuer and `tokenVersion` re-read. A migration that fixed one would leave the other on the old rule. |
| Issuance | A payload literal in `AuthService.login` **and** a second one in `AuthService.refresh`, each with its own TTL | Adding `tid`/`ver`/`perm` was a change to two call sites, not to a contract. |
| Authorization input | `RolesGuard` → `PermissionService` → Core's `UserRole`/`RolePermission`/`Permission` tables | Every authorization decision in every runtime was a Core-database decision. |
| Tenant | `TenantContextInterceptor` → `prisma.user.findUnique({ where: { id } })` on **every authenticated request** | A per-request Core query performed solely to fill `RequestContextService`. |
| Algorithm | Ambient `JwtModule.registerAsync` secret per module | Nothing pinned an algorithm, so `alg` was whatever a token's header said. |

---

## 2. WHAT WAS BUILT

`apps/api/src/platform/auth/` — **19 files, 4,291 lines**: 11 source + 8 specs (plus the two ports'
consumers, listed in §3). The seam is a folder with no business-domain imports, so it is covered by
the existing `keeps platform implementation free of business-module imports` architecture test —
and, since this phase, by two further tests that assert the property directly (§5.2).

### 2.1 The contracts

| File | Lines | What it declares |
|---|---|---|
| `token-contract.ts` | 268 | `TrustedTokenClaims` (one shape for every consumer), `TokenTrust`, `TokenRejectionReason` (13 fine-grained reasons), `TokenRejectedError`, `TOKEN_ASYMMETRIC_ALGORITHM`/`TOKEN_LEGACY_ALGORITHM`, `TokenAlgorithm` (a two-literal union, so a plan cannot carry an algorithm nobody chose), `PERMISSION_NAME_PATTERN`, `canonicalisePermissions`. |
| `permission-source.contract.ts` | 46 | `PermissionSource` — the port `RolesGuard` now depends on. |
| `tenant-resolver.contract.ts` | 49 | `TenantResolver` + `TenantResolution.source` (`'claim' \| 'core-database' \| 'none'`). |

### 2.2 The implementation

| File | Lines | Responsibility |
|---|---|---|
| `token-policy.ts` | 289 | The **only** reader of the token environment surface. Every name optional; the whole configuration is auditable in one constructor and assertable in one spec. Refuses two key sources at once, refuses private material in a verification key, refuses a mint TTL above the accepted maximum. |
| `token-keyset.ts` | 423 | Algorithm pinning + key selection by `kid`; JWKS fetch with cache, cooldown, timeout and a fail-closed unknown-`kid` rule. |
| `token-issuer.ts` | 255 | The only code that mints a token. One payload shape per trust level; `perm` ceiling enforced **at issuance** (a token is never minted with a truncated list); returns the lifetime it actually signed (`exp - iat`), so a caller's `expiresIn` cannot disagree with the token it received. |
| `token-verifier.ts` | 444 | Signature first, claims second. `planVerification()` (algorithm + key, stashed on the request for `passport-jwt`) and `trust()` (issuer, audience, identity, lifetime, `tid`/`ver`/`perm`, revocation), composed as `verify()` for callers holding a raw token. |
| `token-revocation.ts` | 359 | The deny-set: `(userId, ver)` at or below a revoked version is refused; bounded by the accepted TTL so it cannot grow without limit; `describe()`/`snapshot()` report posture so a degraded state is observable. |
| `token-auth.module.ts` | 120 | DI. `JwtModule.register({})` with **no secret**: every key is passed explicitly at the call site, so a call that forgets its key fails loudly instead of silently using "the" secret. |

### 2.3 The claim-only implementations (what a standalone runtime binds)

| File | Lines | Bound by |
|---|---|---|
| `token-permission-source.ts` | 37 | A runtime with no Core database. No Prisma client, no Core import. |
| `claims-tenant-resolver.ts` | 33 | Same. A legacy token resolves to **no tenant** here — honest, and fail-closed. |

### 2.4 The Core implementations (what the combined runtime binds)

| File | Lines | Rule it encodes |
|---|---|---|
| `auth/rbac/services/core-permission-source.ts` | 47 | Asymmetric trust → the `perm` claim, nothing else. Legacy trust → Core's cached catalogue, exactly as before. |
| `tenant/core-tenant-resolver.ts` | 55 | Asymmetric trust → `tid` (no query). Legacy trust → the database, exactly as before. |

**The rule is the token's verified TRUST LEVEL, never "is the claim present".** A shared-secret
token can carry an arbitrary `perm` or `tid`, and its holder could write anything there; the
bridge therefore keeps today's answer rather than half-adopting the new model.

---

## 3. THE BOUNDARY AS IT NOW STANDS

The seam is only worth the name if the consumers moved with it, so the table below names the
consumer of every part of it and where that consumer now gets its answer.

| Capability | Declared in | Consumer (unchanged dependency) | Bound by the combined runtime | Bound by a standalone runtime |
|---|---|---|---|---|
| Verification | `platform/auth/token-verifier.ts` (`TokenVerifier`) | `JwtStrategy` (HTTP) and `MessagingGateway` (WS handshake) | `TokenAuthModule` provides it once and exports it | same class, same module |
| Issuance | `platform/auth/token-issuer.ts` (`TokenIssuer`) | `AuthService.login` and `AuthService.refresh` | `TokenAuthModule` | not registered — a verifier-only runtime must not be able to mint |
| Authorization input | `platform/auth/permission-source.contract.ts` (`PermissionSource`) | `RolesGuard`, a global `APP_GUARD` | `CorePermissionSource`, via `useExisting` in `rbac.module.ts` | `TokenPermissionSource` |
| Tenant | `platform/auth/tenant-resolver.contract.ts` (`TenantResolver`) | `TenantContextInterceptor`, registered globally in every runtime | `CoreTenantResolver`, via `useExisting` in `tenant.module.ts` | `ClaimsTenantResolver` |
| Acceptance policy | `platform/auth/token-policy.ts` (`TokenPolicy`) | `TokenVerifier`, `TokenKeySet`, `TokenIssuer`, `TokenPostureLogger`, `env.validation.ts` | `TokenAuthModule`, from `ConfigService` | same |
| Key selection | `platform/auth/token-keyset.ts` (`TokenKeySet`) | `TokenVerifier` | `TokenAuthModule` | same |
| Deny-set | `platform/auth/token-revocation.ts` (`TokenRevocationRegistry`, `RevocationFeed`) | `TokenVerifier` (deny), `TokenPostureLogger` (report) | `TokenAuthModule`, in-memory, feed unwired | same |

**Why the two ports are bound by the runtime and not by `TokenAuthModule`.** From
`token-auth.module.ts`: "which authority resolves a tenant" is a runtime-policy decision, not a
token decision. Registering both implementations in one module would leave a dead provider in
every deployment and turn "which one is in effect?" into a question about registration order.
The `TenantModule` comment states the same test for the future case directly: the standalone
runtime binds `ClaimsTenantResolver` here instead, and its interceptor code is unchanged.

**What is verifiably true of the combined runtime as it stands:**

- `RolesGuard → PermissionSource`, not `RolesGuard → PermissionService`
  (`roles.guard.ts:16`, `roles.guard.ts:24`).
- `TenantContextInterceptor` holds a `TenantResolver` and no `PrismaService`
  (`tenant-context.interceptor.ts:38`, `:49`); the Prisma read now lives only in
  `CoreTenantResolver`.
- `JwtStrategy` and `MessagingGateway` call the *same* `TokenVerifier`
  (`jwt.strategy.ts:50`, `:63`, `:94`; `messaging.gateway.ts:77`, `:122`). There is one
  verification implementation in the process, not two.
- `AuthService` mints through `TokenIssuer` on both paths (`auth.service.ts:30`, `:108`, `:305`),
  and asks `PermissionSource` for the catalogue that goes into `perm` — at issuance, where the
  answer is Core's, and where a `null` claim set means exactly that
  (`permission-source.contract.ts:39`).
- `AuthModule` no longer registers `JwtModule.registerAsync`, so the module that serves login
  holds no signing material of its own (`auth.module.ts:20`).

---

## 4. WHAT DID NOT CHANGE

This phase changed no HR code and switched no environment. The claims are narrow on purpose, and
each is checkable:

1. **An environment that sets none of the new names behaves as it did before the phase.**
   `.env.example` states it in the file itself (lines 112–115): all of the token names are
   optional, and asymmetric trust is entered by supplying key material deliberately — never by a
   default.
2. **Legacy tokens keep today's answer, exactly.** `legacy-hmac` → Core's cached catalogue for
   permissions (`core-permission-source.ts:41–45`) and Core's `User.tenantId` for the tenant
   (`core-tenant-resolver.ts:48–53`). The pre-existing suites for `RolesGuard`,
   `TenantContextInterceptor`, `AuthService` and `MessagingGateway` assert the legacy behaviour
   and were extended rather than replaced.
3. **No HR file is in the diff.** `git diff --stat -- apps/api` names 16 tracked files: auth,
   rbac, tenant, messaging, config and the architecture test. `src/modules/hr/**` is absent.
   `resolveHrActor()`, `UserDirectoryContract`, `JwtAuthGuard` and every HR module are untouched,
   as the ADR's non-goals require.
4. **No policy file was edited.** `future-hr` is still declared a target
   (`RUNTIME_HEALTH_COMPOSITION['future-hr'].status === 'target'`), asserted by the architecture
   suite as it was before.
5. **The combined runtime's observable surface grew by exactly two boot log lines.**
   `TokenPostureLogger.onModuleInit()` posts `Token acceptance: …` and `Revocation: …` once at
   boot. That is the only new output a running deployment produces from this phase.

**The one behavioural change that is not "unchanged", stated plainly:** a request that carries an
`asymmetric` token now has its permissions read from the token and its tenant read from the token,
with no Core query. That path did not exist before, because no token could be asymmetric before —
it is new behaviour for a new kind of token, not changed behaviour for an old one.

---

## 5. EVIDENCE

Every figure in this report was re-derived from a command run against this working tree on
2026-09-17. Commands are from `apps/api` unless the row says otherwise.

| Command | Result |
|---|---|
| `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0, no diagnostics.** The seam, its consumers and the extended specs all typecheck. |
| `node ../../node_modules/jest/bin/jest.js --testPathPattern "platform/auth\|core-tenant-resolver\|core-permission-source\|architecture-boundaries"` | **11 suites, 165 tests, all passing** — the 8 seam specs, the 2 binding specs, and `architecture-boundaries.spec.ts`. Re-run after the §5.3 cleanup, unchanged. |
| `node ../../node_modules/jest/bin/jest.js` (full suite, captured to `%TEMP%\arch3a-final-full.txt`) | **120 suites, 1,988 tests, all passing.** `apps/api/src` contains 120 `.spec.ts` files, so "every spec file is a suite" holds and nothing was skipped or silently ignored. |
| `node ../../node_modules/jest/bin/jest.js --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` (captured to `%TEMP%\arch3a-final-archpolicy.txt`) | **2 suites, 54 tests, all passing** — the two gates §5.2's tests belong to. |
| `node ../../node_modules/jest/bin/jest.js --testPathPattern "modules/hr"` (captured to `%TEMP%\arch3a-final-hr.txt`) | **12 suites, 106 tests, all passing** — HR is green although this phase changed no HR file (§4.3). |
| `git diff --stat -- apps/api` (repo root) | **16 tracked files changed, 823 insertions(+), 179 deletions(−).** |
| `git status --porcelain` (repo root) | the seam's five paths are the **new files** this change adds: `src/platform/auth/` (19 files), `src/tenant/core-tenant-resolver.ts` + `.spec.ts`, `src/auth/rbac/services/core-permission-source.ts` + `.spec.ts`. The other 16 paths are modifications — the split §10.1/§10.2 versus §10.3. |

### 5.1 Sizes, counted file by file

| Group | Files | Lines |
|---|---|---|
| Contracts — `token-contract`, `permission-source.contract`, `tenant-resolver.contract` | 3 | 268 + 46 + 49 = **363** |
| Implementation — `token-policy`, `token-keyset`, `token-issuer`, `token-verifier`, `token-revocation`, `token-auth.module` | 6 | 289 + 423 + 255 + 444 + 359 + 120 = **1,890** |
| Claim-only ports — `token-permission-source`, `claims-tenant-resolver` | 2 | 37 + 33 = **70** |
| **`platform/auth` source** | **11** | **2,323** |
| **`platform/auth` specs** | **8** | 125 + 277 + 283 + 319 + 376 + 410 + 84 + 94 = **1,968** |
| **`platform/auth` total** | **19** | **4,291** |
| Core bindings — `core-permission-source.ts` + spec, `core-tenant-resolver.ts` + spec | 4 | 47 + 103 + 55 + 107 = **312** |

Consumers as they now stand: `roles.guard.ts` 115 lines, `tenant-context.interceptor.ts` 79,
`jwt.strategy.ts` 159, `messaging.gateway.ts` 442, `auth.service.ts` 570.

### 5.2 The two new architecture tests

`architecture-boundaries.spec.ts` grew from 425 to 464 lines and gained two tests, and that diff is
the most compact statement of what this phase is:

- **`keeps the token seam free of business-module and Core-persistence imports`** — no file under
  `platform/auth` may import `modules/`, `auth/`, `tenant/`, `messaging/`, `database/`, or
  `database/prisma`. The test's own comment gives the reason: "any of which would make 'HR can bind
  this without Core' false, because the binding would drag Core's database along with it."
- **`keeps the claim-only implementations free of any Core dependency`** — the *entire* external
  import list of `token-permission-source.ts` and `claims-tenant-resolver.ts` must equal
  `['@nestjs/common']`. That is a stronger claim than "does not import `PrismaService`": a future
  edit that reaches for a Core helper — a logger, a config service, a cache — fails here rather
  than silently making the extracted runtime need Core again.

Both pass, as two of the 11 suites above; the file is 22 tests in total and all of them pass on their
own (`--runInBand src/architecture-boundaries.spec.ts`). The property is therefore enforced at build
time from here on, not asserted only in this document.

### 5.3 Lint and formatting: this phase's findings, and the repository's pre-existing debt

Two gates §5 otherwise does not claim were measured on the same tree, because the distinction matters
more than the number:

| Gate | Untouched files — pre-existing | This phase's files |
|---|---|---|
| eslint | **exit 1 — 61 errors across 18 files** (`src/common`, `src/module-platform`, `src/health`, `src/integrations`); the largest group is `@typescript-eslint/no-explicit-any` | **exit 0 — 0 problems**, captured to `%TEMP%\arch3a-final-eslint.txt` (empty) |
| prettier | **4 of 5 untouched committed files flagged** (`audit.service.ts`, `module-signature.ts`, `user-directory.contract.ts`, `tenant-context.interceptor.ts`) | 23 files flagged — consistent with the baseline, see below |
| `git diff --check` (repo root, staged) | — | **exit 2 first, then exit 0.** Two `new blank line at EOF`, both this phase's, removed; see below. |

This phase's own four eslint findings, all of them in its own specs, are removed in this commit:

- `platform/auth/token-verifier.spec.ts` — unused `TOKEN_VERIFICATION_PLAN` import
- `platform/auth/token-verifier.spec.ts` — `trustWith` defined and never called
- `tenant/core-tenant-resolver.spec.ts` — unused `_args` parameter
- `auth/rbac/test/core-permission-source.spec.ts` — unused `_userId` parameter

They survived the phase because `apps/api/.eslintrc.js` scopes `argsIgnorePattern: '^_'` to `cms`,
`filters` and `main.ts` only, so it never reached these paths, leaving the two mock parameters named
and unused; they are argument-less now, and removing `trustWith` also removed the imports only it
used.

The same rehearsal found a second, smaller piece of phase-owned hygiene: `token-contract.ts` and
`token-keyset.spec.ts` each ended with a blank line at EOF, which `git diff --check` reports as `new
blank line at EOF` — and which it did not report at all while those files were still untracked,
because that check only reads staged content. Both blank lines are removed.

That is the whole of the cleanup, and none of it changes behaviour: an unused import, an unused
helper, two unused parameters and two trailing blank lines. §10.3's tracked diffstat (+823 / −179) is
identical before and after, because every file the cleanup touched is a new one; §5.1's counts fall by
one line for each removed blank line (`token-contract.ts` 269 → 268, `token-keyset.spec.ts` 284 →
283), and `token-verifier.spec.ts` is 9 lines shorter than at first count (385 → 376). The suite
totals are unchanged in both directions, re-measured after the cleanup: 11 / 165 targeted and
120 / 1,988 full.

The prettier non-conformance is **not** this phase's. `apps/api/.prettierrc` sets `printWidth: 100`
and `trailingComma: "es5"`, while the repository's code is hand-wrapped at ~80 columns with ES-all
trailing commas, so prettier 3.9.6 wants to collapse committed, untouched code — it rewrites 79 of
`audit.service.ts`'s 116 lines, one of them a 99-character constructor it would join onto one line,
exactly as it rewrites the seam's files. The seam reproduces the repository's existing style rather
than introducing a new one. Normalising it would be a repo-wide formatting commit touching files this
phase never opened, so it is deliberately not done here — on the same principle that the 61
pre-existing eslint errors above are left alone. Neither one is a property of this seam.

The E2E suite was **not** runnable and is not claimed as passing anywhere in this report:
`npm run test:e2e` stops in jest's config validation with `Module <rootDir>/test/jest-setup.ts in the
setupFiles option was not found. <rootDir> is: E:\ERP\apps\api\test`, because `test/jest-e2e.json`
sets `rootDir: "."`, which resolves relative to the config file rather than the workspace, so
`setupFiles` looks for `test/test/jest-setup.ts`. This is a pre-existing defect in files this phase
does not touch — `git diff --name-only` lists no `apps/api/test/` file — and the error is raised
before any spec is loaded. Unit and architecture coverage is what this report rests on.

---

## 6. THE ADR'S ACCEPTANCE CRITERIA, ONE BY ONE

The ADR lists nine acceptance criteria for "ARCH-3 implementation" as a whole. This phase is one
part of that whole, so the honest table states per criterion whether 3A carries it.

| ADR criterion | Status after 51-HR-ARCH-3A |
|---|---|
| Core signs with RS256 and publishes JWKS addressed by `kid`; HR verifies locally and holds no signing key | **Mechanism complete; no deployment switched.** `TokenKeySet` pins the algorithm, selects by `kid`, fetches JWKS with cache, cooldown and timeout, and fails closed on an unknown `kid`. `JwtModule.register({})` holds no secret, so a verifier process cannot sign by accident. No key material is configured anywhere, so no runtime is on RS256 yet — and no runtime can be, until Core publishes a JWKS. |
| Access tokens carry `tid`, `ver` and canonicalised `perm`; tokens exceeding `HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS` are rejected | **Satisfied in code.** The lifetime bound is enforced at issuance *and* at verification, and `MAX_PERMISSIONS_PER_TOKEN` is enforced at issuance as an error — a token is never minted with a truncated list. |
| Tenant and subject are read only from claims; no HR path reads a client-supplied tenant | **Satisfied and assertable on the asymmetric path.** `CoreTenantResolver` returns `source: 'claim'` with no query, and no implementation reads a tenant from a header, query or body. The legacy path keeps Core's database, which is what the bridge is for. |
| `platform.identity@v1` returns exactly `DirectoryUserProfile` | **Not this phase.** A delivery contract (ADR §A). No `platform/identity` exists; the pre-existing `platform/user-directory` (which HR already binds through `UserDirectoryContract`) is untouched, and the contract has no implementation behind it yet. |
| `platform.audit@v1` carries `AuditOptions` + `tenantId` + a caller-minted `auditId`, ingested idempotently | **Not this phase.** ADR §E. |
| Audit egress failure never fails a business write and never reports healthy while degraded | **Not this phase.** ADR §E. |
| `future-hr` declares `HR_DATABASE_URL: required` and `CORE_DATABASE_URL: not-used`, with the matrix assertion updated | **Not this phase, and deliberately so** — the ADR's own non-goals exclude the policy edit. The architecture suite still asserts `future-hr` is a `target`. |
| An architecture test proves no HR import closure reaches Core Prisma | **The part this phase owns is done.** §5.2's two tests prove the seam and the claim-only implementations are Core-free. The HR-closure assertion belongs to ARCH-2, because the runtime it would describe does not exist yet. |
| Revocation latency and the audit loss window are documented in the runtime's operational notes | **Half done.** Revocation posture is now observable from the process itself (`describe()`, `snapshot()`, and one boot log pair — §8). The operational notes and the audit loss window (which travels with §E) remain open. |

Read as a count: **two criteria satisfied, two satisfied in mechanism but not switched on, two
owned by the audit contract, one owned by ARCH-2, one forbidden to this phase by the ADR's own
non-goals, and one that is written down in this report rather than in an operational note.** No
criterion is claimed as met that a reader cannot re-run.

---

## 7. WHAT THIS PHASE DID NOT DO

Named explicitly, because each absence is a decision and not an oversight:

- **No identity or audit contract.** No `platform.identity@v1`, no `platform.audit@v1`, no HR
  audit table. ADR §A and §E are untouched.
- **No key material, and therefore no asymmetric trust anywhere.** The switch is key material, and
  every `JWT_ASYMMETRIC_*` name is commented out in `.env.example` (lines 121–128). Setting the
  names is the deployment's decision, not this phase's.
- **No HR extraction and no runtime artifact.** No `hr-app.module.ts`, no HR entrypoint, no
  Dockerfile, no policy edit; `future-hr` is still a declared target. ARCH-2 remains pending.
- **No Core-side change.** Core does not publish a JWKS, does not mint `tid`/`ver`/`perm`, and
  does not expose either contract. Until the first of those happens, the bridge is how the platform
  verifies.
- **No change to the guards or contracts the ADR protects:** `resolveHrActor()`,
  `UserDirectoryContract`, `JwtAuthGuard` — not one line of the diff adds to, removes from or
  renames them. The single occurrence of any of those names in the diff is a comment in the new
  code noting that HR's repository signatures stay as they are.
- **No ADR-0005 amendment**, as the ADR requires.
- **The bridge is still open.** `JWT_LEGACY_HS256_ENABLED` defaults to `true`: shared-secret
  tokens are still accepted, and acceptance is disabled automatically the moment asymmetric
  material is configured. Closing it before Core distributes keys would lock every existing
  deployment out, so the phase leaves it where it was.
- **`RevocationFeed` is bound to `UnwiredRevocationFeed`.** No transport subscribes yet, so
  revocation is whatever the in-process registry is told. The seam exists so that a transport is a
  one-line change; the transport itself is not part of this phase, and no deployment should be
  described as having revocation until one is wired.

---

## 8. RESIDUAL RISKS, AND WHAT BOUNDS EACH ONE

Each row names a risk this phase *introduces or leaves standing*, the mechanism that bounds it —
which exists in the code — and what is still open.

| Risk | What bounds it | What remains open |
|---|---|---|
| Authentication now depends on Core's **key distribution** rather than Core's availability (ADR §Consequences) | `TokenKeySet` fetches the JWKS with a cache, a cooldown against repeated failures and a timeout, and fails **closed** on an unknown `kid` — no "try the other key" path | A cold start with an unreachable JWKS endpoint has no cached key to fall back on. That is the accepted cost of moving trust to a claim, and it is the first thing a target deployment should test. |
| Revocation latency | Bounded by the accepted TTL, default 300s (`HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS`), and the deny-set cannot grow without limit because it is bounded by that same lifetime | The feed is unwired (§7). Until a transport is bound, revocation is in-process only, and the boot log says so rather than implying a feed exists. |
| Token size grows with the permission count | `MAX_PERMISSIONS_PER_TOKEN` (default 200), enforced **at issuance as an error** — never by silently minting a truncated list — and again on verification; `canonicalisePermissions` makes the claim stable | A subject approaching the ceiling fails issuance loudly. The ADR's open question (a permission digest plus on-demand fetch) stays open, as the ADR itself defers it. |
| The bridge outliving its purpose | `JWT_LEGACY_HS256_ENABLED`, which is disabled **automatically** once asymmetric material exists — there is no fallback chain, so a half-migrated deployment cannot silently prefer the weak path | Turning the flag off at sunset is a deliberate deployment act; nothing in this phase sets it. |
| A shared-secret token carrying a forged `perm` or `tid` | The rule is keyed on the **verified trust level**, never on claim presence: outside `asymmetric` trust the claims are ignored and today's answer is used | Nothing — this is the whole point of the trust-level rule, and it holds on both bindings. |
| Degradation that nobody notices | Posture is observable from the process: one boot log pair (`Token acceptance: …`, `Revocation: …`) plus `describe()` and `snapshot()` on the revocation registry | `snapshot()` is not yet exported to a health surface. The ADR (finding F5) routes these signals through the *existing* runtime-health mechanism, which is where that belongs. |

---

## 9. EXIT STATE, AND WHERE THE ADR'S ORDERING NOW STANDS

**What is true now that was not true before this phase.** One verifier, one issuer, one acceptance
policy, and four ports whose bound implementation is chosen by the runtime rather than by the
token. The two structural reasons HR could not be extracted — a second verifier in the WebSocket
handshake, and an authorization path that ends in Core's tables — are gone from the code, and the
property that they are gone is asserted by tests rather than asserted by this paragraph.

**Where the ADR's ordering constraint stands.** The ADR orders tenant-before-extraction and warns
that the first symptom of violating it is a **403, not a connection error** (ADR §Prerequisites,
item 2). At code level that constraint is now satisfied: at asymmetric trust the request context is
filled from `tid`, so the interceptor performs no Core query, and `ClaimsTenantResolver` exists,
is bound-testable and is proven to have no Core dependency. What is *not* done is the deployment
half — key material, and Core publishing a JWKS addressed by `kid` — so no runtime should be
extracted yet, and none was.

**The ADR prerequisites, restated against the code:**

1. **Core issues asymmetric tokens carrying `tid`, `ver` and `perm`** — *half done.* The issuance
   side exists here and is tested (`TokenIssuer` mints the full claim set, with the ceiling
   enforced at issuance). The missing half is Core's key publication and the decision to switch,
   which is configuration, not code.
2. **Tenant moves from the per-request Prisma lookup to `tid`** — *done in code* (§3, §5.2), with
   the combined runtime's legacy branch retained behind a verified trust level.
3. **`platform.identity@v1`** — not started.
4. **`platform.audit@v1`** — not started.
5. **Then, and only then, the `future-hr` policy flip, the runtime extraction, and the
   architecture-boundaries assertion update** — untouched by design; `future-hr` is still a
   `target`.

**So the next work, in the ADR's order:** key publication by Core with rotation overlap (prerequisite
1, deployment half), then `platform.identity@v1`, then `platform.audit@v1`, and only then the
`future-hr` policy flip and ARCH-2 — which is now a runtime and policy change rather than an
authentication rewrite. Nothing in this phase moves ARCH-2 forward on the calendar; it removes the
reason ARCH-2 could not be started.

---

## 10. THE CHANGE, FILE BY FILE

### 10.1 New — the seam, `apps/api/src/platform/auth/` (19 files, 4,291 lines)

Source — 11 files, 2,323 lines:

| Source file | Lines |
|---|---|
| `token-contract.ts` | 268 |
| `token-policy.ts` | 289 |
| `token-keyset.ts` | 423 |
| `token-issuer.ts` | 255 |
| `token-verifier.ts` | 444 |
| `token-revocation.ts` | 359 |
| `token-auth.module.ts` | 120 |
| `token-permission-source.ts` | 37 |
| `claims-tenant-resolver.ts` | 33 |
| `permission-source.contract.ts` | 46 |
| `tenant-resolver.contract.ts` | 49 |

Specs — 8 files, 1,968 lines:

| Spec file | Lines |
|---|---|
| `token-contract.spec.ts` | 125 |
| `token-policy.spec.ts` | 277 |
| `token-keyset.spec.ts` | 283 |
| `token-issuer.spec.ts` | 319 |
| `token-verifier.spec.ts` | 376 |
| `token-revocation.spec.ts` | 410 |
| `token-permission-source.spec.ts` | 84 |
| `claims-tenant-resolver.spec.ts` | 94 |

### 10.2 New — the Core bindings (4 files, 312 lines)

`auth/rbac/services/core-permission-source.ts` 47 + `auth/rbac/test/core-permission-source.spec.ts`
103; `tenant/core-tenant-resolver.ts` 55 + `tenant/core-tenant-resolver.spec.ts` 107.

### 10.3 Modified — 16 tracked files, +823 / −179

| File | Δ | File | Δ |
|---|---|---|---|
| `src/architecture-boundaries.spec.ts` | 39 | `src/messaging/messaging.gateway.spec.ts` | 148 |
| `src/auth/auth.module.ts` | 20 | `src/messaging/messaging.gateway.ts` | 92 |
| `src/auth/auth.service.spec.ts` | 103 | `src/messaging/messaging.module.ts` | 21 |
| `src/auth/auth.service.ts` | 77 | `src/tenant/tenant-context.interceptor.spec.ts` | 75 |
| `src/auth/rbac/guards/roles.guard.ts` | 27 | `src/tenant/tenant-context.interceptor.ts` | 52 |
| `src/auth/rbac/rbac.module.ts` | 9 | `src/tenant/tenant.module.ts` | 23 |
| `src/auth/rbac/test/roles.guard.spec.ts` | 39 | `.env.example` | 33 |
| `src/auth/strategies/jwt.strategy.ts` | 140 | `src/config/env.validation.ts` | 104 |

(Δ is `git diff --stat`'s changed-line count for that file — additions plus deletions. The four
non-architecture spec files are the legacy-behaviour suites, extended rather than replaced — §4,
item 2 — and they are 365 of the 1,002 changed lines.)

### 10.4 Reproducing every figure above

```powershell
cd E:/ERP/apps/api
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json     # expect exit 0, no output
node ../../node_modules/jest/bin/jest.js --testPathPattern "platform/auth|core-tenant-resolver|core-permission-source|architecture-boundaries"   # 11 / 165
node ../../node_modules/jest/bin/jest.js                                # full suite: 120 / 1988
node ../../node_modules/jest/bin/jest.js --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts   # 2 / 54
node ../../node_modules/jest/bin/jest.js --runInBand src/architecture-boundaries.spec.ts     # 22
node ../../node_modules/jest/bin/jest.js --testPathPattern "modules/hr"                      # 12 / 106
node ../../node_modules/eslint/bin/eslint.js src/platform/auth src/tenant/core-tenant-resolver.ts src/tenant/core-tenant-resolver.spec.ts src/auth/rbac/services/core-permission-source.ts src/auth/rbac/test/core-permission-source.spec.ts   # expect exit 0, no output
node ../../node_modules/prettier/bin/prettier.cjs --check "src/platform/auth/*.ts" "src/tenant/core-tenant-resolver*.ts" "src/auth/rbac/**/core-permission-source*.ts"   # 23 files flagged: repo-wide baseline, see §5.3

cd E:/ERP
git --no-pager diff --stat -- apps/api
git --no-pager status --porcelain
```

Note for whoever repeats this, because both of these cost a minute to rediscover: `npx` is blocked
on this machine by the local PowerShell execution policy (`npx.ps1 cannot be loaded`), which is why
every command above invokes the workspace binary through `node` directly; and the dependencies are
hoisted to the **repository root**, not to `apps/` — from `apps/api` the path is
`../../node_modules`, not `../node_modules`, and `apps/node_modules` exists but holds no `jest` or
`tsc`. Jest also writes to its summary on stderr, so capture with `cmd /c '… > out.txt 2>&1'` rather
than a PowerShell pipeline if you want the summary in a file.

One more thing this tree holds and this commit does not: untracked scratch files left behind by
earlier phases — `apps/api/tmp-*.txt`, `hr-arch1-jest*.txt`, `p50r3-*.txt`, `tmp-dbproof.*`,
`prisma/core/migration_diff*.sql`, `testing_module_dump.json` and a stray `apps/api/$null`. None of
them is part of ARCH-3A and none was staged, so the commit carries the seam and nothing else.

---

**PHASE 51-HR-ARCH-3A: COMPLETE.** Two structural blockers to a standalone HR runtime are gone from
the code, both are enforced by tests that run in the suite, the combined runtime's legacy behaviour
is unchanged and asserted, no environment has been switched, no HR file has been touched, and the
next step in the ADR's order — Core publishing keys — is a deployment act that this phase has made
possible rather than assumed.