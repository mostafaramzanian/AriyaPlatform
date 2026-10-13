# PHASE 51-HR-ARCH-3B — THE DELIVERY CONTRACTS AND THE CAPABILITY-CREDENTIAL SEAM

**PHASE: 51-HR-ARCH-3B**
**STATUS: COMPLETE — both ARCH-3 delivery contracts implemented and bound, one capability-credential
store added without touching `ModuleRegistration`, HR's audit call sites moved behind a single
gateway, and the combined runtime's observable behaviour preserved: 125 suites / 2,109 tests pass,
`tsc --noEmit` exits 0 with no output, and every lint finding in the changed paths is provably
pre-existing.**

This phase implements the ADR-0006 amendments recorded for it — **A7/A8** (`platform.identity@v1`
on a signed Core-internal surface, and the capability-scoped credential store that binds it) and
**E8/E9** (`platform.audit@v1` on the existing `domain_events` exchange, and the publisher
authentication that makes it a *contract* rather than a broker convention) — together with the
narrowed `AuditLog` migration those contracts run on. It does **not** extract HR, does not flip the
`future-hr` policy, does not edit `architecture-boundaries.spec.ts`, and does not change
`ModuleRegistration`.

Every figure below was re-derived from a command run on this machine for this phase.

---

## 1. THE PROBLEM, IN THE CODE THAT EXISTED

| Concern | Where it lived before this phase | Why that blocked extraction |
|---|---|---|
| Identity reads | `CoreUserDirectoryAdapter` — the single implementation of `UserDirectoryContract`, in-process | A1 fixed the *contract* (four operations, one allowlisted projection) but not the *wire*. A separate HR process had no way to answer "who is this person?", and the gap was undocumented — hence A7, recorded **before** code was written against it. |
| Capability-scoped credential | `ModuleRegistration`: `moduleId` `@unique` (one row per module), one `secretCiphertext`/`secretIv`/`secretAuthTag` envelope behind one `secretExpiresAt`, resolved by `resolveSecret(moduleId)`; `moduleSignatureMaterial` signs `moduleId`, `requestId` and the tenant slot and has **no capability field** | Capability was representable *nowhere*: not in the signature, not in the store. Two contracts would have had to share one secret, so leaking it would authenticate identity reads **and** audit ingest, and rotating it would break both (A8). |
| Audit contract | `AuditService.log()` inserted `core_db."AuditLog"` in-process and then published fire-and-forget | A runtime without a Core database could not audit at all. "HR writes succeed but produce no audit records" is the silent failure E4 exists to prevent. |
| Audit event identity | The publish key was `row.id` — the id the database assigned at insert — and `requestId` was `UNIQUE` | Idempotency could not be defined for a caller that has not inserted yet (E3); and several events in one request could not be distinct rows, which is exactly what a UNIQUE `requestId` forbade. |
| Audit tenant | `AuditOptions` had no `tenantId` and the HR call sites passed none | The audit record of a multi-tenant deployment could not be attributed to a tenant at all (E2/E6) — audit isolation as a documentation claim rather than a property of the data. |
| Publisher authentication | Implicit: anything that could reach `domain_events` could mint an audit row attributed to any caller | A broker on a private network proves transport reachability, not caller identity (E9). |
| HR's audit call sites | Four services injected `AuditService`, which was provided by `RbacModule` | A business service had to depend on Core's **authorization** module — its permission tables, role services and controllers — in order to write one row to the trail. The coupling §6/§17 removes. |

## 2. WHAT WAS BUILT

Four seams, one per row of §1's table, plus the wiring that binds them into Core. The two transports
live under `src/platform/**` and import no business domain; the store lives beside the registry that
owns it; the HR seam lives in the module that consumes it.

### 2.1 `platform/audit` — the `platform.audit@v1` seam (7 files, 2,165 lines)

