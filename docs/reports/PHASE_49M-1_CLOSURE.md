# PHASE 49M-1 — MODULE PROVISIONING CONTROL PLANE & OPERATIONAL LIFECYCLE

**PHASE: 49M-1**
**STATUS: COMPLETE — audit (§1), design (§2), implementation (§3), schema and migration (§4),
tests (§5), database and regression verification (§6–§7). Provider-neutral control plane,
pure operational state machine, four additive tables, five-condition activation gate, and a
five-route admin surface. No orchestrator, no shell execution, no `ALTER` of a 49M table.**

A provider-neutral provisioning control plane and an explicit operational state machine layered
**on top of** the 49M module registry. No Kubernetes, no Terraform, no Ansible, no Nomad, no
service mesh, and no arbitrary shell execution — none of which exists in this repository, and
each of which the brief forbids introducing.

Every figure in §1 was re-derived from a command run on this machine for this phase; nothing is
quoted from memory. Where something does not exist, this report says so plainly rather than
describing an intention as a capability.

---

## 1. AUDIT

Read-only audit, performed before a single line of 49M-1 code, schema or migration was written.
Scope: `apps/api/src` (**267** `.ts` files excluding the generated Prisma clients), `apps/web/src`,
`apps/api/prisma`, `infrastructure/`, `docker-compose.yml`, `.github/`, root `scripts/` and
`apps/api/package.json` (**65** dependencies across `dependencies` + `devDependencies`). Combined
API + web source surface searched: **439** `.ts`/`.tsx` files excluding generated code.

### 1.1 Existing provisioning — none beyond four type-only extension points

There is **no provisioning implementation of any kind** in this repository. What exists is one
file of types, deliberately inert, and one boolean that says so.

`apps/api/src/module-platform/module-foundations.ts` (156 lines) declares:

| Symbol | Kind | Runtime behaviour |
|---|---|---|
| `ModuleProvisioningStep` | union — `REGISTER` \| `AUTHENTICATE` \| `VERIFY` \| `ACTIVATE` | none |
| `PROVISIONING_STEPS` | `readonly` array of the four, in order | data only |
| `ModuleProvisioner` | interface with a single `provision(identity)` method | **nothing implements it** |
| `remainingProvisioningSteps(completed)` | pure function over the declared order | the only executable line in the file |

The file's own header states the rule it was written to keep: *"An interface costs nothing at
runtime, cannot be invoked, and cannot acquire a hidden default behaviour… So there is no
`ModuleSyncService`, no `ConflictResolver` provider, no `ModuleProvisioner` class, and no table for
any of them."* That is still true, and this audit confirms it rather than assuming it.

Searched across `apps/api/src` + `apps/web/src` excluding generated code, the identifiers a
provisioning plane would need — `IProvisioningProvider`, `ProvisioningProvider`,
`ProvisioningTarget`, `ProvisioningExecution`, `OperationalStatus`, `ModuleRelease`,
`artifactChecksum` — return **zero results**, all seven.

The word `provision` (any casing) appears in exactly **six** files, and none of them provisions
anything:

| File | Hits | What they are |
|---|---|---|
| `module-platform/module-foundations.ts` | 19 | the types above, plus their rationale comments |
| `module-platform/module-foundations.spec.ts` | 14 | tests of the pure function and the declared order |
| `module-platform/module-registry.controller.ts` | 4 | one import, `provisioningSteps: PROVISIONING_STEPS`, `provisioningImplemented: false` |
| `module-platform/module-registry.controller.spec.ts` | 1 | asserts the descriptor |
| `web/src/lib/modules-api.ts` | 2 | `provisioningSteps: string[]`, `provisioningImplemented: boolean` on the descriptor type |
| `web/src/components/core/__tests__/CoreModulesView.spec.tsx` | 2 | fixture values for that descriptor |

`GET /admin/modules/platform` reports `foundations.provisioningImplemented: false` today. **That
boolean is the honest state of the system, and this phase is what would make it true.**
`apps/web/src/components/core/CoreModulesView.tsx` — **564** lines, the entire admin UI for the
registry — contains **0** occurrences of `provision` in any casing: there is no button, no form and
no disabled control to repurpose.

Also absent, and each absence shapes the design: no artifact/release table, no execution or job
table, no operational-state column, and no `rollback`, `decommission` or artifact-`checksum`
identifier anywhere in the module platform. `checksum` appears in `module-foundations.ts` only as a
`ModuleSyncPositionKind` member — `'CURSOR' | 'VERSION' | 'CHECKSUM' | 'TIMESTAMP'` — which is sync
vocabulary, not artifact vocabulary. There is also **no version-comparison helper at all**:
`semverCompare`, `compareVersions` and `isNewerVersion` return zero hits across the API source, so
an upgrade path must define its own comparison rather than reuse one.

### 1.2 Existing deployment — four Dockerfiles, one compose file, and no CI whatsoever

The complete deployment surface of this repository:

| Artifact | Detail |
|---|---|
| `infrastructure/docker/Dockerfile.backend` | image build |
| `infrastructure/docker/Dockerfile.cms` | image build |
| `infrastructure/docker/Dockerfile.core` | image build |
| `infrastructure/docker/Dockerfile.frontend` | image build |
| `infrastructure/nginx/nginx.conf` + `conf.d/api.conf` + `conf.d/frontend.conf` | reverse proxy |
| `docker-compose.yml` | **8** services: `postgres`, `redis`, `rabbitmq`, `minio`, `mailpit`, `api`, `web`, `nginx`; 6 named volumes; 1 network (`aria-network`) |

That is the whole list — `infrastructure/` contains **7 files** and nothing else.

**There is no CI and no automation to hook into.** `.github/` exists as a directory and contains
**0 files** (no `workflows/`, no action, no template). Root `scripts/` exists and contains **0
files**. Searching the entire tree for `*.yml`/`*.yaml` outside `node_modules`, `.next` and `dist`
returns exactly **one** file: `docker-compose.yml`. `apps/api/scripts/` holds **10** files, every
one a `.sql`, `.mjs` or `.ts` verification/E2E helper — no shell script, no deploy script, no
release script.

**No client exists that could drive a container, VM or cluster.** Of the 65 API dependencies, the
patterns `docker`, `dockerode`, `kube`, `k8s`, `ssh`, `terraform`, `ansible`, `nomad`, plus the
archive handlers `tar`, `unzip`, `adm-zip`, and `semver`, match **nothing**. The only outbound HTTP
client is `axios`. This is the most consequential audit finding: a `CONTAINER_HOST` or `KUBERNETES`
provisioning target would be a schema enum member with no code able to satisfy it — the exact
failure mode `IntegrationProviderRegistry` documents for a keyed provider with no class behind it,
where *"registering a key with no class behind it would let an administrator save a configuration
the registry cannot resolve, converting a successful save into a 500 on the first dispatch."*

