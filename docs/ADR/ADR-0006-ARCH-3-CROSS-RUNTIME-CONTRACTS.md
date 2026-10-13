# ADR-0006: Cross-Runtime Platform Contracts

**Date:** 2026-09-17
**Status:** APPROVED (design only — no implementation in this phase; amended during ARCH-3B — see A7, E8 and E9). Architecture only: the implementation status of each decision, and the two gaps ARCH-3B left open (E9's publisher authentication, and the identity client adapter), are recorded in `docs/reports/PHASE_51-HR-ARCH-3B_CLOSURE.md`.
**Phase:** ARCH-3
**Relates to:** ADR-0005 (runtime and database boundaries), ADR-0003 (authentication), ADR-0004 (RBAC)

---

## Decision

A business runtime that is separated from Core keeps serving requests without reaching
into Core's database, by splitting every platform capability it needs into two disjoint
classes: what can be **derived from a signed token**, and what **cannot**.

| Capability | Mechanism | Core required per request? |
|---|---|---|
| Authentication (token validation) | Asymmetric signed JWT, verified locally | No |
| Tenant, subject, token version | Signed claims (`tid`, `sub`, `ver`) | No |
| RBAC / permission resolution | Declared permission strings in the token (`perm`) | No |
| Token revocation | `ver` claim + propagated revocation events, bounded by a short TTL | No (cold path only) |
| Person projection (names, titles) | `platform.identity@v1` — read, on demand, degrade | Yes, degradation only |
| Audit egress | `platform.audit@v1` — write, at-least-once, fire-and-forget | Yes, degradation only |

The split is not arbitrary. Authentication, RBAC and revocation are **hot-path**
concerns evaluated on every request. Making them a synchronous dependency on Core would
leave a business runtime unable to answer a request while Core is down — a strictly worse
availability position than today, bought at the price of exactly the coupling ADR-0005
requires be removed. Person projection and audit are **cold-path** concerns that are
already asynchronous or already degrade, so they can carry a real cross-runtime contract
without putting Core on the request critical path.

Three contracts are defined, following the naming convention already enforced by
`CONTRACT_PATTERN` in `module-platform/module.contract.ts` (`name@v<major>`):

| Contract | Direction | Cardinality | Payload |
|---|---|---|---|
| `platform.identity@v1` | runtime → Core | read-only, on demand | the existing `DirectoryUserProfile` allowlist |
| `platform.audit@v1` | runtime → Core | write-only, at-least-once | the existing `AuditOptions` plus `tenantId` and `auditId` |
| `platform.revocation@v1` | Core → runtime | event feed | `{ userId, ver, tid, revokedAt }` |

RBAC deliberately has **no** contract. Permissions travel in the token, so
`platform.permissions@v1` does not exist; adding one would reintroduce the per-request
Core read that this ADR removes.

The `future-hr` datasource policy target becomes `HR_DATABASE_URL: required` /
`CORE_DATABASE_URL: not-used`. That policy change is **not made in this phase** (see F2).

## What this ADR does not do

It defines no runtime, no entrypoint, no Dockerfile, no policy edit and no production
code. `apps/api/src/runtime-datasources.ts` still declares `future-hr` as requiring
`CORE_DATABASE_URL`, and `architecture-boundaries.spec.ts:109` still asserts it. Both
remain truthful statements of the *current* system until the contracts below exist.
---

## Evidence base

Every statement in this ADR is traceable to the current source. The audit that produced
these findings is summarised here because the decisions below are only as good as the
breakage they were derived from.

**E1 — No cross-runtime platform contract exists today.** Identity, RBAC and audit are
all reached through in-process Core Prisma:

- `auth/strategies/jwt.strategy.ts:36` — `validate()` executes
  `prisma.user.findUnique({ where: { id: userId }, select: { id, email, tokenVersion, status } })`
  on **every authenticated request**.
- `auth/rbac/services/permission.service.ts:75` — `getUserPermissions()` executes a
  `userRole.findMany` with nested `role → permissions → permission` includes.
- `common/audit.service.ts:55` — `log()` executes `prisma.auditLog.create`.

`ModuleClient` is not a substitute: it invokes *other registered modules*, not Core's
platform services.

**E2 — `UserDirectoryContract` is already a transport-neutral contract.** In
`platform/user-directory/user-directory.contract.ts` the port is bound by a plain string
token (`USER_DIRECTORY = 'UserDirectoryContract'`), every method is `async`, and **no
signature mentions a Prisma type or a Core entity**. The interface is already satisfiable
over a network. What is missing is not a contract; it is a second *implementation* of one.

**E3 — Tenant resolution is a per-request Core Prisma read, and it fails closed.**
`tenant/tenant-context.interceptor.ts:19` executes
`prisma.user.findUnique({ where: { id: user.userId }, select: { tenantId: true } })` per
request and publishes `tenantId` into `RequestContextService`. `modules/hr/hr-actor.ts:58`
then requires it, throwing `ForbiddenException` when absent. The consequence for an
HR-only runtime is decisive, and is the most important finding in this audit:

- an HR runtime that **registers** `TenantContextInterceptor` inherits `PrismaService`,
  and therefore Core Prisma;
- an HR runtime that **omits** it makes `resolveHrActor()` throw **403 on every HR
  request**.

The first thing that breaks in a standalone HR runtime is therefore not a database error.
It is an authorization failure on the first authenticated request. Tenant must become a
token claim before HR can be extracted.

**E4 — The revocation check reads a column it never uses.** `jwt.strategy.ts:38` selects
`status`; no branch in `validate()` inspects it. A deactivated user therefore keeps
working until the access token expires. Revocation is currently effective for
`tokenVersion` only.

**E5 — Audit is already best-effort, and already has an async egress path.**
`audit.service.ts:90-95` catches every failure, logs it, and **returns `null` rather than
throwing** ("audit persistence must not break business logic"). On publish failure it
writes an `auditDispatch` row for retry (`audit.service.ts:110`). The non-blocking,
retry-oriented egress shape this ADR adopts is therefore not an invention; it is the
existing shape, relocated to a trust boundary.

**E6 — The audit record has no tenant column.** `AuditOptions`
(`audit.service.ts:6-22`) has no `tenantId` field, and the HR call sites
(`modules/hr/employees/employees.service.ts:222,365,434`) pass `requestId`,
`correlationId`, `userId`, `ip`, `userAgent` and `action` — and nothing else — even
though `HrActor` *does* carry `tenantId`. Multi-tenant audit isolation cannot be
reconstructed from the record as it stands, so `tenantId` is a required addition to the
contract, not an optional one.

**E7 — The redactor is pure.** `common/audit-redactor.util.ts` imports only `crypto`. It
is safe for a Core-free runtime to reuse, so redaction can stay on the egress side.

**E8 — The `future-hr` policy contradicts this target.** `runtime-datasources.ts`
declares:

```ts
'future-hr': {
  datasources: {
    CORE_DATABASE_URL: 'required',      // ← target: 'not-used'
    CMS_DATABASE_URL: 'not-used',
    OBSERVABILITY_DATABASE_URL: 'optional',
    CORRESPONDENCE_DATABASE_URL: 'not-used',
    HR_DATABASE_URL: 'required',
  },
  infrastructure: { redis: 'optional', rabbitmq: 'optional', minio: 'optional' },
},
```

and `architecture-boundaries.spec.ts:109` asserts it:
`expect(requiredDatasources('future-hr')).toEqual(['CORE_DATABASE_URL', 'HR_DATABASE_URL'])`.
The runtime policy records `dockerfile: null` for `future-hr`, so no HR image is built
today.

**E9 — Redis and RabbitMQ are both `optional` for `future-hr`.** This is load-bearing:
neither the revocation deny-set nor the audit egress may *require* Redis or the broker,
and their absence must surface as health degradation rather than as a failed request.

---

## A. Identity contract

**Current.** `USER_DIRECTORY = 'UserDirectoryContract'` declares four methods
(`findProfiles`, `filterTenantMembers`, `findTenantMember`, `findTenantId`) returning the
allowlisted `DirectoryUserProfile` (`id`, `firstName`, `lastName`, `avatarUrl`,
`jobTitle`, `department`), with a bounded batch (`MAX_DIRECTORY_IDS = 200`) normalised by
`dedupeIds()`. `CoreUserDirectoryAdapter` is the single, Core-owned, in-process
implementation.

**A1 — No new interface is introduced.** ARCH-3 adds a second *implementation*,
`PlatformUserDirectoryAdapter`, that satisfies the **existing** `UserDirectoryContract`
over `platform.identity@v1`. The interface is unchanged, the token is unchanged, the
bound is unchanged. This is what makes the later extraction a *binding* change rather
than a domain change: HR code that injects `USER_DIRECTORY` is byte-identical whether
Core is in-process or remote, so nothing in `modules/hr/**` is edited to adopt it.

**A2 — The remote projection is the same allowlist, and widening it is a version
event.** `platform.identity@v1` returns exactly `DirectoryUserProfile`. The contract's own
documentation already forbids returning email, `passwordHash`, `tokenVersion`, `status`,
roles, permissions, or tenant membership beyond "yes/no". Because the projection now
crosses a process boundary, that prohibition becomes a **wire-format** rule: any added
field requires `@v2`, so a well-meaning consumer cannot widen Core's identity exposure
with a one-line DTO edit.

**A3 — The contract exposes exactly the four operations, and no search.** There is no
"find by email", no enumeration, no fuzzy lookup, and no admin variant. A search endpoint
over Core identity would turn every business runtime into an account-enumeration surface
— precisely the abuse the port docblock names — and would undo the reason the projection
is allowlisted at all.

**A4 — Identity flow is one-directional.** Business runtimes read identity; they never
write it. Consistent with DC-CORR-01, HR stores identity columns as plain strings with no
cross-database foreign key, so no HR write can mutate a Core identity row even
accidentally.

**A5 — "Not found" remains a value, not an error.** An absent id is omitted from
`findProfiles`, and `findTenantMember`/`findTenantId` return `null`. A remote transport
must not convert a missing identity into a thrown error: a deleted actor on an old record
is a normal historical state, and a 404 would turn a rendering concern into a 500.

**A6 — Batching is enforced client-side, before the hop.** `dedupeIds()` runs before the
call, so duplicates and empty values are removed and `MAX_DIRECTORY_IDS` is applied
*locally*. This matters more after extraction than before it: an un-normalised id list
sent to a remote Core is an amplification primitive, letting one caller turn a
repeated-id array into unbounded remote work. The normalisation stays the same pure
function, applied on the send side by construction rather than by convention.

**A7 — The identity transport binding (ARCH-3B amendment).** A1 fixes the contract, the
projection, the four operations and the adapter's name; it does not fix **how the adapter
reaches Core**. That gap was left to implementation, and it must not be: the binding is a
wire format that ARCH-2 will consume, so it is an architectural decision with a security
consequence rather than a coding detail. It is recorded here *before* any code is written
against it.

`platform.identity@v1` is served by **Core, on a dedicated Core-internal signed HTTP
surface** — one route group, `/platform/v1/identity`, owned by Core and reachable only by
an authenticated service caller. `PlatformUserDirectoryAdapter` (A1) is the client end.

| Element | Decision |
|---|---|
| Endpoint | Core-internal HTTPS, route group `/platform/v1/identity`, one route per approved operation |
| Contract descriptor | `platform.identity@v1`, validated with the existing `parseContract` / `isValidContract` |
| Caller authentication | A **dedicated service credential** held by the calling runtime and presented as a signed request — not a user token, and not a token-signing key |
| Signature | The existing `module-signature.ts` HMAC over the canonical request (method, path, body digest, timestamp, caller id, tenant, request id, correlation id) — reused, so no second signing scheme is introduced to get wrong |
| Outbound guard | `module-url.guard.ts` applies to the endpoint URL exactly as it does to a module hop |
| Operations | The four `UserDirectoryContract` operations and nothing else. A fifth route is a `@v2` event (A2) |
| Response body | The `DirectoryUserProfile` allowlist and nothing else, ever |
| Tenant authority | Core's database. The signed `tid` states which tenant the caller believes it is acting for; it never substitutes for Core's own membership check |
| Direction | Read-only, unchanged (A4). No route accepts identity data |

**Why a dedicated surface, and not the module transport.** `ModuleClient` /
`ModuleHttpTransport` invokes *registered modules*: instances that register, heartbeat, carry
a release and a lifecycle, and whose base URL is resolved by the registry (evidence base,
first section). Core is not a module — it does not register, has no lifecycle, and is not one
deployment per tenant. Modelling it as one purely to reuse a client would route a platform
capability through an abstraction built for a different actor, and would turn "which Core
answered?" into a registry question. The transport is therefore new; the *authentication
primitives* are reused, which is where the saving actually is.

**Why the service credential is not the JWT signing key.** B2 makes a business runtime
verifier-only precisely so that it cannot mint a token for any subject in any tenant. Handing
that same runtime a signing key as its service credential would restore exactly the capability
B2 removes, under a different name. A service credential authenticates one caller to one
capability; it signs nothing.

**Why the credential is capability-specific.** One shared secret accepted by several platform
endpoints collapses every capability's blast radius into one: leaking it would authenticate
identity reads *and* audit ingest, and rotating it would break both. One credential per
(caller, capability) — the same rule `module-signature.ts` already applies per module
registration.

**Why a user token is not the service credential.** A user token is scoped to a user and a
tenant and expires in minutes; a service call is scoped to a runtime and outlives the request
that triggered it (A6's batch is one call for a whole page, and a cold-path caller has no user
at all). Using the first as the second would make a runtime's access to Core contingent on a
human's session, would put a bearer token on a hop where there is no bearer, and would blur
two trust boundaries that must stay distinguishable.

**Why identity does not also ride the broker.** The broker is `optional` (E9). Identity is a
read that A5 requires to degrade to "no name" rather than fail, so placing it on a broker that
may be absent would make the degradation path the only path in exactly the deployments where
it matters least. Audit is write-only and can afford a broker; identity cannot. The two
transports are therefore deliberately separate, and identity semantics must not be folded
into the audit egress (E8).

**HR holds no Core database credential.** A4 already forbids an HR write to a Core identity
row; the endpoint exists so that the *read* is equally constrained. A business runtime that
can open Core's database does not need this contract, and would make it decorative.

**The invariant this binding exists to preserve.**

```
JWT signing authority    Core issuer only
Business runtime         JWT verifier only, plus one capability-specific service credential
Core identity surface    capability-specific, authenticated, tenant-aware, read-only
```

**What this surface must never become.** No generic Core invocation, no `User` CRUD, no
search, no enumeration, no admin variant, no "return arbitrary fields" parameter (A3). The
four operations are the entire surface, and a caller that wants a fifth answer is asking for
`@v2` rather than for a flag.

**A8 — The capability credential store (ARCH-3B amendment).** A7 fixes the credential's
*scope* — one per (caller, capability) — but the evidence base contained no store able to
represent it. `ModuleRegistration` holds **one** credential per module: `moduleId` is
`@unique` (one row per module), the envelope is a single
`secretCiphertext`/`secretIv`/`secretAuthTag` triad behind one `secretExpiresAt`, and
`ModuleRegistryService.resolveSecret(moduleId)` — the only resolver — is keyed by `moduleId`
alone. `ModuleSignatureInput` carries `moduleId`, `requestId` and `tenantId` and **no
capability field**, so capability is not expressible *in* the signature; it can only be
expressed by **which secret verifies**. The store is therefore the decision, and it is
recorded before any code is written against it.

| Element | Decision |
|---|---|
| Model | A new Core model `ModuleCapabilityCredential`, one row per `(moduleId, capability)` |
| Uniqueness | `@@unique([moduleId, capability])` — the uniqueness *is* the capability boundary |
| Storage | The existing AES-256-GCM envelope (`secretCiphertext`/`secretIv`/`secretAuthTag`), encrypted by the existing `CryptoService` under the existing `AI_CONFIG_ENCRYPTION_KEY`. No second crypto system and no second key |
| Rotation / expiry | `secretUpdatedAt` / `secretExpiresAt`, with exactly `ModuleRegistration`'s semantics: overwrite to rotate, and `NULL` expiry means "no expiry configured" rather than "expired" |
| Parent | FK to `ModuleRegistration.moduleId`, `onDelete: Cascade` — a credential for a module that no longer exists is unresolvable by definition, the reasoning `ModuleInstance` already uses |
| Capability value | The contract descriptor: `platform.identity@v1`, `platform.audit@v1`. A `@v2` is therefore a new credential by construction (A2) rather than a renamed one |
| HR's credentials | Two, with **different plaintext**: `(hr, platform.identity@v1)` and `(hr, platform.audit@v1)` |
| Resolution | `resolveCapabilityCredential(moduleId, capability)`, with expiry enforced at resolve time as `resolveSecret` already enforces it |
| Rotation | `rotateCapabilityCredential(actorId, moduleId, capability)` — **capability-specific**: rotating one does not touch the other |
| Provisioning | The existing administrator-authenticated `ADMIN_MODULES_MANAGE` surface, under the existing one-way rule: issue and rotate return the plaintext **once**, and no route ever reads a stored credential back |
| Trail | A distinguishable action and lifecycle event, `PLATFORM_CAPABILITY_CREDENTIAL_ROTATED` and `module.capability_credential.rotated`, carrying `{ capability, generated: true }` and never the value |
| `ModuleRegistration` | **Unchanged.** Its single secret remains the module-hop credential and is never reinterpreted as a capability credential |

**Why a new store, and not a second row of `ModuleRegistration`.** `moduleId` is the stable
registry identity that `resolve`, `resolveSecret`, `registerInstance` and every signed request
already key on, and it is `@unique` precisely because one module is one credential — a mutable
or duplicated one "would silently reassign a credential and a tenant scope to a different
module". Registering HR twice (`hr` plus, say, `hr.audit`) to hold two secrets would
manufacture a module principal that never registers, never heartbeats and has no release,
purely to store a value — the same category error A7 rejects for Core. Worse, it is the
shared-credential failure wearing a different label: the *same runtime* would hold both, so
the blast radius A7 forbids would still be one leak wide.

**Why the two credentials must differ.** The whole point of splitting them is A7's clause that
leaking one must not authenticate the other capability and rotating one must not break both.
If `(hr, platform.identity@v1)` and `(hr, platform.audit@v1)` were the same bytes, both
properties would fail while every test that merely asserts "two rows exist" would still pass.

**Why `rotateCredential` is not overloaded.** `ModuleRegistryService.rotateCredential(actorId,
id)` already exists and is keyed by the registration **row id**; it records
`MODULE_CREDENTIAL_ROTATED` and emits `module.registration.credential_rotated`. Giving that
same name a `(moduleId, capability)` signature would put two meanings and two key kinds behind
one name — the silent reinterpretation this amendment exists to prevent — so capability
rotation takes a distinct name and a distinct trail, which is also what makes "rotating
identity did not touch audit" *observable* rather than merely asserted by a test.

**Plaintext discipline.** The plaintext never reaches a log line, an HTTP response, a
diagnostic payload, source, or a committed fixture. Only the envelope is at rest, the trail
records that a rotation happened and never what it produced, and a credential is returned by
the call that *created* it and by no other call.

---

## B. Authentication and token validation

**Current.** `JwtStrategy` (HS256) verifies with a shared `JWT_SECRET`, `issuer`
`aria-erp-auth`, `audience` `aria-erp-api`, `ignoreExpiration: false`, and a 15-minute
`expiresIn`. `validate()` then reads Core Prisma **on every authenticated request** to
compare `tokenVersion` (E1) and to select a `status` it never checks (E4).
`JwtAuthGuard` bypasses `@Public()` routes via the `isPublic` metadata key.

**B1 — Validation becomes local and stateless.** HR keeps verifying JWTs, and keeps
`iss`, `aud`, expiry and `tokenVersion` semantics, while dropping the per-request Core
read entirely. No Core availability is required to serve an authenticated HR request.

**B2 — Signing becomes asymmetric, and HR becomes verifier-only.** Today `JWT_SECRET` is
an HMAC secret held by *every* runtime, which means every runtime holds the **signing**
key and can therefore mint a token for any subject in any tenant. A business runtime with
that capability is not a smaller blast radius than Core — it *is* Core. ARCH-3 moves
signing to **RS256 (≥2048-bit)**, with the private key held only by Core and the
**public** key distributed to business runtimes via JWKS addressed by `kid`, or as a
configured static public key. This is the most consequential decision in this ADR, and it
is a **prerequisite** rather than a follow-up: HR must not be extracted while it holds
the platform signing key.

**B3 — The trusted claim set is closed.** A claim outside this table carries no authority.

| Claim | Required | Meaning | Authority |
|---|---|---|---|
| `iss` | yes | `aria-erp-auth` | enforced, exact match |
| `aud` | yes | `aria-erp-api` | enforced |
| `sub` | yes | Core user id | authoritative subject |
| `tid` | yes | tenant id | **authoritative — replaces the per-request Core lookup (E3)** |
| `ver` | yes | `tokenVersion` at issue time | authoritative, see C |
| `perm` | yes | permission strings | authoritative, see D |
| `iat`, `nbf`, `exp` | yes | standard | enforced |
| `kid` (header) | yes | key identifier | enforced, enables rotation |
| `email` | no | display only | **never** an authorization or scoping input |
| `role` | no | display only | **never** an authorization input; ADR-0004 replaced roles with permissions |

`tid` and `sub` are the only sources of tenant and subject. Neither is ever read from a
query string, a header or a body — `resolveHrActor()`'s existing refusal to consult
client input is preserved, and `@Public()` routes continue to carry no subject at all.

**B4 — Absence of `perm` denies; it does not permit.** A token with no `perm` claim is
treated as having no permissions, never as unrestricted. This is stated explicitly because
`RolesGuard` returns `true` for a route that declares no required permissions (by design,
to rely on the JWT guard), and that permissive branch must not become reachable *by
omission* from a remote token. Permission strings are canonicalised (deduplicated, then
sorted at issue) so equality and any future cache key are stable, and their count is
bounded by a declared `MAX_PERMISSIONS_PER_TOKEN`; exceeding it is an issuance error at
Core and never a silently truncated token.

**B5 — Acceptance is narrow, and algorithm confusion is refused.** A token is accepted
only when `iss` and `aud` match exactly, `exp` has not passed, and the header `alg` is the
configured asymmetric algorithm. `alg: none` is rejected, and an HMAC-signed token is
rejected once asymmetric verification is configured — the classic attack in which an
attacker re-signs a forged token using the *public* key as an HMAC secret.

**B6 — HR is a resource server only.** An HR runtime exposes no login, no refresh, no
password reset and no credential handling of any kind. Session continuity remains the
client's business against Core (ADR-0003). This keeps business runtimes out of credential
storage entirely, which is what makes B1's statelessness achievable without inventing a
second session mechanism.

**B7 — Publication has ONE venue, and it is the issuer's own process.** B2 distributes the
public key "via JWKS addressed by `kid`", which left *where* that document lives unstated; it
is fixed here as `GET /.well-known/jwks.json`, served by Core. Core issues the tokens, so
Core publishes the keys its verifiers need: there is no second deployment that publishes key
material, no operator-run key directory, and no route by which a verifier becomes a
publisher. The path is a **contract**, so it is served at the root rather than under a
version prefix (a verifier must not depend on which API version happens to serve the keys it
needs), it is excluded from the global `api/v1` prefix by exactly that one path so no
existing route moves, and the ingress matches it **exactly** rather than owning
`/.well-known/` — ACME answers `/.well-known/acme-challenge/` on this host, and a prefix
location would shadow it. The document is public by design (a verifier needs it *before* it
can authenticate anything) and read-only by construction, and it carries an explicit, bounded
`Cache-Control: public, max-age=300` equal to `JWKS_CACHE_TTL_MS` — the same number the
platform's own verifiers cache by — so no intermediary holds a pre-rotation document longer
than a verifier inside this platform would. Only public material is ever exposed, written
field by field (`kty`, `use`, `alg`, `kid`, `n`, `e`) rather than by spreading a library
export. A runtime that holds no key material of its own answers `404 JWKS_NOT_CONFIGURED`,
**never** `{"keys":[]}`: an empty document is a statement about the key set that a verifier
would read as an answer, while an absent one is the truth about that process.

**B8 — Rotation is an overlap with a floor, and retirement is simultaneous for publication
and acceptance.** A rotation is expressed as configuration, not as an act on a running
process: `JWT_SIGNING_KEYS` carries the key set and `JWT_ACTIVE_KEY_ID` names the single key
that signs. The active key must **not** declare a `retireAt` (a signer with an end date stops
minting when it closes), every other key **must** declare one (a verification key with no end
date stays published and accepted forever, so the rotation could never complete), and the
span from the active key's `activatedAt` to a predecessor's `retireAt` must be at least
**900s**. That floor is derived, not chosen: this platform accepts access tokens for at most
300s (`C1(1)`) and a verifier may keep a JWKS document for up to 300s (`JWKS_CACHE_TTL_MS`),
so ≈600s is the technical floor and 900s adds margin for clock skew between the issuer and a
verifier. It is deliberately **not configurable** — a knob whose only effect is to shorten a
rotation window turns a security property into a typo — and a key set whose declared window is
shorter fails the **boot** rather than the verifier. Retirement itself is a clock, not a
restart: past `retireAt` a key stops being published and stops verifying at the same instant,
and one rule (`isRetired`) answers both questions, so a verifier can never hold a token the
issuer no longer admits to publishing. There is therefore no rotation endpoint, no rotation
permission and no admin UI; a rotation is performed by deployment/secret-management tooling
following the three steps recorded in `apps/api/.env.example`, and the mutual-exclusion rules
make the key set a *third* key source alongside the static key and `JWT_JWKS_URI` — one source,
so "which key signed this?" has one answer.

---

## C. Token revocation

**Current.** `tokenVersion` in the token is compared against the Core row's
`tokenVersion` on every request, so revocation is immediate — at the cost of a Core read
per request. `status` is also fetched and never consulted (E4), so deactivation is
currently **not** enforced until the token expires.

**C1 — Revocation is three layers, and no layer is per-request Core I/O.**

1. **A short access TTL.** The TTL for tokens HR accepts is reduced from 15 minutes to
   **at most 5 minutes** (`HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS`, default `300`). A token
   whose `exp - iat` exceeds this maximum is **rejected**, not merely noted — otherwise
   the bound is advisory and the guarantee is fictional. This layer is what makes the
   revocation gap bounded *by construction*, independent of any infrastructure being up.
2. **`ver` plus a propagated revocation feed.** Core emits `platform.revocation@v1`
   events carrying `{ userId, ver, tid, revokedAt }`, and HR keeps a **bounded, TTL'd
   in-memory deny-set** keyed by `userId`. A token whose `ver` is below the highest
   revoked `ver` for that user is rejected. Entries expire after the longest token they
   could still affect, so the set cannot grow without bound.
3. **An authoritative check on the cold path.** The refresh flow continues to validate
   `tokenVersion` **and** `status` against Core, exactly as today. A revoked or
   deactivated user therefore cannot **extend** access at all, and the two states
   converge quickly: no new access after at most the access TTL, and no continued
   access beyond it.

**C2 — The worst case is stated, not hidden.** With the feed healthy, revocation
propagates in milliseconds. With the feed unavailable, HR **does not** fail every request:
it degrades to the TTL bound and reports a degraded condition on the existing health
contract. The alternative — failing closed on all traffic when a broker is down — would
make an *optional* dependency (E9) into a single point of failure for a runtime whose
policy says that dependency is optional. The chosen point on the strictness/availability
axis is "bounded delay", and it is chosen because the bound is small and arithmetic rather
than aspirational.

| Option | Revocation latency | Core per request | Availability cost |
|---|---|---|---|
| Per-request introspection (today's shape) | immediate | yes | HR down when Core is down |
| **Short TTL + `ver` + feed (chosen)** | ≤ access TTL; ~immediate with feed | no | none beyond the TTL bound |
| Feed only, no TTL floor | unbounded when feed is down or after restart | no | silently unbounded |
| No revocation at all until expiry | ≤ original TTL | no | unacceptable |

**C3 — `status` is enforced where it can be authoritative.** Deactivation is checked at
issuance, at refresh, and on a revocation event — the three points where Core is already
authoritative. The E4 gap is closed at Core, rather than by adding a per-request read back
into HR, which would reinstate exactly the coupling this ADR removes.

**C4 — The restart hazard is a disclosed limitation.** The deny-set is in-process, so an
HR restart loses it and a token revoked moments earlier can be accepted for the remainder
of its TTL. This is accepted because the exposure is bounded by C1(1) to at most 5
minutes, and because the alternative — making Redis mandatory for HR — contradicts the
declared `redis: 'optional'` policy (E9) and imposes an infrastructure requirement on a
runtime that does not otherwise need one. Where a deployment already runs Redis for other
reasons, backing the deny-set with the runtime's existing cache is permitted and strictly
reduces the window; it is not required.

**C5 — Introspection is explicitly not the hot path.** A per-request call to Core asking
"is this token still valid?" would restore the per-request Core dependency that E1
identified as the coupling to remove, and would make every HR request as available as
Core. It is rejected for the request path and retained only as C1(3)'s cold-path check,
where it costs one call per refresh rather than one per request.

---

## D. RBAC and permission resolution

**Current.** `RolesGuard` reads the `roles` metadata key written by `@Roles()` (the
Phase-33N fix; the guard previously read a key nothing wrote, silently bypassing
authorization), then calls `PermissionService.getUserPermissions(user.sub)`, which runs a
`userRole.findMany` with nested `role → permissions → permission` includes and caches the
result (permissions 15 min, role permissions 30 min, hierarchy 1 hour). The guard requires
at least one of the declared strings.

**D1 — Permissions are token-derived, and the guard is not modified.** The `perm` claim
carries the same `permission.name` strings that `PermissionService` produces today. The
`@Roles(...)` call sites are unchanged, the metadata key `roles` is unchanged, and the
"at least one required permission" matching rule is unchanged. Only the *source* of the
array changes — a local claim instead of a Core query — so authorization behaviour in HR
is preserved by construction rather than re-derived.

**D2 — Port reuse, exactly as in A1.** An HR-local provider exposes the same shape as
`getUserPermissions(userId): Promise<string[]>`, so `RolesGuard` and any other consumer
continue to inject the same abstraction. Nothing in the guard's control flow is edited to
accommodate a remote source, and the failure mode stays a `ForbiddenException` (403),
never a 500.

**D3 — HR does not resolve roles or hierarchy.** Role membership, role→permission
mapping and hierarchy are Core concerns, and HR never evaluates them. Authorization inside
HR is only ever "does the token's `perm` contain one of the required strings". The
consequence — a permission change takes effect at token refresh rather than instantly — is
an accepted tradeoff, and it is the same bounded window as C2, not a new one.

**D4 — HR reads no RBAC table.** `Role`, `Permission`, `UserRole` and `RolePermission`
are Core-owned and are read by Core alone. In particular HR does not retain the
`role:hierarchy` or `role:permissions` caches: those are artefacts of Core's resolution
algorithm, and reproducing them in a business runtime would recreate the coupling while
making it harder to see.

---

## E. Audit transport

**Current.** `AuditService.log()` redacts payloads, inserts a `core_db."AuditLog"` row,
then publishes `audit.<resource>.<action>` fire-and-forget, writing an `auditDispatch`
row when the publish fails. It never throws (E5).

**E1 — One contract, write-only, at-least-once.** `platform.audit@v1` is consumed by a
Core-side ingester that writes `core_db."AuditLog"`. HR continues to contribute to the
single platform audit trail and does **not** gain an audit table of its own — which
ADR-0005's persistence ownership already forbids, and which would also make a
cross-runtime audit query impossible without a scatter-gather.

**E2 — The payload is `AuditOptions` plus `tenantId` and `auditId`.** No field is dropped
and none is silently renamed. `tenantId` is a **required** addition, because `AuditOptions`
has no tenant field today and the HR call sites pass none (E6): without it, the audit
record of a multi-tenant deployment cannot be attributed to a tenant at all, and audit
isolation becomes a documentation claim rather than a property of the data.

**E3 — Idempotency is defined by a caller-minted `auditId`.** HR generates a UUIDv4 once,
at the call site, **before** the first transport attempt; Core ingests under a unique
constraint on `auditId` and treats a duplicate as success (a no-op), so retries and
duplicate delivery cannot double-write. This forces one concrete change: today the publish
key is `row.id`, the id assigned by the database insert (`audit.service.ts:81`). With the
insert moved behind the contract, the id must be minted client-side, and it must be minted
**once** so that a retry reuses it rather than producing a second record. `requestId` is
explicitly **not** the idempotency key: many audit rows legitimately share one request, so
using it would collapse distinct events into one.

**E4 — Failure semantics are three explicit states.**

| State | Behaviour | Why |
|---|---|---|
| Egress healthy | Enqueue and return without waiting | Preserves today's non-blocking profile |
| Egress fails | Do **not** throw. Log structured error, increment a degraded counter | Preserves the existing contract that audit must not break business logic (E5) |
| Egress lost for a sustained period | Health reports `DEGRADED` — never a silent 200 | A 200 with no declared state is not health; silence is the one unacceptable outcome |

A completed HR write is never reported to the caller as failed because audit egress
failed, and an audit failure is never invisible.

**E5 — The loss window is disclosed, not papered over.** With no HR audit table and
non-blocking egress, events buffered in memory are **lost** if the broker is unavailable
and HR restarts. That is a real weakening relative to today's in-process insert, and it is
accepted only because it is stated, bounded, and made visible through health (E4) — the
alternative of an HR audit table trades a bounded, visible loss for a permanent, silent
divergence of the platform audit trail across two databases.

**E6 — The rejected alternative, and why.** Synchronous write to a Core audit endpoint
was rejected: it makes every HR write fail when Core's audit path is unavailable,
inverting the existing best-effort semantics (E5) and putting Core on the write critical
path of a runtime whose entire purpose in ADR-0005 is to stop depending on Core. A local
durable spool was rejected as a violation of persistence ownership (E1).

**E7 — Redaction stays on the egress side.** `redactPayload` is pure (E7 of the evidence
base, importing only `crypto`), so HR redacts **before** the data leaves the trust
boundary; Core validates but does not depend on HR having done so. Redaction is a property
of the payload, not of the store, and placing it at the boundary is what makes it hold for
every egress path rather than only the ones that remember to call it.

**E8 — The audit wire binding (ARCH-3B amendment).** `platform.audit@v1` travels on the
**existing** `domain_events` topic exchange: the caller publishes with the routing key
`audit.<resource>.<action>`, which is the form `AuditService` and `AuditDispatcherService`
already use, and Core binds one durable ingest queue named `platform.audit.ingest` to
`audit.#`. The envelope carries the contract descriptor `platform.audit@v1`, the
caller-minted `auditId` (E3), the redacted `AuditOptions` and the required `tenantId` (E2),
and a header block identifying the publishing runtime — so an ingester can reject an unknown
contract, an unknown caller or an unknown shape instead of inferring one. The tenant stays in
the body and is never a routing key, because a routing key is not a place to keep an
authorization input.

This records the binding; it changes none of E1–E7. In particular it adds **no** synchronous
path — the broker remains the transport, E4's enqueue-and-return profile is unchanged, and
the identity binding (A7) is deliberately not reused here. The two contracts are separate
transports with separate credentials, and neither is a fallback for the other.

**E9 — Audit publisher authentication (ARCH-3B amendment).** E8 records the wire binding —
exchange, routing key, durable ingest queue, envelope contents — and leaves **who may publish**
implicit. That must not stay implicit: every runtime able to reach `domain_events` could
otherwise mint an audit row attributed to any caller, and a broker on a private network proves
transport reachability, not caller identity. Network position remains a **supplementary**
control and is never the authentication.

| Element | Decision |
|---|---|
| Authenticating credential | The caller's `(caller, platform.audit@v1)` capability credential (A8). The identity credential does not authenticate an audit publish |
| Mechanism | The existing HMAC-SHA256 in `integration-signature.ts`, reached through a platform-level material builder that mirrors `moduleSignatureMaterial` — same length-prefixed canonical string, same constant-time compare, same freshness window. `moduleSignatureMaterial` stays byte-identical, so no module hop changes |
| Slots | method ← a constant publish marker; path ← the **routing key**, so a captured envelope cannot be republished under a different one; eventId ← `<caller moduleId>:<auditId>`, binding caller identity and the caller-minted idempotency key together; idempotencyKey ← the tenant slot, binding `tenantId` exactly as the HTTP hop binds it; body ← the exact serialised envelope |
| Placement | AMQP message headers, alongside E8's caller and contract header block. The signature is never a field *inside* the body it covers |
| Freshness | The signed timestamp is checked against the existing window, and the signature is computed **at publish time, per attempt** — never at enqueue time — so a dispatcher retry after a broker outage re-signs instead of presenting a stale signature |
| Rejection | Unknown caller, missing, unknown or expired capability credential, absent signature, or a signature that does not verify ⇒ **no row**, a WARN naming caller, capability and reason, and **no requeue** |
| Ordering | Authentication is decided before the `auditId` insert, so an unauthenticated envelope can never occupy the idempotency key of a legitimate one (E3) |
| Credential isolation | The identity credential cannot authenticate a publish, and the audit credential cannot read identity: each surface resolves exactly its own capability |

**Why no requeue on rejection.** A failed signature is a fact about configuration or forgery,
not a transient condition, so requeueing it would only create an unbounded replay loop against
the ingester — an unauthenticated message is the last thing to hand back to the broker. The
envelope is discarded, the rejection is counted, and the loss is disclosed under E5 rather than
hidden.

**Why authentication is not left to a caller allowlist.** An allowlist names who is *expected*;
a signature proves who *sent*. The first is a configuration value that can drift silently and
that an adjacent compromise can edit, and it authenticates a connection rather than a message.

**The rejected alternative.** Accepting any envelope that arrives on the exchange, on the
grounds that the broker is internal, is recorded and rejected: it would leave
`platform.audit@v1` as the only platform contract without a cryptographic caller identity, in
the same ADR where `platform.identity@v1` has one.

---

## F. `future-hr` datasource policy

**Current.** `runtime-datasources.ts` declares `future-hr` with
`CORE_DATABASE_URL: 'required'` and `HR_DATABASE_URL: 'required'`, and
`architecture-boundaries.spec.ts:109` asserts
`['CORE_DATABASE_URL', 'HR_DATABASE_URL']`. The runtime policy also records
`dockerfile: null` for `future-hr`, so no HR image is built today.

**F1 — The target policy.**

| Variable | Current | Target |
|---|---|---|
| `HR_DATABASE_URL` | `required` | `required` (unchanged) |
| `CORE_DATABASE_URL` | `required` | **`not-used`** |
| `CMS_DATABASE_URL` | `not-used` | `not-used` (unchanged) |
| `OBSERVABILITY_DATABASE_URL` | `optional` | `optional` (unchanged) |
| `CORRESPONDENCE_DATABASE_URL` | `not-used` | `not-used` (unchanged) |
| `redis` / `rabbitmq` / `minio` | `optional` | `optional` (unchanged — see E9) |

This is the concrete meaning of "HR runs without Core": `CORE_DATABASE_URL` is not merely
unneeded, it is **declared not-used**, so a future regression that reintroduces a Core
connection is a policy violation the guard can catch rather than undocumented slack.

**F2 — The policy is not changed in this phase, and the order matters.** Promising
`not-used` before the contracts exist would turn a currently *truthful* assertion ("HR
cannot start without Core") into a false one, and would red the existing matrix test
rather than describe reality. The dependency order is fixed: contracts first, then policy,
then runtime, then the guard assertion. A policy edit is therefore an acceptance criterion
of ARCH-3 *implementation*, not of this ADR.

**F3 — The projection is the source of truth.** The target in F1 is expressed as a change
to the machine-readable runtime policy and its projection
(`runtime-policy.json` / `runtime-policy.projection.ts`), not to prose, so that the health
engine, the Docker/prune declarations and the architecture test agree by construction
instead of by review.

**F4 — "Zero Core Prisma" is verified structurally, not promised.** The property is
enforced by an architecture test asserting that no HR source file imports `PrismaService`,
the generated Core client, or anything under `apps/api/src/database/**`, and that HR's
import closure reaches no Core Prisma module. Review cannot establish this property
reliably; a test can, and the existing architecture suite is already where this
repository pins such boundaries.

**F5 — No new health engine is required.** Runtime health is already parameterised by
runtime, and `future-hr` already declares `HrHealthModule`. The contracts' degradation
signals (C2, E4) plug into that existing mechanism; ARCH-3 adds no parallel health
surface.

---

## Prerequisites and ordering

The order below is not a preference. Each step makes the next one possible, and the first
failure that follows from skipping it is named.

1. **Core issues asymmetric tokens carrying `tid`, `ver` and `perm`** (B2, B3). Without a
   trustworthy stateless claim set there is nothing to verify locally. *If skipped:* HR
   must keep either the shared signing key or the per-request Core read.
2. **Tenant moves from the per-request Prisma lookup to the `tid` claim** (E3, B3).
   *If skipped:* **403 on every HR request** — the interceptor either drags Core Prisma in
   or is absent, and `resolveHrActor()` fails closed in both cases. The first symptom of a
   premature extraction is therefore an authorization failure, not a connection error, and
   that is the single most likely surprise in this work.
3. **Core exposes `platform.identity@v1`** (A). *If skipped:* operator surfaces render
   identities with no names and titles.
4. **Core exposes the `platform.audit@v1` ingester** (E). *If skipped:* HR writes succeed
   but produce no audit records — silent, which E4 exists to prevent.
5. **Then, and only then:** the `future-hr` policy flip (F1), the runtime extraction, and
   the `architecture-boundaries.spec.ts` assertion update.

## Non-goals

Deliberately out of scope for this ADR and this phase: any production or runtime code; any
policy edit; any contract implementation; any Core-side change; an HR entrypoint,
`HrAppModule` registration or Dockerfile; an HR audit table; changes to `RolesGuard`,
`JwtAuthGuard`, `resolveHrActor()` or `UserDirectoryContract`; and any amendment to
ADR-0005. ARCH-2 — the extraction itself — remains **pending** until the prerequisites
above are implemented.

## Consequences

**Positive.** HR becomes deployable without a Core database connection; per-request Core
reads drop to zero on the hot path; a compromised business runtime holds no signing key
and is verifier-only; tenant scoping becomes cryptographically anchored rather than a
database lookup; and RBAC behaviour is preserved without re-deriving authorization rules.

**Negative, and accepted.** Authentication now depends on Core's *key distribution* rather
than on Core's availability, so the public key must be cached at boot with rotation overlap
and JWKS downtime must not become an HR outage. Revocation is bounded by the access TTL.
Audit carries a disclosed loss window. Token size grows with permission count, which is why
`MAX_PERMISSIONS_PER_TOKEN` and canonicalisation are specified rather than assumed.

## Open questions

- Should `perm` be replaced by a permission-version digest plus an on-demand
  `platform.permissions@v1` fetch for subjects whose permission sets make the token
  large? Deferred: it reintroduces a read for a minority of users, so it is worth doing
  only once a real set approaches the cap.
- Should the audit ingester deduplicate on `auditId` alone, or on `(auditId, tenantId)`?
  Recommended: `auditId` alone, globally unique.
- Should HR's revocation deny-set be Redis-backed in deployments that already run Redis
  (C4)? Permitted, not required.
- Should a capability credential support a **rotation overlap** — the previous secret accepted
  for a bounded window — or stay single-slot like `ModuleRegistration.secret*`? Recommended:
  single-slot for ARCH-3B, since an overlap needs a second slot per credential and a caller that
  re-reads its configuration; deferred until a rotation actually has to be zero-downtime.

## Acceptance criteria for ARCH-3 implementation

- [ ] Core signs with RS256 and publishes JWKS addressed by `kid`; HR verifies locally and holds no signing key.
- [ ] Publication has one venue and it is Core's own process: `GET /.well-known/jwks.json` is served outside any API version prefix, carries public material only, and is cached for no longer than a verifier here caches it (B7).
- [ ] Rotation is configuration rather than an act on a running process: the active key signs, a predecessor stays published and accepted for at least 900s after its successor became active, and once its `retireAt` passes it is neither published nor accepted, with no restart (B8).
- [ ] Access tokens carry `tid`, `ver` and canonicalised `perm`; tokens exceeding `HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS` are rejected.
- [ ] Tenant and subject are read only from claims; no HR path reads a client-supplied tenant.
- [ ] `platform.identity@v1` returns exactly `DirectoryUserProfile`, and HR binds it to the existing `UserDirectoryContract` with no interface change.
- [ ] `platform.audit@v1` carries `AuditOptions` + `tenantId` + a caller-minted `auditId`, ingested idempotently under a unique constraint.
- [ ] Audit egress failure never fails a business write and never reports healthy while degraded.
- [ ] `future-hr` declares `HR_DATABASE_URL: required` and `CORE_DATABASE_URL: not-used`, with the matrix assertion updated in the same change.
- [ ] An architecture test proves no HR import closure reaches Core Prisma.
- [ ] `platform.identity@v1` and `platform.audit@v1` are authenticated by **different** capability credentials, one per (caller, capability), stored encrypted and rotatable independently; neither credential authenticates the other's surface (A8).
- [ ] An audit envelope that is unsigned, or signed with anything other than the caller's `platform.audit@v1` credential, is rejected without producing a row, and broker network position is never the authentication (E9).
- [ ] Revocation latency and the audit loss window are documented in the runtime's operational notes, not only in this ADR.

## Amendment record

- **2026-09-17** — Created. Design only; no code, policy or runtime change accompanies it.
- **2026-09-17** — Amended during ARCH-3B, **before** any implementation. A1 fixed the
  identity contract but not its wire: the binding is recorded as **A7** — a dedicated
  Core-internal signed HTTP surface (`/platform/v1/identity`), caller-authenticated with a
  capability-specific service credential that is neither a token-signing key nor a Core
  database credential, reusing `module-signature.ts` for authentication and
  `module-url.guard.ts` for the outbound URL. The audit wire binding left implicit by E1–E7
  is recorded as **E8** — the existing `domain_events` exchange, `audit.<resource>.<action>`
  routing key, and one durable `platform.audit.ingest` queue bound to `audit.#`.
  The amendment changes nothing in E1–E7 or A1–A6; the four rejected alternatives
  (Core modelled as a registered module, a user token as the service credential, a shared
  credential across capabilities, request/response over the optional broker) are recorded
  with their reasons in A7. Design only — no code, policy or runtime change accompanies it;
  `future-hr` remains policy-unchanged per F2.
- **2026-09-17 — Amended again during ARCH-3B, still before any implementation.** A7 had fixed
  the credential's *scope* but not that Core contained no store able to hold it: reading the
  baseline showed `ModuleRegistration.moduleId` is `@unique` with a single secret envelope,
  `resolveSecret(moduleId)` is the only resolver, and `ModuleSignatureInput` has no capability
  field — so capability could only ever be expressed by which secret verifies. **A8** records
  the store (`ModuleCapabilityCredential`, `@@unique([moduleId, capability])`, reusing
  `CryptoService`, `AI_CONFIG_ENCRYPTION_KEY` and the existing envelope, expiry and one-way-issue
  conventions, with `ModuleRegistration` semantics untouched and `rotateCredential(actorId, id)`
  deliberately not overloaded). **E9** records the audit publisher authentication that E8 left
  implicit: a capability-scoped HMAC over the envelope, so `platform.audit@v1` carries a
  cryptographic caller identity of its own and broker network position is supplementary only.
  The alternatives rejected here are "one `ModuleRegistration` row per capability" (a fake module
  principal, and the same runtime still holds both secrets), "reusing the module-hop credential
  across capabilities" (already rejected in A7) and "broker network trust as the sole publisher
  control". Nothing in A1–A7 or E1–E8 changes. Design only — no code, policy or runtime change
  accompanies it; `future-hr` remains policy-unchanged per F2.
- **2026-09-18 — ARCH-3B closed the two implementation steps these amendments prepared, and this
  record states what is now fact.** A7/A8's surfaces exist: `src/platform/identity/` serves
  `platform.identity@v1`, the `ModuleCapabilityCredential` store and the
  `CAPABILITY_CREDENTIAL_RESOLVER` seam resolve exactly one capability per `(moduleId, capability)`,
  and the audit ingester exists (`src/platform/audit/`, one durable `platform.audit.ingest` queue
  bound to `domain_events` on `audit.#`). **E9 is NOT implemented**: nothing publishes an audit
  envelope yet — `auditRoutingKey` is called only by its own spec, and `toAuditEnvelope` only by that
  spec and by `platform-audit.service.ts` to validate an event it writes in-process — and the
  ingester reads no AMQP headers, so no signature is verified and the unsigned-envelope acceptance
  criterion below is still open. F1/F2's `future-hr` policy flip is likewise untouched —
  `runtime-datasources.ts` and `architecture-boundaries.spec.ts` still assert `CORE_DATABASE_URL:
  required` for `future-hr`, which remains the truth. File-level record, with the evidence for both
  halves: `docs/reports/PHASE_51-HR-ARCH-3B_CLOSURE.md`.
- **2026-09-20 — Phase 52-ARCH-3C implemented B2's publication half and fixed the rotation
  contract, and this record states what is now fact.** **B7** and **B8** above are new: B2
  required "JWKS addressed by `kid`" without saying where that document lives, and the
  Consequences section required "rotation overlap" without saying how long it must be, so both
  were unenforceable as written. What exists now: `GET /.well-known/jwks.json` is served by Core
  (outside the `api/v1` prefix, exactly matched at the ingress with a bounded `max-age=300`), the
  document is built from the configured key set with public material only, and `JWT_SIGNING_KEYS`
  + `JWT_ACTIVE_KEY_ID` carry a key set whose retirement rule (`isRetired`) is applied by the
  publisher and the verifier alike. Proven live against a real rotation, not by inspection: a
  token signed by the retiring key was accepted while inside its window, and once `retireAt`
  passed — with no restart — that key stopped being published *and* stopped verifying, while the
  active key kept working (17/17 assertions, including refusals for an unknown `kid`, an HS256
  token carrying the shared secret, and an HS256 token keyed with the public key). What is
  **not** fact, and therefore what the first two acceptance criteria above still record as open:
  Core *can* sign with RS256 and publish keys, but no deployment configures key material
  (`JWT_SIGNING_KEYS` appears in no `.env`, no compose file and no policy), so every runtime
  remains on the shared secret and HMAC acceptance has not been turned off anywhere; and no HR
  runtime verifies locally against this document yet, because the `future-hr` policy flip
  (F1/F2) is untouched. B1–B6, C, D, E and F are unchanged by this phase.