| File | Lines | What it declares or does |
|---|---|---|
| `audit.contract.ts` | 334 | The contract. `PLATFORM_AUDIT_CONTRACT = 'platform.audit@v1'`, the `AUDIT_PORT` token, the wire binding (`AUDIT_EXCHANGE = 'domain_events'`, `AUDIT_INGEST_QUEUE = 'platform.audit.ingest'`, `AUDIT_BINDING_PATTERN = 'audit.#'`, `AUDIT_TOPIC_PREFIX = 'audit.'`), `AuditEventInput`/`AuditEvent`, `AuditRecordStatus = 'recorded' \| 'duplicate' \| 'conflict' \| 'rejected'`, `AuditRejectionCode`, `AuditPort`, and the pure helpers both sides share: `isAuditId`, `validateAuditEvent`, `canonicalAuditJson`, `auditEventDigest`, `auditRoutingKey`, `toAuditEnvelope`. |
| `platform-audit.service.ts` | 283 | The **Core binding of the port, and the only writer of a new-style audit row**. It re-uses the redactor, the table and `PrismaService`, but not `AuditService`'s control flow: that flow cannot express this contract — it *generates* an id when none is given, it treats a present row as a conflict, and it publishes the row it just wrote. It re-validates an arriving event through the same `validateAuditEvent` the queue consumer uses, recognises an already-present `auditId` by comparing digests over fields `AuditLog` can prove, and **never throws**: a rejection is RETURNED so the caller can log it. |
| `audit-ingest.consumer.ts` | 220 | The remote half: a consumer on the durable `platform.audit.ingest` queue bound to `domain_events` on `audit.#`, `prefetch` bounding in-flight work, `ack` for terminal outcomes and `nack(false, true)` only for `retry`. With `RABBITMQ_URL` unset it **declines to start and says so** — the same `resolveRabbitMqUrl` rule `NotificationPublisher` already follows. |
| `platform-audit.module.ts` | 44 | DI. Imports `PrismaModule` and nothing else; binds `AUDIT_PORT` with `useExisting` so the port cannot be satisfied by a second, divergent writer; owns the ingest consumer because it is the other half of the same contract. It deliberately does **not** import `NotificationModule`: a `platform.audit@v1` row is the terminal record, and a writer that published its own output would have the consumer ingest it and double the trail. |
| `audit.contract.spec.ts` | 373 | 30 tests: validation, rejection codes, digest stability, routing key, envelope. |
| `platform-audit.service.spec.ts` | 455 | 22 tests: the four outcomes, idempotency, redaction, and the never-throws rule. |
| `audit-ingest.consumer.spec.ts` | 456 | 19 tests: binding, prefetch, ack/nack per outcome, unconfigured-broker path. |

### 2.2 `platform/identity` — the `platform.identity@v1` transport (5 files, 1,290 lines)

| File | Lines | What it declares or does |
|---|---|---|
| `identity.contract.ts` | 120 | `PLATFORM_IDENTITY_CONTRACT = 'platform.identity@v1'`, `IDENTITY_ROUTE_PREFIX = '/platform/v1/identity'`, `IDENTITY_OPERATIONS` and `IDENTITY_ROUTE_SEGMENTS` (`profiles`, `tenant-members`, `tenant-member`, `tenant-of-user`) — the four approved operations and no fifth, with no search and no enumeration (A3). The batch bound is `MAX_IDENTITY_BATCH = MAX_DIRECTORY_IDS`, taken *from* the port rather than restated, and `IdentityProfileResponse = DirectoryUserProfile`: the response type **is** the port's allowlist, so widening Core's identity exposure is a `@v2` event rather than a DTO edit (A2). |
| `platform-identity.controller.ts` | 374 | The route group. Every route is `@Public()` in the JWT sense and authenticated by the A8 capability credential for `platform.identity@v1` instead — so `RolesGuard` has nothing to enforce, and a credential issued for `platform.audit@v1` authenticates nothing here. Tenant authority is Core's **own** membership check (A7), never the signed `tid`. |
| `platform-identity.module.ts` | 48 | DI, and the narrowest import list in the repository: `ModulePlatformModule` for `CAPABILITY_CREDENTIAL_RESOLVER` only, `UserDirectoryModule` for tenant authority. It exports nothing. It never imports `PrismaModule`, and because `UserDirectoryModule` re-exports only the `USER_DIRECTORY` token, Core's database handle is present in the graph but **unreachable** from this controller. |
| `platform-identity.controller.spec.ts` | 539 | 21 tests: the four operations, the uniform 401 without a credential, wrong-capability rejection, the response allowlist. |
| `platform-identity.module.spec.ts` | 209 | 8 tests: the module's own boundary — no `PrismaService` reachable from the controller, nothing exported. |

### 2.3 `module-platform` — the capability-credential seam and the DTO boundary

| File | Lines / diff | What it adds |
|---|---|---|
| `capability-credential.resolver.ts` | 49 (new) | The **one-method seam** the platform transports inject: `resolveCapabilityCredential(moduleId, capability): Promise<string \| undefined>` behind the `CAPABILITY_CREDENTIAL_RESOLVER` string token. It returns a *plaintext or `undefined`* — no envelope, no expiry, no `hasSecret`, no row — so a consumer cannot learn whether a credential is "expired" versus "absent", cannot enumerate a module's capabilities, and never holds a ciphertext it could persist or log. |
| `module-platform.module.ts` | +14 | Provides and exports `CAPABILITY_CREDENTIAL_RESOLVER` via `useExisting: ModuleRegistryService`, so one instance serves both the registry and the seam. The registry class itself stays **unexported**: a consumer that imports this module can ask one read-only question and cannot admit a module, rotate a module-hop credential, read a tenant scope or run the sweep. The wiring spec still asserts the class is absent from `exports`. |
| `dto/module.dto.ts` | 110 changed (532 lines) | The two capability-credential DTOs and their projection functions — see §5.5, where the boundary is proven rather than asserted. |
| `module-registry.service.ts` | +322 | The store's operations: `listCapabilityCredentials(moduleId)`, `rotateCapabilityCredential(actorId, moduleId, capability)` (capability-specific: rotating one does not touch the other), `resolveCapabilityCredential(moduleId, capability)` with expiry enforced *at resolve time*, and the distinguishable trail pair `PLATFORM_CAPABILITY_CREDENTIAL_ROTATED` / `module.capability_credential.rotated` carrying `{ capability, generated: true }` and never the value. |
| `module-registry.service.spec.ts` / `module-registry.controller.spec.ts` | +283 / +108 | 95 and 15 tests covering the store and the HTTP boundary. |
| `module-platform.module.spec.ts` | +36 | The control-plane boundary: what the module exports, and what it must not. |
| `prisma/core/schema.prisma` + `20260917120000_add_module_capability_credential` | +121 / new migration | The `ModuleCapabilityCredential` model: `@@unique([moduleId, capability])` — the uniqueness **is** the capability boundary — the existing AES-256-GCM envelope, the existing `CryptoService` and `AI_CONFIG_ENCRYPTION_KEY`, `onDelete: Cascade` to `ModuleRegistration.moduleId`, and `ModuleRegistration` **unchanged**. |