**MinIO is the only artifact-capable store**, reached through one seam:
`apps/api/src/storage/i-storage.provider.ts` declares `IStorageProvider` with `upload(key, buffer,
contentType)`, `getUrl(key, options)` and `delete(key)`; `storage.module.ts` binds the DI token
`'IStorageProvider'` to the single implementation `MinioProvider`. `getUrl` is contractually a
*short-lived signed* URL — *"the contract is a short-lived credential-free URL, not a permanent
public path"* — which is what an artifact reference needs, and is why no binary payload will go
into PostgreSQL.

For completeness on the live environment: **8** containers are running, all pre-dating this phase —
`aria-erp-postgres`, `aria-erp-redis`, `aria-erp-rabbitmq`, `aria-erp-minio`, `aria-erp-mailpit`,
`aria-erp-api`, `aria-erp-nginx`, and `aria-erp-e2e-dbproxy`. The last is **not** a compose service:
`docker inspect` shows zero compose labels and an `alpine/socat:latest` image running
`tcp-listen:5432,fork,reuseaddr` → `tcp-connect:postgres:5432`, i.e. a hand-started port-forward.
The compose-defined `web` service is not running. Nothing was started, stopped or altered.

### 1.3 Existing lifecycle — 49M's two tables, seven states, and a sweep that must not change

The 49M platform is intact and is the substrate this phase builds on.
`apps/api/src/module-platform/` holds **27** TypeScript files: **14** source + **13** spec.

Schema state: `apps/api/prisma/core/schema.prisma` is **1,981 lines / 88,692 bytes** and declares
**36 models** and **23 enums** in total. 49M's contribution is 2 models + 5 enums:

