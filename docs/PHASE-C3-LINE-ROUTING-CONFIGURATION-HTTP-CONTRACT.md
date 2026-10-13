# PHASE C3 — COMMERCE / PROCUREMENT
# GAP-2 — LINE ROUTING CONFIGURATION HTTP SURFACE

**Repository:** `E:\ERP` · **Phase:** C3 (backend only) · **Status:** implementation complete, validation green
(see §Q/§R for the measured results).

**AUTHORITY.** This document is subordinate to, and does not amend:

- `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md`
- `docs/PHASE-C1-EXECUTION-PROMPT.md`
- `docs/PHASE-C1-O-LINE-ROUTING-CONTRACT.md` (the O contract — line routing is ITS subject; §Z below
  records the one status note appended to it, and nothing else in it was touched)
- `docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md`
- `docs/PHASE-C2-WORKFLOW-EXECUTION-HTTP-AND-PENDING-INBOX-CONTRACT.md`

Where this document is silent, those decide.

---

## A. PRE-IMPLEMENTATION DISCOVERY (zero-guess, from source)

1. **The domain existed; the boundary did not.** `WorkflowLineRoutingVersion` (Commerce Prisma),
   `WorkflowLineRoutingRepository` (`create` / `findById` / `findPublishedForTrigger` / `publish`),
   `WorkflowLineRoutingService` (runtime routing), `WorkflowLineRoutingConfigurationService`
   (`publish(tenantId, id)` + `validateShape(row)`) and the pure planner `workflow-line-routing.ts`
   were all shipped by step O and pinned by its suites. `commerce-isolation.spec.ts` pinned the
   ABSENCE of a controller for them ("O (line routing) is still an application service with no HTTP
   surface").
2. **The only reachable surface was a test probe.** All three e2e suites reach line-routing
   configuration through `CommerceTenantProbeController` (`POST commerce-tenant-probe/routing-versions`,
   `POST commerce-tenant-probe/routing-versions/:id/publish`). That probe — not any
   production route — is what the C1 contract's "authored by an admin UI that does not exist yet"
   comment refers to.
3. **The create contract already existed in test code**: `parseRoutingBody` (three e2e suites) writes
   `status: 'DRAFT'` with `versionLabel` ≤ 64, `trigger` ∈ `WORKFLOW_TRIGGER_EVENTS`, the closed policy
   vocabularies, and a NON-EMPTY `routeRules` array of `{priority, target…, condition}`. The production
   create route therefore writes exactly what the probes wrote.
4. **The lifecycle already had its one transition**: `publish` validates the STORED row (shape,
   vocabulary, frozen fact allowlist, built rule set, target existence within the tenant, actor-source
   support) and then writes DRAFT|VALIDATED → PUBLISHED. Published rows are immutable by contract
   (O4-D1) and are the foreign-key target of `PurchaseDocument.lineRoutingVersionId`
   (ON DELETE RESTRICT). There is no archive, no draft-edit and no delete anywhere in the routing
   domain.
5. **The runtime consumes exactly one published version per tenant and trigger**
   (`findPublishedForTrigger`, no tie-break) or the PINNED version on an already-routed document
   (`findById`, O4-D7). Publishing is therefore a tenant-level act with runtime consequences — which
   is why no C3 test creates a second published version for a trigger the runtime already resolves.
6. **Frontend**: UI-4 documented the «مسیردهی اقلام» branch of the settings overview as ABSENT (not
   disabled) because no HTTP surface existed, and no client/type models routing. The UI-0 §26-GAP-2
   row and the UI-5 gap report both record that absence. Nothing in the frontend expects a shape that
   would constrain this phase.
7. **Isolation pins that MUST move** (all measured, not assumed): controller set 8 → 9, route surface
   52 → 56, the A1 absence-pin for a `workflow-line-routing.controller.ts`, the controller-count
   assertion, and the two prose counts. Nothing else in `commerce-isolation.spec.ts` is affected — the
   ownership matrix, the migration list, the audit region (D7), the seam list and the index count are
   untouched by this phase.

## B. SOURCE FILES AND CONTRACTS INSPECTED

Contracts: the five documents listed above. Source (read before any edit):
`workflow-line-routing.ts`, `workflow-line-routing.service.ts`,
`workflow-line-routing.repository.ts`, `workflow-line-routing-configuration.service.ts`,
`workflow-execution.service.ts`, `workflow-execution.repository.ts`, `workflow-facts.ts`,
`workflow-configuration.ts`, `workflow-configuration.service.ts`, `workflow-configuration.dto.ts`,
`workflow-configuration.controller.ts`, `commercial.dto.ts`, `commercial-configuration.service.ts`,
`commercial.controller.ts`, `commerce-actor.ts`, `commerce.constants.ts`, `dto/commerce-query.dto.ts`,
`commerce.module.ts`, `commerce-isolation.spec.ts`, `commerce-schema.spec.ts`,
`workflow-configuration.repository.spec.ts`, `rules/core/rule-limits.ts`;
`prisma/commerce/schema.prisma` (+ the `line_routing` and `line_routing_version_pin` migrations);
`test/commerce-lifecycle.e2e-spec.ts`, `test/commerce-tenant.e2e-spec.ts`,
`test/commerce-integration.e2e-spec.ts`; frontend: `CommerceSettingsOverview.tsx`,
`CommerceSettingsView.tsx`, `commerce-api.ts`, `CommerceFinalHonesty.spec.tsx`.

## C. PREVIOUS GAP-2 STATE — CONFIRMED

`WorkflowLineRoutingConfigurationService` was referenced by specs and e2e probes only: no controller,
no route prefix, no DTO, no `@Roles`, no reachable production path. A tenant administrator could not
create, read or publish a routing version without a developer — the O contract's own configuration
capability was unreachable in production.

## D. ROUTING SEMANTICS CONFIRMED (what C3 does NOT change)

| Question | Answer (source) |
|---|---|
| Object routed | each `PurchaseLine` of a submitted `PurchaseDocument` (O-A) |
| Routing target | an exact published `WorkflowDefinitionVersion`, pinned per line (O7) |
| Criteria | O5's frozen line fact catalogue only (`lineType`, `lineNumber`, `quantity`, `unit`, `unitPrice`, `tax`, `lineTotal`, `itemReference`, `externalRef`, `technicalDescription`) |
| Engine | the ONE `RuleEngineService.evaluateSync` over `commerce.workflow.line.selection` (O-B, O6) |
| Multi-match | configured: `HIGHEST_PRIORITY` (a tie at the top is an error) or `AMBIGUOUS_ERROR` (O3) |
| No match | configured: `REJECT_OPERATION` or `LEAVE_UNROUTED` (O2) |
| Trigger | `PURCHASE_SUBMITTED` or `AFTER_DOCUMENT_WORKFLOW_APPROVED` (O1) |
| Document aggregation | configured: `ALL_APPROVED` or `INDEPENDENT` (O4 + the O4-D3 matrix vs P) |
| Determinism | routes are ordered by target id before hashing; the engine orders by priority/specificity/id |
| A rule becoming inactive while purchases run | a running document uses its PIN (O4-D7); a later published version never silently changes it |
| Versioning | reuses `WorkflowDefinitionVersionStatus`; published versions immutable; a change is a new version |

C3 changes exactly two things about the configuration: it makes the EXISTING acts reachable, and it
states the label's uniqueness refusal as a named 409. No routing decision, ordering rule, resolution
rule or stored semantic was altered.

## E. HTTP ENDPOINTS INTRODUCED (four, and no fifth)

| Method | Path (under the global `/api/v1`) | Permission | Success | Purpose |
|---|---|---|---|---|
| GET | `commerce/routing-versions` | `commerce.read` | 200 | One page of the tenant's routing versions, newest-touched first |
| GET | `commerce/routing-versions/:id` | `commerce.read` | 200 | One version, with its stored `routeRules` |
| POST | `commerce/routing-versions` | `commerce.workflow.manage` | 201 | Open ONE version as a DRAFT |
| POST | `commerce/routing-versions/:id/publish` | `commerce.workflow.manage` | 200 | Run the existing checklist and publish; the answer is the server's resulting state |

**Naming basis (not guessed):** `routing-versions` and `routing-versions/:id/publish` are the path
segments the O contract's own test seam has used since step O; the collection sits beside
`workflow-definitions` / `workflow-versions` / `commercial-configurations` as a plural, noun-shaped
collection exactly as the module's controller docs prescribe; and in this bounded context "routing"
has exactly one meaning.

**Deliberately absent, with the reason:** no `PATCH` (no draft-edit operation exists in the
configuration service), no `/validate` (publication IS the validation for routing — one walk, not
two), no `/archive` and no `DELETE` (no archive transition exists; published versions are immutable
FK targets of `PurchaseDocument.lineRoutingVersionId`, ON DELETE RESTRICT). PATCH/PUT/DELETE answer
404 because no such route exists — the surface does not promise operations the domain cannot honour.

## F. REQUEST / RESPONSE CONTRACTS

**POST `commerce/routing-versions`** — body (`CreateLineRoutingVersionDto`):

```json
{
  "versionLabel": "1404-01",
  "trigger": "PURCHASE_SUBMITTED",
  "noRouteBehavior": "LEAVE_UNROUTED",
  "multipleMatchBehavior": "HIGHEST_PRIORITY",
  "aggregationPolicy": "INDEPENDENT",
  "routeRules": [
    { "priority": 1, "targetWorkflowDefinitionVersionId": "<uuid v4>", "condition": null,
      "description": "standard lines" }
  ]
}
```

201 with the created row as a VIEW (never the Prisma row):

```json
{ "id": "<uuid>", "versionLabel": "1404-01", "status": "DRAFT",
  "trigger": "PURCHASE_SUBMITTED", "noRouteBehavior": "LEAVE_UNROUTED",
  "multipleMatchBehavior": "HIGHEST_PRIORITY", "aggregationPolicy": "INDEPENDENT",
  "routeRules": [ … exactly what was sent … ], "createdAt": "…", "updatedAt": "…" }
```

There is NO `tenantId`, no `status`, no `id` and no `createdAt` in any request; `tenantId` is refused
by the pipe (422), and so are `status`/`id`, because the lifecycle is walked by the routes that own it.

**GET `commerce/routing-versions`** — query: the shared `CommercePageQueryDto` (`page`, `pageSize` ≤
100, `search` matched case-insensitively against `versionLabel`, the row's identifying column).
Response: `{ items: [view…], page, pageSize, total }`, ordered `createdAt desc, id asc`.

**GET `commerce/routing-versions/:id`** — `:id` is a UUID v4 (`ParseUUIDPipe`). 200 with one view;
404 (`Workflow line routing version not found`) for an unknown id OR one belonging to another tenant.

**POST `commerce/routing-versions/:id/publish`** — no body. 200 with the view, `status: "PUBLISHED"`.
Refusals in §L.

## G. PERMISSION MODEL (from source — no new permission)

- reads → `commerce.read` (the module's list/read convention);
- create/publish → `commerce.workflow.manage`.

Basis: the routing row's status column IS `WorkflowDefinitionVersionStatus` (the schema says "reuses
the established Aria version lifecycle"), the module assigns `commerce.workflow.manage` to exactly
that lifecycle ("author, validate, publish, archive" — `workflow-configuration.controller.ts`), and
the UI-4 settings mapping states the same split (`CommerceSettingsView.tsx`: `commerce.workflow.manage`
→ "versions, steps and the validate/publish/archive walk"). No new permission was created and the
permission catalogue's count is unchanged; unauthenticated requests answer 401, a member without the
permission answers 403 (measured in C3-B).

## H. ACTOR MODEL

`resolveCommerceActor(req)` — the module's one resolver — is called in EVERY handler; the controller
passes the actor to the service, which scopes with `actor.tenantId`. `req.body.tenantId`,
`query.tenantId`, `params.tenantId` and `req.user.tenantId` are not consulted anywhere (the isolation
suite scans for exactly that pattern), and no DTO carries a tenant or a user field.

## I. TENANT ISOLATION

`tenantId` is the FIRST argument of every repository method the new reads touch; every query is
tenant-qualified; `findUnique` appears nowhere; the list is both tenant-qualified and window-bounded;
cross-tenant reads answer 404 (not 403, which would confirm the row exists). This is structural, not
controller validation: the repository cannot address a row without the tenant predicate. Measured in
C3-C, including the same label being legal in two tenants and a smuggled `tenantId` being refused
(422) on both the read and the write.

## J. REPOSITORY / SERVICE ARCHITECTURE

```text
WorkflowLineRoutingController      (HTTP only: decorators, ParseUUIDPipe, resolveCommerceActor + delegate)
  → WorkflowLineRoutingConfigurationService   (application surface: label rules, page window, view)
      → WorkflowLineRoutingRepository         (ALL Prisma access; tenantId first; no findUnique)
          → CommercePrismaService             (commerce_db only)
```

- The controller contains no rule, no query and no validation beyond the pipe; it never inspects
  `routeRules` to choose a group, a workflow or a winner.
- The service composes the EXISTING gate: `publishVersion(actor, id)` is a thin wrapper over
  `publish(actor.tenantId, id)` — the C1/O walk, unchanged, still the single authority for what may be
  published — and answers with a serialized view so no Prisma row reaches the wire.
- Two additive reads were added to the repository: `findByLabel` (the create-time collision read, the
  same shape `WorkflowConfigurationRepository.findVersionByLabel` uses) and `listPage` (rows + total in
  ONE `$transaction`, `createdAt desc, id asc`, bounded by the caller's window). Both are reads on the
  model the file already owns, so the ownership matrix in `commerce-isolation.spec.ts` is untouched.
- Route resolution itself did not move: `WorkflowLineRoutingService.routeLinesForDocument` and the pure
  planner remain the only place a line is matched to a version.

## K. VALIDATION RULES

| Layer | Enforces |
|---|---|
| HTTP DTO | `versionLabel` non-empty ≤ 64 (`VARCHAR(64)`); `trigger` ∈ `WORKFLOW_TRIGGER_EVENTS`; the three policy fields ∈ O2/O3/O4 tuples; `routeRules` 1..`RULE_LIMITS.maxRulesPerSet`; each route's `priority` ∈ the ENGINE's `[minPriority, maxPriority]`; `targetWorkflowDefinitionVersionId` a UUID v4; `condition` an object or null; `description` non-empty ≤ `RULE_LIMITS.maxRuleNameLength`; page window bounds; whitelist (so `tenantId`/`status`/`id` are 422) |
| Service | the label trimmed, non-empty and bounded again (an internal caller cannot skip the DTO); the label's uniqueness pre-read; the page window clamped to the module ceiling |
| Publish walk (existing, unchanged) | trigger / no-route / multi-match / aggregation vocabularies against the same tuples; `routeRules` a non-empty array of well-formed routes; the frozen LINE fact allowlist; `validateRuleSetVersion` on the built `commerce.workflow.line.selection` set; target exists, is PUBLISHED and belongs to the actor's tenant; every step's `actorSource` is `CONFIGURED_USER` |

The structural half is deliberately NOT duplicated in the DTO: it needs the database and the rule
engine, and it is applied to the STORED row — which is also why a DRAFT may point at a workflow
version that is not published yet (creation is legal; publication is what refuses it).

## L. CONFLICT / CONCURRENCY SEMANTICS

| Condition | Answer |
|---|---|
| label already used in this tenant | **409** `WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN` (pre-read; the schema's `@@unique([tenantId, versionLabel])` remains the guarantee for the race the read cannot see) |
| publishing an already PUBLISHED version | **409** `WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED` ("A published routing version is immutable; create a new version instead.") |
| publishing an ARCHIVED version | **409** `WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED` ("An archived routing version cannot be published.") — the existing code and message, unchanged |
| target not found / not published / another tenant | **409** `WORKFLOW_LINE_ROUTING_TARGET_INVALID` |
| target has an unsupported actor source | **409** `WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED` |
| a fact outside the frozen catalogue | **409** `WORKFLOW_LINE_ROUTING_FACT_NOT_ALLOWED` |
| built rule set invalid | **409** `WORKFLOW_LINE_ROUTING_RULE_SET_INVALID` |
| unknown id, or another tenant's id | **404** |
| malformed body / unknown field / bad enum | **422** `VALIDATION_FAILED` (the global pipe) |

No optimistic-concurrency token was added: the domain has none (published rows are never edited), and
adding one would invent a mechanism nothing defined. The one state race that exists — publishing the
same draft twice — is settled by the second call reading `PUBLISHED` and answering the 409 above.

## M. COMMERCIAL GROUP RELATIONSHIP

None, and none was invented: a routing version targets a `WorkflowDefinitionVersion`, not a
`CommercialGroup`. The commercial slice's own configuration (P) keeps its `assignmentRules` and its
`commercialGroupId` references; line routing never reads or writes them. The two configuration spaces
meet only at the O4-D3 matrix, through the approved O→P boundary, exactly as before.

## N. WORKFLOW RELATIONSHIP

Routing CONFIGURATION is a workflow-scoped configuration: its targets are published workflow
definition versions, its rule set id is `commerce.workflow.line.selection`, and its lifecycle status
is the workflow version lifecycle. It remains separate from (and does not merge with) the workflow
definition/version configuration surface (M), the execution surface (N) and commercial approval (P):
no route in C3 touches a `WorkflowInstance`, a `WorkflowStepInstance` or a `PurchaseDocument`'s
status, and no workflow route gained a routing field. Regression coverage: the C1/C2 lifecycle suite
(V-A…V-H, C2-A…C2-F) still passes unchanged alongside the new C3 scenarios (C3-G re-proves the
runtime resolution directly).

## O. MIGRATION / INDEX CHANGES

**None.** No schema change was required and none was made: the model, its unique keys
(`[tenantId, versionLabel]`, `[tenantId, id]`) and its index (`[tenantId, status, trigger]`) already
support every query the surface issues. No speculative index was added: the list read is bounded
(take ≤ 100) and tenant-qualified, and no measured query proves an index is required — so
`prisma/migrations` gained no directory and `prisma db push` was never used.

## P. TESTS ADDED

| File | Tests | What it pins |
|---|---|---|
| `workflow/workflow-line-routing.dto.spec.ts` (new) | 13 | the wire contract: required fields, every closed vocabulary from both ends, the label width, the engine's priority/rule-count/name bounds, UUID v4 targets, condition shape, and the forbidden `tenantId`/`status`/`id` |
| `workflow/workflow-line-routing-configuration.service.spec.ts` (extended) | +10 (20 total) | create (DRAFT, trim, tenant from actor, view without tenant), the label 409 and its code, the service-side label guarantees, the list window/clamp/search and envelope, get 404, publish delegating to the EXISTING gate (`findPublishedVersion` + `publish` called), and the gate's refusals travelling unchanged |
| `workflow/workflow-line-routing.repository.spec.ts` (new) | 6 | tenant-qualified `where` on all four reads, the conditional `updateMany` publish, the one-snapshot bounded list with `createdAt desc, id asc` and the identifying-column search, and `findUnique` appearing nowhere |
| `commerce-isolation.spec.ts` (updated, measured) | 34 (unchanged count) | controller set 8 → 9, surface 52 → 56, the A1 absence-pin replaced by the pinned registration, the permission per route, the decorator chain, the actor-per-handler scan, and every untouched boundary re-proved |
| `test/commerce-lifecycle.e2e-spec.ts` (extended) | +8 | the C3-A…C3-H scenarios below, through the real boundary stack (harness pipe, guards, controllers, services, repositories, `commerce_db`) |

No existing assertion was weakened: the isolation suite's route surface GAINED four lines and no
existing line moved; the one absence-pin that had to change was replaced by the registration that
makes it true, exactly as C2 replaced its own for the execution controller.

## Q. VALIDATION RESULTS (measured, in this workspace)

| Gate | Result |
|---|---|
| Targeted line-routing unit suites (planner, integration, configuration service, configuration repository, DTO) | **5 suites / 57 tests — pass** |
| Targeted repository guard (`workflow-configuration.repository.spec.ts`, module-wide) | pass |
| Isolation suite (`commerce-isolation.spec.ts`) | **34 / 34 — pass** |
| Schema suite (`commerce-schema.spec.ts`), gateways suite | pass |
| Full API unit suite (`npx jest --runInBand`) | **196 suites / 3224 tests — 0 failures** (C2 baseline: 194 / 3195) |
| Commerce e2e — lifecycle | **1 suite / 25 tests — pass** (17 unchanged + 8 new C3) |
| Commerce e2e — integration + tenant | **2 suites / 33 tests — pass** (unchanged) |
| TypeScript (`tsc --noEmit -p tsconfig.json`) | clean |
| `prisma validate` (commerce schema) | valid |
| `prisma generate` | regenerated (client is gitignored, built at build time) |
| `prisma migrate deploy` | 11 migrations found, **no pending** — no drift, no new migration |
| ESLint (every touched file) | **clean** — the only findings in a touched file are two PRE-EXISTING `no-unused-vars` in `commerce-isolation.spec.ts` (`UNTOUCHED_BY_DELEGATE`, `allRawSql`, both C1-era and visible in the pre-phase lint log), left alone as unrelated cleanup; `test/commerce-lifecycle.e2e-spec.ts` is not covered by the eslint `tsconfig.eslint.json` project (pre-existing configuration, C2's file already had the same outcome) |
| Prettier (touched files) | my new/edited regions conform; the ONE remaining warn is `workflow-line-routing.ts`, whose non-conformance **predates C3** (step O shipped the `REASON_*` constants, the outcome union and the sort comparator in a form prettier would reflow) — left untouched rather than reformatting another phase's code |
| Architecture / policy suites | included in the 196-suite run (runtime-policy, architecture-boundaries, entitlement, tenant, guard suites) |

Every gate above was re-run on the FINAL tree (after the formatting pass): the unit suite, the three
e2e suites, TypeScript, ESLint and the targeted routing suites all re-confirmed green.

Baseline failures: none introduced. The HR e2e specs (`hr.e2e-spec.ts`, `hr-runtime.e2e-spec.ts`)
remain the pre-existing, commerce-independent failures C2 recorded (37F/12P standalone) — out of this
phase's scope and untouched by it.

## R. E2E SCENARIOS — FINAL STATE (through the real boundary stack)

- **C3-A** — an authorized reader pages the collection (envelope echoed, `total` a number) and reads
  the fixture's PUBLISHED version back with its `routeRules`; no `tenantId` anywhere on the wire.
- **C3-B** — no principal → **401** on all four routes; the read-only member reads the collection (200)
  and is refused **403** on create and on publish.
- **C3-C** — the SAME label is legal in two tenants; B cannot read or publish A's version (**404**),
  A cannot read B's; neither list contains the other's id; a `tenantId` query parameter and a
  `tenantId` body field are both **422**.
- **C3-D** — create the exact supported schema → **201 DRAFT**, read back exactly what was written,
  newest-first ordering proved with a second draft, **no update route** (PATCH → 404), publish →
  **200 PUBLISHED**, republish → **409** with `WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED`, and
  the published row reads back PUBLISHED.
- **C3-E** — bad trigger / bad policy / empty `routeRules` / non-UUID target / missing fields → **422**;
  a DRAFT pointing at a non-published target → publish **409** `WORKFLOW_LINE_ROUTING_TARGET_INVALID`
  with the row still DRAFT; a condition naming a fact outside the frozen catalogue → **409**
  `WORKFLOW_LINE_ROUTING_FACT_NOT_ALLOWED`.
- **C3-F** — a duplicate label in one tenant → **409** `WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN`, and
  exactly one row with that label exists afterwards (the refusal wrote nothing).
- **C3-G** — a submitted document still routes its line through the PREVIOUSLY published
  `PURCHASE_SUBMITTED` version and pins THAT version (not the C3-published one), and the tenant still
  has exactly one published version for that trigger.
- **C3-H** — the C3-authored rows are removed with tenant-scoped, explicit predicates, leaving the
  fixture's published slot and the file's invariants exactly as they were found.

## S. ARCHITECTURE / POLICY RESULTS

Green, without a single relaxation: the module still owns `commerce_db` only, the repository boundary
holds (the controller and service issue no Prisma statement), the actor is resolved per handler from
the session, every route carries the entitlement chain and exactly one `commerce.*` role, the
ownership matrix and the seam list are unchanged (the two new reads are on the file's OWN model), D7's
audit accounting is unchanged (the configuration service still records no audit — its C1/O-measured
silence, recorded in §Y), and no `tenantId` appears in a DTO.

## T. FRONTEND COMPATIBILITY

**No change, and none required.** UI-4 contains no routing client or type: it documents the
«مسیردهی اقلام» branch as ABSENT because no HTTP surface existed, so there is no shape to stay
compatible with. The backend API was not bent toward any UI expectation, and the UI was not bent
toward the API: the settings branch can be added in a later UI phase against this documented
contract. No web file was touched, so no web gate was re-run (the frontend suite's own honesty
assertions scan frontend sources only and remain true).

## U. FILES CREATED

- `apps/api/src/modules/commerce/workflow/workflow-line-routing.controller.ts`
- `apps/api/src/modules/commerce/workflow/workflow-line-routing.dto.ts`
- `apps/api/src/modules/commerce/workflow/workflow-line-routing.dto.spec.ts`
- `apps/api/src/modules/commerce/workflow/workflow-line-routing.repository.spec.ts`
- `docs/PHASE-C3-LINE-ROUTING-CONFIGURATION-HTTP-CONTRACT.md` (this file)

## V. FILES MODIFIED

- `workflow/workflow-line-routing.ts` — the three policy vocabularies + the label width exported as
  tuples (ADDITIVE; values unchanged), so the DTO and the publication gate read one statement each.
- `workflow/workflow-line-routing.repository.ts` — `findByLabel` + `listPage` (additive tenant-first
  reads on the model the file already owns) and a header note. No write path was added.
- `workflow/workflow-line-routing-configuration.service.ts` — the four application methods
  (`createVersion`, `listVersions`, `getVersion`, `publishVersion`), the view + its serializer, the
  label-collision code, and the four vocabulary constants turned into aliases of the shared tuples
  (VALUES unchanged). `publish` and `validateShape` are untouched.
- `workflow/workflow-line-routing-configuration.service.spec.ts` — the collaborators the surface
  composes (mock-only) and 10 new tests.
- `commerce.module.ts` — one controller import and one registration entry.
- `commerce-isolation.spec.ts` — the measured pins: controller set 8 → 9, route surface 52 → 56, the
  CONTROLLERS/CONTROLLER_SURFACE artifacts, the A1 registration check (replacing the absence-pin with
  its own replacement), and the two prose counts.
- `test/commerce-lifecycle.e2e-spec.ts` — the controller mounted in the harness module and the
  C3-A…C3-H scenarios.
- `docs/PHASE-C1-O-LINE-ROUTING-CONTRACT.md` — an appended status amendment (§C3 AMENDMENT), nothing
  else touched.
- `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md` — an appended §UI-C3 amendment + footer, nothing else
  touched.

## W. GIT STATUS

Not committed (the phase's report is the deliverable; the C2 work is ALSO still uncommitted in this
working tree, and C3 must not stage another phase's files). C3's own entries:
`apps/api/src/modules/commerce/commerce.module.ts`, `commerce-isolation.spec.ts`,
`workflow/workflow-line-routing*.ts` (service, repository, planner, + 2 new specs, + new controller
and DTO), `apps/api/test/commerce-lifecycle.e2e-spec.ts`, and the four docs above. Everything else in
`git status` (web/UI shots, `nav-catalogue.ts`, the C2 slice, `next-env.d.ts`) belongs to other,
earlier phases and was not touched or staged by C3.

## X. COMMIT

None. No commit hash exists for this phase.

## Y. REMAINING COMMERCE GAPS (re-classified from current source)

| Gap | State after C3 |
|---|---|
| GAP-1 workflow execution HTTP | **CLOSED** (C2) |
| GAP-1b pending-decision inbox | **CLOSED** (C2) |
| GAP-2 line-routing configuration HTTP | **CLOSED** (this phase) |
| GAP-3 `PurchaseDocument → CLOSED` | STILL OPEN — no writer; untouched |
| GAP-4 KPI / summary | STILL OPEN — intentionally deferred to a future Reporting module |
| GAP-5 Commerce-wide search | STILL OPEN — untouched |
| GAP-6 quotation / remaining commercial capability | STILL OPEN — untouched |
| GAP-7 audit / timeline read | STILL OPEN — untouched (C3 added no audit write and no audit read) |
| GAP-8 member / seed mismatch | PARTIAL — untouched |
| GAP-9 notifications | STILL OPEN — untouched |
| GAP-ENV deployment / runtime alignment | STILL OPEN — untouched |

## Z. UNKNOWNS / DECISIONS REQUIRED (stated, not guessed)

1. **Draft-edit semantics are UNDEFINED.** Nothing in the O contract says whether a DRAFT may be
   edited, by whom, or whether an edit invalidates a prior validation. C3 therefore exposed NO update
   route; a future phase needs a contract decision before one exists.
2. **Archive semantics are UNDEFINED for routing.** `WorkflowLineRoutingVersion` reuses the version
   lifecycle enum (which has ARCHIVED), and `publish` refuses an ARCHIVED row — but no operation
   archives one and no rule states what archiving a published routing version means for documents
   pinned to it (`ON DELETE RESTRICT` keeps the row alive; retirement would be a status change).
3. **"Exactly one published version per tenant and trigger" is a CONVENTION, not a constraint.**
   `findPublishedForTrigger` has no tie-break, and the schema has no partial unique index for it. C3
   left both facts exactly as they were and its tests avoid creating a second published version; a
   future phase that wants a replace-published-version flow must decide the tie-break (or add the
   index) deliberately.
4. **`VALIDATED` is never written for routing.** `publish` accepts DRAFT or VALIDATED, but no path
   walks DRAFT → VALIDATED, and C3 declined to invent one: for routing, publication IS the validation.
   If a two-step walk is wanted later, it needs its own contract (what validation means at DRAFT
   level).
5. **Routing configuration writes are still UNAUDITED** — the C1/O-measured silence the isolation
   suite pins in D7 (the file performs no delegate write and records no event; the runtime routing
   service, not this one, carries the `line_routing_*` audit trail). Adding configuration audit is a
   deliberate GAP-7-adjacent decision, not a C3 side effect.
6. **No index supports `ORDER BY created_at DESC` for the list.** Not added, because no measured query
   requires it and the prompt forbids speculative indexes; the read is bounded (take ≤ 100) and
   tenant-qualified. If a tenant ever holds enough routing versions for it to matter, an additive
   index is the minimal fix.
7. **The frontend does not call these routes yet** (expected: backend-only phase). The adoption
   contract is the §UI-C3 amendment in the UI-0 document.

## ACCEPTANCE CRITERIA (§26 of the phase brief) — ALL SATISFIED

- [x] Existing Line Routing contract inspected (C1-O, read in full, plus its O4 amendment)
- [x] Existing service/domain behaviour verified (publish walk, planner, runtime resolution)
- [x] Real production HTTP surface exists (four routes, registered in `commerce.module.ts`)
- [x] Exact endpoint contract documented (§E, §F)
- [x] Authentication enforced (401 measured)
- [x] Commerce entitlement enforced (`@RequiresModule` + `@RequiresFeature` + `ModuleEntitlementGuard`)
- [x] Correct EXISTING Commerce permission enforced (`commerce.read` / `commerce.workflow.manage`)
- [x] Actor resolved from the authenticated request (`resolveCommerceActor(req)` per handler)
- [x] Tenant derived from actor/context; no client-provided tenantId (422 measured)
- [x] Repository boundary preserved (no Prisma in controller/service)
- [x] Commerce Prisma only (commerce_db; isolation suite green)
- [x] Existing Line Routing semantics preserved (C3-G; C1/C2 suites unchanged and green)
- [x] No routing logic duplicated in the controller (delegation only)
- [x] All supported operations covered (list, read, create, publish) — and only those
- [x] Validation verified (§K; DTO + service + the domain walk)
- [x] Conflict semantics verified (§L; measured in C3-D/E/F)
- [x] Tenant isolation verified (C3-C; repository reads tenant-first)
- [x] Authorization verified (C3-B)
- [x] Existing service behaviour regression-tested (the C1/O suites + C3-G)
- [x] Workflow compatibility checked (submit → line run → pin, unchanged)
- [x] Commercial Group compatibility checked (no relationship exists; none invented)
- [x] Architecture/isolation tests green (34/34, no assertion weakened)
- [x] API contract documented (this file + the two amendments)
- [x] No unrelated gaps implemented
- [x] No frontend redesign (no web file touched)
- [x] Full required validation green (§Q)

---

## FINAL STATUS

COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-2