### 2.4 HR — one gateway, four services, and no way to forget the tenant

| File | Lines / diff | What it does |
|---|---|---|
| `modules/hr/hr-audit.gateway.ts` | 101 (new) | `HrAuditGateway.record(actor, act)`: the only surface through which HR writes to the trail. It stamps `auditId: randomUUID()`, `tenantId: actor.tenantId`, `requestId`, `correlationId`, `actorId`, `ip`, `userAgent` **last**, so a field added to `HrAuditAct` later cannot shadow them — the gateway's values win by construction. `HrAuditAct` has no `tenantId` and no `auditId` field at all, so a call site cannot pass the wrong tenant or invent an event identity. It never throws, and logs `rejected`/`conflict` at error level because that is an operator's alarm, not a caller's. This is the audit counterpart of `hr-identity.gateway.ts` (committed in ARCH-3A, unmodified here). |
| `modules/hr/{employees,employment,organization,positions}/*.service.ts` (+ their specs) | 25 changed each; 14/2/12/11 in the specs | The four services that audit mutations now inject `HrAuditGateway` instead of `AuditService`, so the dependency that reached `RbacModule` for audit is gone. |
| `modules/hr/hr.module.ts` | +22 | Provides the gateway, and takes its audit dependency from the platform module rather than from RBAC. The module still imports `RbacModule` — for the reason RBAC exists: its controllers are gated on `hr.*` permissions. |
| `modules/hr/hr-isolation.spec.ts` / `hr-application-boundaries.spec.ts` | +42 / +19 | The rules that keep this true as the module grows: 9 and 8 tests. |

### 2.5 The legacy producer, Core's wiring, and the narrowed migration

| File | Diff | What it does |
|---|---|---|
| `common/audit.service.ts` | +51 | The **legacy** producer stays a producer. `AuditOptions` gains an optional `auditId` (generated when absent, never persisted as null) and an optional `tenantId` (optional *by design*: legacy producers and the 36,489 historical rows have no deterministic tenant). The publish key stays `row.id`, and the comment says why — `AuditDispatch`'s `auditId` keeps its historical meaning of `AuditLog.id` and is not reinterpreted. |
| `core-app.module.ts` | +34 | Registers `PlatformAuditModule` and `PlatformIdentityModule`, in Core, because the trail is `core_db."AuditLog"` and A7's tenant authority is Core's own membership check: a process with no Core database can host neither. Neither is mandatory for Core operation — with `RABBITMQ_URL` unset the consumer declines to start, and with no credential issued the identity surface answers a uniform 401. |
| `app.module.ts` | +21 | The combined runtime registers `PlatformAuditModule` explicitly rather than relying on `HrModule` to drag it in, so ingesting does not wait for a business module to be enabled. |
| `20260918120000_add_auditlog_audit_id_tenant` | new migration | The narrowed migration: add `auditId` nullable → backfill **deterministically** as `auditId := id` (true for every row, because `id` is already UNIQUE) → verify count and distinctness in-transaction → add `UNIQUE("auditId")` → drop `UNIQUE("requestId")` and replace it with a plain index → add `tenantId` **nullable and unbackfilled**. Its own comment block records what it is *not*: making `tenantId` NOT NULL required a deterministic tenant for all 36,489 rows, and only 557 (1.53%) have provable evidence, so the proof failed — correctly. |

---

## 3. THE BOUNDARY AS IT NOW STANDS

The table names the consumer of every part of the seam, and — in the last column — what is still
missing for a runtime that runs in its own process. That column is not decoration: it is where this
phase stops.

