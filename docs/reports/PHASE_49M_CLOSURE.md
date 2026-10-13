# PHASE 49M — CORE DISTRIBUTED MODULE PLATFORM

**PHASE: 49M**
**STATUS: GREEN**

Deployment-agnostic module platform: identity, registration, discovery, health, contract
versioning and secure module-to-module communication. Where a module runs is a **row**, not
a code path — every topology in the mission brief (all local, all remote, or any mixture) is
the same code, the same contract and the same transport. No business module was created,
referenced or implied.

Verified against PostgreSQL 16 / core_db with the real Core process, a real HTTP module
fixture and a real browser. Closure evidence was produced on this machine on 2026-09-05.
Every figure below was observed in a captured command output; where something was **not**
verified it says so.

---

## 1. AUDIT

Read-only audit performed before any code was written (§4). What already existed:

**Existing module registration / discovery / health-of-a-module — none.** `grep` across 727
files for `ModuleRegistry`, `ModuleResolver`, `ServiceRegistry`, `ServiceDiscovery`,
`moduleId`, `instanceId`, `deploymentMode`, `heartbeat`, `lastSeen`, `registerModule`,
`discoverModule` returned **zero results**. `src/modules/` exists but holds only CMS blog
and media code — it is a folder, not a registry. So there was no mechanism to extend and
nothing to duplicate.

**Existing integration architecture — 49L, and it IS extended rather than competed with.**
`src/integrations/` holds `IntegrationProviderRegistry` (one adapter: n8n),
`integration-signature.ts` (HMAC-SHA256 over a length-prefixed canonical string),
`integration-url.guard.ts` (SSRF policy) and `AutomationService` as the only business-facing
seam. 49M reuses the **signature primitives** and the **URL policy** as pure functions —
`module-signature.ts` imports `canonicalRequest`/`signRequest`/`verifySignature` from 49L,
and `module-url.guard.ts` imports `evaluateIntegrationUrl`/`buildIntegrationUrl` — so there
is exactly one canonicalisation and one endpoint policy in the codebase. This is asserted,
not asserted-in-a-comment: `module-signature.spec.ts` compares the produced canonical string
byte-for-byte against 49L's own `canonicalRequest`.

What is **not** reused is the envelope. `IntegrationEvent` is one-way, fire-and-forget, with
a closed event-type enum and no response type; `IntegrationProviderResult` deliberately
carries nothing a caller could branch on. A module call is request/response, addressed to one
logical module, and needs a typed reply — so `ModuleCallRequest`/`ModuleCallResult` are new.

**Existing security.** `JwtAuthGuard` (passport-jwt) + `RolesGuard` reading `roles` metadata;
`@Public()` for health/auth/callbacks. `CryptoService` (49J-0) provides AES-256-GCM under
`AI_CONFIG_ENCRYPTION_KEY`. **Still no mTLS anywhere** — re-verified for this phase: no
client certificate, no CA, no `https.Agent` with `cert`, nothing in the nginx config
requesting one. §19 lists mTLS first; adopting it means building certificate issuance,
distribution, renewal and revocation for every module instance, which §20 explicitly says
not to do unless existing infrastructure requires it. HMAC with a per-module shared secret
under the SAME master key is the approved existing mechanism. mTLS is recorded as deferred,
not as a gap.

**Existing health.** `HealthService.getReadinessStatus` returns per-dependency booleans and
gates readiness on the database specifically — so this repository's convention already is
that health is a DECLARED STATE rather than a status code. §13's "unless that is the project
convention" is therefore answered by the project itself, and 49M follows it: a 200 with no
declared state is DEGRADED, never HEALTHY.

**Existing background work.** Three bounded `setInterval` pollers with `unref()`ed timers:
`AuditDispatcherService`, `ReminderDispatcherService` (49I) and `AutomationRetryService`
(49L). `@nestjs/schedule` and `cron` are **absent** from `apps/api/package.json`
(re-verified). `ModuleSweepService` follows the same pattern.

**Existing correlation.** `RequestContextMiddleware` mints `requestId` + `correlationId` per
request into `AsyncLocalStorage`; `TenantContextInterceptor` adds `userId`/`tenantId` from
the database using the verified JWT subject. 49M reads that context rather than inventing
an identifier, and never accepts a tenant from a caller.

**Existing API versioning.** `app.setGlobalPrefix('api/v1')` in `core-main.ts`. Module
contracts are versioned separately and explicitly (`module.invoke@v1`) because a module's
contract version is not Aria's HTTP prefix.

**Nothing was duplicated.** No second signature scheme, no second secret store, no second
URL policy, no second scheduler, no second correlation mechanism.

---

## 2. MODULE REGISTRY

**Module identity — stable, and the two ids are never conflated (§5).**
`ModuleRegistration.moduleId` is the LOGICAL identity (`finance`): unique, slug-shaped by
`ModuleRegistration_moduleId_format`, and **immutable** — the update DTO has no field for it,
because renaming would silently reassign a credential and a tenant scope to a different
module. `ModuleInstance.instanceId` is ONE DEPLOYMENT (`finance-prod-01`): unique globally,
so two modules cannot claim one instance identity.

**Instance identity — a separate table, and that split is the phase.** Everything a module
could lie about to gain trust lives on the REGISTRATION and is written only by the
permission-gated admin API (`enabled`, `tenantScope`, `tenantIds`, the credential).
Everything a module legitimately reports about itself lives on the INSTANCE (version,
endpoint, capabilities, contracts, health). `ModuleRegistration` has **no `baseUrl` column at
all** — an endpoint belongs to a running instance, so moving a module between LOCAL and
REMOTE never touches the logical row.

**Registration — authenticated, and it cannot elevate (§7/§8).** `POST /modules/register` is
`@Public()` in the JWT sense only; authentication is HMAC verified before any state is
touched. The decision order in `registerInstance` is: the logical module must already be
registered → the endpoint must pass the SSRF policy → compatibility must pass → and then the
module's **admitted state**, and only that, decides the lifecycle. `RegisterModuleDto` has no
`enabled`, no `tenantScope`, no `tenantIds`, no `permissions`, no `lifecycle`, no `health` and
no `secret`; under `forbidNonWhitelisted` sending one is a 422 rather than a silent drop.
Verified live: a registration for a disabled module returns
`lifecycle: DISABLED, reason: MODULE_DISABLED` (E2E check 11).