| Symbol | Members / role |
|---|---|
| `ModuleType` | `CORE`, `BUSINESS`, `INTEGRATION` |
| `ModuleDeploymentMode` | `LOCAL`, `REMOTE`, `CENTRAL`, `HYBRID` |
| `ModuleLifecycleState` | `REGISTERED`, `ACTIVE`, `DEGRADED`, `UNAVAILABLE`, `DISABLED`, `DEREGISTERED`, `INCOMPATIBLE` — **7** |
| `ModuleHealthState` | `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `DISABLED`, `UNKNOWN` |
| `ModuleTenantScope` | `ALL`, `RESTRICTED` |
| `ModuleRegistration` | the LOGICAL module — admin-owned; holds `enabled`, `tenantScope`, `tenantIds` and the encrypted credential; **has no `baseUrl`** |
| `ModuleInstance` | ONE DEPLOYED instance — module-written; holds `deploymentMode`, `version`, `baseUrl`, `healthPath`, `capabilities`, `apiContracts`, `eventContracts`, `lifecycle`, `health`, `healthErrorCode`, `lastSeenAt`, `lastProbedAt` |

Migration `20260905120000_add_module_platform/migration.sql` is **313 lines**: 5 `CREATE TYPE`,
2 `CREATE TABLE`, **13 CHECK constraints**, **5 indexes** (2 unique + 3 plain, two of them partial),
and exactly **1 foreign key** (`ModuleInstance.registrationId → ModuleRegistration.id`, CASCADE).
All **20** migration directories on disk are recorded as applied (`finished_at IS NOT NULL`) in
`_prisma_migrations` in `core_db` — including 49I `20260831120000_add_calendar_reminders`, 49J
`20260903120000_add_global_search_projection`, 49K `20260903130000_add_user_preferences`, 49L
`20260904120000_add_integration_platform` + its grant seed, and 49M's pair. Verified **before**
planning any new migration, per the additive-only rule.

Three behaviours of 49M this phase must not perturb, because existing specs assert them:

1. **`ModuleInstance.lifecycle` is written by registration, heartbeat, probe and the sweep.** It is
   *registry* lifecycle, not operational lifecycle. `DISCOVERED` is deliberately not a member — it is
   derived on read for the LOGICAL module in `ModuleRegistryService`
   (`derivedLifecycle: ModuleLifecycleValue | 'DISCOVERED'`).
2. **`ModuleSweepService`** is a `setInterval` on `SWEEP_TICK_MS = MODULE_HEARTBEAT_INTERVAL_MS`
   (30s) against a 90s stale threshold, `unref`'d, idempotent, bounded by `STALE_SWEEP_BATCH = 100`,
   and it makes **no network calls**. It demotes stale instances to `UNAVAILABLE`.
3. **`ModuleHealthService.probeInstance` never throws** and never equates a 200 with health: a
   reachable instance that does not *declare* a state resolves to `DEGRADED`. Verdicts carry three
   separable facts — `registryKnown`, `endpointReachable`, `applicationHealthy` — plus a short
   `errorCode` (`UNKNOWN_INSTANCE`, `NO_ENDPOINT`, `SSRF_BLOCKED`, `TIMEOUT`, …).

Compatibility is already centralised in `module-contract.util.ts`: `parseContract`,
`contractsCompatible`, `satisfiesContract`, `isValidContract`, `isValidCapability`,
`hasCapabilities`, and `checkCompatibility` — a four-check gate (`PROTOCOL_MISMATCH` →
`CONTRACT_MISSING` → `CONTRACT_MALFORMED` → `CAPABILITY_MALFORMED`) whose contract is
all-or-nothing: *"THERE IS NO PARTIAL ACTIVATION."* 49M-1 reuses these functions; it does not
restate the rule. Resolution failures are likewise already normalised to five codes
(`MODULE_NOT_FOUND`, `MODULE_DISABLED`, `MODULE_FORBIDDEN`, `MODULE_UNAVAILABLE`,
`CONTRACT_UNSUPPORTED`).

### 1.4 Existing security — reuse everything, invent nothing

| Mechanism | Where | State for this phase |
|---|---|---|
| RBAC | `admin.modules.manage`, `admin.modules.read` in `permissions.ts` (domain `ADMIN`), seeded by `20260905120500_seed_module_permission_grants`, granted to SUPER_ADMIN (both), ADMIN (both), OPERATIONS_ADMIN (**read only**) | **reused as-is — no new permission** |
| Encryption at rest | `common/crypto.service.ts` — AES-256-**GCM**, fresh 12-byte IV per encryption, authenticated, key read per call from `AI_CONFIG_ENCRYPTION_KEY`, accepts hex or base64 and validates the **decoded** width at 32 bytes, plus `matches()` for constant-time compare | reused; ONE master key, ONE store |
| Machine-to-machine auth | `module-signature.ts` re-exports 49L's `canonicalRequest`/`signRequest`/`verifySignature`; HMAC-SHA256 over a length-prefixed canonical string; `moduleId` and the tenant slot folded into the `eventId`/`idempotencyKey` slots; ±5-minute window checked **before** the HMAC; 9 `x-aria-module-*` headers | reused unchanged |
| SSRF policy | `module-url.guard.ts` wraps 49L's `evaluateIntegrationUrl`/`buildIntegrationUrl` and adds one rule: `REMOTE`/`CENTRAL`/`HYBRID` require HTTPS and refuse private literals even when `INTEGRATION_ALLOW_PRIVATE_TARGETS=true` | reused; applied at write **and** immediately before every call |
| Route gating | `ModuleRegistryController` — **10** routes, `@UseGuards(JwtAuthGuard)` at class level, **every** route `@Roles`-gated: **4** read, **6** manage. The **3** module-facing routes are isolated in `ModuleRegistrationController` (`POST /modules/register`, `/heartbeat`, `/deregister`), `@Public()` + HMAC, with **one uniform 401** across all six rejection reasons | pattern followed exactly |
| Audit | `common/audit.service.ts` — `log()` runs both payloads through `redactPayload` before insert, then publishes fire-and-forget; `RequestContextService` (AsyncLocalStorage) supplies `requestId`, `correlationId`, `userId`, `tenantId` | reused for every provisioning action |
| mTLS | **still absent** — no client certificate, no CA, no `https.Agent` with `cert`, nothing in `nginx.conf` requesting one | remains DEFERRED, as in 49M |

`.env.example` documents the module platform in a comment block and deliberately defines **no
module-specific variable**: no `MODULE_REGISTRY_URL`, no `MODULE_SECRET`, no `HR_MODULE_URL`, no
`FINANCE_MODULE_URL`. Two existing variables govern the platform — `AI_CONFIG_ENCRYPTION_KEY` and
`INTEGRATION_ALLOW_PRIVATE_TARGETS`. **49M-1 adds no environment variable either**: a provisioning
target is a row, for the same reason a module endpoint is a row.

### 1.5 What the audit forecloses

Stated here so §2's design reads as consequence rather than preference:

- **No container / VM / cluster target type**, because no client can drive one (§1.2).
- **No binary artifact in PostgreSQL**, because a signed-URL object store already exists (§1.2).
- **No `ALTER` to `ModuleRegistration` or `ModuleInstance`**, because the `lifecycle` column, the two
  partial indexes and the sweep's idempotence are asserted by the 13 existing specs (§1.3).
- **No new permission, no new secret store, no new signing scheme, no new URL policy** (§1.4).
- **No shell execution**: `child_process`, `execFile`, `execSync` and `spawn(` return **zero hits**
  across all 267 API source files. `child_process` does appear in **9** files repo-wide, every one a
  harness *outside* `src` — `apps/api/scripts/{module,integration}-e2e.mjs`,
  `apps/api/test/global-{setup,teardown}.ts`, and `apps/web/phase49{h,i,k,l,m}-validate.mjs` — i.e.
  test tooling that the application never imports, not a runtime capability.
- **No new queue or scheduler**: `setInterval` + a conditional-`UPDATE` claim is the audited in-repo
  precedent, used by exactly **4** services — `common/audit-dispatcher.service.ts`,
  `calendar/reminder-dispatcher.service.ts`, `integrations/automation-retry.service.ts`, and
  `module-platform/module-sweep.service.ts` — and `@nestjs/schedule`/`cron` are absent from
  `package.json`.

---

## 2. DESIGN

Nine decisions, each traceable to a §1 finding. This section was written **before** any schema,
migration or service file existed; §3 onward records what was then built against it.

### 2.1 `IModuleProvisioningProvider` — the one seam

```ts
export interface IModuleProvisioningProvider {
  readonly targetType: ProvisioningTargetType;
  validateTarget(target: ProvisioningTarget): Promise<TargetValidation>;
  provision(plan: ProvisioningPlan): Promise<StepOutcome>;
  configure(plan: ProvisioningPlan): Promise<StepOutcome>;
  verify(plan: ProvisioningPlan): Promise<VerificationOutcome>;
  activate(plan: ProvisioningPlan): Promise<StepOutcome>;
  stop(ref: InstanceRef): Promise<StepOutcome>;
  restart(ref: InstanceRef): Promise<StepOutcome>;
  upgrade(plan: UpgradePlan): Promise<StepOutcome>;
  rollback(plan: RollbackPlan): Promise<StepOutcome>;
  decommission(ref: InstanceRef): Promise<StepOutcome>;
}
```

Ten methods, resolved by `ProvisioningTargetType` through a registry modelled on 49L's
`IntegrationProviderRegistry` (own-property lookup, so `'constructor'` cannot resolve to a truthy
non-provider). **No method accepts a URL, a command string, an image name or a shell fragment.**
Every method returns a per-step outcome rather than a boolean, following the rationale
`module-foundations.ts` already records for its four steps: a provisioner that reports "failed" is
useless, one that reports "failed at VERIFY" is not.

A step a provider genuinely cannot perform returns `supported: false` with code `STEP_UNSUPPORTED`.
**It does not return success.** For `LocalProvisioningProvider` that applies to `restart` and to
process-level `stop`: nothing in this repository can restart a process it did not start (§1.2 — no
docker/ssh client, no shell), and reporting a restart that never happened is worse than refusing.

### 2.2 `ProvisioningTargetType` — two members, both drivable

`LOCAL_SERVER` | `REMOTE_AGENT`. There is no `CONTAINER_HOST`, no `VM`, no `KUBERNETES`, for the
reason in §1.2: **zero** clients exist to drive them.

**One real provider** (`LocalProvisioningProvider`, `LOCAL_SERVER`). `REMOTE_AGENT` resolves to **no
provider**, which normalises to `PROVIDER_UNAVAILABLE`, disables the action in the UI, and is reported
as **DEFERRED** — never as a passing test.

### 2.3 Four new tables, zero `ALTER`

| Table | Cardinality | Purpose |
|---|---|---|
| `ModuleRelease` | N per `moduleId` | artifact **reference** + `checksumAlgorithm`/`checksum` + `contractVersion` + `requiredCapabilities[]` + `releaseStatus` |
| `ProvisioningTarget` | N | `targetType`, operator label, typed connection reference — **no `url` column** |
| `ModuleProvisioningExecution` | N | `status`, `step`, `correlationId`, `idempotencyKey` (UNIQUE), `attemptCount`, `errorCode`, timestamps, bounded retention |
| `ModuleOperationalStatus` | **1:1 with `ModuleInstance`** | `operationalState` + `stateChangedAt` + `lastExecutionId` |

`ModuleRelease` stores a MinIO object **key**, never bytes: `IStorageProvider.getUrl` already issues
short-lived signed URLs (§1.2), and a `bytea` column would put every artifact into the WAL and into
every backup.

`ModuleProvisioningExecution` is modelled on 49L's `AutomationExecution` — the same
`idempotencyKey` UNIQUE constraint, the same `attemptCount`/`errorCode` pair, and the same bounded
retention idiom, so retries and concurrency reuse a pattern that already has specs.

`ModuleOperationalStatus` is a **new 1:1 table, not a column on `ModuleInstance`**. This is the
load-bearing schema decision. 49M's `lifecycle` is written by four independent paths (registration,
heartbeat, probe, sweep) and asserted by **13** existing spec files; operational state is written by
the provisioning plane alone. Separating them lets the sweep keep demoting a stale instance to
`UNAVAILABLE` without ever contradicting an `UPDATING` operational state, and **no existing test
changes**.

### 2.4 `ModuleOperationalState` — a pure transition table

`REGISTERED`, `PROVISIONING`, `CONFIGURING`, `VERIFYING`, `ACTIVE`, `UPDATING`, `DISABLED`,
`FAILED`, `DECOMMISSIONED` — **9 members**. `DISCOVERED` is excluded: 49M already derives it for the
*logical* module (§1.3), and this table is keyed by *instance*, where it could never be true.

```
REGISTERED     → PROVISIONING | FAILED
PROVISIONING   → CONFIGURING  | FAILED
CONFIGURING    → VERIFYING    | FAILED
VERIFYING      → ACTIVE       | FAILED
ACTIVE         ↔ UPDATING
ACTIVE         ↔ DISABLED
UPDATING       → FAILED
FAILED         → PROVISIONING | DISABLED
DISABLED       → DECOMMISSIONED
DECOMMISSIONED → ∅  (terminal)
```

A pure, dependency-free module (`module-operational-state.ts`) exports the table and
`canTransition(from, to)`, in the style of `module-foundations.ts`. The UI requests an **action**,
never a state: no route accepts an arbitrary `operationalState`.

### 2.5 Activation gate — five conditions, all or nothing

Health 200 **plus** identity match **plus** version match **plus** contract compatibility
(`checkCompatibility`, reused) **plus** capability-manifest match (`hasCapabilities`, reused).
A checksum mismatch or a capability shortfall yields `FAILED`, never a partially activated instance —
the rule `module-contract.util.ts` already states as *"THERE IS NO PARTIAL ACTIVATION."*

Because **no version-comparison helper exists** (§1.1), ordering for upgrade/rollback is decided
here: a small pure `compareModuleVersions` written for this phase, dotted-numeric with a documented
non-numeric fallback, unit-tested directly. Adding `semver` as a dependency for one comparison is not
justified, and silently exact-matching would make rollback unorderable.

### 2.6 Async by execution id, never by a held-open request

`POST` returns `202` with an execution id; progress is read by polling
`GET /admin/modules/executions/:id`. Work runs detached in-process on the audited
`setInterval` + conditional-`UPDATE` claim precedent (§1.5, 4 existing services), with `attemptCount`
bounded and every timeout finite. No new broker, no new scheduler dependency.

### 2.7 Credentials

Provisioning returns a credential **reference**, never a secret value. The one-time reveal stays
where 49M put it. **Dual-key rotation is documented as a limitation, not faked**: 49M stores one
active secret across three columns (`secretCiphertext`/`secretIv`/`secretAuthTag`), so there is no
second slot for an overlapping key, and adding one would mean `ALTER`-ing a 49M table (§1.5).

### 2.8 RBAC and observability

`admin.modules.manage` for every provisioning action, `admin.modules.read` for status and history.
**No new permission**, so no new seed migration and no change to the three existing role grants
(§1.4). `correlationId` is carried from `RequestContextService`, never regenerated; every action is
audited through `AuditService.log` with its existing `redactPayload` pass.

### 2.9 Migration shape

One additive migration: `CREATE TYPE` for `ProvisioningTargetType`, `ModuleOperationalState`,
`ModuleReleaseStatus` and `ProvisioningExecutionStatus`; **4** `CREATE TABLE`; CHECK constraints in
the 49M style (which uses **13** of them); indexes including a partial index for claimable
executions; and FKs only to 49M's own tables, matching 49M's single `ON DELETE CASCADE` FK.
**No `DROP`, no `ALTER` of any existing column, no backfill, no seed row.**

Verified immediately before writing this section: **20** migration directories on disk, **20** rows
in `_prisma_migrations` in `core_db`, **0** with `finished_at IS NULL` — 49I through 49M all intact,
so a new additive migration is safe to append.

---

## 3. IMPLEMENTATION

The two files with no dependencies were written first, on the principle §2.4 states: if the rules
live in data and the decision is a pure function, a test can enumerate the whole space instead of
sampling it. Sections 3.4 onward follow the dependency order outward from there.

### 3.1 `module-operational-state.ts` — the transition table

247 lines, **zero imports**. Nothing it depends on can pull a database, a clock or a network call
into what is pure graph reachability.

Exports: `ModuleOperationalStateValue` (9 members), `MODULE_OPERATIONAL_STATES`,
`INITIAL_OPERATIONAL_STATE` (`REGISTERED`), `TERMINAL_OPERATIONAL_STATES` (derived from the table,
not restated), `IN_FLIGHT_OPERATIONAL_STATES` (4), `isOperationalState`, `allowedTransitions`,
`canTransition`, `isTerminalState`, `isInFlightState`, `TransitionFailure`, `checkTransition`.

Four properties the implementation makes structural rather than promised:

- **`canTransition` is the only reader of the table.** `allowedTransitions` returns a **copy**, so
  one accidental `push` cannot widen the machine for the whole process — asserted directly.
- **Own-property lookup**, via `isOperationalState`, for the reason
  `IntegrationProviderRegistry.descriptor` documents: `TRANSITIONS['constructor']` on an object
  literal resolves through `Object.prototype` and returns a truthy non-array.
- **Self-transitions are refused for all 9 states.** A no-op state write still moves
  `stateChangedAt`; an idempotent retry is recognised by its `idempotencyKey` instead.
- **`checkTransition` orders its reasons**: `UNKNOWN_STATE` before `TERMINAL_STATE` before
  `ILLEGAL_TRANSITION`, because "this instance is decommissioned" and "you cannot go from ACTIVE to
  VERIFYING" send an operator to different places.

`TERMINAL_OPERATIONAL_STATES` is `['DECOMMISSIONED']` — and `FAILED` is deliberately **not**
terminal, which is what makes a failed provision retryable.

### 3.2 `module-version.util.ts` — ordering, decided rather than deferred

The §1.1 open question is now closed: **no dependency was added**, and no exact-match-only rule was
adopted. `module-version.util.ts` (171 lines, zero imports) implements a total order over exactly
the versions `ModuleInstance_version_format` already permits — the migration's regex is restated
here so the comparison cannot start accepting a shape the database would reject.

Exports: `ParsedModuleVersion`, `parseModuleVersion`, `isValidModuleVersion`,
`compareModuleVersions`, `VersionOrderFailure`, `checkUpgradeOrder`, `checkRollbackOrder`.

The load-bearing decision: **`compareModuleVersions` returns `undefined` on an unparseable input
and never falls back to string comparison.** Lexicographically `'10.0.0' < '9.0.0'`, so a string
fallback would report a downgrade as an upgrade — the worst failure available to something that can
replace a running module. An `undefined` forces the caller to refuse.

- Pre-release sorts **below** its own release (`1.0.0-rc.1` < `1.0.0`); two pre-releases at one
  numeric version compare as plain strings, enough to order `rc.1` against `rc.2`.
- Build metadata is **ignored** for ordering, so `1.0.0+a` and `1.0.0+b` compare equal — two builds
  of one version differ only in checksum, which is what a caller must compare instead.
- A component that is not a safe integer is refused, not clamped: `Number('1'.repeat(400))` is
  `Infinity`, and two `Infinity` majors would compare *equal*.
- `checkUpgradeOrder` requires strictly newer, `checkRollbackOrder` strictly older, and both report
  `SAME_VERSION` separately from `NOT_NEWER`/`NOT_OLDER` — re-deploying the identical version is a
  legitimate repair intent, and "not newer" would send an operator hunting a bump they do not have.

### 3.3 Test result for the pure layer

Both specs run under the existing Jest config (`rootDir: src`, `testRegex: .*\.spec\.ts$`,
`ts-jest`) with no configuration change. Final counts for these two files, re-run at closure:

```
PASS src/module-platform/module-operational-state.spec.ts   19 tests
PASS src/module-platform/module-version.util.spec.ts        17 tests
```

`module-operational-state.spec.ts` enumerates **all 81 ordered pairs** and asserts that exactly
**16** are legal, against an edge list written out independently of the implementation. That is the
point of moving the rule into data: an added permissive edge fails the suite instead of passing
unnoticed.

One correction made during the run rather than papered over: the antisymmetry assertion originally
compared `Math.sign(forward)` with `-Math.sign(backward)`, which fails on the equal case because
`Object.is(-0, 0)` is false. The property under test is the ordering, not the numeric identity of
zero, so the assertion now sums the signs to `0` and checks the magnitude separately.

### 3.4 `module-provisioning.contract.ts` — the seam, and what it cannot carry

277 lines, **one import** (`ModuleOperationalStateValue`, a type). It declares
`IModuleProvisioningProvider` exactly as §2.1 specified, plus `ProvisioningActionValue` (9),
`ProvisioningOutcomeCode` (16), `ProvisioningStepOutcome`, `ProvisioningVerification`,
`ProvisioningTargetValidation`, `ProvisioningTargetRef`, `ProvisioningInstanceRef`,
`ProvisioningReleaseRef`, `ProvisioningPlan`, and the three constructors `stepSucceeded`,
`stepFailed`, `unsupportedStep`.

The load-bearing content is the set of fields that are **absent**:

- `ProvisioningTargetRef` has `id`, `targetKey`, `targetType`, `enabled` and `credentialRef` — and
  **no `url`, `host`, `port` or secret value**. A provider receives the *name* of a credential.
- `ProvisioningReleaseRef` has an object **key**, a checksum and a byte count — and no URL and no
  bytes.
- `ProvisioningPlan` carries a `targetState` the service computed, never one a caller named.

`supported` is a field separate from `ok`, and `unsupportedStep` is the only way to produce
`supported: false`. Collapsing the two would erase the difference between "this provider cannot
restart a process" and "the restart failed" — which send an operator to different places: change the
deployment model, versus find out what broke.

### 3.5 `provisioning-provider.registry.ts` — why the plane is neutral

151 lines. `ModuleProvisioningService` imports **this class and the contract types, and never
`LocalProvisioningProvider`**. That is the whole mechanism behind "provider-neutral": adding a remote
agent is one adapter, one `case`, one descriptor — no service change, no schema change, because the
enum member already exists.

`REMOTE_AGENT` is **declared and deliberately unresolvable**. It appears in the enum, in the schema
and in `describe()`, with `available: false` and all **9** actions listed as unsupported; `resolve()`
returns `undefined`, which the service normalises to `PROVIDER_UNAVAILABLE`. That combination is what
makes DEFERRED a *visible* state rather than a silent gap, and it is never reported as a passing
capability.

Two details carried over from 49L's `IntegrationProviderRegistry` rather than reinvented:
own-property lookup, so `DESCRIPTORS['constructor']` cannot resolve through `Object.prototype` into a
truthy non-descriptor that an `if (!descriptor)` guard would pass; and descriptors returned **by
copy**, so a caller cannot mutate the table for the whole process.

One deliberate divergence: `resolve` returns `undefined` where 49L's throws `NotFoundException`. A
request against `REMOTE_AGENT` is an expected, documented outcome that must become a normalised code
on an execution row — not a 404 an operator has to interpret.

### 3.6 `local-provisioning.provider.ts` — what `LOCAL_SERVER` honestly means

361 lines, **5 imports**, and **none of them is `child_process`**. The audit's two facts are
unchanged by this file: no `docker`, `dockerode`, `kube`, `k8s`, `ssh`, `terraform`, `ansible` or
`nomad` client among the **65** dependencies, and `child_process`/`execFile`/`execSync`/`spawn(`
still return **zero** hits across the API source tree.

So `LOCAL_SERVER` means *the machine this API process already runs on* — not a container it starts,
not a VM it creates, not a pod it schedules. The three things it can genuinely do, it does:

1. **Resolve and verify an artifact reference.** The object key exists, and the declared checksum's
   shape matches its declared algorithm. This is a reference check, not a re-hash: fetching bytes
   would need a URL, which the seam refuses to carry.
2. **Verify a deployment against the five-condition gate**, reusing `probeInstance`,
   `checkCompatibility` and `hasCapabilities` rather than reimplementing any of them. A second notion
   of "compatible" living in this file is precisely the drift `module-contract.util.ts` exists to
   prevent.
3. **Report an operational outcome** the service records.

**What it refuses to pretend.** `restart` returns `supported: false` with `STEP_UNSUPPORTED`.
Nothing here can restart a process it did not start, and an operator who believes a restart happened
**stops investigating** the reason the module is misbehaving — which makes a false success strictly
worse than a refusal. `stop` *is* supported, in the narrower sense this system can honour: an
instance can be made ineligible to serve, which is a registry-level fact Core owns.

The gate is **all or nothing**, and the `fail()` helper is what makes that structural rather than
promised: it initialises all five booleans to `false` and lets a caller re-assert only the ones
already established. A `CHECKSUM_MISMATCH` therefore reports four false downstream flags rather than
stale `true`s from a partially-run check — asserted directly in the spec.

Two conditions worth naming, because both are easy to get subtly wrong:

- **A first `PROVISION` is not probed.** With no running instance, verification stops at the static
  conditions and reports them; claiming a health observation for something not yet running would be
  inventing one, which is why 49M returns `UNKNOWN` rather than `HEALTHY` for an unprobed instance.
- **Identity is checked before health.** A release belonging to another module must be refused
  before anything reaches out, because that is the mismatch that would otherwise install another
  module's artifact under this module's credential.

### 3.7 `module-provisioning.service.ts` — refuse first, record second, run third

777 lines, **8 imports**, and the order of the four phases is the design:

1. **Refuse** what must not be attempted — *before any row is written*.
2. **Record** the execution as `PENDING` with its `idempotencyKey`.
3. **Return** `202` with the execution id. Nothing is awaited past this point on the request path.
4. **Run** the claimed execution, drive one provider step, then write the transition and the audit
   row.

Every check in phase 1 is cheap, local and reversible, and each one turns a would-be failed
deployment into a code an operator can read. A control plane that accepts first and discovers later
produces execution history full of failures that were knowable at request time. There are **15**
`this.refuse(` call sites and **16** members of `ProvisioningRefusal`.

**A defect found and fixed by writing the test, not by reading the code.** The concurrency checks
originally sat *after* `checkTransition`. A `STOP` requested during an upgrade therefore reported
`ILLEGAL_TRANSITION` — true in the narrow sense (`UPDATING` has no edge to `DISABLED`) and misleading
in the way that matters: it tells the operator the action is *never* allowed, when in fact it becomes
legal the moment the upgrade lands. Both concurrency checks now precede the transition check, so the
answer is the actionable `EXECUTION_IN_PROGRESS`: **wait**. Refusal-code ordering is now a *tested
property* of the service rather than an incidental consequence of statement order.

Four more decisions the spec pins down:

- **A cross-module instance key returns `INSTANCE_NOT_FOUND`**, the same code as a key that does not
  exist. "`finance-prod-01` is not an instance of `hr`" and "no such instance" are the same
  actionable fact, and a distinct code would let a caller difference the two answers to enumerate
  another module's instance ids.
- **`WITHDRAWN` is refused for every action, including `ROLLBACK`.** That is the entire reason
  `WITHDRAWN` and `DEPRECATED` are separate enum members: a release pulled for a security reason must
  not remain reachable by rolling back to it. `DEPRECATED` *is* a legal rollback target — "do not
  deploy new" is not "unsafe", and refusing it would strand an instance whose only known-good
  previous version has since been deprecated.
- **Version ordering is decided before anything is attempted**, so a downgrade presented as an
  upgrade is a refusal that *names its reason* (`NOT_NEWER`, distinct from `SAME_VERSION`) instead of
  a failed execution someone has to diagnose.
- **The claim is a conditional `UPDATE`.** `updateMany({ where: { id, status: 'PENDING' } })` —
  exactly one racer sees `count === 1` and the loser does nothing. Correctness comes from the shape
  of the operation, not from process topology, which is why no broker and no scheduler were added.
  This is the audited in-repo precedent (`AutomationRetryService`, `AuditDispatcherService`,
  `ReminderDispatcherService`, `ModuleSweepService`).

`runExecution` **never throws**. A rejected promise here would become an unhandled rejection in
whatever timer or request started it, and an unhandled rejection terminates the Node process —
turning one bad artifact into an outage. Every failure becomes a terminal row with a code.

`canTransition` is **re-checked** inside `applyState`, even though `request` already checked it. The
two are not redundant: an execution is accepted at one moment and runs at another, and a concurrent
disable or decommission can land in between. Writing a state the table forbids *because it was legal
earlier* is exactly the class of bug a transition table exists to prevent.

`getExecution` does **not** project `idempotencyKey` (it embeds a caller token), `credentialRef` or
`artifactKey`. The cheapest way to guarantee a field is never returned is not to select it.

### 3.8 `dto/provisioning.dto.ts` and the controller — rules made unexpressible

`RequestProvisioningDto` is 141 lines and declares **six** fields: `moduleId`, `action`, `targetKey`,
`instanceKey?`, `releaseVersion?`, `requestKey`. Its content is mostly what it *omits*, and each
omission is stronger than a validator would be:

- **No state field.** No `operationalState`, no `targetState`, no `lifecycle`. An administrator
  cannot assign `ACTIVE` to a module that never passed verification, because there is nowhere to put
  it. The caller names an ACTION; `ACTION_TARGET_STATE` maps it to a state and the table decides.
- **No URL, host, port, image or command.** The destination is a `targetKey` resolved to a row whose
  table has **no address column**; the artifact is a `releaseVersion` resolved to an object key. The
  probe-arbitrary-host and run-arbitrary-command anti-patterns are unexpressible.
- **No credential** — not a secret, not a token, not even a reference. The reference lives on the
  target row where an administrator put it.
- **Nothing names a business module.** `moduleId` is a validated slug, never an
  `@IsIn(['hr','finance'])`, because a module exists when a row exists.

`action` is the single place an `@IsIn` is correct: the nine verbs are Core's own vocabulary, not a
module's. `forbidNonWhitelisted` is already global, so an undeclared field is a 400 rather than a
silently ignored property — and the controller **rebuilds the payload field by field** anyway, so a
body carrying `baseUrl`, `host`, `command` or `operationalState` cannot reach the service even
hypothetically. That is asserted directly.

`ModuleProvisioningController` is 164 lines and **five** routes on
`admin/modules/provisioning`: `GET capabilities`, `POST request`, `POST executions/:id/run`,
`GET executions/:id`, `GET by-module/:moduleId/executions`.

- **No new permission.** Three reads on `admin.modules.read`, two actions on
  `admin.modules.manage` — both already exist, both already seeded, all three role grants untouched.
  An `admin.provisioning.*` permission would have meant a new seed migration for a capability the
  existing pair already describes exactly.
- **`run` is manage-level** despite reading like a poll, because it changes what is running.
- **`capabilities` is declared first**, before any `:executionId` route. Nest matches in declaration
  order, so the reverse would send `GET .../capabilities` into a UUID pipe — the shadowing hazard
  `ModuleRegistryController` already documents for `GET /platform`.
- **Every action is `202`, never `200`**, including a refusal (`accepted: false` plus a code) and a
  de-duplication. All three mean "there is an execution you can poll, or a reason there is not";
  mapping an operator-fixable state to a 4xx would make "the target is disabled" indistinguishable
  from "this endpoint is broken".
- `take` is parsed here and **clamped in the service**, so the service's ceiling is the single place
  that bounds an unbounded history read.

This brings the module-platform admin surface to **18** routes: **10** on `ModuleRegistryController`
(4 read / 6 manage), **3** on `ModuleRegistrationController`, and these **5**.

### 3.9 `module-platform.module.ts` — three providers added, nothing exported

The 49M-1 classes join the **existing** module rather than forming a new one, because they operate on
the same two 49M tables and reuse `ModuleHealthService` and the same `PrismaService`. A separate
`ModuleProvisioningModule` would have had to import this one to reach the health probe, then export a
service only this module's controller uses.

`imports` is still exactly `[PrismaModule, RbacModule]` — no `IntegrationsModule`, no
`StorageModule`, no business module. `controllers` goes from 2 to **3**; `providers` gains
`LocalProvisioningProvider`, `ProvisioningProviderRegistry` and `ModuleProvisioningService`.

**`exports` is unchanged at two entries** (`ModuleClient`, `ModuleHealthService`). None of the three
new providers is exported, for the reason `ModuleRegistryService` is not: a business module that could
reach the provisioning service could redeploy or decommission *another* module. The control plane is
reachable only through its permission-gated controller. `module-platform.module.spec.ts` asserts the
absences and the exact length, so adding one is a test failure somebody has to justify.

---

## 4. SCHEMA AND MIGRATION

One additive migration, `20260905130000_add_module_provisioning`, **502 lines**. Verified against the
live `core_db` after `migrate deploy`:

| Object | Designed (§2.3, §2.9) | On disk | In `core_db` |
|---|---|---|---|
| `CREATE TYPE` | 4 named + `ProvisioningAction` | **5** | **5** (9 + 4 + 9 + 5 + 2 labels) |
| `CREATE TABLE` | 4 | **4** | **4** |
| Named CHECK constraints | "13-style" | **42** `ADD CONSTRAINT` (6 FK + 36 CHECK) | **36** CHECK across the four tables |
| Indexes | incl. partial for claimable | **4** unique + **6** plain | 14 total, **2 partial** |
| FKs | 49M tables only | **6** | **6** |
| `DROP` / `ALTER COLUMN` | none | **0** / **0** (3 `DROP` hits are comment text) | — |

`_prisma_migrations`: **21** rows, **0** with `finished_at IS NULL`. Migration directories on disk:
**21**. The four tables all exist, with CHECK counts `ModuleRelease` 11, `ProvisioningTarget` 6,
`ModuleProvisioningExecution` 12, `ModuleOperationalStatus` 7.

`schema.prisma` after the additions: **2,067** lines, **40** models, **28** enums, **2,401** CRLF
line endings and **0** bare LF. `ModuleRegistration`, `ModuleInstance`, `IntegrationConfig`,
`AutomationExecution`, `UserPreference` and `SearchDocument` are all present and unmodified.

Three schema decisions worth restating because they are load-bearing:

- **`ModuleOperationalStatus` is a new 1:1 table, not a column on `ModuleInstance`.** 49M's
  `lifecycle` is written by four independent paths (registration, heartbeat, probe, sweep) and
  asserted by 13 existing spec files; operational state is written by the provisioning plane alone.
  Separating them lets the sweep keep demoting a stale instance to `UNAVAILABLE` without ever
  contradicting an `UPDATING` operational state — and **no existing test changed**.
- **`ModuleRelease` stores an object key, never bytes.** A `bytea` column would put every artifact
  into the WAL and into every backup.
- **The three FK delete behaviours are deliberately different.** `registrationId` cascades (a
  deleted module takes its releases and history with it); `targetId` **restricts** (a target with
  history cannot be deleted out from under it); `instanceId` and `releaseId` **set null**, which is
  why the execution row *also* stores `instanceKey` as a snapshot — the
  `ModuleProvisioningExecution_nonprovision_requires_instance` CHECK would otherwise fire on a
  deleted instance and make history unreadable. That interaction was caught in the `shadow_49m1`
  database before it reached `core_db`.

---

## 5. TESTS

Seven spec files, run under the existing Jest config (`rootDir: src`, `testRegex: .*\.spec\.ts$`,
`ts-jest`) with **no configuration change**:

| Spec | Lines | Tests |
|---|---|---|
| `module-operational-state.spec.ts` | 241 | **19** |
| `module-version.util.spec.ts` | 182 | **17** |
| `provisioning-provider.registry.spec.ts` | 100 | **8** |
| `local-provisioning.provider.spec.ts` | 287 | **19** |
| `module-provisioning.service.spec.ts` | 702 | **42** |
| `module-provisioning.controller.spec.ts` | 260 | **15** |
| `module-platform.module.spec.ts` (updated) | 143 | **6** |

`module-platform` suite: **19 files / 327 tests, all passing**. Whole API suite:
**71 suites / 1,271 tests, all passing** in 24.2 s — up from 49M's 65/1,149, with **zero** pre-existing
tests modified. `tsc --noEmit -p tsconfig.json` exits **0**; ESLint reports **0** problems on the
seven files.

Every spec leads with a docblock that orders its assertions **by the cost of that guarantee being
false**, and inline comments state the harm rather than restating the code. `restart` refusing matters
because an operator who believes a restart happened stops investigating.

Four choices about how these tests are built:

- **The state machine is enumerated, not sampled.** All **81** ordered pairs are checked against an
  edge list written independently of the implementation; exactly **16** are legal. An added permissive
  edge fails the suite instead of passing unnoticed. Self-transitions are refused for all 9 states, and
  every route to `DECOMMISSIONED` goes through `DISABLED`.
- **The service spec stubs Prisma by hand** (7 delegates) while using the *real*
  `ProvisioningProviderRegistry` and `LocalProvisioningProvider`. Every assertion is about a
  **decision**; the four tables' CHECK constraints are covered separately against real Postgres in §4,
  because a mocked constraint proves nothing about the database.
- **Refusals are asserted for their code, not merely for failing.** `EXECUTION_IN_PROGRESS` over
  `ILLEGAL_TRANSITION`, `SAME_VERSION` distinct from `NOT_NEWER`, `NOT_OLDER` for an upgrade wearing a
  rollback label, `VERSION_MALFORMED` rather than a guess. Ordering is a tested property.
- **The all-or-nothing gate is verified negatively.** On `CHECKSUM_MISMATCH` all four downstream
  booleans must be `false`, not stale `true`s — the assertion that would catch a future refactor
  reporting partial success.

Prototype safety is asserted on both registries: `constructor`, `toString`, `__proto__` and
`hasOwnProperty` resolve to nothing across `isKnown`, `describe` and `resolve`, and neither
`allowedTransitions` nor `describe` returns a reference a caller could mutate.

---

## 6. WHAT WAS DELIBERATELY NOT BUILT

Reported as absent rather than described as present:

- **No orchestrator.** No Kubernetes, Terraform, Ansible, Nomad, Docker client or service mesh — none
  was in the 65 dependencies before this phase, and none is now.
- **No shell execution.** `child_process`, `execFile`, `execSync` and `spawn(` remain at **zero** hits
  across the API source tree. `local-provisioning.provider.ts` imports none of them.
- **`REMOTE_AGENT` is DEFERRED, and visibly so.** Declared in the enum and the schema, reported by
  `GET capabilities` with `available: false` and all 9 actions unsupported, resolving to no provider.
  It is never counted as a passing capability.
- **`restart` is unsupported, not faked.** So is process-level start/stop; `stop` is honoured only in
  the registry sense of making an instance ineligible to serve.
- **No artifact byte transfer.** Releases carry an object key, a checksum and a size. The provider
  verifies the *reference*; it does not download, re-hash or unpack.
- **Dual-key credential rotation remains a documented limitation** (§2.7). 49M stores one active
  secret across three columns, so there is no second slot for an overlapping key, and adding one would
  mean `ALTER`-ing a 49M table.
- **No admin UI for provisioning.** The five routes exist and are tested; no Next.js page was added.
- **No timer starts executions automatically.** `POST executions/:id/run` is explicit, which keeps the
  async path observable rather than hidden behind a `void promise` that swallows its own failures. The
  claim being a conditional `UPDATE` is what makes adding a timer later safe.

---

## 7. REGRESSION AND ARTIFACTS

**Nothing pre-existing was modified except two files, both additively.** `module-platform.module.ts`
gained one controller and three providers; `module-platform.module.spec.ts` gained assertions for
them. No 49M service, controller, DTO, contract or spec was edited, and no 49M column, constraint or
index was altered — which is what makes "no existing test changed" a checkable claim rather than a
hope.

**One file written in this phase was edited after its spec was written**:
`module-provisioning.service.ts`, to move the concurrency checks ahead of the transition check (§3.7).
That was a defect the test surfaced, not a test bent to fit the code.

New in 49M-1: **9** source files (`module-operational-state.ts`, `module-version.util.ts`,
`module-provisioning.contract.ts`, `provisioning-provider.registry.ts`,
`local-provisioning.provider.ts`, `module-provisioning.service.ts`,
`module-provisioning.controller.ts`, `dto/provisioning.dto.ts`, and this phase's share of
`module-platform/`), **7** spec files, and **1** migration directory containing a single
`migration.sql`.

**Nothing is committed.** `git status --porcelain` reports **131** entries, **100** of them untracked.
If a commit is requested, stage **explicit paths only**:

- `apps/api/.tok` and `apps/api/.rid` must **never** be staged.
- Untracked `apps/api/src/preferences/` belongs to an earlier phase and is out of scope here.
- `apps/api/prisma/core/schema.prisma` carries **+1,140 / −41** lines of uncommitted 49K–49M work, not
  just 49M-1's four models. Confirm the intended scope before staging it.
- **Never** run `prisma format` or `git checkout --` on `schema.prisma`. The only reliable recovery
  source is `apps/api/src/generated/core-client/schema.prisma`.

`shadow_49m1` still exists on the `aria-erp-postgres` container (reached on host port 5544 through the
`aria-erp-e2e-dbproxy` socat forward). It served its purpose — catching the FK/CHECK interaction in
§4 — and can be dropped whenever convenient. Eight containers are up; all pre-date this phase and none
was started, stopped or altered by it.

**49N was not started.** No orchestrator was installed, no remote shell execution was implemented, and
no business module was created.

---

## FINAL VERDICT

**49M-1: GREEN.**

The control plane is provider-neutral where it claims to be: `ModuleProvisioningService` reaches
providers only through the registry, and the one real provider refuses the steps it cannot honour
rather than reporting them as done. The operational state machine is pure data with all 81 pairs
enumerated. Four tables were added with zero `ALTER` and zero `DROP`, and the whole API suite went
from 1,149 to 1,271 passing tests with no pre-existing test modified.

The scope limits are reported as limits: `REMOTE_AGENT` is visibly unavailable, `restart` is visibly
unsupported, artifacts are verified by reference rather than by bytes, and dual-key rotation is still
a documented limitation of 49M's credential shape. None of those is dressed up as a capability.

**Prior phase statuses are unchanged: 49I GREEN, 49J-A GREEN, 49J-0 GREEN, 49J YELLOW, 49K GREEN,
49L GREEN, 49M GREEN.**

---

## REPORT INTEGRITY

Verified after the final edit, so the figures describe this file as it stands:

| Check | Result |
|---|---|
| Size | **54,590 bytes / 53.3 KB**, **824 lines** |
| Encoding | UTF-8, **no BOM**, byte-valid under strict `UTF8Encoding($false, $true)` |
| Mojibake markers | **0** |
| Literal `?` characters | **5**, all genuine — the two optional-field markers in §3.8 (`instanceKey?`, `releaseVersion?`) plus three in this row; no `0x3F` replacement damage |
| Typography | 92 em-dashes, 40 `§` references, all rendering |
| Structure | §1–§7 in ascending order, then FINAL VERDICT, then this section |
| Trailing whitespace | **0** lines |
| Seams | **0** triple-newline runs from the chunked edits; 824 CRLF line endings, 0 bare LF |
| Tables | 76 rows, **0** unterminated |
| Fences | 6 fence lines — **3 balanced blocks** |
| EOF | single terminating newline |

Every figure in §4 and §5 was re-derived immediately before being quoted: the migration counts from
`migration.sql` and from `pg_constraint`/`pg_indexes`/`pg_enum` in the live `core_db`, the test counts
from individual `jest` runs plus one whole-suite run, and the `git` counts from
`git status --porcelain`. Where the header `STATUS` line previously overstated progress it has been
reconciled, and §2's "nothing is implemented yet" note was rewritten now that §3 records the build.