| Capability | Declared in | Consumer, as it stands today | Bound by the combined runtime | What a standalone runtime still needs |
|---|---|---|---|---|
| Identity reads (four operations) | `platform/identity/identity.contract.ts` + `platform-identity.controller.ts` | **Nothing in-process**: `HrIdentityGateway` still injects `USER_DIRECTORY` in-process, which is why the transport is not "used up" by the combined runtime | `PlatformIdentityModule`, registered in `core-app.module.ts` | A1's second implementation, `PlatformUserDirectoryAdapter`. It **does not exist** in this tree (a repository-wide grep for the symbol returns nothing), so the wire is implemented and unbound — precisely the state A1 intends for the extraction step |
| Audit write | `audit.contract.ts` (`AUDIT_PORT`) | `HrAuditGateway` — one gateway, four services, and the only business consumer the grep finds | `PlatformAuditModule`: `AUDIT_PORT` → `PlatformAuditService` via `useExisting` | Nothing: the port *is* the seam |
| Audit ingest | `audit.contract.ts` (the E8 binding constants) | `AuditIngestConsumer`, a provider of the module that binds the port it writes through | Bound to `domain_events` on `audit.#` when `RABBITMQ_URL` is set | A **signed producer**. No code publishes an audit envelope yet: `toAuditEnvelope` is called by the service for validation and by specs, and `auditRoutingKey` has no caller outside its own spec (§6, risk 3) |
| Capability credential resolution | `module-platform/capability-credential.resolver.ts` | `PlatformIdentityController`; asserted by `module-platform.module.spec.ts` | `ModulePlatformModule` exports the token, `useExisting` → `ModuleRegistryService` | Same binding; the audit transport would consume the same token when its publisher side is built |
| Capability credential store | `module-registry.service.ts` + the `ModuleCapabilityCredential` model | the administrator surface (`module-registry.controller.ts`) and the resolver above | `ModulePlatformModule` | Same |
| Legacy audit | `common/audit.service.ts` | the pre-existing producers, unchanged in every call site | `RbacModule`, exactly as before | It must keep working, and it does |

---

## 4. WHAT DID NOT CHANGE

The phase's value is as much in this list as in §2, because every item here is a property a reviewer
would otherwise have to re-derive from the diff.

- **`ModuleRegistration`**, its single secret envelope, and `resolveSecret(moduleId)`.
- **`module-signature.ts` and `moduleSignatureMaterial`** — byte-identical, so no module hop changes;
  the ADR's E9 records the audit material builder as one that *mirrors* it rather than edits it.
- **`module-url.guard.ts`, `module-client.service.ts`, `module-http.transport.ts`** and the rest of
  the control plane's transport, which are untouched.
- **`architecture-boundaries.spec.ts` and `runtime-policy.spec.ts`** — not in the 23-file diff, and
  the entire suite that contains them is green.
- **`runtime-datasources.ts` and the `future-hr` policy** — the extraction's policy flip is item 5 of
  the ADR's ordering and is deliberately not here.
- **`HrIdentityGateway`, `UserDirectoryContract`, `resolveHrActor()`, `RolesGuard`, `JwtAuthGuard`** —
  the ARCH-3A seam is *used* by this phase, not extended.
- **The legacy publish path and `AuditDispatch`'s `auditId` semantics.**
- **No new permission and no new `RolesGuard` rule**: the identity route group is `@Public()` in the
  JWT sense, so RBAC has nothing to enforce on it and nothing was added to the catalogue.

## 5. VERIFICATION

### 5.1 The gates, with the commands that produced them

Every row below is a command run against this working tree, not a claim about a design.