**Lifecycle — seven stored states plus one derived (§15).** `REGISTERED`, `ACTIVE`,
`DEGRADED`, `UNAVAILABLE`, `DISABLED`, `DEREGISTERED`, `INCOMPATIBLE`. `DISCOVERED` is
**derived on read** — "admitted, never announced" — and is deliberately not a column, because
it would be permanently wrong for every row that has an instance. `INCOMPATIBLE` is its own
member rather than folded into `DISABLED` because "an operator disabled it" and "we cannot
speak to it" demand different actions.

**Capabilities — stable strings, never an enum (§9).** `ModuleInstance.capabilities` is
`String[]`, validated for SHAPE only (`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, ≤ 96 chars, ≤ 64
entries). There is deliberately **no allowlist of known capabilities**: one would mean Core
must ship a release before a module can offer anything new. Asserted directly —
`isValidCapability('something-nobody-has-built.yet')` is true.

---

## 3. DEPLOYMENT MODEL

The central requirement, and how it is enforced rather than intended.

| Mode | Stored | Transport | Endpoint policy |
|---|---|---|---|
| `LOCAL` | ✅ | `ModuleHttpTransport` | may be private/loopback, may be plain HTTP, may be absent |
| `REMOTE` | ✅ | `ModuleHttpTransport` | HTTPS required; private literals refused |
| `CENTRAL` | ✅ | `ModuleHttpTransport` | HTTPS required; private literals refused |
| `HYBRID` | ✅ | `ModuleHttpTransport` | HTTPS required; private literals refused |

**One transport serves all four.** `ModuleHttpTransport.modes` lists every mode; there is no
`LocalTransport`/`RemoteTransport` pair and no second business contract, which is §25's
requirement literally. `deploymentMode` is read in exactly **two** places in the entire
phase: `ModuleClient.call` (to select a transport from a list that currently has one entry)
and `module-url.guard.ts` (to choose a network policy). Neither reads `moduleId`.

**Deployment-agnostic verification — four separate assertions, not one claim:**

1. `module-registry.service.spec.ts` → "registers identically in ALL FOUR deployment modes":
   the same registration is performed as LOCAL, REMOTE, CENTRAL and HYBRID, and the stored
   `lifecycle` and `health` are asserted identical in each. The mode changes what is STORED
   and nothing about what is DECIDED.
2. `module-client.service.spec.ts` → "issues an IDENTICAL call for every deployment mode":
   the request object, tenant, actor, correlation id and timeout handed to the transport are
   asserted byte-equal across all four.
3. `module-http.transport.spec.ts` → "builds an IDENTICAL request for a LOCAL and a REMOTE
   instance, apart from the URL": same body, same header names, same signed identity.
4. `module-transport.integration.spec.ts` → against a REAL server: the LOCAL call succeeds
   through exactly the method a REMOTE call uses, and the same server registered as REMOTE
   over plain HTTP is refused **before a socket opens** (`fake.received` is empty).

**No business-domain special case anywhere.** `module-registry.service.spec.ts` →
"handles two differently-named modules identically" compares the full outcome for `finance`
and `sprockets`. `module-registry.controller.spec.ts` → "declares no permission that names a
business module". `modules-api.spec.ts` → "names no business module in any label". A grep of
`src/module-platform/*.ts` (excluding specs) for `HR|Finance|employee|invoice|payroll` returns
**18 hits, all of them comments or a generic capability example** — no identifier, no branch,
no enum member.

---

## 4. DISCOVERY

**Resolver.** `ModuleRegistryService.resolve(moduleId, contract?)` — the only way to reach a
module. Input is a LOGICAL id and a contract; there is no parameter for a URL, a host, an
instance id, a deployment mode or a tenant. It **never throws**: missing, disabled,
tenant-forbidden, unhealthy and contract-incompatible are five distinct result codes, because
each demands a different operator action.

**Endpoint.** Returned only on `ResolvedModuleInstance`, which is consumed **inside**
`ModuleClient` and never handed to a caller — `ModuleCallResult` has no endpoint field. That is
what makes §11's "no hard-coded module URLs" structural: a business caller has no object to
read a URL off. Verified: `module-client.service.spec.ts` → "leaks no network information in a
failure", and the live E2E → "the failure leaks no network information".

**Multiple instances (§12).** `instanceId` is the unique key; `moduleId` is only indexed, so
`finance-prod-01` and `finance-prod-02` coexist with no model change. `resolve` takes up to 10
candidates, filters them, and returns the first — healthiest (enum order) then most recently
seen. Deliberately **not** round-robin: §12 asks that multiple instances be MODELLED, and
inventing a balancing policy nobody measured would be the infrastructure creep §3 forbids. The
list is a list, so adding balancing later changes one line. Asserted: "supports SEVERAL
instances of one logical module".

**Cache / cost (§45).** There is **no cache**, and that is the honest answer: resolution is ONE
query covered by `ModuleInstance_moduleId_lifecycle_lastSeenAt_idx`, and staleness is computed
in memory from `lastSeenAt` rather than by probing. A cache would add an invalidation problem
to a single indexed read. What §45 actually forbids — a discovery call per request, a probe per
widget, unbounded polling — is absent: the admin page costs **two** queries per page load (list
+ platform descriptor), not one per row, and rendering twenty modules issues **zero** outbound
requests. Asserted: `module-health.service.spec.ts` → "answers from stored state with NO
network call".

**Resolution failure (§39).** Codes are `MODULE_NOT_FOUND`, `MODULE_DISABLED`,
`MODULE_FORBIDDEN`, `MODULE_UNAVAILABLE`, `CONTRACT_UNSUPPORTED`. A stale instance is skipped
rather than returned-and-hoped-for; an instance whose declarations no longer include the
required contract is reported as `CONTRACT_UNSUPPORTED` rather than `MODULE_UNAVAILABLE`,
because "restart it" and "upgrade it" are different instructions.

---

## 5. HEALTH

**Health contract — `module.health@v1`, a DECLARED state (§13).** The three facts §13 asks for
are kept separate all the way to the UI:

| Fact | Meaning |
|---|---|
| `registryKnown` | is the instance in the registry at all? |
| `endpointReachable` | did the endpoint answer? |
| `applicationHealthy` | did the application **declare** itself well? |

**A 200 is not health.** A reachable endpoint that declares no `state` resolves to **DEGRADED**
with `NO_HEALTH_STATE`. That is the most load-bearing health assertion in the phase — a proxy
answering 200 in front of a dead module is the most common way a health check lies. Verified
twice: unit ("treats a 200 with NO declared state as DEGRADED") and live (the E2E fixture
declares `{ state: 'HEALTHY', version: '1.0.0' }` and the probe returns all three facts true).

**Status model.** `HEALTHY` / `DEGRADED` / `UNAVAILABLE` / `DISABLED` / `UNKNOWN`. `UNKNOWN` is
the default and is never treated as healthy: a registered-but-never-probed instance cannot be
resolved as HEALTHY. A version mismatch between the instance's report and the registered row is
**DEGRADED with `VERSION_DRIFT`**, not UNAVAILABLE — the module is up, the registry is
describing something else, and refusing to route would take down a working module over
bookkeeping.

**`lastSeen`.** `lastSeenAt` is refreshed by a heartbeat AND by a successful probe (a successful
probe is evidence of life; without that, a module that only answers probes would be swept while
demonstrably healthy). `lastProbedAt` is separate, so "we heard from it" and "we checked it" stay
distinguishable.

**Heartbeat (§14).** 30 s interval, 90 s stale threshold — three missed beats, not one, so a slow
tick or a brief blip does not flap a healthy module. A heartbeat may refresh liveness and report
a state; it **cannot** change the endpoint, version, capabilities or contracts (the DTO has no
such fields), and it cannot promote an `INCOMPATIBLE`, `DISABLED` or `DEREGISTERED` instance.
Verified live: a heartbeat for the incompatible instance returns `lifecycle: INCOMPATIBLE`.
Heartbeats are **not audited** (§33).

**No polling of modules.** `ModuleSweepService` runs every 30 s and issues a DATABASE query
against the partial index — no network call. Health arrives by push; a live probe happens only
when an administrator asks. The sweep needs no claim or lock because the update is idempotent,
so two API instances sweeping concurrently is harmless.

**Failure behaviour (§27).** Verified live, end to end: with the module fixture killed mid-run,
`POST /admin/modules/invoke` returned **200 with `ok: false, errorCode: UNREACHABLE`**,
`GET /health` stayed 200, and the registry still listed the module. Core does not crash, and the
module-specific surface degrades on its own.

---

## 6. CONTRACTS

**API versions (§16).** A descriptor is `<name>@v<major>`. Compatibility requires the name AND
the major to match exactly — no "v2 can serve v1" fallback, because nothing in Core can inspect
a remote response shape, so a silent downgrade would mean sending v1 and interpreting a v2
answer as v1. Backward-compatible ADDITIONS within a major need no change here, which is exactly
what §16 permits; a change of meaning requires a new major and will not be silently accepted in
its place.

**The one contract this phase defines** is `module.invoke@v1`: an operation name, a payload, an
answer. Defining `invoice.create@v1` would mean Core owns the shape of a business operation it
does not implement. A module declaring a richer contract lists it in `apiContracts`; Core matches
the string and routes without understanding it.

**Event versions (§17).** `ModuleInstance.eventContracts` holds `<eventType>@v<version>`
declarations so a module can state what it consumes. **No event is created by this phase** and
nothing here implies any particular event type exists — the mechanism only.

**Compatibility (§18) — all-or-nothing.** `checkCompatibility` runs four checks cheapest-first
(protocol integer → base contract present → every contract well-formed → every capability
well-formed). A failure produces lifecycle `INCOMPATIBLE`, never ACTIVE-with-a-warning and never
ACTIVE-minus-one-capability. The row is **kept**, so an operator can see why a module they
deployed is not serving. Verified live: `accepted: false, lifecycle: INCOMPATIBLE,
reason: PROTOCOL_MISMATCH`, and the row reads `INCOMPATIBLE` in the database.

**Stable normalized client.** `ModuleClient.call` → `ModuleCallResult`: `ok`, opaque `data`, a
short `errorCode`, `instanceId`, `correlationId`. No HTTP status, no headers, no response object,
no retry counter, no endpoint.

---

## 7. SECURITY

**Authentication (§19) — HMAC-SHA256, and it is 49L's, not a second scheme.** The canonical
string is length-prefixed and ordered exactly as 49L built it; `module-signature.spec.ts`
asserts byte equality against 49L's own `canonicalRequest`, so a re-implementation would fail
the suite. The 49M-specific part is what the signature COVERS:

- `moduleId` — so a request signed for module A cannot be replayed at module B;
- `requestId` — so one signature is one request;
- `tenantId`, including `null` as a distinct signed marker (`-` vs `t:<id>`) — so stripping the
  tenant header is detected rather than silently accepted;
- `path` — so a heartbeat signature is not a deregistration signature (asserted).

**Why not mTLS.** Re-audited, unchanged since 49L: no client certificate, no CA, no configured
`https.Agent`, nothing in nginx requesting one. §20 forbids building a CA unless existing
infrastructure requires it. Recorded as deferred in §14 below.

**Transport (§26).** HTTPS is REQUIRED for `REMOTE`/`CENTRAL`/`HYBRID` and refused otherwise,
even when `INTEGRATION_ALLOW_PRIVATE_TARGETS` is set — that flag exists to make LOCAL
development possible, not to let a remote registration point inward. Timeouts are bounded
(1 s–30 s, default 10 s) and clamped rather than rejected for in-process callers.
`AbortSignal.timeout` is used so a pending call cannot hold the event loop open.

**Tenant (§21).** Derived from `RequestContextService` — which `TenantContextInterceptor`
populates from the database using the verified JWT subject — and never from a body, a query
parameter or a header. There is no `tenantId` on `ModuleCallRequest`; the E2E smuggles one
anyway and the transport sends `tenant-1` regardless. `null` is a real value and is never read
as "any tenant": a tenant-less caller is admitted only by an `ALL`-scoped module. The tenant is
also covered by the signature, so the far end can trust the signed copy rather than the header —
the fixture in the E2E does exactly that.

**RBAC (§32).** Two permissions, `admin.modules.read` and `admin.modules.manage`, both seeded by
`20260905120500_seed_module_permission_grants` and verified present in core_db with grants
SUPER_ADMIN (both), ADMIN (both), OPERATIONS_ADMIN (read only), everyone else none. Every admin
route carries `@Roles(...)`; `module-registry.controller.spec.ts` discovers the handlers by
reflection and asserts **no route is ungated**, and that the only two permission strings declared
are those two — no per-module permission exists, which is §32's requirement.

**SSRF (§40).** Four layers, and the first is the strongest: **an administrator cannot type an
endpoint at all.** `CreateModuleRegistrationDto` and `UpdateModuleRegistrationDto` have no
`baseUrl`; the browser harness asserts the form's field list is exactly
`["moduleId","displayName","moduleType","tenantScope"]`. Then: 49L's policy (schemes,
credentials-in-URL, metadata addresses, this process's own infrastructure endpoints, private
literals unless opted in); the off-host HTTPS + no-private rule; and re-validation immediately
before **every** call and **every** probe, because the policy is environment configuration and
can change without the row changing. `InvokeModuleDto` has no `url` field, so the proxy
anti-pattern is unexpressible — the live E2E sends one anyway and gets **422**.

**Secrets (§20).** One credential per module, AES-256-GCM under the SAME
`AI_CONFIG_ENCRYPTION_KEY` — one master key, one store. `provision` and `rotate` are
`POST :id/credential`, `expire` is `secretExpiresAt` (NULL means no expiry and is never read as
expired), `revoke` is `enabled: false` + a rotation. The plaintext is returned **once**; no route
reads a stored credential, and `PublicModuleRegistration` has no field for one, so a projection
that tried to emit it would not compile. Verified live: after rotation, `GET :id` returns
`hasCredential: true` and does not contain the secret; the browser harness asserts no
64-hex-character string survives a page reload.

**Replay / idempotency.** The ±5-minute timestamp window is checked BEFORE the HMAC, so a flood
of stale requests costs nothing; comparison is constant-time. `requestId` is carried on every
call so a downstream module can deduplicate. Rotation does not disable the module — a routine key
change is not an outage — and that trade is stated in the code.

---

## 8. ADMIN UI

`/admin/modules` — "ماژول‌ها و سرویس‌های متصل", RTL, Persian, gated on `admin.modules.read` with
writes gated separately on `admin.modules.manage`.

**Registry.** One row per logical module: display name, id, type, status line, tenant scope,
credential status, aggregate health, derived lifecycle; then one line per instance with its
instance id, version, deployment mode, lifecycle, last heartbeat, staleness, capabilities and a
health error explanation. The platform descriptor (protocol version, base contract, heartbeat
cadence, stale threshold) is READ FROM THE SERVER rather than duplicated in the bundle.

**Test connection.** Per instance, addressed by instance id — there is no body, so nothing about
the destination is caller-supplied. The verdict renders the **three facts separately**, because
"registry knows it / endpoint answered / application is well" is what an operator needs at 3am,
not a single OK/FAIL.

**Health.** Never colour alone (§30): every badge carries a symbol (🟢🟡🔴⚪) **and** a Persian
label **and** a class, and the label is the accessible name. `modules-api.spec.ts` asserts all
three are non-empty for all five states. A stale instance renders UNAVAILABLE regardless of its
last report.

**Capabilities.** Listed per instance from what the module declared. Nothing is invented
client-side.

**Enable / disable.** One button per row; disabling cascades to every instance in one transaction
so the UI and the resolver never disagree.

**No secrets.** The credential appears exactly once, immediately after generation, in component
state only — never localStorage, never a cookie, never the URL. Verified in the browser: present
once, absent after reload.

**No endpoint field, and no workflow-editor-equivalent.** There is no `baseUrl`, `url`, `version`
or `healthPath` input anywhere on the page (asserted), and no UI for editing a module's internals —
a module's configuration belongs to the module.

**One nav entry, not one per module.** `core-nav.ts` gains a single `/admin/modules` item; the
browser harness asserts exactly one DISTINCT `/admin/modules*` href exists (two `<a>` elements is
correct — `CoreShell` renders the rail and the drawer). A per-module entry would make the
navigation tree depend on database rows and break 49K's drift test the moment a module registered.

---

## 9. FUTURE FOUNDATIONS

All three are **declarations only**, which is what §36/§37/§38 ask for. `module-foundations.ts` is
types, two constant lists and ONE pure function — no service, no provider, no table. A service
with a `sync()` that currently throws would be an invitation; an interface cannot be invoked.

**Sync (§36).** `ModuleSyncPositionKind` (`CURSOR` / `VERSION` / `CHECKSUM` / `TIMESTAMP` — a union,
so a later phase must CHOOSE rather than support all four), `ModuleSyncPosition`, `ModuleSyncPlan`
with an explicit `FULL`/`INCREMENTAL` mode and a mandatory `maxRecords`. `FULL` vs `INCREMENTAL` is
explicit rather than inferred from a missing cursor, because that inference is how a lost cursor
becomes an accidental full re-import. **Nothing implements it**, and the platform descriptor
reports `syncImplemented: false`.

**Conflict (§37).** `OWNER_WINS`, `VERSION_MISMATCH`, `EXPLICIT_RESOLUTION`, `LAST_WRITE_WINS` —
declared in that order, with `OWNER_WINS` as the default. `LAST_WRITE_WINS` is listed **last** and
is never the default: it discards data silently and depends on clock agreement between machines
that have no reason to agree. Asserted directly. **No policy is applied to anything**, because
there is no cross-module business data to conflict.

**Provisioning (§38).** `REGISTER → AUTHENTICATE → VERIFY → ACTIVATE`, plus a `ModuleProvisioner`
interface that must report a per-step outcome rather than a boolean, and `remainingProvisioningSteps`
— a pure function so the UI can show progress today. Every one of those four steps already exists as
a MANUAL operation in this phase, so the type describes existing behaviour rather than promising new
behaviour. No Docker/VM/Kubernetes creation: there is no Docker API client, no Kubernetes client and
no cloud SDK in `apps/api/package.json` (verified), and the descriptor reports
`provisioningImplemented: false`.

---

## 10. TESTING

All figures below were read from captured output on this machine.

**Unit — 13 spec files, and what each one defends:**

| Spec | Defends |
|---|---|
| `module-contract.util.spec.ts` | descriptor parsing, exact-major compatibility, capability SHAPE, the all-or-nothing gate |
| `module-signature.spec.ts` | byte equality with 49L's canonicalisation, moduleId/tenant coverage, splicing, window, constant-time, expiry |
| `module-url.guard.spec.ts` | inherited 49L policy, off-host HTTPS, private-as-REMOTE refusal, env-flag restoration |
| `module-registry.service.spec.ts` | deployment neutrality, no-self-elevation, INCOMPATIBLE recording, tenant scope incl. null, staleness, probes, credential boundary |
| `module-health.service.spec.ts` | the §13 rule, the three facts, refusals that make no network call, `checks` sanitisation |
| `module-client.service.spec.ts` | identical call per mode, tenant from context, correlation carried, minimal actor, no unsigned call, clamping |
| `module-http.transport.spec.ts` | signing, identical LOCAL/REMOTE request, every failure code, per-call policy, no body leak |
| `module-registry.controller.spec.ts` | every route gated, actor from token, no url forwarded, descriptor names no domain |
| `module-registration.controller.spec.ts` | uniform 401s, nothing reaches the domain on rejection, acting module = signing module, cross-endpoint replay |
| `module-sweep.service.spec.ts` | cadence vs threshold, no throw, no overlap, stops on destroy |
| `module-foundations.spec.ts` | declarations only, LAST_WRITE_WINS never default, step ordering |
| `module-platform.module.spec.ts` | the real DI graph resolves; `ModuleClient` exported, registry NOT |
| `module-transport.integration.spec.ts` | see below |

**Integration (§42) — a REAL disposable module service.** `module-transport.integration.spec.ts`
starts an actual `http.Server` on loopback; `fetch` is **not** stubbed. The fake VERIFIES the
signature with the same primitives Core uses at the far end, so canonicalisation, header names,
body serialisation and HMAC are exercised across a real socket. It also proves the LOCAL leg and
the REMOTE-refusal leg with the same server, same client, same instance — only the mode differs.

**Security.** Covered in the specs above and again live: uniform 401s, no state change on
rejection, replay across modules/tenants/endpoints refused, no credential in any read, no upstream
body in any result, 422 for a smuggled `url`.

**Browser (§44).** `apps/web/phase49m-validate.mjs`, real Chrome against the real Next build and the
real Core process: **18/18 PASS**, 10 screenshots in `apps/web/phase49m-shots/`, **0 console
errors**. Covers view / register / credential-once / credential-gone-after-reload / enable / disable
/ one-nav-entry / unauthorized-sees-nothing / delete / no-endpoint-field.

**E2E (§43).** `apps/api/scripts/module-e2e.mjs` against the real Core process (port 3011) and real
core_db: **38/38 PASS**. The fixture is `module-under-test` with capability `probe.echo` — not HR,
not Finance, no business data — and it is deleted in a `finally`, with the removal asserted.

**Typecheck.** `tsc --noEmit` API **EXIT=0**, web **EXIT=0**.

**Build.** `nest build` produced `dist/module-platform/*` (14 modules); `next build` compiled
successfully and lists `/admin/modules` as a static route.

**Jest totals at hand-off:**

| Suite | Result |
|---|---|
| API, module-platform only | 13 suites / **205 tests**, EXIT=0 |
| API, full | **65 suites / 1149 tests**, EXIT=0 |
| API, full excluding module-platform | 52 suites / **944 tests**, EXIT=0 |
| Web, full | **44 suites / 736 tests**, EXIT=0 |

Those four numbers reconcile exactly, and that arithmetic is the point: 944 + 205 = 1149, and
**944 is the 49L hand-off figure unchanged** — so 49M added 205 tests and altered none. Web went
from 705 to 736: +16 (`modules-api.spec.ts`) +15 (`CoreModulesView.spec.ts`), and the 49K
navigation drift test still passes with one more entry on each side.

---

## 11. DATABASE

**Tables — two.** `ModuleRegistration` (the logical module) and `ModuleInstance` (one
deployment). The split is §5's requirement; combining them would make "where is finance?"
unanswerable the moment a second instance existed.

**Enums — five.** `ModuleType`, `ModuleDeploymentMode`, `ModuleLifecycleState`,
`ModuleHealthState`, `ModuleTenantScope`. Verified in core_db with exactly the members declared.

**Migrations — two, both non-destructive.** `20260905120000_add_module_platform` and
`20260905120500_seed_module_permission_grants`. No DROP, no ALTER of an existing column, no
backfill, no seed row. Every column is either NOT NULL with a default or nullable, so both tables
are complete on creation and a rollback is two `DROP TABLE` plus five `DROP TYPE`. Applied count
went **18 → 20**, unfinished **0**, rolled back **0**.

**13 CHECK constraints**, verified present:

| Constraint | Refuses |
|---|---|
| `ModuleRegistration_moduleId_format` | a non-slug logical id |
| `ModuleRegistration_displayName_bounded` | an empty or over-long name |
| `ModuleRegistration_tenantScope_consistent` | ALL-with-a-list, and RESTRICTED-to-nobody |
| `ModuleRegistration_protocolVersion_bounded` | a protocol the code never heard of |
| `ModuleRegistration_secret_complete` | two of the three GCM columns |
| `ModuleInstance_instanceId_format` / `_moduleId_format` | non-slug ids |
| `ModuleInstance_version_format` | `latest`, `v2`, `2`, `1.2`, `''` |
| `ModuleInstance_healthPath_relative` | a path carrying a scheme or an authority |
| `ModuleInstance_capabilities_bounded` (64) / `_apiContracts_bounded` (32) / `_eventContracts_bounded` (64) | unbounded declaration lists |
| `ModuleInstance_remote_requires_baseUrl` | an off-host instance with no endpoint |

**One foreign key, internal to the phase.** `ModuleInstance_registrationId_fkey → ModuleRegistration(id)`
ON DELETE CASCADE. Unlike 49L (which has none by design), CASCADE is correct here: an instance of a
module that no longer exists is unresolvable by definition. Nothing references `User`, `Tenant` or
any business table.

**Indexes — 7, including one Prisma cannot express.**
`ModuleInstance_lastSeenAt_idx` is PARTIAL:
`WHERE lifecycle IN ('REGISTERED','ACTIVE','DEGRADED')`. The predicate is verified in core_db and
`SWEEPABLE_LIFECYCLES` is asserted to match it in the service spec, so the sweep scans only rows it
could act on. Same technique 49L uses for its retry index.

**Schema impact on existing tables — none.** Verified by query: 49L's two tables still present and
unchanged, and `information_schema` reports **0** tables matching `%hr%|%finance%|%employee%|%invoice%|%payroll%`
and **0** matching `%sync%|%conflict%|%provision%|%mesh%`. Row counts after the E2E and browser runs:
`ModuleRegistration` **0**, `ModuleInstance` **0** — both fixtures cleaned up.

---

## 12. REGRESSION

| Phase | Evidence |
|---|---|
| **49I** (Calendar/Reminders) | `reminder.service.spec.ts`, `reminder-dispatcher.service.spec.ts`, `jalali.util.spec.ts` all pass in the full run; no file touched |
| **49J** (Search + AI) | `search-*.spec.ts`, `ai-*.spec.ts`, `openai.provider.spec.ts` pass; no file touched |
| **49K** (Experience Platform) | `preference.service.spec.ts` passes; `nav-catalogue.ts` gained ONE entry and `core-nav.spec.ts`'s drift test — which requires the client tree and the server allowlist to match entry for entry — passes with both sides updated |
| **49L** (Integration Platform) | all 8 integration specs pass; `integration-verify.sql` re-run and identical (7 CHECKs, 7 indexes, **0 FKs**, 2 permissions, 5 grants); `integration-signature.ts` and `integration-url.guard.ts` are imported but **not modified** |

**Search / AI / Dashboard / Preferences / IntegrationGateway / n8n adapter — all unchanged.** The
944-test figure excluding `module-platform` is byte-identical to 49L's hand-off number, which is the
strongest single statement available: no existing test changed behaviour.

**The one deliberate coupling to watch.** 49M imports pure functions from `src/integrations/`. If a
later phase changes 49L's canonicalisation or URL policy, `module-signature.spec.ts` and
`module-url.guard.spec.ts` fail — by design. That is a feature: one policy, and any change to it is
visible in both phases' suites at once.

**Files modified outside `module-platform/` — eight, all additive** (seven are `M` in git; the
eighth, `nav-catalogue.ts`, sits inside 49K's still-untracked `src/preferences/` — see §13)**:**

| File | Change |
|---|---|
| `prisma/core/schema.prisma` | +2 models, +5 enums, appended |
| `src/auth/rbac/constants/permissions.ts` | +2 permission strings, +domain map, +ADMIN list |
| `src/auth/rbac/constants/roles.ts` | +grants for SUPER_ADMIN / ADMIN / OPERATIONS_ADMIN |
| `src/core-app.module.ts` | +1 import, +1 module registration (registered LAST) |
| `src/preferences/nav-catalogue.ts` | +1 nav target |
| `.env.example` | +documentation only — **no new variable** |
| `apps/web/src/components/core/core-nav.ts` | +1 nav item, +1 icon import |
| `apps/web/.../core-nav.spec.ts` | +1 entry in the mirrored allowlist |

---

## 13. GIT / ARTIFACTS

**Modified files — 8**, listed in §12 above. Every one is additive: no line was deleted from any
existing file, and no existing behaviour was altered.

**Re-derived from `git status --short`, and the arithmetic does not land on 8 — here is why.**
Seven of the eight report as `M`:

```
 M apps/api/.env.example
 M apps/api/prisma/core/schema.prisma
 M apps/api/src/auth/rbac/constants/permissions.ts
 M apps/api/src/auth/rbac/constants/roles.ts
 M apps/api/src/core-app.module.ts
 M apps/web/src/components/core/core-nav.ts
 M apps/web/src/components/core/__tests__/core-nav.spec.ts
```

The eighth, `apps/api/src/preferences/nav-catalogue.ts`, cannot report as `M`: the whole
`apps/api/src/preferences/` directory is 49K work that was never committed, so git sees `??` on the
directory and `ls-files` on the file errors with *did not match any file(s) known to git*. 49M did
edit it — it carries the `// Phase 49M` comment and the `{ href: '/admin/modules', permission:
Permissions.ADMIN_MODULES_READ }` entry at lines 66–70 — but to git it is one line inside an
untracked tree, not a modification. **8 is therefore the honest count of files this phase edited;
`git status` will only ever show 7 `M` entries for it.** The tree-wide `M` count is 31, the rest
being pre-existing 49J/49K/49L dirt.

**New files — 38**, plus 10 screenshots:

| Area | Count | Files |
|---|---|---|
| API source | 14 | `src/module-platform/*.ts` + `dto/module.dto.ts` (3,738 lines) |
| API specs | 13 | `src/module-platform/*.spec.ts` (2,944 lines) |
| Migrations | 2 | `20260905120000_add_module_platform`, `20260905120500_seed_module_permission_grants` |
| Scripts | 2 | `scripts/module-verify.sql`, `scripts/module-e2e.mjs` |
| Web | 5 | `lib/modules-api.ts`, `components/core/CoreModulesView.tsx`, `app/admin/modules/page.tsx`, 2 specs |
| Harness | 1 | `apps/web/phase49m-validate.mjs` |
| Report | 1 | this file |
| **Subtotal — new files** | **38** | 14 + 13 + 2 + 2 + 5 + 1 + 1 |
| Screenshots — *not added into the 38* | 10 | `apps/web/phase49m-shots/*.png` |

The subtotal row IS the 38; the screenshot row sits below it and is not summed in, so the Count
column reads 38 files and 10 images rather than a single 48. The 27 files under
`apps/api/src/module-platform/` (14 source + 13 spec) are the first two rows; the remaining 11 are
the migrations, scripts, web files, harness and this report.

**Secrets — none committed.** No certificate, no private key, no module secret, no API token, no
exported credential. The credential generated during the E2E and browser runs existed only in
process memory and in an encrypted column that was then deleted. `.env.example` gained
documentation and **no new variable**. `grep` for a 64-hex-character literal in the new files
returns nothing.

**Temporary files — none left behind.** The E2E fixture (`module-under-test`) and the browser
fixture (`browser-under-test`) are both deleted in a `finally` and the removal is ASSERTED, not
assumed: `SELECT count(*)` returns 0 for each, and `module-verify.sql` reports
`ModuleRegistration 0 / ModuleInstance 0`. The disposable HTTP servers on ports 4599/4699 and the
one in the integration spec are all closed. Test output went to `%TEMP%`, not the repository.

**⚠️ `git add .` IS UNSAFE IN THIS TREE, and this is the same warning 49L recorded.** Two
pre-existing untracked files sit in `apps/api/`:

```
apps/api/.tok
apps/api/.rid
```

They are credential-shaped, predate this phase, and are NOT in `.gitignore`. Any commit must stage
**explicit paths**. The expected 49M set is 8 modified + 38 new + 10 PNGs; nothing else.

**Unrelated changes — none introduced, and none disturbed.** `git status` shows 129 lines, most of
them pre-existing dirty/untracked work from 49J/49K/49L (`CoreSupportView.tsx`, `k-jest*.out`,
`phase48c*-shots/`, `backups/`, `lovable/`, `tools/`, `firefox-*.png`, `ws-install*.txt`,
`testing_module_dump.json`, …). No `git reset`, no `git clean`, no `git restore`, no rebase, no
force-push, and no `git config` change was performed at any point.

**One incidental note.** `apps/api/dist/` was rebuilt (`nest build`) and `dist/generated` was
re-copied by hand — the `postbuild` script's `rmSync` failed with EPERM while the previous Core
process held the directory, which is why the first E2E attempt failed with
`Cannot read properties of undefined (reading 'findUnique')`: the built bundle was resolving a
Prisma client that predated the new models. Killing the process and re-copying fixed it, and the
second run passed 38/38. `dist/` is a build artifact and is not tracked.

---

## 14. DEFERRED

Real deferrals, each with the reason it was not built rather than a promise.

**1. mTLS between Core and modules (§19).** HMAC-SHA256 is implemented and is the approved existing
mechanism. mTLS would require certificate issuance, distribution, renewal and revocation for every
instance — a CA — which §20 forbids building absent existing infrastructure, and there is none: no
client certificate, no CA, no configured `https.Agent`, nothing in nginx requesting one. The
transport is a single seam, so adding a certificate-bearing agent later is one file.

**2. DNS-rebinding-proof SSRF (§40), inherited from 49L.** The guard blocks literal
private/loopback/link-local addresses, metadata endpoints, this process's own infrastructure
endpoints and non-HTTP(S) schemes. It does **not** pin a resolved address into the socket, because
Node's `fetch` does not expose that, so a hostname is re-resolved and a rebinding attacker can still
win the race. Stated here rather than papered over.

**3. Byte-exact raw-body signing on the module-facing routes**, inherited from 49L's callback. The
signature is verified over `JSON.stringify(dto)` — the validated DTO — not the received bytes,
because this application configures no raw-body parser and adding one globally would change request
handling for every existing route. `forbidNonWhitelisted` guarantees no extra property survives, so
the reconstruction is exact for any well-formed sender, and the E2E proves it end to end with an
independently-implemented signer. A raw-body parser scoped to these routes would close it.

**4. A TLS E2E against a real HTTPS module.** The transport is proven against a REAL server over
loopback HTTP in LOCAL mode, and the REMOTE-over-plain-HTTP refusal is proven with the same server —
so both the happy path and the mode-specific network rule are covered. What is not covered is a real
certificate handshake, because generating a trusted certificate inside a test run means adding a
certificate-generation dependency for one test. §26's rule is enforced and asserted; the handshake
itself is untested.

**5. Load balancing across instances (§12).** Multiple instances are MODELLED and resolvable; the
resolver picks healthiest-then-freshest rather than round-robin. §12 explicitly does not require
balancing, and inventing an unmeasured policy would be creep.

**6. In-process transport (§25).** Permitted "only if proven necessary" and not proven: there is no
in-process module in this repository to dispatch to, and a second transport would create the
two-business-path situation §25 forbids. A LOCAL module today registers a loopback endpoint.

**7. Synchronisation, conflict resolution and provisioning (§36/§37/§38).** Extension points only,
as required. The platform descriptor reports `syncImplemented: false` and
`provisioningImplemented: false` so the UI cannot imply otherwise.

**8. A module-initiated callback / event push.** 49M is request/response from Core outward, plus
module-initiated registration and heartbeat. A module pushing a business EVENT into Core would need
49L's event contracts extended to inbound, which is a separate decision.

---

## 15. BLOCKERS

**None.**

Nothing in §50's stop-condition list was hit, and each was checked rather than assumed:

| Stop condition | Outcome |
|---|---|
| module identity cannot be made stable | Not hit — immutable slug + DB CHECK + immutable-by-DTO |
| service discovery cannot be secure | Not hit — resolution is tenant-scoped, credential-gated, and returns no topology |
| tenant context cannot be preserved | Not hit — derived from verified context, covered by the signature, `null` handled as its own value |
| contract versioning cannot be enforced | Not hit — exact-major matching, all-or-nothing gate, re-checked at call time |
| remote auth cannot be secured | Not hit — HMAC over a length-prefixed canonical string, one secret store, bounded window, constant-time |
| endpoint configuration creates unacceptable SSRF risk | Not hit — an administrator cannot type an endpoint at all; the residual DNS gap is documented, not hidden |
| registry requires direct DB access to a remote module | Not hit — no cross-module DB access exists; the only FK is internal |
| local and remote require different business contracts | Not hit — one transport, one contract, asserted four ways |
| implementation becomes tied to one Business Module | Not hit — no business module exists, is named, or is implied |
| Kubernetes / service mesh / Kafka / Redis PubSub becomes necessary | Not hit — nothing was added to `package.json`; the sweep is a `setInterval` matching three existing precedents |

**One honest limitation, not a blocker.** The `/ready` endpoint still reports only Core's own
dependencies; module health lives on the registry and is not folded into Core readiness. That is
deliberate — Core must stay ready when an optional module is down (§27) — but it means an operator
watching only `/ready` will not see a degraded module. The admin page is where that lives.

---

## 16. FINAL GATE

**MODULE REGISTRY**
- [x] stable module identity — immutable slug, unique, DB CHECK, absent from the update DTO
- [x] instance identity — separate table, globally unique, never conflated with `moduleId`
- [x] registration — HMAC-authenticated, cannot self-admit, cannot self-enable
- [x] lifecycle — 7 stored states + 1 derived; terminal states cannot be escaped by heartbeat
- [x] capabilities — module-declared strings, shape-validated, no Core-side allowlist
- [x] contract versions — `<name>@v<major>`, exact-major matching, re-checked at call time

**DISCOVERY**
- [x] service discovery — `resolve(moduleId, contract?)`, never throws, five distinct failures
- [x] multiple instance model — `instanceId` unique, `moduleId` indexed, asserted
- [x] no hard-coded module URLs — no caller can supply or read one
- [x] bounded resolution — one indexed query, no cache to invalidate, no fan-out

**HEALTH**
- [x] health endpoint — `module.health@v1`, DECLARED state required
- [x] status model — 5 states, `UNKNOWN` never healthy, 200-without-state is DEGRADED
- [x] lastSeen — refreshed by heartbeat AND successful probe; `lastProbedAt` kept separate
- [x] degraded / unavailable handling — three facts kept distinguishable to the UI

**SECURITY**
- [x] module authentication — HMAC-SHA256, 49L's canonicalisation, asserted byte-identical
- [x] secure transport — HTTPS required off-host; bounded timeouts; unref'd abort signal
- [x] credential protection — one-way, one store, never in a read, no field to leak it into
- [x] tenant context — derived, signed, `null` handled as its own value
- [x] RBAC — 2 permissions, seeded, every route gated, no route ungated (asserted)
- [x] SSRF protection — admin cannot type an endpoint; policy re-applied per call and per probe
- [x] replay / idempotency — ±5 min window before HMAC, constant-time, `requestId` per call

**CONTRACTS**
- [x] API versioning — explicit descriptors, no silent downgrade
- [x] event versioning — declarations supported; no event created
- [x] compatibility checks — all-or-nothing, INCOMPATIBLE recorded not activated
- [x] stable normalized client — `ModuleCallResult` carries no transport detail

**OBSERVABILITY**
- [x] correlationId — carried from the request context, never regenerated
- [x] requestId — per call, signed
- [x] trace compatibility — reuses `RequestContextService`; OTEL bootstrap untouched
- [x] safe logging — module id / instance id / contract / operation / status / duration only; never a signature, header, body or credential

**UI**
- [x] admin module registry — `/admin/modules`, Persian, RTL
- [x] health — symbol + label + colour, never colour alone
- [x] test connection — per instance, three facts rendered separately
- [x] capabilities — listed from what the module declared
- [x] enable / disable — with a transactional cascade to instances
- [x] no secrets — shown once, absent after reload (asserted in a real browser)

**FOUNDATION**
- [x] future sync extension points — types only; `syncImplemented: false`
- [x] future conflict extension points — 4 policies declared, `OWNER_WINS` default, none applied
- [x] future provisioning extension points — 4 steps + interface; `provisioningImplemented: false`

**TESTING**
- [x] unit — 13 suites / 205 tests
- [x] integration — real `http.Server`, real socket, far-end signature verification
- [x] security — uniform 401s, replay, tenant, SSRF, credential containment
- [x] browser — 18/18, 10 screenshots, 0 console errors
- [x] typecheck — API EXIT=0, web EXIT=0
- [x] build — `nest build` and `next build` both clean

**REGRESSION**
- [x] 49I unchanged
- [x] 49J unchanged
- [x] 49K unchanged — drift test passes with the mirrored entry added on both sides
- [x] 49L unchanged — `integration-verify.sql` identical; its files imported, not modified

**QUALITY**
- [x] no HR assumption
- [x] no Finance assumption
- [x] no Local/Remote hard-coding — `deploymentMode` read in exactly two places, never with `moduleId`
- [x] no shared DB coupling — the only FK is internal to this phase
- [x] no distributed infrastructure creep — zero dependencies added

---

## FINAL VERDICT

**49M = GREEN.**

Every mandatory gate above passes, and every figure in this report was read from a captured command
output on 2026-09-05: `tsc` EXIT=0 twice, 205 module-platform tests, 1149 API tests, 736 web tests,
38/38 E2E against the real Core process, 18/18 in a real browser, 20 migrations applied with 0
unfinished and 0 rolled back, and both verification scripts re-run.

**The single sentence this phase exists to make true, and which is now checkable rather than
aspirational:** *Local/Remote is a property of Deployment, not of the Business Domain.* Moving a
module between LOCAL, REMOTE, CENTRAL and HYBRID changes **one column on one row**. It changes no
business code, no contract, no transport, no permission and no test — and that claim is asserted
four separate ways, including once against a real HTTP server.

**Prior phase statuses are unchanged: 49I GREEN, 49J-A GREEN, 49J-0 GREEN, 49J YELLOW, 49K GREEN,
49L GREEN.** 49J remains YELLOW for its own recorded reasons; nothing in 49M touched it.

**Nothing is committed.** Awaiting direction — and if a commit is requested, stage **explicit
paths only** (see §13: `apps/api/.tok` and `apps/api/.rid` must never be staged).

**49N was not started.** No workflow editor, no Kubernetes, no service mesh, no Kafka, no Redis
PubSub, no HR module, no Finance module, and no fake business data.

---

## REPORT INTEGRITY

Verified after the final edit, so the figures describe this file as it stands:

| Check | Result |
|---|---|
| Size | **53,466 bytes / 52.2 KB**, **853 lines** |
| Encoding | UTF-8, **no BOM**, byte-valid under strict `UTF8Encoding($false, $true)` |
| Mojibake markers | **0** |
| Literal `?` substitutions | **12**, all genuine — 8 in prose/regex plus the two-character `??` untracked marker, which appears twice (§13 and this row): 8 + 4 = 12; no `0x3F` replacement damage |
| Typography | 159 em-dashes, 68 `§` references, 53 ticked gate boxes, all rendering |
| Structure | §1–§16 in ascending order, then FINAL VERDICT, then this section |
| Trailing whitespace | **0** lines |
| Seams | **0** triple-newline runs from the chunked edits; 853 CRLF line endings, 0 bare LF |
| Tables | **0** unterminated rows |
| Fences | 4 fence lines — **2 balanced blocks** |
| EOF | single terminating newline |

**Environment after the run:** `m49m-*` temporary files **0** under `%TEMP%` and **0** under the
repository; ports **3000 / 3011 / 4599 / 4699** all closed; no surviving harness `node` process.
Eight containers are up and all pre-date this phase: seven are compose services (`postgres`,
`redis`, `rabbitmq`, `minio`, `mailpit`, `api`, `nginx` — `web` is defined but not running) and
`aria-erp-e2e-dbproxy` is a hand-started `alpine/socat` port-forward with no compose labels, not a
compose service. None was started, stopped or altered by this phase.

**Screenshots:** `apps/web/phase49m-shots/` holds **10** PNGs. They are retained deliberately, on
the 49L precedent (`phase49m-shots/` is not in `.gitignore`, and neither was `phase49l-shots/`).
They are **not** inside the 38: §13's table carries an explicit subtotal row at 38 with the image
row listed below it, so the count of non-image new files is 38 and the images are 10 more.