| Gate | Command (from `apps/api`, binaries at the repo root) | Result |
|---|---|---|
| Full suite | `node ../../node_modules/jest/bin/jest.js --silent` | **125 suites, 2,109 tests, 0 failed, 0 skipped.** `apps/api/src` contains exactly 125 `.spec.ts` files, so "every spec file is a suite" holds and nothing was silently ignored. |
| Every path this phase touched | `node ../../node_modules/jest/bin/jest.js src/platform src/module-platform src/modules/hr src/common/audit.service.spec.ts --silent` | **45 suites, 739 tests, 0 failed** in 30.3 s — re-run **after** the final formatting edits of this phase, so it is a statement about the tree being committed. |
| The audit seam alone | `… src/platform/audit` | **3 suites, 71 tests** (30 + 22 + 19). |
| The identity seam alone | `… src/platform/identity` | **2 suites, 29 tests** (21 + 8). |
| The control plane | `… src/module-platform` | **19 suites, 393 tests.** |
| HR | `… src/modules/hr` | **12 suites, 106 tests.** |
| Types | `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` | **exit 0 with no diagnostic output at all** — the captured file contains the completion marker and nothing else. |
| Lint, the changed paths | `node ../../node_modules/eslint/bin/eslint.js src/platform/audit src/platform/identity src/module-platform src/modules/hr src/common/audit.service.ts src/app.module.ts src/core-app.module.ts -f stylish` | **12 errors, 0 warnings, 5 files — all 12 provably pre-existing (§5.4).** |
| Formatting, this phase's 36 parseable files | `node ../../node_modules/prettier/bin/prettier.cjs --check --end-of-line auto <36 paths>` | **30 pass, 6 flagged.** The 36 is derived, not asserted: 23 tracked files **less** `schema.prisma` (prettier says "No parser could be inferred" — no Prisma plugin is installed, and the same is true of the two `.sql` migrations) **plus** the 14 new TypeScript files. **All six flagged files are flagged at their `HEAD` content too** (§5.4). |
| Formatting, the three directories | `… --list-different --end-of-line auto src/module-platform src/platform src/modules/hr` | **57 files flagged** — 21 in `src/platform` (18 `auth` + 3 `user-directory`, neither directory in this diff) and 36 of `src/module-platform`'s 42 TypeScript files, 0 in `src/modules/hr`; the sum is exact — **pre-existing**, and the set includes files this phase never opened. Two fewer than the count measured earlier in this phase, and the difference is exactly the two files it reflowed. |
| Whitespace | `git diff --check` (repo root) | **exit 0** — no trailing whitespace, no blank line at EOF. |
| The change itself | `git diff --stat` (repo root) | **23 tracked files, +1,274 / −134** (the ADR's +15 / −2 included), plus 16 new files (14 source, 2 migrations). |

### 5.2 Sizes, counted file by file

| Group | Files | Lines |
|---|---|---|
| `platform/audit` source — `audit.contract`, `platform-audit.service`, `audit-ingest.consumer`, `platform-audit.module` | 4 | 334 + 283 + 220 + 44 = **881** |
| `platform/audit` specs — `audit.contract.spec`, `platform-audit.service.spec`, `audit-ingest.consumer.spec` | 3 | 373 + 455 + 456 = **1,284** |
| **`platform/audit` total** | **7** | **2,165** |
| `platform/identity` source — `identity.contract`, `platform-identity.controller`, `platform-identity.module` | 3 | 120 + 374 + 48 = **542** |
| `platform/identity` specs — `platform-identity.controller.spec`, `platform-identity.module.spec` | 2 | 539 + 209 = **748** |
| **`platform/identity` total** | **5** | **1,290** |
| The capability-credential seam — `capability-credential.resolver.ts` (new) | 1 | **49** |
| HR's audit seam — `hr-audit.gateway.ts` (new) | 1 | **101** |
| Migrations — `20260917120000_add_module_capability_credential`, `20260918120000_add_auditlog_audit_id_tenant` | 2 | new |

The two transports are 3,455 lines across 12 files, of which 2,032 are specs, and the ratio is
deliberate: a wire format that is not asserted is a wire format that drifts.

### 5.3 What the new tests actually assert

| Spec (tests) | The assertion that carries the weight |
|---|---|
| `audit.contract.spec.ts` (30) | Every `AuditRejectionCode` is reachable from `validateAuditEvent`; the digest is stable and order-independent over the fields `AuditLog` can prove; the routing key is exactly `audit.<resource>.<action>`; and an envelope carrying the **sibling** capability is rejected — so one credential cannot impersonate the other (A8). |
| `platform-audit.service.spec.ts` (22) | The four outcomes. A replay of the same `auditId` is a **duplicate**, not a second row; the same id with a different digest is a **conflict**; the service **stamps the capability descriptor itself**, so an in-process caller cannot smuggle another capability onto the trail; and no path throws. |
| `audit-ingest.consumer.spec.ts` (19) | The queue and binding it declares, the prefetch bound, `ack` for every terminal outcome and `nack(false, true)` **only** for `retry`, and the unconfigured-broker path — the process says it is not ingesting rather than failing silently. |
| `platform-identity.controller.spec.ts` (21) | The four operations and no fifth; a uniform 401 with no credential; wrong-capability rejection; the response body against the port's allowlist. |
| `platform-identity.module.spec.ts` (8) | The module's own boundary: `PrismaService` is not reachable from the controller even though the handle is in the import graph, and nothing is exported. |
| `module-registry.controller.spec.ts` (15) | The serialised key set of the read route contains **no** envelope property, and the write route returns `secret` and nothing else (§5.5). |
| `module-registry.service.spec.ts` (95) | Uniqueness is the capability boundary; rotation is capability-specific; expiry is enforced at resolve time; the trail pair carries the capability and `{ generated: true }` and never the value. |
| `module-platform.module.spec.ts` (7, +36) | `CAPABILITY_CREDENTIAL_RESOLVER` is exported **and the registry class is not** — the asymmetry §2.3 depends on, asserted rather than intended. |
| `hr-application-boundaries.spec.ts` (8) | Rule 5 now asserts both halves: every application service imports `HrAuditGateway`, and the gateway is the **only** file in `modules/hr` whose imports reach the platform audit seam (`offenders(SOURCE, importsSeam)` equals `['hr-audit.gateway.ts']`). A future call site that reaches for the port directly fails here. |
| `hr-isolation.spec.ts` (9, +42) | HR's isolation properties as the gateway changes them. |
| The four services' specs — `employees`, `employment`, `organization`, `positions` (13 + 16 + 4 + 6 = **39**, +14/+2/+12/+11) | Each mutated service's audit call still happens, now through the gateway. |

Those eleven rows cover **14 suites** and the counts are jest's own, read from a fresh `--json` run over
exactly those suites on this tree: **273 tests, 0 failed** — the arithmetic sum of the rows, not an
estimate. The five specs that carry the seam's weight (`audit.contract`, `platform-audit.service`,
`audit-ingest.consumer`, `module-registry.service`, `module-registry.controller`) are 30 + 22 + 19 + 95 +
15 = **181** of them.

### 5.4 Lint and formatting: which findings are this phase's, and which are the repository's debt

The distinction matters more than the totals, so both sides were measured on this tree.

**eslint — 12 errors in 5 files, none of them inside a line this phase added.** The method was
mechanical rather than a judgement: parse `git diff -U0`'s hunk headers for the added ranges in each
file, then test every finding's line against those ranges.

| File | Findings | Added ranges in that file | Verdict |
|---|---|---|---|
| `src/common/audit.service.ts` | 57:24, 58:24, 143:22 (`no-explicit-any`) | 2, 8–18, 20–29, 77–80, 83, 85, 108–111, 122–139 | all three **outside** → pre-existing |
| `src/module-platform/module-registry.controller.ts` | 76:20 (`no-explicit-any`) | 33–34, 38–39, 217–281 | **outside** → pre-existing |
| `src/module-platform/module-registry.controller.spec.ts` | 27:76, 72:83, 79:87, 114:88, 124:80 | 47–48, 89–90, 97–99, 145–157, 250–337 | all five **outside** → pre-existing |
| `src/module-platform/module-client.service.spec.ts` | 40:7 (`no-unused-vars`) | — (the file is unmodified, so `git diff` is empty) | pre-existing |
| `src/module-platform/module-registration.controller.spec.ts` | 88:8, 143:85 | — (unmodified) | pre-existing |

This is the debt ARCH-3A already recorded — 61 errors across 18 files in `src/common`,
`src/module-platform`, `src/health` and `src/integrations` — and it is left alone for the same reason:
it is not a property of this seam, and fixing it would be a commit that touches files this phase never
opened.

**prettier — 57 files flagged across the same three directories, and every one of them pre-existing.**
Four observations establish that, in place of an opinion:

1. Files this phase **never opened** are flagged: `src/platform/auth/**` (18 files) and
   `src/platform/user-directory/**` (3) — neither directory is in the diff — plus 36 of
   `src/module-platform/**`'s 42 TypeScript files, most of which this phase never opened. Among them are
   `token-policy.ts` and `audit.service.ts`, both of which are flagged **at their HEAD content**.
2. `src/module-platform/dto/provisioning.dto.ts` was briefly reformatted during this work, that change
   was reverted, and the file is flagged again, unchanged.
3. The diff prettier asks for always has the same shape, and `apps/api/.prettierrc` explains it: the
   config asks for `printWidth: 100` and `trailingComma: "es5"`, while the repository is written in
   prettier 3's defaults — hand-wrapped at roughly 80 columns with ES-all trailing commas. So
   `prettier --check` wants to *remove* the trailing comma after the last parameter or argument of a
   signature or call, to *join* lines the author wrapped, and to *split* the rare line past column 100.
   On `token-policy.ts` that is lines 123 and 128; on `audit.service.ts` it is a **107**-character
   constructor line that exists verbatim in the HEAD version.
4. Line endings are a second, independent cause of "flagged": `core.autocrlf=true` converts on
   checkout, so of the 411 tracked files under `apps/api/src`, **323 are CRLF-only and 88 LF-only,
   with no mixed file**, and prettier's default `endOfLine: "lf"` flags a CRLF working copy whose
   *content* conforms. `src/app.module.ts` is exactly that case — content-clean at HEAD and in the
   working copy (both verified), yet `prettier --list-different src/app.module.ts` names it, and
   adding `--end-of-line auto` clears it. Every measurement in this section therefore uses
   `--end-of-line auto`, so that the number reported is about content and not about checkout.

Normalising either cause would be a formatting commit across files this phase never touched, so it is
deliberately not done. What **was** done is the part that is this phase's: two files it owns were
flagged for content, and both are fixed in this commit — `hr-audit.gateway.ts` (a trailing comma after
a call's last argument, plus a missing final newline; the file is LF-only like every new file here) and
`hr-application-boundaries.spec.ts` (a manual wrap prettier joins to a 74-character line).

Re-measured afterwards with `--check --end-of-line auto` over all **36 parseable files** of this change
— 23 tracked minus `schema.prisma`, plus the 14 new TypeScript files — **30 pass and 6 are flagged**,
and the six are not waved at: **every one of them is flagged at its `HEAD` content as well**, so none
of the six is a line this phase introduced.

- **Five tracked `.ts` files, flagged at `HEAD` too.** `audit.service.ts`,
  `module-registry.controller.ts`, `module-registry.controller.spec.ts`, `module-registry.service.ts`
  and `module-registry.service.spec.ts` were each checked by reading `git show HEAD:<path>` into memory,
  running prettier's `resolveConfig` + `format` on that text with the same absolute `filepath` the CLI
  would use (so `apps/api/.prettierrc` applies, not prettier's defaults), and comparing the result with
  the input: **all five differ at `HEAD`**, for the reasons observation 3 gives. Concretely, the diff
  against `HEAD` removes the comma after the last argument in
  `registrationRow({ enabled: true, instances: [instanceRow()] }),` and after
  `registerDto({ protocolVersion: MODULE_PROTOCOL_VERSION + 1 }),`, while the diff against the working
  copy instead *joins* the hand-wrapped call
  `await service.registerInstance(registerDto({ protocolVersion: MODULE_PROTOCOL_VERSION + 1 }));`.
  So the flagged lines are inherited, not introduced.
- **The ADR is the sixth, and it is flagged at `HEAD` too.** `ADR-0006-ARCH-3-CROSS-RUNTIME-CONTRACTS.md`
  was checked the same way, and it differs at `HEAD` as well: prettier's markdown formatter pads every
  table cell to its column width (`| Capability | Mechanism | … |` becomes
  `| Capability                        | Mechanism | … |`). That is a property of the document's whole
  history, not of the 15-line record this phase appended to it.

The same HEAD probe was run over **all 21 modified `.ts` files**, not only the flagged ones, as a control
on the method: **7 differ at `HEAD` and 14 are HEAD-clean**, and the 7 are the five above plus two files
this phase's edits happen to have brought to conformance — `dto/module.dto.ts` and
`module-platform.module.spec.ts` are flagged at `HEAD` but `--list-different` is silent on them now
(exit 0). So this change left the formatting status of every file it touched the same or better, and no
file worse.

**Outside those 36, the reports are flagged as a class, and that is stated rather than hidden.**
`prettier --list-different "docs/reports/*.md"` names **all 17** files in that directory: the 16 that
predate this phase — the ARCH-3A closure report among them — and this report. Conforming would mean
reflowing sixteen documents this phase never opened, to make one of them satisfy a config no report has
ever satisfied; that is a formatting commit of its own, and not this one. It is why this report is not
counted in the 36: it is not a `.ts` file and not a tracked modification, but its formatting status is
the same as the ADR's and is recorded here anyway.

`git diff --check` is exit 0 over the whole change, so the whitespace gate is clean independently of
prettier's opinion.

### 5.5 The capability-credential boundary, proved rather than typed

`CapabilityCredentialResponseDto` (`dto/module.dto.ts:487`) has eight fields and none of them can
carry an envelope: `id`, `moduleId`, `capability`, `hasSecret`, `credentialUpdatedAt`,
`credentialExpiresAt`, `createdAt`, `updatedAt`. `secretCiphertext`, `secretIv` and
`secretAuthTag` are not fields, so a route that tried to serialise one does not compile.

`CapabilityCredentialSecretResponseDto` (`dto/module.dto.ts:529`) has exactly one field, `secret`, and
it is the only place in the HTTP surface where a credential's plaintext appears — on the write route
that generated it, with deliberately no `GET` counterpart: an operator who loses a credential rotates
it, because a route that could read one back would make every audit row about rotation a lie.

Both are declared as **classes**, and the file states why: an interface of the same name would merge
with the class, and that merge is what lets a field be added in one declaration and be silently absent
from the other. `CapabilityCredentialSecretResponseDto` was an interface before this phase and was
converted for exactly this reason.

The boundary is **executable, not merely typed**. `module-registry.controller.ts` returns
`rows.map(toCapabilityCredentialResponse)` — a field-by-field rebuild, not a spread — and the write
route returns `toCapabilityCredentialSecretResponse(result)`, which rebuilds `{ secret }`. The spec
then asserts the runtime key set of both responses, which is the check a type cannot make: a spread
would compile, and it fails the spec.

---

## 6. WHAT REMAINS, AND THE RISKS THIS PHASE LEAVES OPEN

Ordered by what would bite first, and stated without hedging because each one is a property a reader
can check in this tree.

**1. No producer publishes an audit envelope — the publisher half of E8 and all of E9.** The
repository-wide greps are unambiguous: `auditRoutingKey` appears only at its definition
(`audit.contract.ts:320`) and in its own spec; `toAuditEnvelope` only at its definition, in the
contract spec, and in `platform-audit.service.ts:63` where it validates; `AUDIT_EXCHANGE` and
`AUDIT_INGEST_QUEUE` only in the contract, the consumer, and their specs. So the ingest queue is bound
and idle, and the one writer in production today is the in-process path through `AUDIT_PORT`.

The consequence that must not be glossed: **E9 is unimplemented, and therefore the ADR's acceptance
criterion that an unsigned envelope is rejected without producing a row is not met by ARCH-3B.** The
consumer names exactly one field of a delivery — `content: Buffer` — so it reads no AMQP headers at
all: neither E8's caller/contract header block nor E9's HMAC signature is checked, and the capability
descriptor is *stamped by the ingest side* (the service) rather than proven by the sender. Today that
is safe only because nothing else publishes a well-formed `platform.audit@v1` envelope and the broker
is a trusted network position — which E9 explicitly says is "supplementary, never the
authentication". It is recorded here as the first residual risk rather than left to be discovered from
a log line.

**2. The identity transport is served and unbound.** `PlatformUserDirectoryAdapter` — A1's second
implementation and the client end of A7 — does not exist in this tree; a worktree-wide search over
`apps/api/src` returns zero hits. `HrIdentityGateway` still injects `USER_DIRECTORY` in-process, so
the wire is exercised by its controller and module specs and by nothing in production. This is
precisely the state A1 specifies for the extraction step, and it is why the transport's existence is
not evidence that the extraction happened.

**3. Item 5 of the ADR's ordering is untouched.** `runtime-datasources.ts` still declares `future-hr`
as requiring `CORE_DATABASE_URL`, and `architecture-boundaries.spec.ts` still asserts it. That
statement remains true, and flipping it is the extraction, not this phase.

**4. `tenantId` is nullable and unbackfilled.** Only 557 of 36,489 rows (1.53%) have provable tenant
evidence, so the narrowed migration added the column and left it null. The tenancy rule is therefore
enforced at the write path — `AuditEventInput.tenantId` is required, so an un-tenanted platform event
cannot be expressed — rather than by a NOT NULL constraint, and tenant-scoped reads must tolerate
NULL. A later phase can decide whether the historical rows are tenant-less or whether a deterministic
tenant can be derived; both are better answers than a guess.

**5. Two producers, one table, and one constraint deliberately removed.** `UNIQUE("requestId")` was
dropped and replaced by a plain index, because many audit events legitimately share one request id —
folding them together was the idempotency mistake E3 names. The unique key on `auditId` is what keeps
the two producers from colliding. This is a *removal* of a database constraint, so it is called out
here rather than buried in the migration.

**6. Pre-existing lint and formatting debt** (§5.4): 12 eslint errors across the five files that carry
them — and two of those five were never touched by this phase — plus 57 prettier-flagged files across
the directories this phase worked in. All of it predates this phase and none of it is fixed here. If the
repository is ever normalised, that must be its own commit with no behaviour change — mixing it into a
seam commit is what would make this one unreviewable.

---

## 7. THE CHANGE, FILE BY FILE

**Modified — 23 tracked files (+1,274 / −134)**

| Group | Files |
|---|---|
| Core wiring (3) | `src/app.module.ts`, `src/core-app.module.ts`, `src/common/audit.service.ts` |
| Control plane (7) | `module-platform.module.ts` + spec, `module-registry.controller.ts` + spec, `module-registry.service.ts` + spec, `dto/module.dto.ts` |
| HR (11) | `hr.module.ts`, `hr-isolation.spec.ts`, `hr-application-boundaries.spec.ts`, and the four application services with their specs: `employees`, `employment`, `organization`, `positions` |
| Schema (1) | `prisma/core/schema.prisma` |
| Docs (1) | `docs/ADR/ADR-0006-ARCH-3-CROSS-RUNTIME-CONTRACTS.md` — +15 / −2: the `Status:` line now names A7, E8 **and E9** and points at this report for the two gaps, and a 15-line record is appended to the ordering section, stating what ARCH-3B made fact and, explicitly, that E9 did not. Recorded before the code, then reconciled with it. |

**New — 16 files**

| Group | Files |
|---|---|
| `src/platform/audit/` (7) | `audit.contract.ts` + spec, `platform-audit.service.ts` + spec, `audit-ingest.consumer.ts` + spec, `platform-audit.module.ts` |
| `src/platform/identity/` (5) | `identity.contract.ts`, `platform-identity.controller.ts` + spec, `platform-identity.module.ts` + spec |
| The two seam files (2) | `src/module-platform/capability-credential.resolver.ts`, `src/modules/hr/hr-audit.gateway.ts` |
| Migrations (2) | `20260917120000_add_module_capability_credential/migration.sql`, `20260918120000_add_auditlog_audit_id_tenant/migration.sql` |

Plus this report, `docs/reports/PHASE_51-HR-ARCH-3B_CLOSURE.md`.

One thing this working tree holds and this commit does not: **scratch files.** The verification captures
this phase wrote — `apps/api/tmp-*.txt`, `tmp-*.json`, `tmp-*.cmd`, `tmp-*.js` and the nine `tmp-*.txt`
gate logs at the repository root, **89 files** — were deleted once §5 was reconciled, so every number
above is reproducible from the tree rather than restorable from a leftover. The other untracked artefacts
the working copy carries (`p50r-*`, `qa-49*`, `k-jest*`, `hr-arch1-*`, `apps/web/*-shots/`,
`ERP_Structure_v*.xml`) belong to earlier phases; none of them is part of ARCH-3B and none was staged.
`git status --porcelain` for this change is the **23 modified tracked files**, the **16 new files** listed
above, and this report.

**How to review it, in the order of the dependency chain.** Read the two contracts first
(`audit.contract.ts`, `identity.contract.ts`) — they are the only files where a wire format is decided.
Then their consumers (`platform-audit.service.ts` and `audit-ingest.consumer.ts`, and
`platform-identity.controller.ts`). Then the seams that bind them: `module-platform.module.ts` for the
resolver token and its `useExisting` binding, `hr-audit.gateway.ts` as HR's only door to the trail, and
`core-app.module.ts` with `app.module.ts` for who registers what. Then the migration, read for what it
*drops* (`UNIQUE("requestId")`) and for what it leaves null (`tenantId`). The specs come last, in the
order §5.3 lists them.

**Status: complete.** 125 suites and 2,109 tests pass, `tsc --noEmit` is clean, `git diff --check` is
exit 0, and all 14 source files this phase authored pass `prettier --check`. Of the 36 parseable files
in the change, 6 are flagged — five `.ts` files for trailing commas and hand-wrapped lines, and the
ADR — and **each of the six is flagged at its `HEAD` content as well**, so §5.4 itemises them as
inherited rather than leaving a number standing. The two residual gaps — the audit publisher with its
E9 signature, and the identity client adapter — are written down in §6 rather than implied by silence.
