# PHASE 54 — PLATFORM RULE ENGINE — SPECIFICATION FREEZE (54-A)

> **This is a SPECIFICATION / DECISION artifact. It contains no business implementation.**
>
> Phase 54's requirements arrived as an approved product brief and did **not** exist anywhere in
> this repository: at freeze time `docs/reports/` stopped at `PHASE_52-ARCH-3C`, and a
> repository-wide search for `Phase 54` / `PHASE_54` / `phase-54` returned **zero hits**. This
> document therefore *establishes* the repository's authoritative Phase 54 numbering and answers
> the ambiguities that would otherwise have been resolved by guessing inside a migration.
>
> Everything below is either **(a)** a decision this document freezes, or **(b)** a statement
> read off the live repository at the baseline below, cited to the file that makes it true.
> Where a requirement would have needed an invented business policy, it is listed under §39
> (STOP conditions) or §40 (deferred) instead of being filled with a plausible default.

## Baseline at freeze time

| Item | Value |
|---|---|
| Branch | `master` |
| HEAD | `c91485e` — *Phase Gate A: Production-Grade JWT Key Provisioning via Docker Compose secrets* |
| Working tree | 12 modified files, all `apps/api/test/*.e2e-spec.ts` (pre-existing, untouched by 54-A) |
| Untracked | pre-existing gate/QA artifacts (`secrets/`, `tmp-gate-a/`, `tmp-gate-b/`, `backups/`, `lovable/`, shot folders, log files) — untouched, none staged |
| Gates | 52-ARCH-3C PASS · 52-ARCH-3C-R1 PASS · Gate A PASS · Gate B PASS · Commerce STOP |
| Tracked change added by 54-A | `docs/reports/PHASE_54_PLATFORM_RULE_ENGINE_SPEC.md` (this file), and nothing else |

---

## 1. SCOPE

Phase 54 delivers a **typed, versioned, explainable, deterministic platform-level rule engine**
— built by EXTENDING the existing `apps/api/src/rules/` engine, never by adding a second engine
beside it — plus the **first consumer** of that engine: HR/Leave approval and leave-limit rules.

In scope:

1. **Platform rule engine (reusable execution semantics).** Typed declarative rule definitions,
   a pure evaluator, validation, explicit deterministic ordering, conflict diagnostics, rule
   versioning with an immutable publish lifecycle, match history, explanation and non-mutating
   simulation.
2. **Entitlement.** Which tenancies may use a module/feature at all, expressed **only** through
   the existing platform entitlement surface (`ModuleRegistration.enabled` + `tenantScope`/
   `tenantIds`), never through a rule and never through HR data.
3. **HR/Leave as the first consuming domain.** Leave *policy* configuration and *approval
   runtime* owned by `hr_db`; leave limits; sequential approval routing; substitute (fallback)
   approvers; rejection reasons; the approval-aware leave lifecycle.
4. **Explainability and simulation, API + UI.** `SIMULATION — NO DATA CHANGED`.
5. **Three presentation levels over one engine** (simple / intermediate / advanced), so the same
   typed model serves an employee, a manager, an HR administrator and a platform administrator
   without exposing JSON, SQL or rule internals to ordinary users.

Out of scope — and explicitly refused in this phase — is listed in §4 and §40. The single most
important scope statement is the storage boundary frozen as decision **D1** (and carried through the
layering in §6.1 and the HR model in §15): *reusable rule execution belongs to Platform; business
rule configuration belongs to the consuming bounded domain.*

---

## 2. AUTHORITATIVE DECISIONS D1–D13

These thirteen decisions are **authoritative and frozen** by this document. Implementation may
not silently re-decide any of them; a change requires an amendment to this file, in its own
phase, with its own review.

### D1 — RULE STORAGE OWNERSHIP

The Rule Engine implementation is **platform-level and reusable**. Rule **configuration data**
belongs to the domain that owns the business semantics.

| Owner | Owns |
|---|---|
| Core / platform | module and feature **entitlement** (`ModuleRegistration.enabled`, `tenantScope`, `tenantIds`) |
| Platform Rule Engine (`apps/api/src/rules/`) | evaluation, validation, explanation, simulation, version *semantics*, deterministic execution |
| HR / `hr_db` | leave policy configuration and versions, leave approval definitions and step definitions, leave substitute definitions, leave approval **runtime instances**, and the historical configuration references those instances point at |

- Leave business-rule data is **NOT** moved into `core_db` merely because the engine is reusable.
- **No Core → HR database foreign keys.** `hr_isolation` already makes the reverse impossible
  (`hr-isolation.spec.ts` rule 2: no Core Prisma client in HR, no `@relation` into Core).
- Where the reusable engine needs external context, it receives it through **typed domain ports
  / interfaces** (a resolved value passed in), never by reaching for a database.

### D2 — LEAVE LIFECYCLE

This phase **is** the phase that introduces approval-aware leave semantics. Minimum lifecycle:

```
PENDING → APPROVED
PENDING → REJECTED
PENDING → CANCELLED
```

`APPROVED`, `REJECTED` and `CANCELLED` are **terminal**. `COMPLETED`, `PAID`, `POSTED` and
`ARCHIVED` are **not** added unless separately authorized (§40).

- `LeaveRequest.status` is the **business-level current state**. Nothing else.
- Detailed approval history is **separate**:
  `LeaveRequest → LeaveApprovalInstance → LeaveApprovalStepInstance[]`.
- **Do NOT** put `approver1` / `approver2` / `approver3` (or any equivalent) on `LeaveRequest`.
- Historical leave data is preserved; the existing `PENDING`/`CANCELLED` semantics are not
  destroyed; the migration maps every historical state explicitly (§37).
- The four-part atomic change already written into the repository as a maintenance contract
  (`prisma/hr/schema.prisma` lines 747–753, `src/modules/hr/domain/leave-status.ts`) is honored
  in ONE change: the enum member, the database-side state discipline in the migration, the
  transition table and the permission with its Core seed row move together.

### D3 — SUBSTITUTE APPROVER (NOT PARALLEL APPROVAL)

There is **no true parallel approval** requirement in this phase. "Parallel" in earlier
discussion is clarified as **SUBSTITUTE / FALLBACK APPROVER**:

```
Step 1:   Primary approver = X     Substitute approver = Y
X available   → the step is routed to X
X unavailable → the step is routed to Y     (never to both)
```

- **Do NOT** route to X and Y simultaneously. **Do NOT** implement quorum, majority approval,
  parallel branches, AND gateways or OR gateways (§40).
- Substitute configuration lives in the **HR/Leave** domain and may carry `effectiveFrom`,
  `effectiveTo`, a primary approver, a substitute approver and an activation condition.
- References are **tenant-safe and same-domain** (composite `(tenant_id, …)` foreign keys, the
  HR tenancy doctrine), never a Core user identity used as authority.

### D4 — SIMULATION AND EXPLANATION

Simulation and explainability are **both required**, and both ship **API + UI**.

- Backend: rule evaluation API, simulation API, explanation model.
- Frontend: HR/Leave settings and configuration UI, simulation UI, and role-appropriate
  explanation UI.
- Simulation is **explicitly non-mutating** and is labelled `SIMULATION — NO DATA CHANGED`.
  Simulation creates **no** leave record, **no** approval instance, **no** notification and
  **no** success-mutation audit event (§14, §26).

### D5 — UX LEVELS (THREE PRESENTATION LAYERS, ONE ENGINE)

| Level | Audience | Sees |
|---|---|---|
| **1 — SIMPLE** | employee | the business outcome and the explanation relevant to them (e.g. why a request was refused, who it is waiting for) |
| **2 — INTERMEDIATE** | manager / HR administrator | approval action, mandatory rejection reason, business-level policies, approval configuration, substitutes, limits, simulation |
| **3 — ADVANCED** | platform administrator | typed rule builder, versioning, conflict diagnostics, simulation, explanation, entitlement |

They are **three presentation layers over the same typed engine** — not three engines, not three
evaluation paths, not three validation implementations.

Ordinary users are never shown JSON, JavaScript, TypeScript, SQL or rule implementation
internals (§27–§32).

### D6 — REJECTION

- **Reject ALWAYS requires a reason.** Mandatory at the DTO, mandatory in the step-instance row
  (database CHECK), and no state transition occurs without it.
- **Approve**: reason optional, unless a more specific rule later requires one.
- **No success audit without a successful transition**: the audit event is written after the
  transition commits, and a refused transition writes a failed/refused event, never a success.
- The decision reason is **stored immutably** and the employee can see the reason relevant to
  their own request — and only that (§13, §22, §28).

### D7 — LEAVE LIMIT RULES (TYPED, COUNTING-BASIS AWARE)

The engine must support typed leave limits whose **counting basis is part of the type**, never
implied by a bare number:

| Field | Values frozen by this phase |
|---|---|
| leave type | a `LeaveType` of the same tenant (`hr_db`) |
| employment condition | an authoritative `EmploymentRecord` fact — `EmploymentType` = `FULL_TIME` / `PART_TIME` / `CONTRACT` / `TEMPORARY` / `INTERNSHIP` (`prisma/hr/schema.prisma`, enum `EmploymentType`) |
| maximum | a **positive** integer (`>= 1`); a limit of `0` is not expressible — "this leave kind is forbidden" is a different policy act and needs its own product decision (§16, §39) |
| counting basis | `REQUEST_COUNT` or `DAY_COUNT` |
| period | `YEAR` — offered as a named period kind and **expanded to an explicit inclusive window at configuration time** through `src/calendar/jalali.util.ts` (`jalaliToGregorian` + `jalaliMonthLength`), then stored as dates (§16.2) |
| counted states | which request states consume the limit — `APPROVED` only, or `APPROVED` + `PENDING` ("reservation") — declared by the rule, never hidden in a constant |

`REQUEST_COUNT` and `DAY_COUNT` are **different semantics**, not two spellings of one number.
The phrase *"3"* is meaningless without its counting basis, and the UI must never render a
maximum without it.

`DAY_COUNT` counts the **calendar days covered by the range** (inclusive: `end_date - start_date + 1`),
derived at evaluation time and never stored — upholding the schema's existing refusal of a stored
`duration_days` (`prisma/hr/schema.prisma` lines 697–711). **Working-day / holiday-adjusted counting
is NOT implemented**: HR has no read path to `CalendarOccasion`, so a workday count would be invented
arithmetic; it is deferred (§40).

**No additional legal/HR limits are invented.** Only the shapes above exist until a further product
decision authorizes more.

### D8 — APPROVAL ROUTING (SEQUENTIAL)

The primary routing mode is **SEQUENTIAL**:

```
Step 1 → X      (activated first)
Step 2 → Y      (activated only when Step 1 reaches its required decision)
Step 3 → Z
```

For every step the runtime records: order, the configured approver rule, the **resolved**
approver, the substitute configuration considered, the **resolution reason**, status, decision,
decision reason/comment, decision timestamp, and the **policy version** in force.

- **Historical approval instances are immutable records.**
- The authoritative person graph is **`EmploymentRecord.managerEmployeeId`** — an HR-internal
  employee reference, effective-dated and tenant-guarded, never a Core user id
  (`prisma/hr/schema.prisma`, the `EmploymentRecord` section). One step of the walk already
  exists as a bounded, tenant-scoped repository read:
  `EmploymentRepository.findManagerOfCurrentRecord()`.
- The chain walk is **bounded by a caller-owned maximum** and tenant-scoped at every step,
  mirroring the existing `evaluateAncestorStep` discipline
  (`src/modules/hr/domain/organization-hierarchy.ts`): one step per query, no recursion into a
  whole-subtree load, and a refusal rather than an unbounded traversal.
- The chain is a chain of **identified steps**, not an unbounded grant of authority: holding the
  approval permission does not confer authority over anybody else's steps (§25).

### D9 — APPROVER AVAILABILITY

"Approver unavailable" is a **configurable business rule**, and each signal must have an
**authoritative repository source**:

| Signal | Authoritative source | Status in Phase 54 |
|---|---|---|
| employee no longer active | `Employee.status` (`ACTIVE`/`INACTIVE`/`TERMINATED`) | available |
| employment interval ended | `EmploymentRecord.status` = `ENDED` / no open interval | available |
| configured substitution assignment ("active delegation") | `LeaveSubstitutionDefinition` effective window (`effectiveFrom`…`effectiveTo`), §19 | available |
| approver's own **decided** leave covering the step's activation day | the approver's `LeaveRequest` rows in `APPROVED` state — a bounded read of stored decisions, §20.4 | available |
| inactive login / standalone delegation record / out-of-office flag | **no authoritative source exists** (the directory port exposes no status; no delegation or availability table is authorized) | **NOT implemented** (§20, §40) |

Rules that follow from this:

1. Availability is resolved through a **bounded, read-only context** assembled by the
   application layer and passed into the pure evaluator (D12). The evaluator never queries.
2. **No recursive Leave → Leave evaluation.** The "on leave" signal reads **stored, already
   decided** rows only; it never triggers an approval evaluation, and a `PENDING` request never
   makes an approver unavailable. The read is one tenant-scoped query in a bounded window, never
   a nested evaluation.
3. A signal is not implemented merely because it is common. Adding one requires an authoritative
   source and an amendment to this document (§39).

### D10 — RULE VERSIONING

```
DRAFT → VALIDATED → PUBLISHED → ARCHIVED
```

- **Published versions are immutable.** Editing a published definition creates a **new** version;
  it never rewrites the published one.
- Existing leave requests and approval instances **retain** the policy/version reference they
  were created under — including the version they were decided under, after the tenant has moved
  on.
- New requests may use the newly published version. History is never rewritten when configuration
  changes (§23).

### D11 — CONFLICT RESOLUTION

Multiple matching rules are **never** resolved by array order, database insertion order,
"last created wins", or any runtime accident. The engine defines a **declared total ordering**:

```
1. priority      (higher wins)
2. specificity   (more specific condition wins, counted from the typed condition tree)
3. stable id     (lexicographic, ascending — the deterministic tie-break)
```

The implementation must make this ordering **explicit and total** (a comparator that breaks an
otherwise-equal pair by comparing the stable rule id), and must publish it in the explanation so
an operator can see *why* one rule won. Equal-authority **incompatible** rules (same priority and
same specificity, mutually exclusive outcomes, no declared precedence) must **fail validation /
publish**, never silently select one.

> Baseline note: today's engine relies on `Array.prototype.sort` stability for the equal-priority
> case (`rule-engine.service.ts`, `return 0`). Phase 54 replaces that undeclared dependence with
> the ordering above.

### D12 — PURE RULE ENGINE

```
RuleVersion + EvaluationContext + explicit evaluation date/time  =  deterministic result
```

The core evaluator **must not**: use Prisma, use HTTP, use a database, read environment
variables, call `USER_DIRECTORY`, write audit, mutate a leave request, send a notification,
execute code, or execute SQL. Domain/application layers assemble the context and apply actions.

This extends the falsifiable discipline HR already applies to its own domain tier
(`hr-application-boundaries.spec.ts`: every non-spec file under `domain/` has zero import
specifiers) to the engine core: the evaluation path depends on nothing it cannot be tested with.

### D13 — TYPED RULE LANGUAGE

User rules are **declarative and typed**. Never allowed: `eval`, the `Function` constructor,
JavaScript, TypeScript, SQL, shell, or any arbitrary executable expression. Every operand has a
**declared type**; unknown fields and type mismatches are **validation errors**.

Minimum operator vocabulary (frozen; §8 defines each precisely):

```
equals  notEquals  in  notIn
greaterThan  greaterThanOrEqual  lessThan  lessThanOrEqual
isEmpty  isNotEmpty
dateBefore  dateAfter  dateBetween
count
AND  OR  NOT
```

---

## 3. GOALS

1. **One engine, extended.** `apps/api/src/rules/` becomes the platform's rule engine with typed,
   versioned, explainable, deterministic evaluation. No second engine is created and the existing
   one is not left behind as a competing production implementation (§6, §7).
2. **Determinism as a contract, not an accident.** Same rule version + same context + same
   evaluation instant ⇒ byte-identical evaluation result, including match history and the
   ordering decision (D11).
3. **Explainability as a first-class output.** Every evaluation can answer "which rules were
   considered, which matched, which one decided, and on what stated grounds" — in a form a
   Persian-speaking HR operator and an employee can read (§13, §28–§32).
4. **Simulation without consequence.** An operator can ask "what would happen if…" and get the
   real engine's answer with `SIMULATION — NO DATA CHANGED` (D4, §14).
5. **Leave approval that is HR-real.** Sequential routing, substitutes, mandatory rejection
   reasons, immutable decision history, and limits whose counting basis is explicit (D6–D9).
6. **Entitlement respected.** A tenancy without the module/feature gets a refusal, not a silent
   partial experience; disabling never deletes (§4, §5).
7. **History is preserved and referenced, never rewritten.** Policy versions, approval instances
   and approval steps remain readable forever (§23, §35).

---

## 4. NON-GOALS

### 4.1 What Phase 54 does NOT implement

- Commerce (still STOP), payroll, expense engine, accounting engine, inventory engine.
- A generic workflow engine, generic BPMN, or a generic task engine.
- Arbitrary code rules, SQL rules, or any executable expression language.
- Parallel approval, quorum, majority approval, AND/OR gateways (D3, §40).
- A generic notification engine.
- A billing/subscription platform.
- Destructive module uninstall or data deletion when a module is disabled.
- A second rule engine beside `apps/api/src/rules/`, and any business policy implemented by the
  example rule set (`src/rules/rules/example.rule.ts` remains example/test-only).

### 4.2 DISABLE ≠ DELETE (module and feature disablement)

Disabling is an **access** decision, never a data decision.

**Disabling HR:**

- prevents access to HR surfaces;
- hides HR navigation;
- blocks runtime HR mutations;
- hides HR settings;
- **does NOT delete** historical HR data — employees, employment intervals, attendance, leave
  requests, leave types.

**Disabling Leave (as a feature inside HR):**

- prevents Leave operations (no create, no decision, no withdrawal);
- hides Leave navigation and Leave settings;
- **does NOT delete** leave requests, leave policy history, approval instances, approval steps or
  substitution history.

**Re-enabling** restores access to the preserved data and configuration. There is no
"re-provision" step and no data migration on re-enable, because nothing was removed.

### 4.3 How disablement is expressed (and how it is NOT)

The platform's authoritative entitlement surface already exists: `ModuleRegistration.enabled`
(default `false`) plus `tenantScope` (`ALL` / `RESTRICTED`) and `tenantIds`, enforced by
`ModuleRegistryService` resolution (`module-registry.service.ts`, failure code `MODULE_DISABLED`).
Phase 54 uses **that** surface and nothing else:

- **Entitlement is not a rule.** No leave policy, no rule definition and no rule evaluation result
  can grant or revoke module availability.
- **Entitlement is not HR data.** HR keeps no copy of "is HR enabled", because a copy would be a
  second authority that can disagree with the control plane.
- **HR's own process is honest about it.** HR is an independently deployable module that can run
  in a runtime that has no Core database (`hr.module.ts`; runtime policy serves HR in the
  `combined` runtime and reserves `future-hr`), so HR cannot consult Core's registry per request.
  Entitlement is therefore enforced at the boundary that *can* see it (the runtime that hosts the
  module and the Core-side surface), and HR must never assume Core is reachable in order to
  evaluate a rule — which is one more reason the engine core is pure (D12).

> **AMENDMENT 1 (Phase 54-C, D14 — see §43).** The sentence *"Phase 54 uses **that** surface and
> nothing else"* above is superseded **in part**: the **module** level remains exactly that surface
> and nothing else, while the **feature** level that §5 row 3 already names is specified in §43 —
> the same authority (Core-owned, `core_db`), never a column or a table in `hr_db`, so §5 rule 3
> stands untouched. No other clause of this section changes, and nothing in this amendment
> authorizes a rule to grant, revoke or observe entitlement.

---

## 5. PLATFORM ENTITLEMENT MODEL

| Layer | Question it answers | Where it lives | Can a rule change it? |
|---|---|---|---|
| Module registration | may this module serve this tenancy at all? | `core_db.ModuleRegistration` (`enabled`, `tenantScope`, `tenantIds`) | **No** |
| Instance operational state | what has the control plane done to this deployed instance? | `core_db` operational-state row, machine in `module-operational-state.ts` | **No** |
| Feature entitlement | may this tenancy use a feature *inside* an enabled module? | `core_db.ModuleFeature` / `ModuleFeatureGrant` (§43, D14), read through the `ENTITLEMENT_PORT` platform port — never by HR reading a table | **No** |

Rules of use for Phase 54:

1. Entitlement is evaluated **before** any rule evaluation, by the runtime/Core-side surface that
   owns it. A rule engine that could grant entitlement would make the entitlement surface
   advisory, which is exactly the failure the registry exists to prevent.
2. Entitlement **never** appears in a rule condition, a rule action, a leave policy, a limit rule
   or an approval definition.
3. Entitlement is **never** copied into HR rows: `hr_db` stores no `moduleEnabled` and no
   `featureEnabled` column (§24).
4. Disabling is non-destructive (§4.2); preserved data stays readable when re-enabled.
5. **No new entitlement table is introduced by this phase.** If a feature-level entitlement
   surface proves necessary, it extends the existing registry/entitlement ownership by amendment
   — it is not a new table in `hr_db`.
   **This amendment path was exercised in Phase 54-C (§43, D14):** the feature surface is Core-owned
   (`core_db.ModuleFeature` / `ModuleFeatureGrant`) and is recorded in §41's register and in this
   document's change log. The prohibition this rule carries is unchanged and absolute: **no
   entitlement table, column or copy exists in `hr_db`.**

---

## 6. RULE ENGINE ARCHITECTURE

### 6.0 Verified state of the existing engine at freeze time

| Fact | Evidence (read off the live repository) |
|---|---|
| The engine is small and in-memory | `src/rules/rule-engine.service.ts` (36 lines), `rule-registry.service.ts` (22 lines), rule sets in a `Map` |
| Exactly one rule set is registered anywhere | `src/rules/rules/example.rule.ts` → `core.example`, two rules |
| It is wired into the app but **consumed by no business domain** | `RulesModule` is imported by `app.module.ts:71` and `core-app.module.ts:74`; a repository-wide search for `RuleEngineService` matches only `src/rules/*` — no HR, CMS, correspondence, calendar or CQRS consumer |
| `evaluate()` is **synchronous** and returns **first match only** | the `for` loop returns `[rule.result(context)]` at the first match, so **no match history exists** |
| Version is declared but never set | `RuleResult.version?: string` (`rule.types.ts`) is never assigned; `RuleDefinition` and `RuleSet` carry no version |
| Ordering is priority-only, relying on V8 sort stability | the comparator returns `0` for equal priorities |
| Unknown set ⇒ `NotFoundException`; throwing rule ⇒ `InternalServerErrorException` | one bad rule kills the whole evaluation |
| Context is untyped facts + optional tenant | `RuleContext { facts: Record<string, unknown>; tenantId?; correlationId?; userId? }` |
| Existing tests pin today's contract | `rule-engine.service.spec.ts` (9 cases) and `rule-engine.service.integration.spec.ts` (3 cases over `core.example`) |

**Verdict:** a placeholder — unconsumed, synchronous, first-match oriented, weakly versioned, not
explainable enough for Phase 54, and deterministic only by accident rather than by declared
contract. It is nevertheless **the** engine, and Phase 54 extends it.

### 6.1 Layering

```
                    ┌─────────────────────────────────────────────┐
                    │  PLATFORM RULE ENGINE  (src/rules/)         │
                    │  pure: no Prisma, no HTTP, no audit, no env │
  rule version  ───▶│  validate │ order │ evaluate │ explain     │──▶ EvaluationResult
  typed context ───▶│           │       │          │ simulate    │    + match history
  eval instant  ───▶│                                             │
                    └─────────────────────────────────────────────┘
                                    ▲                      ▲
                     context assembled by        definitions/versions
                     the consuming domain         supplied by their owner
                                    │                      │
             ┌──────────────────────┴───────────┐   ┌──────┴───────────────────────┐
             │ HR application layer (hr_db)     │   │ HR-owned rule configuration  │
             │ LeaveService, approval service,  │   │ leave policy + approval      │
             │ tenant-scoped repositories       │   │ definitions (versioned rows) │
             └──────────────────────────────────┘   └──────────────────────────────┘
```

1. **Engine tier (pure).** Validation, ordering, specificity, evaluation, explanation assembly and
   simulation over a supplied context. Deterministic, framework-free.
2. **Definition tier (owner-supplied).** Definitions arrive as typed data from the owning domain
   or as in-process definitions for platform-internal sets. The engine never learns their origin.
3. **Context tier (owner-assembled).** Facts are resolved by the application layer through
   repositories/ports (`EmploymentRepository`, `LeaveRepository`, the bounded availability read).
   The engine receives values, never handles.
4. **Action tier (owner-applied).** A decision becomes a mutation (status transition, step
   activation, audit) only in the application layer, inside the caller's transaction.

### 6.2 Module, provider and registration boundary

- `RulesModule` remains the **single registration surface** for platform rule sets and the only
  place the example set is registered. The example set never becomes business policy.
- The pure engine is also provided through a **dependency-free provider module**, so a runtime
  that must not instantiate example/legacy rule sets can still evaluate (the HR runtime in
  particular). Exporting the *same* `RuleEngineService` from a narrower module is extension;
  introducing a second engine class is not permitted (§7).
- Registration is keyed by **rule-set id + version**. Today's `register()` throws on a duplicate
  id; that discipline is kept (a duplicate *id+version* is still an error) and versioning is added
  instead of loosening uniqueness.

### 6.3 Async evaluation

`evaluate()` gains an asynchronous form so DB-backed or port-backed context can be resolved
before evaluation, while the decision step itself stays synchronous and pure:

```
resolveContext(...)  →  evaluateSync(ruleVersion, context, evaluationInstant)  →  EvaluationResult
```

- `evaluateSync` is the deterministic core: no `await`, no I/O, no clock read (the instant is an
  argument).
- The async surface is the **caller's** boundary: assemble context, then call the pure core.
- The existing synchronous API keeps working for current in-process rule sets and stays covered by
  the existing specs; retiring it is a separate decision, not a side effect of this phase.

### 6.4 Failure isolation

- A rule that throws is **skipped** and recorded in the match history as an error entry (rule id +
  failure reason). One bad rule never turns the whole evaluation into a 500.
- An unknown/unpublished rule set is a **typed outcome** for the domain path (the HR caller turns
  it into a readable 409/422); the legacy synchronous API keeps `NotFoundException` for its
  existing contract.
- Validation failures are reported per rule with the offending field path (§7, §8).

---

## 7. RULE DEFINITION MODEL

A rule definition is **typed data**, not code. The minimum shape (field names are indicative;
the frozen constraints are the *semantics* and the *closedness* of the vocabulary):

```
RuleSetDefinition
  id                 stable, dot-namespaced, e.g. "hr.leave.limit"
  version            semver-ish string, monotone per set ("1", "1.1", "2")
  status             DRAFT | VALIDATED | PUBLISHED | ARCHIVED
  scope              PLATFORM | DOMAIN(domainKey)
  effectiveFrom/To    optional, dates — configuration validity, not evaluation time
  rules: RuleDefinition[]

RuleDefinition
  id                 stable, unique inside the set — the ordering tie-break (D11)
  name               human label (rendered by the UI, never parsed)
  priority           integer; higher wins
  when               ConditionNode (typed, closed vocabulary — §8)
  then               ActionSpec (typed — §9)
  description        optional, human text (inline help source, §32)
  deprecated         optional, boolean
```

Constraints:

1. **Closed fields.** A misspelled field is a validation error, never silently ignored (the same
   discipline `token-signing-keys.ts` applies to its entry fields).
2. **Stable ids.** A rule id is an identifier, not a label: renaming a rule for display never
   changes its id, because the id participates in deterministic ordering and in historical
   explanations.
3. **No code, no SQL, no template expressions.** `when` and `then` are data (§8, §9).
4. **Types declared, not inferred.** Every condition operand declares its type; the engine refuses
   a comparison between incompatible types at validation time.
5. **Specificity is derived, not authored.** Authors do not hand-write a specificity score (which
   would be a second, disagreeing authority); the engine computes it from the condition tree.
6. **Version is explicit.** A definition without a version cannot be published.
7. **Existing in-process interface preserved.** `RuleDefinition` (the TypeScript interface with
   `evaluate()`/`result()`) continues to exist for platform-internal and test rule sets, including
   the example set. Phase 54 adds the typed-data authoring path beside it; it does not delete the
   in-process one, and it does not let the example set become business policy.

## 8. RULE CONDITION MODEL

A condition is a **tree of typed nodes** with a closed set of operators.

### 8.1 Node kinds

```
{ all: ConditionNode[] }        — AND
{ any: ConditionNode[] }        — OR
{ not: ConditionNode }          — NOT
{ field, op, value }            — comparison / membership / emptiness / date / count
{ count: { over, where, op, value } }   — aggregate comparison (D7 limits)
```

### 8.2 Operators, exactly

| Operator | Operand types | Meaning |
|---|---|---|
| `equals` / `notEquals` | same declared type on both sides | equality after type-appropriate comparison (string equality is exact; dates compare as dates) |
| `in` / `notIn` | left: value; right: non-empty array of the same type | membership **inside** the array (deliberately different from the field name `in`, which holds the array) |
| `greaterThan` / `greaterThanOrEqual` / `lessThan` / `lessThanOrEqual` | number, or date | numeric/date ordering |
| `isEmpty` / `isNotEmpty` | string, enum, date | absence of a value (`null` or blank string) / presence of one |
| `dateBefore` / `dateAfter` | date | strict ordering against a date operand |
| `dateBetween` | date | inclusive range against `[from, to]` (a range with `from > to` is a validation error, never an always-false rule) |
| `count` | integer result vs. number operand | aggregate over a declared collection in the context (see §8.4) |

### 8.3 Field vocabulary and types

- **Every field is declared** in a field catalogue owned by the *consuming domain* (HR declares
  the leave field catalogue), with its type: `string`, `number`, `boolean`, `date`, `enum(...)`.
- **Unknown field ⇒ validation error.** No fallback to `undefined`, no implicit truthiness.
- **Type mismatch ⇒ validation error.** `greaterThan` on a string is refused, not coerced.
- **No hidden defaults.** A missing fact is `isEmpty`, explicitly; it never silently satisfies a
  comparison.
- **No cross-domain leakage.** HR's catalogue exposes HR facts. Core ownership facts (identity,
  entitlement) are not rule fields (§5).

### 8.4 `count` and collections

`count` exists because D7's limits are *aggregate* statements ("at most 3 requests of this type
this year"), and expressing that with per-row comparisons would be ambiguous.

```
count { over:    <collection name in the context>, e.g. "leaveRequestsThisYear"
        where:   [ConditionNode, ...]   (optional, evaluated against each item)
        op:      greaterThan | ... | lessThanOrEqual
        value:   number }
```

- The **application layer** supplies the bounded collection; the engine never queries (D9, D12).
- Bounded by an explicit maximum size; exceeding the bound is a validation/context error, not a
  silent truncation (§34).
- The counting **basis** (`REQUEST_COUNT` / `DAY_COUNT`) and the **counted states** are fields of
  the limit rule's typed configuration (§16), so a bare `3` is never ambiguous (D7).

---

## 9. ACTION MODEL

Actions are **typed outcomes an application layer applies**; the engine never performs them.

```
ActionSpec
  type        REQUIRED_APPROVAL_STEP | AUTO_APPROVE | AUTO_REJECT | LIMIT_REFUSAL |
              STEP_ACTIVATION | APPROVER_RESOLUTION | NOTIFY(declarative, deferred)
  parameters  typed per action type
```

Frozen rules:

1. **The engine produces decisions; the application applies them.** No action inside the engine
   writes a row, calls a repository, sends a message or writes audit (D12).
2. **Every action is explainable.** An action carries the rule id, the version, and the grounds
   (which condition leaves were true) so the explanation can be rendered without re-evaluating
   (§13).
3. **No free-form payloads.** Action parameters are typed fields, exactly like conditions; there is
   no `data: any` escape hatch.
4. **Notification is declarative only.** This phase declares (at most) *that* a notification would
   be produced for a decision; it builds no generic notification engine (§40).
5. **Simulation mode returns actions without executing them**, with the `SIMULATION — NO DATA
   CHANGED` marker (§14).
6. **Unknown action type ⇒ validation error** at publish time, never a runtime no-op.

## 10. RULE VERSIONING

1. A version is identified by **(rule-set id, version string)**. Both are required.
2. Versions are **monotone per set**: a new version is derived from a published one, and the
   published one is never mutated (D10).
3. **DRAFT** — editable, not evaluable by business paths.
   **VALIDATED** — passed validation (typed, conflict-free, no unknown fields); still not the
   version new decisions use until published.
   **PUBLISHED** — immutable; the version new evaluations resolve to.
   **ARCHIVED** — not selected for new evaluations; still resolvable for explanations and for
   historical references.
4. **Exactly one PUBLISHED version per set** (per scope) at a time. Publishing a new version
   archives the previous one in the same act.
5. **Historical references never rewrite**: an approval instance stores the rule-set id + version
   it was created under and the version that decided each step (§23). Reading history after a
   publish yields the *old* version's text, verbatim.
6. **Version text is stored, not recomputed** — a version's serialized definition is retained so
   an old explanation can be reproduced without trusting today's code (§13, §23).

## 11. PUBLISH LIFECYCLE

```
DRAFT ──validate──▶ VALIDATED ──publish──▶ PUBLISHED ──publish(next) / archive──▶ ARCHIVED
  ▲                     │                       │
  └──── edit (new) ─────┘                       └── no path back to DRAFT/DELETE
```

- **Validation is mandatory and total** before publish: unknown fields, type mismatches, missing
  versions, non-deterministic ids, unbounded collections and **conflicts** (§12) are refused.
- **Publishing is an audited act**: who published which version, when (through the owning domain's
  audit gateway — for HR, `HrAuditGateway`, §26).
- **No deletion.** An archived version stays readable; deleting policy history is not offered.
- **Effective dating is configuration, not evaluation time**: `effectiveFrom`/`effectiveTo` decide
  which version applies *now*; the evaluation instant is supplied separately and explicitly (D12).
- **Publish is not a mutation of live decisions.** Requests already in flight keep the version
  they started under (§10.5, §23).

## 12. CONFLICT RESOLUTION

### 12.1 Ordering (frozen)

```
1. higher priority wins
2. higher specificity wins
3. lower (lexicographically ascending) stable rule id wins
```

- The comparator is **total**: for any two distinct rules it returns non-zero. Equality of all
  three keys is impossible because rule ids are unique inside a set (D11).
- Ordering is computed from the **declared** definition, never from insertion order, array order or
  creation timestamps.

### 12.2 Specificity (derived, deterministic)

Specificity is counted from the typed condition tree, with a fixed rule:

| Construct | Contribution |
|---|---|
| a leaf comparison (`field op value`) | +1 |
| `count` comparison | +1 |
| `all` (AND) node | +2 per child node |
| `not` (NOT) node | −1 |
| `any` (OR) node | +0 (an alternative is not more specific) |

The exact weights are part of the frozen specification; they are **not** tunable per tenant,
because a tenant-tunable ordering would make the same configuration decide differently in two
tenancies and the explanation unexplainable.

### 12.3 Conflicts that must fail validation/publish

- two rules with the **same priority and same specificity** whose decisions are **incompatible**
  (different action types for the same decision point) and which have no declared precedence;
- two rules with the same **id** in one set/version;
- two rules that would both terminate the same step with different outcomes;
- a rule whose condition can never be true because of a **type contradiction** (validation error,
  not a silently dead rule).

**Diagnostics**: the validator returns a conflict report (rule ids, the conflicting dimension,
the computed ordering) so the UI can show it and the API can refuse the publish with a readable
message — never a silent winner (D11).

---

## 13. EXPLANATION MODEL

An evaluation returns not only a decision but **why**, in a shape that can be rendered without
re-evaluation and without exposing rule internals.

```
EvaluationResult
  ruleSetId, ruleSetVersion
  evaluationInstant            (explicit, supplied — D12)
  decision                     the winning action/decision, or NONE
  winningRule? { id, name, priority, specificity, version, action }
  matchHistory: MatchRecord[]  EVERY rule considered, in evaluated order:
      { ruleId, ruleName, priority, specificity, matched: boolean,
        failedLeaves?: field paths that were false,
        error?: { message }        (a rule that threw — §6.4)
        decision? }                (present for matching rules)
  orderingBasis                the three keys that produced the winner (D11)
  explanationText              human-rendable summary derived from the above
```

Frozen rules:

1. **Match history is complete and ordered** — every rule of the version appears, in the declared
   ordering, with whether it matched. This is the gap today's first-match engine leaves.
2. **Explanation is derived from the result, not re-computed.** Rendering an old decision must not
   depend on today's configuration (that is why the version text is retained, §10.6).
3. **No internals leak to ordinary users.** The *renderer* chooses the level of detail (D5, §27):
   an employee sees outcome + reason; a manager sees the decision and the step; an HR admin sees
   policy grounds; a platform admin sees the full ordering basis and match history.
4. **Persian-facing text is rendered by the UI from typed codes and values** — the engine emits
   codes, field paths, dates and numbers, not Persian prose, so the same explanation can be
   localised and reused (§32). (This mirrors the existing convention that failure codes, not
   sentences, cross a boundary: `TransitionFailure`, `CompatibilityFailure`.)
5. **Rejection reasons are part of the explanation** for a refused request, verbatim, because the
   reason is the human's statement and this system never re-words a person's own words (§22).
6. **Determinism extends to the explanation**: identical inputs produce an identical match history
   ordering (D11, §38).

## 14. SIMULATION

Simulation runs **the real engine** over a **supplied** context and applies **nothing**.

API shape (semantics frozen, naming indicative):

```
POST …/simulate
{
  ruleSetId, version?            (defaults to the currently published version)
  evaluationInstant?             (defaults to "now" ONLY at the API boundary; the engine always
                                  receives an explicit value — D12)
  context: <typed facts, same catalogue as a real evaluation>
  subject?: { employeeId }       (whose facts to assemble — never a client-supplied tenantId)
}
→
{
  mode: "SIMULATION",
  banner: "SIMULATION — NO DATA CHANGED",
  decision, winningRule?, matchHistory[], orderingBasis, explanationText,
  wouldApply: [ <typed actions, unapplied> ]
}
```

Frozen rules:

1. **Non-mutating, absolutely**: no leave record, no approval instance, no step, no notification,
   no success-mutation audit. (§26 names the one permitted trace.)
2. **Real engine, real validation, real ordering.** Simulation never uses a simplified evaluator;
   if the definition is invalid, simulation refuses with the same validation report as publish.
3. **Tenant-scoped by the actor**, never by the body: the tenant comes from the resolved HR actor
   (`resolveHrActor`, fail-closed), and no DTO in this phase declares `tenantId` (§24 — the HR
   doctrine already makes that a build-failing shape).
4. **Bounded**: a bounded collection size, a bounded evaluation count, and a bounded response size
   (§34).
5. **Labelled everywhere**: the banner is part of the response *and* part of the UI; a screenshot of
   a simulation must be impossible to mistake for a real decision.
6. **Permission-gated** (simulation requires the configuration/administration permission for the
   relevant level — §25), never available to an ordinary employee.

## 15. LEAVE POLICY MODEL

The rule **execution** is platform-level; the leave **configuration** it executes is `hr_db` data
(D1, §6, §24.4). The shape this phase freezes (table names are indicative; the constraints are not):

```
hr_db
├── LeavePolicy                     one tenant's stated policy, effective-dated, scoped to a
│                                   leave type and (optionally) an employment type
├── LeavePolicyVersion              an immutable published snapshot of a policy's rules
├── LeaveApprovalDefinition         the approval flow a policy version states
├── LeaveApprovalStepDefinition     one ordered step: approver rule + substitute + availability
├── LeaveSubstitutionDefinition     primary → substitute, effective-dated, with its condition
├── LeaveApprovalInstance           the runtime flow for ONE leave request
└── LeaveApprovalStepInstance       the runtime of ONE step: resolved approver, decision, reason
```

Frozen constraints:

1. **All seven belong to `prisma/hr/schema.prisma`.** None appears in `prisma/core/schema.prisma`,
   and no Core table gains a leave column. `hr_db` owns leave policy exactly as it already owns
   `LeaveRequest` and `LeaveType`.
2. **Tenancy is structural, as everywhere in `hr_db`**: a `tenant_id` column of TEXT (the platform
   tenant identifier, `20260916120000_hr_tenant_identifier_text`), plus a `@@unique([tenantId, id])`
   composite target so siblings can carry composite `(tenant_id, …)` foreign keys — the pattern
   `LeaveRequest_tenant_employee_fkey` / `LeaveRequest_tenant_leave_type_fkey` already demonstrate
   (migration lines 207, 213). A request can no more cite another tenant's policy than it can cite
   another tenant's leave type.
3. **Approvers are HR people, not Core identities.** A step's approver is an `Employee` of the same
   tenant (composite FK), never a bare Core user id; the login link is optional (`Employee.userId`)
   and is read only through `HrIdentityGateway` (§19, §20, §24).
4. **Effective dating follows the employment doctrine** (`effectiveFrom`, nullable `effectiveTo`,
   intervals never rewritten). Two policies or limits of the same scope with overlapping intervals
   must be refused, the way `20260916090000_hr_exclusive_interval_and_cycle_guards` refuses
   overlapping employment and attendance windows.
5. **No deletion, anywhere.** Every relation is `onDelete: Restrict`, there is no delete route, and
   no `.delete(`/`.deleteMany(` appears — the isolation guard's rule 5, which HR already obeys.
   Retirement is a status (`HrRecordStatus.ACTIVE` / `INACTIVE`), never a removal.
6. **A rule body is validated typed data, stored with the text it was published as.** The stored
   payload is what the platform engine validated and what an old explanation is rendered from
   (§10.6, §13.2). The engine itself never reads these tables (D12).
7. **Published immutability is enforced at the storage layer, not only by a service convention** —
   the precedent is `hr_org_unit_no_cycle_guard` (a trigger/constraint refusal for a writer that
   bypasses the service). A `PUBLISHED` version that a second writer can edit is not immutable, it
   is merely polite.
8. **Nothing is seeded.** No leave type, no leave policy, no limit and no approver is created by
   this phase. The leave-type catalogue is deliberately empty today (schema lines 771–775) and stays
   the tenant's statement; until a tenant states a policy, the system renders "no policy has been
   stated", which is the truth rather than a default policy nobody approved.

## 16. LEAVE LIMITS

A limit is **typed policy data that is evaluated**, never a stored counter. That is the storage
consequence of the schema's existing refusal to keep derived leave facts (no balance, no accrual, no
`durationDays`: schema lines 697–711) and of the module's refusal to run background work
(`hr-application-boundaries.spec.ts` rule 7; `hr-isolation.spec.ts` rule 8).

```
LeaveLimitDefinition
  leaveTypeRef        same-tenant LeaveType
  employmentType?     EmploymentType declared by the employment interval covering the range
  maximum             integer > 0
  countingBasis       REQUEST_COUNT | DAY_COUNT        — mandatory, never implied (D7)
  period              YEAR — the tenant-visible JALALI year (the only period in this phase)
  windowStart         inclusive calendar day  (@db.Date)  — the RESOLVED window of `period`
  windowEnd           inclusive calendar day  (@db.Date)  — resolved, not guessed
  consumesStates      the request states that consume the limit — REQUIRED, never defaulted
  effectiveFrom/To
```

Frozen constraints:

1. **The counting basis is part of the type and is mandatory** (D7). `REQUEST_COUNT` and
   `DAY_COUNT` are different semantics; a stored `3` is never interpreted without it, and a limit
   whose basis is absent fails validation.
2. **The calendar interpretation stays on the domain side of the boundary, and it already has one
   home.** A limit states its period as the tenant-visible Jalali `YEAR` (§2/D7); the HR application
   layer resolves that period into two inclusive calendar dates through the repository's single
   calendar boundary, `src/calendar/jalali.util.ts`, and hands the **resolved** window to the engine
   in the evaluation context. The engine performs no calendar arithmetic (D12, §34.3) — it cannot
   answer "when does this year start", and it does not need to. The resolved window is recorded with
   the evaluation grounds (count, maximum, window, basis) so a decision made in one year still states
   the window it actually counted over after the year has rolled.
3. **`DAY_COUNT` counts CALENDAR days**, derived at evaluation from the stored `start_date` /
   `end_date` range of each counted request — never a stored duration column. No `durationDays`-style
   derived column is introduced anywhere.
4. **`consumesStates` is required and has no default.** "Does a pending request consume the limit?"
   is a policy question, so the policy author states it and the engine never guesses. A limit with
   an empty or absent state set fails validation rather than silently counting everything or
   nothing.
5. **Counting is assembled by the domain, from stored rows, inside a bounded query** (§34). The
   engine receives a number and the facts it was computed from; it never queries (D12).
6. **Scope matching is temporal.** A limit naming an `employmentType` applies only when the
   employment interval covering the requested range declares that type
   (`EmploymentRecord.employmentType` is effective-dated). When the context cannot state the
   employment interval for part of the range, evaluation is **refused as insufficient context** —
   never resolved by assuming a type.
7. **A limit refusal is a decision, not an error**: the `LIMIT_REFUSAL` action carries its grounds
   (count, maximum, window, basis) so an employee's or a manager's explanation can state exactly
   which limit was met and how it was counted.
8. **Only these two bases exist in this phase.** No monetary limit, no accrual, no carry-over, no
   encashment, no working-day arithmetic, no holiday subtraction and no overlap rule: each is a
   policy this repository has not been authorized to state (§39, §40).
9. **The authorized worked examples are examples, not vocabulary.** The brief illustrates limits with
   `Sick` + a contract classification, and a larger maximum for a second classification — one of the
   two is named with a word ("Duty") that the repository's `EmploymentType` enum does not declare.
   The *semantics* frozen in this section are what is authorized; the literals are not, and no enum
   member, no leave type and no help-text term may be minted to match a word the schema does not
   declare (§39.2, §39.10).

## 17. LEAVE APPROVAL MODEL

The request's `status` is the **business** state; the approval flow is **separate history** (D2):

```
LeaveRequest (status: PENDING | APPROVED | REJECTED | CANCELLED)
      │  1 : 1 (at most one live flow per request)
      ▼
LeaveApprovalInstance          opened when a request is routed; closed by a terminal request state
      │  1 : n
      ▼
LeaveApprovalStepInstance[]    one row per configured step, in order
```

`LeaveApprovalInstance` carries: the policy version and rule-set version it was opened under, the
requested range snapshot, `openedAt`, `openedBy`, `closedAt`, `status`, and the terminal outcome.
`LeaveApprovalStepInstance` carries: `order`, the configured approver rule, the **resolved approver**
plus the resolution reason, the substitute reference actually used (if any), the availability
signals consulted and their outcome, `status`, `decision`, `decisionReason`, `decidedAt`,
`decidedBy`, and the rule-set/version that decided it. Field names are indicative; the semantics
below are frozen.

**Frozen step vocabulary** (this phase defines it, since nothing in the repository had an approval
vocabulary before):

```
PENDING     configured, not yet activated (a predecessor has not reached its decision)
ACTIVE      awaiting exactly the resolved approver's decision — at most ONE step at a time (§18)
APPROVED    decided positively; decision reason optional
REJECTED    decided negatively; decision reason MANDATORY (D6, §22)
SKIPPED     the flow ended before this step needed a decision (a rejection or a withdrawal)
CANCELLED   closed because the request was withdrawn (PENDING → CANCELLED)
```

**Instance vocabulary**: `ACTIVE` (routed, undecided) → `COMPLETED` (a step decided, or the request
was withdrawn). An instance is never deleted and never rewritten.

Frozen rules:

1. **No approval columns on `LeaveRequest`.** No `approverId`, no `decidedAt`, no `decidedBy`, no
   `approver1/2/3` — the schema states this refusal in writing today (lines 739–741) and this phase
   keeps it true by putting the detail in the two runtime tables.
2. **Step rows are append-only history.** After a decision, the row's decision fields are immutable;
   a correction is a NEW request (the existing doctrine: `isLeaveRequestRestatable` is derived from
   terminality, and a decided request is terminal).
3. **Every step row records WHO decided and WHY it was that person** — resolution reason (`PRIMARY`,
   `SUBSTITUTE`, or a typed unavailability outcome), so "why did this go to them?" is answerable
   from history rather than reconstructed from current configuration.
4. **A decision is recorded with the rule version that produced it**, not with "the policy as it is
   now" (§10.5, §23).
5. **A step cannot be decided by a non-resolved approver**, and the resolved approver cannot decide a
   step that is not `ACTIVE`: both are refused with typed reasons, and neither writes a success
   audit event (§26).
6. **No escalation, no timeout, no reminder in this phase.** There is no scheduler in these layers
   (`hr-application-boundaries.spec.ts` rule 7 forbids `setInterval`, `setTimeout`, `Cron`, `Queue`,
   `EventEmitter`, `outbox`), and inventing an SLA policy nobody approved would be exactly the kind
   of fabrication §39 stops (§40).

## 18. SEQUENTIAL ROUTING

The routing mode in this phase is **SEQUENTIAL** (D8), and only sequential:

```
Step 1 → X        Step 2 is not activated until Step 1 reaches its decision
Step 2 → Y        (APPROVED or REJECTED are decisions; PENDING is not)
Step 3 → Z
```

Frozen rules:

1. **`order` is unique inside a definition and dense** (`1..n`). Ordering comes from the declared
   `order`, never from insertion order or row id (the same determinism rule as §12.1).
2. **At most one `ACTIVE` step at any instant.** Activating the next step happens in the same
   transaction as recording the current step's decision — so a crash cannot leave a request with
   two active steps or with none while the flow is live.
3. **A step's decision is APPROVED or REJECTED** (D6); anything else is not a decision.
4. **Rejection at step *k*** → the request becomes `REJECTED`, the instance `COMPLETED`, and every
   later step becomes `SKIPPED` (never `CANCELLED` — cancellation is the withdrawal word). Earlier
   decisions keep their verbatim reasons.
5. **Approval of the last step** → the request becomes `APPROVED`. A single-step flow therefore
   decides in one act.
6. **Withdrawal while routed** (existing `PENDING → CANCELLED`, `hr.leave.manage`) closes the
   instance: undecided steps become `CANCELLED`, decided steps keep their decisions, and the
   instance records who withdrew and when. The existing transition's meaning is preserved — a
   pending request remains withdrawable, which is the behaviour the current table and permission
   already promise (D2).
7. **A request with no configured flow** is not routed and not auto-approved: it stays `PENDING`
   with no instance, and the UI states that no policy governs it. Silently approving an ungoverned
   request is the one outcome this phase refuses to invent (§39).
8. **One live instance per request.** Re-submission after a terminal state is a new request, not a
   re-opened instance.

## 19. SUBSTITUTE APPROVER MODEL

There is no parallel approval in this phase (D3). A step has a **primary** and, optionally, a
**substitute**, and the routing is exclusive:

```
LeaveSubstitutionDefinition
  primaryEmployeeRef      same-tenant Employee  (composite (tenant_id, employee_id) FK)
  substituteEmployeeRef   same-tenant Employee
  effectiveFrom / effectiveTo
  activationCondition     typed condition over the CLOSED availability vocabulary (§20)
  status                  HrRecordStatus.ACTIVE | INACTIVE
```

Frozen rules:

1. **Exclusive routing.** The step is routed to exactly one person: the primary when available, the
   substitute when the configured activation condition holds. Never both, never a "copy for
   information" second approver (that would be parallel approval under a different name).
2. **The definition says WHO; the engine says WHETHER.** The substitution is configuration stored in
   `hr_db`; the platform engine evaluates the condition *given a context* and returns a resolution
   decision with its grounds — `PRIMARY` or `SUBSTITUTE` plus the signal that decided it.
3. **The resolution is recorded on the step instance.** `resolvedApprover`, the resolution reason,
   the substitute definition actually used, and the signals consulted — so history explains the
   routing even after the configuration changes (§17.3, §23).
4. **Tenant-safe, same-domain references.** Both approvers are employees of the request's own tenant,
   enforced by composite foreign keys, not by a service check. A Core user id is never the authority
   (§15.3, §24).
5. **No substitution chains.** The substitute of a substitute is not resolved in this phase: an
   unbounded search is how a routing rule becomes unexplainable. If the substitute is also
   unavailable, the outcome is a typed `NO_RESOLVABLE_APPROVER` refusal, surfaced to the HR
   administrator — never a silent fallback to somebody else (§39).
6. **Self-approval is not silently accepted or silently refused.** Whether the requester may be their
   own approver is policy; this phase therefore **requires** the condition to be stated explicitly
   (the primary/substitute may not be resolved to the requester unless the policy states it), and
   records the resolution reason either way. A default choice would be an invented HR policy.
7. **Substitutions are effective-dated and never edited in place**: changing who substitutes whom
   creates a new definition (or closes the old interval), so a past decision's routing stays
   reproducible (§10, §35).

## 20. APPROVER AVAILABILITY

"Approver unavailable" is a **configurable business rule**, and each signal it may consult must have
an authoritative source (D9). This phase freezes the vocabulary to exactly the signals the repository
can already answer:

| Signal | Authoritative source | Available in 54 |
|---|---|---|
| `NO_LINKED_USER` | `hr_db`: `Employee.userId` is null | **yes** |
| `NOT_TENANT_MEMBER` | `HrIdentityGateway` → `USER_DIRECTORY` membership answer (yes/no only) | **yes** |
| `EMPLOYEE_INACTIVE` | `hr_db`: `Employee.status` ∈ {`INACTIVE`, `TERMINATED`} | **yes** |
| `NOT_EMPLOYED_ON_DATE` | `hr_db`: no employment interval covering the evaluation date | **yes** |
| `ACTIVE_SUBSTITUTION` | `hr_db`: `LeaveSubstitutionDefinition` effective window (§19) — the "active delegation" of D9 | **yes** |
| `ON_APPROVED_LEAVE` | `hr_db`: the resolved approver's own `LeaveRequest` rows in `APPROVED` state covering the activation day — a bounded read of stored decisions | **yes** |
| `INACTIVE_USER` | **none** — the directory port deliberately returns no status field | **no → §39** |
| `STANDALONE_DELEGATION` | **none** — no delegation record (delegate-my-inbox) is authorized | **no → §40** |
| `MANUAL_AVAILABILITY` | **none** — no manual availability table is authorized | **no → §40** |

Frozen rules:

1. **The vocabulary is closed.** A step's availability condition may only name signals from the
   available column; an unknown signal is a **validation error and refuses publish** — never a
   runtime no-op that silently means "available".
2. **`INACTIVE_USER` is not implementable in this phase and must not be faked.** The port's own
   contract forbids growth into status ("no status, no roles, …"; `user-directory.contract.ts`), and
   widening it would re-couple a business module to Core's identity model — the coupling the
   directory extraction removed. `hr-isolation.spec.ts` rule 1 also makes
   `hr-identity.gateway.ts` the *single* file that may reference the port. If an approved
   requirement genuinely needs "an inactive login is unavailable", that is a platform decision about
   the port, and §39 stops for it.
3. **Availability is resolved through a bounded, read-only context assembled by the application
   layer** — at most: the resolved approver's employee row, the relevant employment interval, one
   membership answer for the linked login, one effective substitution row, and whether that
   approver's own **approved** leave covers the activation day (one bounded window read). The
   engine receives the answers; it performs no I/O (D12).
4. **The "on approved leave" signal reads stored decisions only — it never evaluates anything.**
   It is a single tenant-scoped read of the resolved approver's own `APPROVED` leave requests
   covering the activation day; it never opens, advances or re-evaluates an approval, and a
   `PENDING` request never makes anybody unavailable (D9.2). Its answer enters the context as a
   boolean plus the covering request ids, so the explanation can cite *what* made the approver
   unavailable without re-reading anything — depth is impossible by construction here, not by a
   counter (the counter is why the prompt's recursion warning exists).
5. **Unavailability never deadlocks a request silently.** If neither the primary nor the substitute
   is resolvable, the request stays `PENDING` (not approved, not rejected) and the refusal is
   visible to the HR administrator with its grounds (§19.5) — the operator decides, the engine does
   not invent an approver.
6. **The signals consulted are recorded** on the step instance (§19.3), so "why did this go to Y?"
   is answered from history, not re-derived from today's configuration.

## 21. LEAVE LIFECYCLE

This phase is explicitly the phase that introduces approval-aware leave semantics (D2), using the
maintenance contract the repository already wrote for whoever added approval
(`prisma/hr/schema.prisma` lines 747–753; `domain/leave-status.ts`).

```
PENDING ──approve(last step)──▶ APPROVED
   │
   ├──reject(any step)──────▶ REJECTED
   │
   └──withdraw──────────────▶ CANCELLED
```

```
LEAVE_REQUEST_STATUS_TRANSITIONS (after this phase)
  PENDING:    ['APPROVED', 'REJECTED', 'CANCELLED']
  APPROVED:   []          terminal
  REJECTED:   []          terminal
  CANCELLED:  []          terminal
```

Frozen rules:

1. **The transition table stays the single statement of the lifecycle**
   (`src/modules/hr/domain/leave-status.ts`), and its existing derivations keep working:
   `isTerminalLeaveRequestStatus` becomes true for the two decided states, and
   `isLeaveRequestRestatable` — already derived from terminality rather than listed separately —
   therefore keeps saying "a decided request is never edited in place; a correction is a new
   request". The file's own comment anticipates this day; nothing about its shape changes.
2. **The change is atomic across the four surfaces the contract names**: the enum member(s) in
   `prisma/hr/schema.prisma`, the state discipline in the HR migration's CHECKs, the transition table
   in `leave-status.ts`, and the permission that gates the new route plus its Core seed row. Splitting
   it is how the transaction table and the database start to disagree.
3. **No state exists that nothing can write.** `COMPLETED`, `PAID`, `POSTED` and `ARCHIVED` are NOT
   added (D2, §40): an enum member nothing can legitimately write is a promise the table does not
   keep, which is precisely the reasoning the schema records today for `APPROVED`/`REJECTED`.
4. **`status` remains the business state only.** The decision detail lives on
   `LeaveApprovalStepInstance` (§17): no `decidedAt`, no `decidedBy`, no approver columns are added to
   `LeaveRequest` — the schema's written refusal (lines 739–741) is kept, not repealed.
5. **`cancelled_at` keeps its two-way discipline**: `LeaveRequest_cancelled_state_check` continues to
   mean `(status = 'CANCELLED') = (cancelled_at IS NOT NULL)`, extended so that a decided
   (`APPROVED`/`REJECTED`) request cannot carry a cancellation timestamp. The migration states the
   new members' discipline in the database, not only in the service.
6. **Existing history is preserved and never rewritten.** Every existing row is `PENDING` or
   `CANCELLED`; both keep their exact current meaning, no row is updated by the migration, and no
   default is applied. The migration's mapping is **explicit and total**: every existing value maps
   to itself. If any historical value could not be expressed by the new CHECK — or if ambiguity
   appeared in real data — the phase **STOPS** rather than guessing (§37, §39).
7. **Decisions are made only on a routed, active step** (§17.5). A request that no policy governs is
   not silently approved or rejected; it stays `PENDING` (§18.7).
8. **Approve/reject authority is not the request's author.** The decision route is gated by a
   permission (`hr.leave.approve`, §25) *and* by being the step's resolved approver; the withdrawn
   route keeps using `hr.leave.manage` exactly as today.

## 22. REJECTION REASON

Reject always requires a reason (D6). Four surfaces state it, and each one is independently true:

| Surface | Discipline |
|---|---|
| DTO | a non-blank, trimmed, length-bounded string; absence is a validation error |
| step-instance row | CHECK: `status = 'REJECTED'` ⇒ the reason is non-blank (the shape of `LeaveRequest_reason_check`) |
| service | no state transition is attempted without a reason, and no success audit is written without a successful transition |
| UI | the field is required on the reject action, and the employee is shown the reason verbatim |

Frozen rules:

1. **Approve takes an optional reason.** A rule that later requires one for a specific step is a
   policy this phase does not invent (§39).
2. **The reason is the human's statement, kept verbatim.** It is stored as one trimmed line exactly as
   typed — never re-worded, never summarised, never machine-translated, and never replaced by the
   engine's own explanation. The schema makes the same promise for the request's own `reason`
   ("this layer never re-words a person's own statement") and the platform makes it for audit
   reasons ("the gateway records what the caller stated").
3. **Immutability.** Once written, the decision reason is never edited. A request to change a decision
   is a new act on a new request, not an edit of history (§17.2, §35).
4. **No success audit without a successful transition.** A refused reject (no reason, wrong approver,
   inactive step, already terminal) writes no success event; the audit trail records the attempt as a
   refusal through `HrAuditGateway` with `success: false` and its reason (§26).
5. **The employee sees the rejection reason relevant to their own request — and only that** (§28).
   Other steps' internal notes are not exposed, and nothing about *other* employees' requests is
   reachable from an employee-facing explanation.
6. **The reason is part of the explanation, quoted, not re-derived** (§13.5).

## 23. SNAPSHOT / VERSION SEMANTICS

The rule that makes history trustworthy: **a decision is explained by the configuration that was in
force when it was made, never by today's configuration.**

Frozen rules:

1. **Routing snapshots the flow.** When a request is routed, the instance records: the policy id and
   policy **version**, the rule-set id and **version**, the ordered step definitions it was opened
   with (order, approver references, substitute references, availability signals), the requested
   range, and the evaluation instant used for routing.
2. **Each decision snapshots its own grounds.** The step instance records the rule-set/version that
   decided it, the evaluation instant, the resolution reason, the signals consulted, the decision,
   the reason (verbatim) and the actor. Two steps of the same flow may therefore legitimately cite
   different versions if a publish happened between them — and that is recorded, not hidden.
3. **A publish never touches in-flight flows.** Publishing a new version affects only requests routed
   *after* it (§10.5, §11). No back-fill, no re-evaluation, no "policy drift" job — these layers run
   no background work at all (§17.6).
4. **The version's text is retained**, so an old explanation is rendered from stored text rather than
   from today's code and today's configuration (§10.6, §13.2).
5. **References are RESTRICT, and resolved facts are stored alongside them.** Runtime rows keep the
   definition ids *and* the values that were resolved from them, so retiring a policy, a substitute
   or an approver cannot blank a historical record (nor can it cascade — every relation in `hr_db` is
   `onDelete: Restrict`).
6. **The evaluation instant is always explicit** (D12). The API boundary may default it to "now" for
   a *new* act; the engine never reads a clock, so replaying a decision with the recorded instant and
   the recorded context reproduces the recorded result.
7. **Simulation produces no snapshot at all.** A simulation reads versions and returns an
   explanation; it creates no instance, no step and no "simulated" row that could later be mistaken
   for history (§14).

## 24. TENANT ISOLATION

The existing HR tenancy doctrine extends to every table this phase adds; nothing here is new
policy, it is the same rules applied to new rows.

Frozen rules:

1. **The tenant comes from the actor, never from a request body.** Every new route sits behind
   `JwtAuthGuard`, is gated on an `hr.*` permission, and passes `resolveHrActor(req)` (fail-closed)
   as the first argument to the service — the pattern every HR controller already follows. No DTO in
   this phase declares `tenantId`, and `hr-isolation.spec.ts` rule 7 makes that a build-failing
   shape rather than a review comment.
2. **Every new read states its tenant first.** The boundary spec's rule 6 requires repository read
   methods to start with `tenantId`; the policy/instance repositories this phase adds obey the same
   signature discipline, and `findUnique` remains forbidden outright (a read that cannot carry a
   tenant predicate has no place in a multi-tenant database).
3. **Cross-tenant references are structurally impossible**, not merely refused by a service: every
   approver, substitute, policy, limit and instance reference is a composite `(tenant_id, …)`
   foreign key inside `hr_db` (§15.2, §19.4).
4. **No cross-database foreign keys, ever.** A leave policy never joins Core's identity tables;
   the login link is read only through `HrIdentityGateway`, which is the module's single port
   surface and whose answers are membership (yes/no) and a displayable name — no roles, no
   permissions, no status (§20.2).
5. **The engine is tenant-agnostic and therefore never tenant-authoritative.** It receives
   assembled facts; it cannot read a tenant, and its result carries no tenant field. Consequence: any
   memoization of definitions or results must be **tenant-keyed or absent** — a cache keyed without
   the tenant is a cross-tenant leak waiting for its second caller (§34).
6. **An id from another tenant behaves as "not found".** Existence is never confirmed across tenants,
   in responses or in error text, and the same rule applies to explanations: an employee's view can
   only ever render their own request, its policy's own text, and the names of the people in its own
   flow.
7. **The platform-side guards keep their existing meaning**: business modules may not import Core's
   Prisma client (`architecture-boundaries.spec.ts`: "forbids Core Prisma persistence in independent
   modules"), and the UserDirectory adapter stays free of HR-specific coupling ("keeps UserDirectory
   adapter free of HR-specific coupling"). The rule engine is not an exception to either.
8. **Audit rows are tenant-stamped from the actor** by the gateway, never by the caller — an
   unattributable audit row is not expressible (§26).

## 25. AUTHORIZATION

Authorization is decided by **entitlement + permission + operator configuration + resolved role in
the flow**, and each layer answers exactly one question. None substitutes for another.

| Layer | Question | Where it lives now |
|---|---|---|
| Module operational state | is the module usable at all? | `module-platform/module-operational-state.ts`, read through the platform module gate |
| Module/feature entitlement | is this capability enabled for the tenant? | `core_db` (`ModuleTenantScope`, entitlement rows); surfaced to HR through a platform port, never a table read |
| Permission | may this actor perform this verb? | `core_db` RBAC (`permissions.ts` codes, JWT scopes); `@Permissions(...)` + `PermissionsGuard` |
| Flow role | may this *specific person* decide this *specific step*? | `hr_db`: the step instance's resolved approver |
| Domain scope | does this person's HR scope include this employee? | the HR domain's own rules (reporting subtree); not a platform concern |

Frozen rules:

1. **Every new route is gated.** Read routes use `hr.leave.read`; configuration and decision routes
   use their own codes. The single new permission this phase needs is `hr.leave.approve`, which
   `permissions.ts` already reserves in writing ("approval policy is deferred to its own phase,
   which will bring the state, its transition table, its CHECK, this string and its Core seed row
   together") — this phase is that phase, and it brings all five together (§21.2).
2. **A permission is never a substitute for being the resolved approver**, and being the resolved
   approver is never a substitute for the permission. Both are required to decide a step.
3. **The reporting subtree is not reinvented as a string.** `hr.leave.approve` is granted to the
   roles that hold such capabilities today (`SUPER_ADMIN`, `ADMIN`) as a *capability*; the scope of
   whom a given approver may decide for is expressed by the **configured flow** (who the step routes
   to), which is tenant policy — not by a permission string invented for a server-side traversal
   that does not exist (`hr.attendance.read.team` was refused for exactly this reason).
4. **Fail closed everywhere.** Absent permission, absent actor, ambiguous tenant, missing module
   state → refuse. `resolveHrActor(req)` throws rather than defaulting; the module gate refuses
   rather than permitting.
5. **Module disablement outranks permission.** A disabled HR module refuses even a `SUPER_ADMIN`
   request, and a disabled Leave capability refuses leave operations while HR itself still serves
   attendance — see §4 (DISABLE ≠ DELETE).
6. **Configuration authority is separate from decision authority.** Editing policies, limits,
   substitutes and flows is an HR-administrator act; deciding a step is an approver act. No route
   accepts both in one payload.
7. **No client-supplied authority.** No DTO carries `approverId`, `decidedBy`, `tenantId` or an
   availability signal as a *claim*: the approver is resolved server-side from the flow, and the
   decision actor is the authenticated caller.
8. **The engine holds no authority** (D12). It may not read a permission, a module state, an
   entitlement or an actor. Authorization is decided before evaluation and after it — never inside
   it.

## 26. AUDIT BOUNDARY

HR writes to the platform trail through exactly one surface: `HrAuditGateway.record(actor, act)`
(Phase ARCH-3B). This phase adds events; it does not add a second channel.

Frozen rules:

1. **One gateway, one identity, one tenant.** `auditId` is minted per logical act, `tenantId` and the
   request facts are stamped from the actor, and the caller cannot supply either — they are absent
   from `HrAuditAct` by design. No new audit helper, interceptor, event bus or outbox is introduced
   (`hr-application-boundaries.spec.ts` forbids `EventEmitter`/`outbox` outright).
2. **What gets audited in this phase:**
   - policy / approval-flow / limit / substitute **configuration**: `create` (and lifecycle acts such
     as publish, archive, retire) on `hr.leave_policy`, `hr.leave_policy_version`,
     `hr.leave_approval_definition`, `hr.leave_substitution`, `hr.leave_limit`;
   - **routing and decisions**: on `hr.leave` — routing recorded with the resolved approver and the
     policy version; `approve` / `reject` recorded with the decision instant and the grounded reason
     (`reject` carries the verbatim rejection reason);
   - **refusals** with `success: false` and a reason: permission refusal, non-resolved approver,
     inactive step, terminal request, missing policy, `NO_RESOLVABLE_APPROVER`.
   Existing actions keep their current spelling (`create` / `update` / `cancel` on `hr.leave`,
   `create` / `update` on `hr.leave_type`), so historical queries remain valid.
3. **No success event before the fact.** The audit write follows a **committed** transition; a
   transition that was refused or rolled back gets a refusal event, never a success event (§22.4).
4. **Simulation writes no audit success event and no mutation** (§14). If a simulation is audited at
   all, it is one entry describing a read-only act, and it must not be mistakable for a decision.
   Reading configuration is not an event to be written.
5. **An audit failure never breaks a personnel fact.** The gateway never throws and never returns a
   partial result; a rejected or conflicting platform event is logged at error level as an operator's
   alarm. This phase keeps that contract — it does not make leave approval depend on the audit
   transport.
6. **The audit trail is not the business history.** Decisions live in `LeaveApprovalStepInstance`
   (§17); the audit trail is the *platform* record of who acted. Neither is reconstructed from the
   other, and a missing audit row never alters a decision.
7. **PII discipline.** Audit values carry the decision and its grounds — never a person's private
   detail beyond what the decision needed, never credentials, never a whole employee record. Reasons
   are quoted as typed (§22.2), and no free text is copied into an audit payload that the operator
   would not already see.
8. **The engine writes nothing** (D12) — including audit. If an act deserves an audit row, the
   application layer writes it, outside the pure evaluation.

## 27. UI LEVEL 1 / 2 / 3

Three presentation layers over **one** typed engine (D5). They are not three engines, three rule
formats or three code paths in the evaluator: the same evaluation produces the same result, and the
layer decides only *how much of the explanation* is rendered and *which verbs* are offered.

```
LEVEL 1 — SIMPLE        business outcome + the reason in plain words
LEVEL 2 — INTERMEDIATE  + why (which rule/limit/policy), which step, and the action to take
LEVEL 3 — ADVANCED      + rule builder, versions, conflicts, simulation, full explanation tree
```

Frozen rules:

1. **Level is a view of the same result, not a different evaluation.** A Level 1 screen and a Level 3
   screen for the same request must never disagree about the outcome; if they could, the split has
   become two engines.
2. **The layer never sees what it is not entitled to.** Hiding on the client is not hiding: each
   route is authorized server-side (§25), and the payload a lower layer receives does not *contain*
   the advanced detail at all — role-appropriate projection, not client-side filtering of a fat
   response.
3. **No JSON, no code, no SQL, no rule internals at Levels 1–2** (D5). A condition is rendered as a
   sentence ("more than 3 sick requests this year"), never as `{op:"gt",left:…}`; an availability
   signal is rendered as a phrase ("no linked login"), never as its enum literal. This is the same
   doctrine `hr-ui.tsx` already states for state badges: a state is a WORD a screen reader can read.
4. **Level 3 is where the typed vocabulary is legitimately visible** — as labelled builder controls
   with types and validation messages, still not as raw JSON to copy-paste. `JSON`/`JavaScript`/
   `SQL` are never an input surface (§33), even for a platform administrator.
5. **Every level is always second-guessable.** A Level 1 user can ask "why?" and receive Level 2
   detail *for their own scope*; a manager can ask for their step's grounds. A user never has to
   accept a bare verdict.
6. **The level is per surface, not per person forever.** The same human is Level 3 in
   `admin/hr/leave` settings and Level 1 when reading their own request's outcome; which layer is
   shown follows the *capability being used*, which is what the permission gates already express.
7. **Labels stay centralized.** State and reason labels live with the API client conventions
   (`lib/hr-api.ts` label helpers, `components/hr/hr-ui.tsx` primitives, every interactive element
   carrying a `data-testid`) rather than being re-worded per screen — the repo's existing reason for
   the shared HR UI file.

## 28. EMPLOYEE UX (LEVEL 1)

The employee's question is: *"What happened to my request, and what do I do now?"*

Frozen requirements:

1. **One screen is enough.** `admin/hr/leave` (the existing leave register view) shows the employee
   their own request, its `status` as a word, and the business outcome — approved, rejected, awaiting
   decision, withdrawn.
2. **A rejection always shows its reason, verbatim** (§22.5), plus *when* it was decided. Nothing
   else about internal steps is shown to the employee by default.
3. **A pending request states who has it and which step.** "With X, step 2 of 3" is Level 1
   information: it is not rule internals, and without it "pending" is indistinguishable from lost.
4. **A refusal is explained in words, not codes.** "This was not recorded: the limit for Contract
   employment is 3 sick requests in the stated period, and 3 are already recorded in it" — grounds
   from the explanation model (§13), never an error code.
5. **No fabricated promises.** No balance, no accruals, no projected entitlement, no approval
   probability, no "expected decision time" (§40). If policy is silent, the screen says the policy
   does not cover the case rather than inventing a number.
6. **Withdrawal stays available while the request is `PENDING`**, exactly as today, and the employee
   sees that a decided request cannot be edited (a correction is a new request) — the current
   `isLeaveRequestRestatable` semantics expressed in words.
7. **The employee never sees another person's decision detail** — not reasons, not notes, not the
   flow of other requests (§24.6).

## 29. MANAGER UX (LEVEL 2)

The manager's question is: *"What am I being asked to decide, and what do I have to state?"*

Frozen requirements:

1. **A decision queue scoped to being the resolved approver.** The manager sees the steps routed to
   them — nothing else, even within their own tenant.
2. **The request's facts in one view**: the employee, the leave type, the inclusive date range, and
   the requester's own stated reason (quoted, never re-worded).
3. **The grounds for the decision are visible**: which policy version routed it here, which limit (if
   any) it touches and how it was counted, and — when a substitute is involved — that the step was
   routed to them as the configured substitute, with the signal that decided it. A manager asked to
   decide on grounds they cannot see is being asked to guess.
4. **Reject requires a reason, and the UI requires it before submission** (§22). The field is not
   optional-in-theory-required-in-practice; a reject without a reason is not submittable.
5. **Approve's reason is optional** and clearly marked optional; the manager is never forced to type
   a sentence to do their job.
6. **No rule authoring here.** A manager cannot edit policies, limits, substitutes or flows — those
   are HR-administrator acts (§25.6), and a manager who needs a change asks the administrator.
7. **No bulk auto-approve, no "approve all".** Bulk decision tools are a separate product decision;
   a one-click mass decision is exactly the shape that removes the stated reason the phase requires.
8. **The manager's decision is recorded with the version that routed it** (§23.2), so a later policy
   change cannot make their decision look wrong.

## 30. HR UX (LEVEL 2/3)

The HR administrator's question is: *"What is our leave policy, what does it do, and what will it do
for this case?"*

Frozen requirements:

1. **Settings live under the existing HR surface** (`admin/hr/leave`, with the surrounding
   `admin/hr/*` navigation that already exists) — a new page family, not a new admin application.
2. **The administrator edits business-level things**: leave policy, approval flows and their ordered
   steps, primary/substitute configuration, limits with basis-window-states, effective dates, and
   which requests a policy governs. Never a JSON document, never a snippet.
3. **Validation is explained before publish, not after failure.** The publish attempt returns the
   validation report in words ("step 3 has no substitute and its primary has no linked login"),
   and the conflict report when two equal-authority rules disagree (§12) — a refusal the operator can
   act on, not a stack of type names.
4. **DRAFT / VALIDATED / PUBLISHED / ARCHIVED are visible states with their consequences stated**
   (§11): "this version governs requests recorded from now on" and "requests already routed keep the
   version they were routed under".
5. **Simulation is a first-class screen** (D4, §14), always labelled `SIMULATION — NO DATA CHANGED`,
   with the outcome, the grounds and the routing it would produce — including the case where the
   simulation is *refused* for insufficient context, which is a result the administrator must see.
6. **Effectiveness is stated in the operator's calendar.** Dates are stored and displayed as calendar
   days with Jalali rendering at the boundary (`calendar/jalali.util`); the administrator never
   types an epoch or an ISO instant to configure a year window (§16.2).
7. **The employee view is reachable from the register**: an administrator can see exactly what the
   employee sees (Level 1/2 for that request), so "the employee cannot understand this" is
   discoverable in the tool rather than reported as a bug.
8. **No HR data is produced by the settings screens themselves.** Editing a policy does not create,
   modify or re-evaluate a leave request (§23.3); the screens configure, they do not act on requests.
9. **Entitlement is read, not edited, here.** Whether Leave is enabled for the tenant is platform
   administration (§31); HR screens state the current state and refuse mutations when Leave is
   disabled (§4), rather than offering a toggle that would silently be ineffective.

## 31. PLATFORM ADMIN UX (LEVEL 3)

The platform administrator's question is: *"What do the rules do, and why did this case go that
way?"*

Frozen requirements:

1. **The advanced surface exposes the typed engine**: rule builder with typed operands and the fixed
   operator vocabulary (§10), validation report, decision-order preview, conflict diagnostics
   (§12), version history and the version comparison, full explanation tree, and simulation across
   tenants *of the administrator's choosing*.
2. **Cross-tenant visibility is deliberate and audited.** A platform administrator may inspect
   another tenant's rule *configuration*; the read is authorized by a platform permission and
   audited, and it never becomes an HR business capability (no deciding on someone's behalf, no
   editing a request).
3. **Conflict diagnostics are publish-blocking and explicit** (§12.3): "these two rules of equal
   authority both match; state which one wins" — never a resolver that picks silently.
4. **Entitlement is administered here and only here**: enabling/disabling a module or capability for
   a tenant, with the DISABLE ≠ DELETE consequences spelled out in the confirmation (§4) so an
   administrator cannot believe they are deleting data.
5. **Simulation on the platform surface obeys the same label and the same non-mutation guarantee**
   (D4, §14) — a platform administrator is not a special case that gets to write.
6. **The engine's internals are explained, not exposed as implementation.** The builder renders the
   typed vocabulary; it does not offer `eval`, JavaScript, TypeScript, SQL or shell input, and it does
   not let a rule reach the database, the network, the environment or the clock (§33, D12, D13).
7. **Version immutability is visible**: editing a `PUBLISHED` version offers "create a new version",
   and the UI states that existing decisions keep the version they were decided under (§10, §23).
8. **No hidden switches.** Any flag that changes evaluation outcomes is either stored policy
   (visible, versioned, audited) or does not exist. An environment variable must never change a
   business decision (§33, D12) — an administrator cannot be shown a different verdict than the one
   a tenant receives because a process happened to have a variable set.

## 32. EDUCATION / INLINE HELP

The rule engine is the first capability in this repository whose behaviour a non-engineer must
predict without writing code. Education is therefore part of the deliverable, not documentation about
it.

Frozen requirements:

1. **Every configuration screen explains itself in place.** Policy, flow, step, substitute and limit
   editors each carry short inline help answering: what this field does, what changes when it is set,
   and what it does *not* do (e.g. "the window is the period you count within; it is not the period
   the employee may take leave").
2. **Terms are defined once and used consistently**: policy, version, publish, step, primary approver,
   substitute, availability signal, limit, counting basis (`REQUEST_COUNT` / `DAY_COUNT`), window,
   consuming states, effective dates, simulation, explanation. The same word means the same thing in
   the UI, the API and this document — a second word for the same concept is how operators learn the
   wrong model.
3. **The counting basis is never implied.** Anywhere a maximum is displayed, its basis and window are
   displayed with it (`3 sick requests per stated period`), because a bare "3" is exactly the
   ambiguity D7 refuses to allow.
4. **Worked examples, not abstractions.** The help text shows a concrete case (Sick + `CONTRACT` →
   max 3 requests per year, plus a second case for another classification the schema actually
   declares) drawn from the authorized requirements, and never a fabricated legal or statutory rule
   (§39). One detail of the brief is recorded here rather than smoothed over: its second limit
   example names an employment classification ("Duty") that the repository's `EmploymentType` enum
   does not declare, so no member, leave type or help-text term may be minted for it — a
   classification the enum lacks is a schema decision that stops (§39.2, §39.10).
5. **Consequence statements accompany destructive-looking acts.** Disabling a module states
   "no data is deleted; historical requests, policies and approval history are preserved" (§4) — the
   difference between DISABLE and DELETE is stated where the button is, not only in this document.
6. **Explanations teach the model.** A rendered explanation names the policy and version, the step,
   the limit and its basis, and the availability signal in words, so an operator who reads a few
   explanations has effectively read the engine's semantics.
7. **No tooltip is load-bearing.** Every explanation is also reachable as text (the explanation
   panel, the validation report, the empty-state message); "hover to understand" is not a
   requirement for a person using a keyboard or a screen reader.
8. **The help is part of the reviewed artifact.** Copy that states policy behaviour is reviewed
   against this specification, since a wrong sentence here becomes a wrong rule in the database.

## 33. SECURITY CONSTRAINTS

The attack surface this phase introduces is *user-authored rules*. It is therefore treated as
untrusted input at every step, and the mitigations are structural rather than filtering.

Frozen constraints:

1. **No code execution, ever** (D13). No `eval`, no `new Function`, no dynamic `import()`, no
   template execution, no `vm`, no child process, no shell, no SQL string built from a rule. A rule
   is JSON-shaped typed data interpreted by a fixed evaluator with an explicit operator table.
2. **A closed operator vocabulary.** Only the operators in §10 are implemented; an operator not in
   the table is a validation error, not a passthrough. The evaluator's dispatch is exhaustive over
   the type, so an unknown operator cannot silently evaluate as "true" (a fail-open would be the
   worst possible default).
3. **Typed operands with a declared type per operand.** Field references resolve only against the
   registered context schema; unknown fields, type mismatches and missing required operands are
   validation errors (§11, §8.3). No implicit coercion of a string into a number or vice versa — implicit
   coercion is how "3" quietly becomes three of the wrong thing.
4. **Depth and size bounds.** Condition trees have a maximum depth and node count, definitions have a
   maximum step count, and reason/text fields have length bounds — a bound is what turns a
   resource-exhaustion rule into a validation message.
5. **Bounded evaluation work.** A rule may count over a stated window; it may not scan a table. The
   engine performs no I/O (D12), so a "rule" cannot become a database-load vector, and the domain
   bound that assembles the count is a query limit, not a policy question (§34).
6. **No secrets, no environment, no clock, no randomness.** The engine cannot read configuration or
   the environment (D12, §31.8); evaluation is a pure function of its inputs, which also makes an
   unexplained verdict impossible to attribute to a hidden flag.
7. **Standard input hygiene everywhere else**: DTO validation with `class-validator` (the shape the
   existing HR DTOs already use), tenant-scoped queries (never `findUnique` for tenant data, §24.2),
   and no `tenantId`/`actorId`/approver claim accepted from a client (§25.7).
8. **Authorization is enforced server-side**, per route, on every verb, including the read routes
   that render explanations (D5, §27.2). An explanation is a disclosure: it can reveal policy,
   limits and people, so it is authorized with the same care as the mutation it describes.
9. **Audit is tamper-evident by construction**, not by client cooperation: the gateway mints the
   identity, stamps the tenant from the actor, and a caller cannot supply either (§26.1).
10. **The example rule stays an example.** `src/rules/rules/example.rule.ts` must not be seeded,
    registered as production policy, or turned into a leave rule; a demonstration that becomes a
    business rule is exactly the accidental policy this phase forbids (§39).
11. **No data exfiltration through errors.** A refusal states the typed reason and the grounds the
    caller is entitled to see; it never includes a raw database error, a stack trace, another
    tenant's identifier, or the existence of a record the caller may not read (§24.6).

## 34. PERFORMANCE CONSTRAINTS

The performance requirement of this phase is not throughput; it is that **a bounded question is
answered with a bounded amount of work**, because the engine is the one place a rule can accidentally
become a scan.

Frozen constraints:

1. **The engine is O(conditions), not O(data).** Evaluation complexity is bounded by the rule-set
   size and condition depth (§33.4); a rule never drives a query, so no rule can change the query
   plan of the operation that invoked it (D12).
2. **One decision, a fixed number of reads.** Routing a request performs a bounded set of reads: the
   applicable policy/version and its steps, the employment interval covering the range, the limit
   definitions in scope, the approver rows, and at most one membership answer per resolved approver.
   Counting reads are bounded by the configured window (§16.2), which keeps the range honestly scoped
   ("the period the operator stated") rather than open-ended over all history.
3. **The counting query is indexed for the shape it has.** Counting by basis and window over
   `LeaveRequest` reuses the existing tenant/employee/date access paths; if a new index is genuinely
   required, it is added in the same migration as the feature that needs it and justified in that
   migration's comment — not measured later against production.
4. **No N+1 through the flow.** A step's approver names are hydrated in one batched directory read
   (the port is explicitly batched, with `MAX_DIRECTORY_IDS` as its bound), never per step.
5. **Simulation obeys the same bounds and writes nothing** (D4, §14): no row is retained, so a
   repeated simulation costs a bounded read each time instead of accumulating state. It may not be
   used in this phase as a bulk "what-if over every request" scan.
6. **Definition reads may be cached only if the cache key includes tenant AND version** — a published
   version is immutable (§10.3), so a version id is a valid cache key; a policy id or a tenant id
   alone is not (§24.5). Without that key, no caching.
7. **The HR list endpoints keep their existing pagination discipline** (bounded pages, deterministic
   ordering). This phase adds no unpaginated list route, and explanation payloads are per-request
   rather than a per-tenant dump.
8. **No background work is introduced to satisfy performance** (§17.6): no precomputation, no nightly
   counting, no cached balances. If a limit must be known at scale, the answer is an index and a
   bounds-checked query, not a derived table that can disagree with the facts it was computed from
   (§16, §40).

## 35. CONCURRENCY

Approval introduces the first genuinely simultaneous contention in the HR domain: two people (or one
person with two tabs) deciding the same step, while a third withdraws the request.

Frozen rules:

1. **Every state change is a guarded write (compare-and-set), not read-then-write.** The existing
   pattern reads the row, asks the domain's transition table, then writes by the compound key
   (`tenantId_id`) — necessary but not sufficient when two writers race. This phase writes decisions
   through a guarded predicate that includes the state being replaced (`status = 'ACTIVE'` on the
   step, the current request state on the request) and treats a `count !== 1` result as a **conflict**,
   not a retry: the loser of a race must be told the step was already decided.
2. **At most one `ACTIVE` step per instance is a database invariant**, not a service convention — the
   shape the repository already prefers for invariants a second writer could violate (the attendance
   unique key, the `EXCLUDE USING gist` interval guards, the `hr_org_unit_no_cycle_guard` trigger).
   A partial unique index (or an exclusion constraint) over `(tenant_id, approval_instance_id)` where
   the step is `ACTIVE` makes "two active steps" unrepresentable.
3. **The request's transition and the step's decision are one transaction.** Deciding a step and
   moving `LeaveRequest.status` cannot be separately committed: a decided step with a still-pending
   request (or the reverse) is the failure mode that makes an approval system untrustworthy, and it
   is exactly what a single transaction with guarded writes prevents.
4. **Activation of the next step is inside that same transaction** (§18.2), so the flow is never
   briefly "no active step".
5. **Withdrawal races a decision safely.** Both are guarded writes on the request's state: whichever
   commits second finds the state it expected absent and reports a conflict; the withdrawal path
   additionally cancels undispatched steps, and a step cancelled by a withdrawal can no longer be
   decided.
6. **Concurrent publishes cannot both become current.** A publish is a guarded transition
   (`DRAFT`/`VALIDATED` → `PUBLISHED`) on one version row; two administrators publishing at the same
   moment cannot produce two equally-current versions, and the persistence layer refuses a second
   `PUBLISHED` version for the same scope and effective interval (a uniqueness/exclusion rule, not a
   "last write wins").
7. **No optimistic-lock column is introduced where a state predicate states the same thing.** The
   version the row already carries (`status`, timestamps) is the lock; adding `version` counters to
   every table to express what a state predicate already expresses would be new machinery with a new
   way to be wrong.
8. **The engine is not a concurrency participant** (D12): it receives a snapshot of the context and
   returns a result. Serialization, locking and retry semantics belong to the application layer that
   owns the transaction.

## 36. IDEMPOTENCY

The goal: a repeated request must not produce a second business act — with one deliberate exception
that this phase states explicitly.

Frozen rules:

1. **Deciding a step is idempotent-by-refusal, not idempotent-by-silence.** Repeating the *same*
   decision for an already-decided step returns a conflict stating the step was already decided (by
   whom, when, on which version) rather than silently succeeding. Silence would make a double-submit
   indistinguishable from a legitimate first decision, which is how "one act, two audit rows" or "one
   act, two decisions" becomes possible.
2. **This is the deliberate asymmetry, and it is stated because it is a decision:** the platform's
   audit contract recognises a genuine replay (a producer supplying a stable event id), and that is
   *not* the same as a business decision. A repeated HTTP request is not a replay to be swallowed; it
   is a second attempt against a state that already moved, and the caller must learn that (§35.1).
3. **Routing is idempotent.** A second route attempt on a request that already has a live instance
   returns the existing instance rather than opening a second one; "one live instance per request" is
   a storage invariant (§18.8) expressed as a uniqueness rule, not as a hopeful service check.
4. **Simulation is idempotent because it writes nothing** (§14): the same inputs produce the same
   explanation, and repeating it changes no state, sends no notification and creates no record.
5. **A refused act is not a consumed act.** A rejection attempted without a reason, or by a
   non-resolved approver, leaves the flow exactly as it was — no step activation, no request
   transition, no success audit (§22.4, §26.3). This is what makes a retry safe: the refusal path
   has no side effects to duplicate.
6. **The evaluation instant is part of the identity of a decision.** Because the engine takes an
   explicit instant and never reads a clock (§23.6), "decide with the same instant twice" is
   reproducible, and the recorded instant is what an explanation and a replay agree on.
7. **No new idempotency-key table** in this phase. A cross-cutting key store is a platform decision
   with its own retention and semantics; where an act must be single-shot, the state predicate of
   the row itself is the key (§35.1).

## 37. MIGRATION STRATEGY

This section is the contract for the implementation phase(s) that follow **this** freeze. Phase 54-A
writes no migration, no schema change and no seed (§5, §11).

Frozen rules:

1. **A hand-written SQL migration in the owner's folder, plus the schema in lockstep.** HR changes
   arrive as a new folder under `apps/api/prisma/hr/migrations/<timestamp>_<name>/migration.sql` with
   `schema.prisma` updated in the same change set — the established shape (the leave migration's
   comment states the reason explicitly: state and CHECKs and the enum arrive in the SAME migration).
   Applied with `npm run db:migrate:hr` (`prisma migrate deploy`); there is no schema-push path in
   this repository for these databases.
2. **Additive first.** New enum members, new tables, new indexes and new CHECK constraints. The
   migration that introduces `APPROVED`/`REJECTED` does not rewrite a single existing row (§21.6): it
   widens the CHECK and adds the discipline the new states need.
3. **Explicit, total mapping of historical states.** Every existing value is accounted for by the
   migration's own comment and by the new CHECK. Today that mapping is the identity mapping
   (`PENDING` → `PENDING`, `CANCELLED` → `CANCELLED`), and the migration states that in writing so a
   future reader does not have to infer whether something was transformed. **If any row could not be
   mapped — or if real data disagrees with the assumed set — the phase STOPS** (§39) rather than
   inventing a target state.
4. **New states are never back-filled into old rows.** No existing request becomes `APPROVED` or
   `REJECTED` because a policy "would have" approved it: a decision is an act by a person, and the
   migration does not manufacture decisions (§12 of the HR reasons, still true here).
5. **`core_db` gets exactly one companion change**: the `hr.leave.approve` permission row and its
   role grant, in a new migration patterned on
   `20260919120000_seed_hr_leave_permission_grants` (idempotent seed: `ON CONFLICT DO NOTHING`,
   granted to the roles the existing HR seeds grant to). It arrives **with** the state it gates —
   the contract `permissions.ts` wrote down — and it adds no other permission, no module and no
   entitlement row.
6. **No cross-database statement.** A `core_db` migration never references an `hr_db` table and vice
   versa (the two are separate Prisma schemas with separate role grants); the permission seed cites
   only Core's own tables.
7. **Guards are installed in the database where the repository already installs them** — constraints,
   partial unique indexes, exclusion constraints, and (where a walk is genuinely required) a trigger
   in the style of `hr_org_unit_no_cycle_guard`. A rule that only the service enforces is a rule the
   next writer can break (§15.7, §35.2).
8. **Rollback is stated before it is needed.** Each migration records, in its header comment, what
   "undo" would mean and what would be lost — the leave migration models this
   ("`status`/`cancelled_at` are dropped together; nothing is deleted; rehire creates a new open-ended
   record" discipline). For an additive approval migration, undo means dropping the new tables and
   narrowing the CHECK, and that costs the approval history — which the header states, because a
   destructive step that is not written down is a destructive step someone will take by accident.
9. **Seeding stays out of it.** No policy, no limit, no approver, no leave type is seeded in either
   database (§15.8). A seeded policy would be an approved-looking default nobody approved, and the
   leave-type catalogue's emptiness is deliberate.
10. **Migrations are reviewed like code**: bounded statements, no unbounded `UPDATE`, no `DML` mixed
    into a table-creation migration without a stated reason, and the file's comments state the
    invariant each constraint protects — the standard every existing HR migration already meets.

## 38. TEST GATES

No implementation phase of Phase 54 may be reported as PASS without the following evidence. The gates
are ordered: an earlier failure is not repaired by a later pass, and a gate that was not run is a
gate that failed.

**38.1 Standing gates (must remain green, unchanged, from the 52-ARCH-3C baseline)**

| Gate | Command | Why it is the gate for this phase |
|---|---|---|
| Architecture boundaries | `npm run test:architecture` | forbids Core Prisma persistence in independent modules; the rule engine must not become an exception |
| Runtime policy projection | `npm run test:policy` | the HR runtime/datasource map is generated and asserted (`runtime-datasources.ts`, `arch:policy`) |
| HR isolation | `npm run test:api -- modules/hr/hr-isolation` | tenancy, forbidden delegate reads, forbidden I/O, no delete, DTO-tenant shape |
| HR application boundaries | `npm run test:api -- modules/hr/hr-application-boundaries` | repository signature discipline, clock discipline, no scheduler |
| Audit contract | `npm run test:api -- platform/audit` | the gateway's tenant stamping, `success` semantics and replay contract |
| API build / types | `npm run build:api` | a spec that requires `any` to compile is not a spec |
| Lint / format | `npm run lint`, `npm run format:check` | repository formatting is part of the definition of "written" |

Note on the format gate, recorded because this document measured it rather than assumed it: the
repository has no `.prettierrc`, and **all twenty committed `docs/reports/*.md` artifacts fail
`prettier --check` today** (this file included — it is prose like its siblings). The gate therefore
applies to the code an implementation phase writes and to files it touches; it is not a claim that
report artifacts are prettier-formatted, and it must not be "fixed" by reformatting one report in
isolation while its nineteen siblings stay as they are.

**38.2 Gates this phase's implementation must ADD (each one must be able to FAIL)**

1. **Pure-evaluator gate.** A spec asserts the engine's determinism: same `RuleVersion` +
   `EvaluationContext` + instant ⇒ identical result across repeated runs and across property-style
   permutations of input ordering. It must also assert the *negative* contract — no clock, no
   randomness, no environment read — by allowing only a pure module graph for the engine folder
   (the existing boundaries specs show the shape: an assertion that can fail when a forbidden import
   is added, not a convention in a comment).
2. **Versioning gate.** Published versions cannot be edited (storage-level refusal); editing produces a
   new version; an in-flight instance keeps the version it was opened with; a new request routes
   under the newly published version.
3. **Conflict-resolution gate.** Overlapping rules with the same authority fail validation/publish;
   differing priorities resolve in the declared order; an equal-authority tie-break is asserted by
   inserting the same rules in a permuted order and getting one identical outcome (§12.1).
4. **Lifecycle gate.** The transition table's four states are asserted directly, including every
   refusal: `APPROVED`/`REJECTED` are terminal; `CANCELLED` is terminal; an ungoverned request stays
   `PENDING`; no transition exists that skips a step.
5. **Rejection-reason gate.** Rejecting without a reason fails at the DTO, and a direct service call
   without a reason fails before any write; a refused reject writes no success audit and does not
   advance the flow (§22.4, §26.3).
6. **Sequential-routing gate.** At most one `ACTIVE` step (asserted under a race, not only
   sequentially), rejection skips later steps, approval of the last step completes the request, and
   withdrawal cancels undecided steps while preserving decided ones.
7. **Substitution gate.** Available primary ⇒ `PRIMARY`; unavailable primary with an applicable
   substitution ⇒ `SUBSTITUTE` and the resolver recorded; both unavailable ⇒ typed
   `NO_RESOLVABLE_APPROVER` and the request stays `PENDING`; no chain resolution; never two recipients.
8. **Limit gate.** `REQUEST_COUNT` and `DAY_COUNT` produce different, asserted outcomes for the same
   stored rows (this is the D7 test: the same number must not mean two things); an absent basis or an
   inverted window fails validation; insufficient employment context is refused rather than assumed.
9. **Simulation gate.** Simulation creates no leave row, no instance, no step, no audit event and
   sends no notification — asserted by counting rows and audit calls around a simulation call, not by
   inspecting a flag (§14).
10. **Entitlement gate.** With the module/feature disabled: the leave routes refuse, the settings and
    navigation are hidden, and **the historical rows are still present** (§33, and the disablement
    section of this document).
11. **Explanation gate.** Each explanation level is rendered from stored data: an employee's
    explanation contains the outcome and the applicable stipulation but no internal rule text; a
    manager's contains the action and the rejection reason requirement; nothing in any level exposes
    JSON, SQL, field names or the typed condition tree.
12. **Migration gate.** The migration applies to a database seeded with the current states, the
    historical state mapping is asserted explicitly (today: identity), and no row is rewritten
    (§37.3). An ambiguous historical state in the fixture must make this gate fail rather than pass
    silently.
13. **Documentation gate for this artifact.** A tiny read-only guard (the one permitted kind of test
    change) asserts that this document exists and that the D1–D13 identifiers it claims are present,
    so the decisions cannot be quietly dropped from the repository. If the implementing phase prefers
    no guard at all, this gate is optional; it is never a licence to modify unrelated specs.

**38.3 Evidence discipline**

- Gates are run against the final tree of the phase, not an intermediate one.
- A skipped or quarantined test is reported as such, in the final report, with its name.
- The existing modified e2e specs in the working tree are **not** touched by this phase and their
  state is not evidence either way (§6, §11).

## 39. STOP CONDITIONS

The phase (and each implementation phase that follows this freeze) **STOPS and reports** instead of
guessing when any of the following is true. Stopping is a successful outcome; inventing an answer is
not.

1. **Ambiguous historical data.** An existing `LeaveRequest.status` value (or any other stored leave
   fact) cannot be mapped by the frozen lifecycle, or the migrated database disagrees with the
   assumed set (§21.6, §37.3).
2. **Missing authoritative source.** A required business rule cannot be evaluated from data that
   actually exists in the owning domain — an availability signal with no source (§20.1), an approver
   reference with no employee, an employment interval covering the range that does not exist.
3. **A requirement to see an identity fact the directory port does not expose.** Asking for user
   status, roles, permissions or credentials through `USER_DIRECTORY` is a platform decision that
   changes a platform contract — it stops here rather than widening the port (§20.2).
4. **A rule the repository has not been authorized to state.** Working hours, holidays, accrual,
   carry-over, monetary conversion, legal entitlement, minimum/maximum service length, SLA/escalation
   timing, payroll interaction, or any policy the product decisions do not contain.
5. **Equal-authority incompatibility that validation cannot decide.** Two rules that both apply and
   cannot both be satisfied, with no declared priority/specificity that separates them: publish must
   be refused rather than "one of them" chosen (§12.3).
6. **A cycle.** An approver resolution, an org traversal or an availability signal that would require
   resolving itself — a substitution chain (§19.5), or a signal that had to open or advance an
   approval in order to answer itself (the one known signal is made non-recursive by construction in
   §20.4; a new one stops here rather than being given a depth counter).
7. **A need for cross-database joins or foreign keys.** Any design that wants an `hr_db` policy to
   reference a `core_db` row by FK, or a Core table to carry a leave column, stops for a platform
   decision (D1, §24.4).
8. **A need for background work.** Anything requiring a scheduler, a queue, an outbox, a timer or an
   event emitter in the HR module — the boundaries spec forbids the primitives, and an approval
   deadline nobody approved is not a feature (§17.6).
9. **A UI requirement that needs a value no stored fact supports.** Rendering "remaining balance",
   "paid days", "working days consumed" or any figure the repository does not store must stop, not
   be computed silently into a displayed number (§16.3, §16.8).
10. **A contradiction between this document and the code.** If implementing any frozen rule would
    contradict an existing invariant, boundary spec or migration CHECK, the contradiction is reported
    and resolved by a decision — not by narrowing the rule inside an implementation.
11. **A destructive step in the migration.** Any drop, any rewrite of existing rows, any narrowing of
    a CHECK against live data, or any seed of business configuration (§37.2, §37.4, §37.9).
12. **A test gate that cannot be written to fail.** If a gate can only pass by construction, it is not
    evidence; stop and report instead of claiming the gate green (§38.2).

## 40. EXPLICITLY DEFERRED FEATURES

Deferred is not "not wanted". It is "not authorized in this phase", and it is listed so that no
implementer adds it out of helpfulness, and no reviewer has to guess whether its absence was an
accident.

**40.1 Forbidden by the phase's own scope (would be a different product):**

Commerce, a generic workflow/BPMN engine, a generic task engine, arbitrary code/JavaScript/SQL rules,
parallel approval, quorum, majority approval, a generic notification engine, payroll, an expense
engine, an accounting engine, an inventory engine, a billing/subscription platform, destructive module
uninstall, and data deletion when a module is disabled.

**40.2 Deferred because the semantics are not this phase's:**

| Deferred | Why it is deferred |
|---|---|
| `COMPLETED`, `PAID`, `POSTED`, `ARCHIVED` leave states | D2; a state nothing may write is a broken promise |
| Parallel branches, AND/OR gateways, quorum, majority | D3; routing is exclusive primary-or-substitute |
| Substitution chains | §19.5; an unbounded search cannot be explained |
| Conditional/skipping steps, dynamic flows | Sequential routing only (§18) |
| Escalation, timeout, reminders, SLA | §17.6; no scheduler exists in these layers |
| Standalone delegation (`STANDALONE_DELEGATION`), manual availability (`MANUAL_AVAILABILITY`), "inactive login" (`INACTIVE_USER`) | §20; no authorized source exists — and the directory port deliberately exposes no status field |
| Accrual, carry-over, encashment, balances | §16.8; the schema deliberately stores no balance |
| Working-day / holiday-aware duration | §16.3; no holiday calendar is authorized as a source |
| Monetary limits and payroll coupling | §16.8, §40.1 |
| Overlap-with-existing-leave rules | a policy this repository has not been authorized to state (§39.4) |
| Shift-aware approval rules | attendance has no shift source in this phase |
| Rule import/export, rule marketplace, templated policy library | configuration surfaces nobody approved |
| Advanced analytics on approvals | reporting is not a Phase 54 deliverable |
| Notification/e-mail on decision | §40.1; routing + history only |
| Cross-module rule reuse for a second consumer (Commerce) | this freeze establishes the *reusable* engine; a second consumer is its own decision |
| Entitlement changes beyond leave's own feature toggle | D1: entitlements are Core-owned, and this phase adds none beyond what it must gate |
| Automatic policy migration when an employee changes org unit | nothing in the repository defines reassignment semantics yet |
| Approval of anything other than leave | attendance, travel and expense approvals are separate phases |

## 41. DECISION REGISTER (FINAL REVIEW)

Every decision in §2 was re-read against the live repository after the document was written, and each
is **ACCEPTED**. No decision is left open, and none of them contradicts an existing invariant: the
storage boundary honors `hr_db` ownership and the composite-key tenancy pattern, the lifecycle change
follows the maintenance contract already written in `schema.prisma`/`leave-status.ts`, the substitute
model avoids parallel approval entirely, and the pure-engine contract keeps the database, the clock
and the audit trail on the application side of the boundary.

| # | Decision | Verdict | Frozen in |
|---|---|---|---|
| D1 | Rule Storage Ownership — platform execution, domain-owned configuration | **ACCEPTED** | §6, §15, §24.4 |
| D2 | Leave Lifecycle — `PENDING`/`APPROVED`/`REJECTED`/`CANCELLED`, detail in approval history | **ACCEPTED** | §17, §21, §23 |
| D3 | Substitute Approver — exclusive primary-or-substitute, never parallel | **ACCEPTED** | §19, §20 |
| D4 | Simulation and Explanation — both required, API and UI, non-mutating | **ACCEPTED** | §13, §14, §28–§31 |
| D5 | UX Levels — exactly three presentation layers over one typed engine | **ACCEPTED** | §27–§31 |
| D6 | Rejection — reason always mandatory; approve optional | **ACCEPTED** | §21, §22 |
| D7 | Leave Limits — typed, counting-basis aware (`REQUEST_COUNT` / `DAY_COUNT`) | **ACCEPTED** | §16 |
| D8 | Approval Routing — sequential only, one active step, immutable history | **ACCEPTED** | §17, §18, §23 |
| D9 | Approver Availability — closed signal vocabulary with authoritative sources | **ACCEPTED** | §20 |
| D10 | Rule Versioning — published versions immutable, history never rewritten | **ACCEPTED** | §10, §11, §23 |
| D11 | Conflict Resolution — deterministic ordering, refuse equal-authority conflicts | **ACCEPTED** | §12 |
| D12 | Pure Rule Engine — no Prisma, HTTP, DB, env, clock, audit, notification or mutation | **ACCEPTED** | §6, §7, §34, §35 |
| D13 | Typed Rule Language — declarative vocabulary only, no `eval`, no code, no SQL | **ACCEPTED** | §7, §8, §33 |
| D14 | **Phase 54-C — Platform module/feature entitlement.** Module-level **inbound** gate (narrow, fail-closed read of `enabled` + `tenantScope`/`tenantIds`; deliberately **not** `resolve()`), plus the feature level: Core-owned `ModuleFeature` / `ModuleFeatureGrant` in `core_db`, read through the `ENTITLEMENT_PORT` platform port, explicit idempotent provisioning, admin surface. Supersedes §4.3's *"and nothing else"* **for the feature level only**, and exercises §5 rule 5's amendment path (which is not superseded). | **ACCEPTED** | §43, §4.3, §5 |
| D15 | **Phase 54-C — module-entitlement tenant scope (ratifies the §43.7 clause).** HR is provisioned `tenantScope = RESTRICTED`, seeded with the tenants that exist at migration time; **new** tenants receive nothing automatically and need explicit provisioning; absent entitlement is **fail closed**. `tenantScope = 'ALL'` is **rejected** for this purpose — it would make HR the default for every tenant created later and would force a second, deny-shaped mechanism to express "not purchased". Leave stays explicit and tenant-scoped, and its effective state still requires HR effective **and** its own grant (§43.9). No billing, subscription, pricing or metering surface is introduced. Recorded together with its execution gate **D15-G1, which FAILED** (162 existing tenants against the live 64-entry `RESTRICTED` cap) — see §44. | **ACCEPTED** | §44, §43.7 |
| D16 | **Phase 54-C — module/tenant membership storage (corrects D15's failed gate).** HR's membership is carried by a Core-owned **child table**, `ModuleRegistrationTenant` (one row per entitled tenant; **presence is membership**), which becomes the **authoritative** membership source for HR. The legacy `ModuleRegistration.tenantIds` array keeps its 64-entry `CHECK` and its meaning for every other module — **not raised, not removed** — and `tenantScope = 'ALL'` stays rejected. All 162 tenants that exist at migration time are seeded explicitly (state-preserving); a tenant created later stays unentitled until provisioned; missing membership is **fail closed**. No billing, subscription, pricing or metering. The pre-migration check was run **first**, and the two coexistence conflicts it found are reported (§45.3) and resolved by the mechanism in §45.4 before any migration is written. | **ACCEPTED** | §45, §44, §43.7 |

**Amendment 1 (Phase 54-C) — what it changed, and why it was needed.** §5 rule 5 anticipated a
feature-level surface and named the only lawful shape for it: an amendment that extends the existing
entitlement ownership, never a new table in `hr_db`. Phase 54-C is that amendment. It was required
because §5 row 3 named a layer that had **no** implementation anywhere in the repository — each of
these was verified against the code before the amendment was written, not assumed:

- `ModuleRegistration` (Core) has `enabled`, `tenantScope`, `tenantIds` and **no** feature concept.
- **No** migration has ever inserted a `ModuleRegistration` row, including for HR — so there is no
  registration to read today, for HR or for any module.
- Nothing evaluated entitlement on an **inbound** request. `ModuleRegistryService.resolve()` is the
  **outbound** path: it requires a live `ModuleInstance` whose `lastSeenAt` is fresh, whose lifecycle
  is `RESOLVABLE` and whose contracts match — `module-registry.service.ts` L1058–L1121 — and HR has
  neither a registration row nor an instance row. Wiring `resolve()` inbound would therefore refuse
  **every** HR request with `MODULE_NOT_FOUND` / `MODULE_UNAVAILABLE`. That is why §43.5 freezes the
  gate as a narrow read instead, and why the difference is a rule rather than an implementation note.

The layer itself — its storage, its resolver, its gate, its provisioning, its admin surface and the
gates that keep it honest — is §43. It adds **no** permission code, touches **no** `hr_db` schema,
and does not make the rule engine entitlement-aware in any direction (§43.11).

**Review checks performed on this document** (each of these was verified, not assumed):

| Check | Result |
|---|---|
| No unsupported business rule is asserted | pass — every un-authorized policy is in §39/§40 instead of being invented |
| No invented section reference | pass — the forty sections were authored here, and amendment 1 added §43; citations point at files/sections that exist |
| D1–D13 all resolved, and amendment 1 adds D14 | pass — see the register above; none is "to be decided during implementation". D14 is resolved by §43, which also records the scope limits it deliberately does **not** cross (§43.9, §43.12) |
| No contradiction with the existing Leave data model | pass — `status`, `reason`, `cancelled_at` discipline kept; no new column on `LeaveRequest`; identity mapping for existing rows |
| No contradiction with HR tenancy architecture | pass — TEXT tenant ids, composite `(tenant_id, …)` FKs, tenant from the actor, no cross-database FK |
| No contradiction with `HrAuditGateway` | pass — audit stays a platform concern, called from the application layer with the actor, success written only after a successful transition |
| No contradiction with `HrIdentityGateway` | pass — the port stays the module's single identity surface and is not widened for availability |
| No generic workflow engine introduced | pass — no BPMN, no generic task engine, no parallel gateway, no scheduler, no notification engine |
| D15's execution gate was run **before** the code, and its failure is recorded rather than worked around | pass — §44.2 states the measured numbers (162 tenants, a live `CHECK` cap of 64, no `hr` registration), and §44.3 stops the blocked steps instead of truncating the list, splitting the module or inventing an overflow rule. The storage correction is left as a new decision (D16) and is **not** taken implicitly |
| D16's pre-migration check was run **before** the migration, and the two coexistence conflicts it found are reported rather than worked around | pass — §45.2 tabulates everything measured against the live `core_db` (162 tenants / 162 distinct ids / 0 null / 2 `ACTIVE`; the live `CHECK` with its 64-entry `RESTRICTED` cap; the single `gate-finance` registration row; the feature tables absent), and §45.3 reports the two exact conflicts: the frozen `CHECK` cannot represent "`RESTRICTED`, membership held elsewhere", and `resolve()` (L1081) admits any scope it does not recognise. **§39 stop condition 10** is the clause this exercises — a contradiction between the frozen text and the code is resolved by a decision, never by narrowing the rule inside an implementation |

## 42. DOCUMENT STATUS AND AMENDMENT RULE

**Status: FROZEN at Phase 54-A, and amended once since — by append, under this rule.** This file is the
repository's authoritative statement of Phase 54's requirements and decisions, and the source of truth
for every Phase 54 implementation phase that follows. Anything not stated here, in the approved product
brief, or in the repository's existing invariants is **not authorized**; §39 says what to do in that
case (stop and report — not fill the gap with a plausible default).

**Amendment 1 (§43, D14) was appended on 2026-09-21 under the rule below** and is part of the frozen
text. The 54-A sections are unedited except where amendment 1 carries an explicit supersede note in
place (§4.3 and §5) and its register row (§41) — so a reader who knows the 54-A text can see exactly
what changed and what did not (§43.11).

**Amendment 2 (§44, D15) was appended on 2026-09-21 under the same rule**, and it is an append in the
strict sense: it adds a register row (§41), a check row, a change-log row and §44, and it rewrites no
earlier text. The status sentence above says "amended once" because it was written when amendment 1 was
the only append; with amendment 2 the document stands at **two** appends, both listed in the change log
below. Amendment 2 records a decision **and** the failure of that decision's own execution gate, so the
implementation stops at the boundary §44.3 names instead of being pushed past it.

**Amendment 3 (§45, D16) was appended on 2026-09-21 under the same rule**, again as a pure append: a
register row (§41), a check row, this note, a change-log row and §45 — no earlier text rewritten. It
records the storage correction D15's failed gate left open (a Core-owned membership **child table**),
the pre-migration check that was run before it, and the two coexistence conflicts that check found.
The status sentence above still reads "amended once"; the document now stands at **three** appends,
all listed in the change log below. Like amendment 2, this one stops at a named boundary: §45.9 waits
for a yes to the mechanism before any migration is written.

Amendment rule:

1. **Append, do not silently edit.** A changed decision is a **new numbered decision** (D14, D15, …)
   with an explicit note that it supersedes the earlier one, so a reader can see that the rule changed
   and when — the same discipline this document applies to rule versioning (§10, §23).
2. **This section numbering is the repository's Phase 54 numbering.** No previous numbering is being
   followed, and future Phase 54 documents cite these numbers, not their own.
3. **The document is not a substitute for the code's own contracts.** Where this document and an
   implementation disagree, the implementation is wrong until a decision says otherwise (check 10 of
   §39).

### Change log

| Phase | Date | Change |
|---|---|---|
| 54-A | freeze | Initial specification: forty sections and D1–D13 frozen; baseline `c91485e` on `master`. |
| 54-C | 2026-09-21 | **Amendment 1 (D14, §43):** the platform module/**feature** entitlement layer — module-level inbound gate (narrow fail-closed read, not `resolve()`), Core-owned `ModuleFeature` / `ModuleFeatureGrant`, the `ENTITLEMENT_PORT` platform port, HR's `HR.Leave` feature registry, the admin surface, and explicit idempotent provisioning. Supersedes §4.3's *"and nothing else"* for the feature level only; exercises §5 rule 5's amendment path. No `hr_db` table, no `hr_db` column, no cross-database FK, no new permission code. |
| 54-C | 2026-09-21 | **Amendment 2 (D15, §44):** the module-entitlement tenant scope — HR provisioned `RESTRICTED` (explicit membership), new tenants fail-closed, `ALL` rejected, no billing/subscription logic; the existing Leave precedence (§43.9) restated, not changed. Records execution gate **D15-G1 FAILED** — 162 tenants exist against the live 64-entry `RESTRICTED` cap — which blocks the seed migration and (at rest) the HR wiring step per §44.3. This amendment makes **no** code, migration or schema change. |
| 54-C | 2026-09-21 | **Amendment 3 (D16, §45):** module/tenant membership storage — a Core-owned `ModuleRegistrationTenant` child table (**presence is membership**) becomes the **authoritative** membership source for HR under a third `ModuleTenantScope` member, `RESTRICTED_MEMBERS`; the legacy `tenantIds` 64-entry cap is **not** raised or removed, `ALL` stays rejected, all 162 existing tenants are seeded state-preservingly, new tenants stay unentitled, fail-closed. Records the pre-migration check and its two coexistence conflicts (§45.3), the mechanism that resolves them (§45.4), the FK/deletion decision inspected from existing semantics (§45.5), and the three-migration set with its 55P04 ordering (§45.6). This amendment makes **no** code, migration or schema change. |

<!-- end of PHASE 54-A specification -->

---

## 43. AMENDMENT 1 — PLATFORM MODULE / FEATURE ENTITLEMENT (D14)

### 43.1 The rule this section adds

**Every inbound request into a business module passes through an entitlement gate, and the gate's
default answer is REFUSE.** The gate answers exactly two questions, in this order, and answers them
from Core's own registry — never from the caller, never from the module's own database:

1. **Module level —** is this tenancy entitled to this module at all?
2. **Feature level —** if the request names a feature, is this tenancy entitled to *that feature
   inside that module*?

Three properties are the rule, not an implementation detail:

- **Fail-closed.** Absence of a row is a refusal, never an allowance. There is no allowlist of
  module ids, no "unregistered modules are assumed enabled", no dev-mode bypass. A module that has
  never been provisioned is a module that refuses.
- **Narrow read.** The gate reads `enabled` plus the tenant scope of the registration, and nothing
  else. It does **not** call `ModuleRegistryService.resolve()`: `resolve()` is the outbound path and
  additionally demands a live, fresh, contract-matching `ModuleInstance`
  (`module-registry.service.ts` L1058–L1121), which an **inbound** request into a module's own API
  does not have and must not need. Using `resolve()` here would refuse every request to every
  module that does not also run as a remote peer — verified against HR, which has neither a
  registration nor an instance row (§41 D14 rationale).
- **Ordered: module first, feature second.** A feature can never be reachable when its module is
  refused. This is the whole of the "hierarchy" — see §43.9 for the limit.

### 43.2 The entitlement model

Two levels, two tables, one vocabulary. The vocabulary is Core's existing registry vocabulary,
extended by exactly two codes rather than by a parallel one:

| Level | Storage | Meaning of a row |
|---|---|---|
| Module | `core_db.ModuleRegistration` (existing, unchanged) | `enabled` **and** tenant scope decide; HR is the `hr` registration |
| Feature | `core_db.ModuleFeature` (new) | the module *declares* a feature and says whether the platform offers it at all (`enabled`) |
| Feature grant | `core_db.ModuleFeatureGrant` (new) | **presence is the grant**: one row = this tenant holds this feature |

The decision function is total — one input, one outcome, no implicit fallbacks:

```
decide({ moduleId, featureId? })  ->  { ok: true } | { ok: false, failure: <code> }
```

Evaluation order is frozen, and each step can only make the outcome **more** restrictive:

1. no `ModuleRegistration` row for `moduleId` → `MODULE_NOT_FOUND`
2. registration `enabled === false` → `MODULE_DISABLED`
3. registration `tenantScope === 'RESTRICTED'` and this tenant is not in `tenantIds` → `MODULE_FORBIDDEN`
4. `featureId` absent → **allow** (the module level was the whole question)
5. no `ModuleFeature` row for `(moduleId, featureId)` → `FEATURE_NOT_FOUND`
6. that feature row's `enabled === false` → `FEATURE_DISABLED`
7. `featureId` present but the request carries no tenant id → `FEATURE_NOT_GRANTED`
   (a grant is a per-tenant row; a tenant-less caller can never match one)
8. no `ModuleFeatureGrant` row for `(feature row, tenant)` → `FEATURE_NOT_GRANTED`
9. otherwise → **allow**

`MODULE_NOT_FOUND`, `MODULE_DISABLED` and `MODULE_FORBIDDEN` are the codes `resolve()` already
raises for the same three conditions; the gate reuses them so an operator reads **one** vocabulary
for one registry. `FEATURE_NOT_FOUND`, `FEATURE_DISABLED` and `FEATURE_NOT_GRANTED` are the only new
codes — and `FEATURE_DISABLED` deliberately differs from `FEATURE_NOT_GRANTED`: *"the platform does
not offer this"* and *"your tenancy does not hold this"* are different facts, and therefore different
operator conversations.

### 43.3 Storage — additive, Core-owned, in `core_db`

Two new models in `apps/api/prisma/core/schema.prisma`, plus two additive **relation fields**: no
column is added to any existing table, so no existing row is rewritten.

```prisma
/// Phase 54-C (D14): a feature a module declares, and whether the platform offers it at all.
/// Fail-closed: a declared feature is OFF until an operator turns it on.
model ModuleFeature {
  id           String   @id @default(uuid())
  moduleId     String
  featureId    String
  displayName  String
  enabled      Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  registration ModuleRegistration  @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)
  grants       ModuleFeatureGrant[]

  @@unique([moduleId, featureId])
  @@index([moduleId])
}

/// Phase 54-C (D14): PRESENCE IS THE GRANT. One row = this tenancy holds this feature.
model ModuleFeatureGrant {
  id           String   @id @default(uuid())
  featureRowId String
  tenantId     String   @db.Uuid
  grantedAt    DateTime @default(now())

  feature      ModuleFeature @relation(fields: [featureRowId], references: [id], onDelete: Cascade)
  tenant       Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([featureRowId, tenantId])
  @@index([tenantId])
}
```

The two back-relations are `features ModuleFeature[]` on `ModuleRegistration` and
`featureGrants ModuleFeatureGrant[]` on `Tenant`. Both are relation fields only — **no column, no
index, no data change** on either existing table. `Tenant` here is `core_db`'s own tenant registry,
the same authority the registry already uses, and the relation is inside one database, so §24's
cross-database FK prohibition is untouched. Deleting a tenant removes its grants by cascade, which is
correct: a grant is a statement about a tenant, and a statement about a tenant that no longer exists
must not outlive it.

Constraints follow the registry's existing style rather than inventing a new one: SQL `CHECK`s that
`moduleId` and `featureId` match the same lowercase-slug rule as `ModuleRegistration.moduleId`, that
`displayName` is non-empty, and that `tenantId` is a real tenant (the FK above). `enabled` defaults
to `false` in the schema, exactly as `ModuleRegistration.enabled` does, so a declared feature is off
until an operator turns it on — the fail-closed default is the storage default, not a service
convention. The DDL is **additive only** — `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT`; no
`DROP`, no `DELETE`, no `ALTER … TYPE`, no narrowing of an existing `CHECK` (§39 check 11).

### 43.4 Where the code lives — the port, not a second registry

The surface is one directory under the platform layer, `apps/api/src/platform/entitlement/`,
following the existing platform-port pattern (`platform/audit/`, `platform/identity/`,
`platform/user-directory/`) exactly:

| File | Contains |
|---|---|
| `entitlement.contract.ts` | the `ENTITLEMENT_PORT` token, the `EntitlementPort` interface (**one** read-only method: `decide(input)`), the `EntitlementDecision` / `EntitlementFailure` types, the `RequiresModule` / `RequiresFeature` metadata decorators, and the failure-code Persian label record |
| `platform-entitlement.service.ts` | `PlatformEntitlementService implements EntitlementPort` — the **only** reader of `ModuleFeature` / `ModuleFeatureGrant` and the only implementation of the frozen §43.2 order |
| `module-entitlement.guard.ts` | `ModuleEntitlementGuard implements CanActivate` — reads the metadata, calls the port, maps a refusal to `403` |
| `platform-entitlement.module.ts` | providers `PlatformEntitlementService` and `{ provide: ENTITLEMENT_PORT, useExisting: PlatformEntitlementService }`; **exports the token only** |
| `module-feature.controller.ts` | the admin surface (§43.8), a controller of this module — not a second writer elsewhere |

The consumer-facing contract is **one method, read-only**. `useExisting` (not `useClass`) is the same
choice `platform-audit.module.ts` and `module-platform.module.ts` already make and for the same
reason: one instance, one resolver, so there is no second copy of the decision logic to drift.
Mutating operations are **not** on the port — a consumer physically cannot grant itself entitlement,
and that is a property of the type, not of a code review.

### 43.5 The gate — declaration, order and refusal shape

The gate is a Nest `CanActivate` guard applied **declaratively** at the boundary, never called from a
service:

- `@RequiresModule(HR_MODULE_ID)` on the controller class states the module-level question.
- `@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)` on a controller class states the feature-level
  question.
- `@UseGuards(ModuleEntitlementGuard)` applies the gate; the guard class is listed in the owning
  module's `providers` so the wiring is a visible, testable fact rather than an inference.

**A decorated surface with no metadata is refused.** If the guard runs and finds no
`@RequiresModule`/`@RequiresFeature` metadata, it returns `403` — a forgotten decorator must close a
door, not open one. The corresponding gate asserts that every HR controller carries
`@RequiresModule(HR_MODULE_ID)` and that every Leave controller additionally carries
`@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)` (§43.10), so the fail-closed default is a
backstop, never the everyday path.

Order of evaluation for one request is fixed by the existing chain and this amendment adds to the
end of it, never to the front:

1. `JwtAuthGuard` (global, `APP_GUARD`) — is there an authenticated actor?
2. `RolesGuard` (global, `APP_GUARD`) — does the actor hold the required permission?
3. `ModuleEntitlementGuard` (controller) — is this tenancy entitled?
4. the handler, which then applies its own tenant condition (§24).

Two consequences are stated as rules rather than left to be noticed. **First,** entitlement is
evaluated *after* authentication and authorization, so an unauthenticated or unauthorized request
never reaches the registry — entitlement adds a gate, it does not replace RBAC. **Second,**
entitlement is *not* a permission: a `SUPER_ADMIN` holding every permission code is still refused by
`ModuleEntitlementGuard` when the tenancy is not entitled. Routine administration of RBAC cannot
grant module access, and that is the point of §5's two-layer model.

The tenant is read from `RequestContextService.get()?.tenantId` — **the same source
`ModuleRegistryService.resolve()` uses** (`module-registry.service.ts` L1079) — so one request has
one tenant authority for both entitlement and data. No DTO field, no header, no query parameter and
no body field can influence it; §25 rule 7 is unchanged and this section adds no exception.

A refusal is `403 Forbidden` with a stable machine-readable body:

```json
{ "statusCode": 403, "code": "FEATURE_NOT_GRANTED", "moduleId": "hr", "featureId": "leave" }
```

The `code` is the frozen §43.2 failure code; `moduleId` and `featureId` are echoed so an operator and
a support engineer read the same sentence. Denials are **not** written to the audit trail — an
audit trail records events that happened to the system, and a refused request changed nothing; the
attempt is already an access-log fact. There is no "entitlement denied" notification, no workaround
header, and no partial mode: the refusal is total for the request.

If the port is not provided in a module that applies the guard, Nest fails at **boot**, not at request
time. That is deliberate: a misconfigured deployment must not start and then refuse, nor start and
then allow.

### 43.6 The HR surface — one constant, one feature, one port

HR's side of this is deliberately tiny, because entitlement is an access concern that belongs to the
boundary and not to HR's business:

| Adds | Where | Why |
|---|---|---|
| `HR_MODULE_ID = 'hr'` | `apps/api/src/modules/hr/hr.constants.ts` | the module's canonical id, next to the module's other constants — the same shape `HR_FEATURE` uses |
| `HR_FEATURE = { LEAVE: 'leave' } as const` | `apps/api/src/modules/hr/hr.constants.ts` | the feature ids HR declares, as a frozen record |
| `@RequiresModule(HR_MODULE_ID)` + `@UseGuards(ModuleEntitlementGuard)` on each HR controller class | the HR controller files | the module-level gate, declared where the route surface is |
| `@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)` on each Leave controller class | the HR Leave controller files | the feature-level gate, on the surface the feature names |
| `PlatformEntitlementModule` in `HrModule.imports`, `ModuleEntitlementGuard` in `HrModule.providers` | `apps/api/src/modules/hr/hr.module.ts` | one import site, exactly as `PlatformAuditModule` is imported today |

HR gains **no** gateway, **no** service, **no** repository and **no** table for entitlement. HR code
never reads `ModuleFeature`/`ModuleFeatureGrant`, never touches Core's database, and never decides
entitlement — it *declares* the requirement on its boundary and the platform answers it. The
asymmetry is the whole design: HR states *what it needs to know*, Core states *whether it is so*.

Consequently the HR isolation rules gain one narrow allowance and one new prohibition:

- **Allowed:** HR **controller** files and `hr.module.ts` may import from `platform/entitlement/**`.
  This mirrors the existing allowlist precedent for `PlatformAuditModule` / `UserDirectoryModule` in
  `hr.module.ts` (`hr-isolation.spec.ts` L368), and the permission is scoped to the boundary —
  entitlement is a presentation-layer concern.
- **Prohibited:** no HR **service** or **repository** file may import, reference or name entitlement
  at all. If entitlement ever needs to be known inside HR's application layer, that is a new
  decision (§42 rule 1), not a quiet import.

The rule that HR's business logic cannot see entitlement is stronger than the rule that it cannot see
Core's database, and the reason is the same one §5 gives for the feature layer: a business rule that
reads entitlement starts to depend on *who is paying*, which is policy the engine owns and HR does
not.

### 43.7 Provisioning — explicit, idempotent, and the reason HR keeps working

The fail-closed rule has a blunt consequence that must be handled deliberately rather than
discovered: **the moment the gate lands, `hr` has no `ModuleRegistration` row, so every HR request is
`403 MODULE_NOT_FOUND`.** Verified: no migration in `apps/api/prisma/core/migrations/**` has ever
inserted a `ModuleRegistration` row. That fail-closed steady state is the intended behaviour for a
module nobody has provisioned — but it must not become the state of every **existing** installation
as a side effect of this amendment. Provisioning is therefore explicit, and it is a migration.

Two migrations, in this order, each with its own directory and its own purpose:

| Migration | Does |
|---|---|
| `…_add_module_feature_entitlement` | the additive DDL of §43.3: two tables, their indexes, their `CHECK`s, their FKs |
| `…_seed_hr_leave_feature_entitlement` | the **provisioning**: the `hr` registration, the `hr`/`leave` feature row, and the grant rows for the tenants that exist at that moment |

Both are idempotent by construction: every insert targets an existing unique key and carries
`ON CONFLICT … DO NOTHING` (`ModuleRegistration.moduleId`, `ModuleFeature(moduleId, featureId)`,
`ModuleFeatureGrant(featureRowId, tenantId)`), so running them twice is indistinguishable from
running them once, and running them on a database where an operator has already provisioned by hand
changes nothing. Idempotent seeding of platform-owned rows is not a new idea here — it is exactly
what `…_seed_module_permission_grants` and `…_seed_hr_leave_permission_grants` already do, and this
migration is the same class of row: **the platform's own registry, not business configuration.** It
inserts no leave type, no policy, no working-hours record, no employee and no request.

**Why a migration rather than a hook or a default.** The three alternatives were each considered and
each is worse:

- *A `tenant.create` hook that provisions new tenants* — rejected. It makes entitlement a side effect
  of tenant creation, which means the two can drift and neither is auditable on its own. Provisioning
  must be an act an operator can perform, date and review, not an implicit consequence.
- *Treating a missing registration as enabled* — rejected outright: it deletes §43.1's fail-closed
  property, and with it every reason to have a registry.
- *A `registerModule` migration for every module* — out of scope here. This amendment provisions
  **HR only**, and only because this amendment is what would otherwise break it.

**The seeded shape, and the one clause worth confirming.** `hr` is seeded with
`moduleType = 'BUSINESS'`, `enabled = true`, `protocolVersion = 1`, and the tenant scope that the
recorded decision model implies:

- `tenantScope = 'RESTRICTED'` with `tenantIds` = **the tenants that exist when the migration runs**.

This is the faithful reading of the decision model that motivated the work — *provisioning is explicit,
and a tenant that was not provisioned is refused* — and it keeps the module level fail-closed for
tenants created later, exactly as the feature level is. Two costs are accepted knowingly and are
recorded here rather than discovered later:

1. **`tenantIds` is bounded at 64** (the registry's own `CHECK`/`@ArrayMaxSize` bound). If more than
   64 tenants exist at migration time the seed **raises and stops** instead of truncating the list —
   a migration that silently narrows an operator's tenant list into a `CHECK` violation later is a
   worse outcome than a migration that refuses to guess. The operator then either widens the row to
   `tenantScope = 'ALL'` or records a new decision for a per-tenant module grant table (D15).
2. **A tenant created after this migration gets neither HR nor Leave** until an operator provisions
   it — one `PATCH` of `tenantIds` for the module, one grant for the feature. That is fail-closed by
   construction and is the behaviour the decision model asks for; §43.9 states it plainly so it is
   read as a rule and not as an omission.

If a deployment has **zero** tenants at migration time, the seed inserts the feature row and the
feature declaration but no registration row (an empty `tenantIds` list would violate the registry's
own bound, so the migration declines to insert rather than insert an invalid row) — leaving the
strictly fail-closed state for a tenant-less platform, and leaving `ModulePlatformModule`'s admin
surface as the documented way to provision it.

The **feature** row is seeded `enabled = true` with a display name for operators, and the grants are
inserted for the same set of existing tenants (`INSERT … SELECT` over `Tenant`), so an existing
installation keeps working identically on the day this lands: HR answers, and Leave answers, for
every tenant that was already using it. A **later** module or feature gets no seed row at all — it
must be provisioned, which is the whole point.

`HR_MODULE_ID` and `HR_FEATURE.LEAVE` are the code's spelling of `'hr'` and `'leave'`; the migration
is the database's spelling of the same two facts. They are one fact in two places, so a gate asserts
they agree (§43.10), and the assertion reads the migration's SQL as **text** — no import, no new
coupling between HR and the platform.

### 43.8 The admin surface — where an operator grants and revokes

Entitlement that cannot be administered is entitlement that gets hard-coded, so the amendment carries
the surface that makes provisioning an ordinary operation. The API lives in
`platform/entitlement/module-feature.controller.ts` as a controller of
`PlatformEntitlementModule` — **not** a second writer in the registry module — and hangs off the
registry's existing path prefix so an operator finds modules and their features in one place:

| Route | Purpose | Permission |
|---|---|---|
| `GET admin/modules/:moduleId/features` | list the declared features: `featureId`, `displayName`, `enabled`, granted-tenant count | the registry's existing **read** code |
| `POST admin/modules/:moduleId/features` | declare a feature (a declared feature starts `enabled = false`, per §43.3) | the registry's existing **manage** code |
| `PATCH admin/modules/:moduleId/features/:featureId` | rename (`displayName`) or turn the platform offer on/off (`enabled`) | the registry's existing **manage** code |
| `GET admin/modules/:moduleId/features/:featureId/tenants` | the granted tenant ids, bounded and paginated | the registry's existing **read** code |
| `POST admin/modules/:moduleId/features/:featureId/tenants` | grant: body `{ tenantIds: string[] }`, 1–64 entries per call | the registry's existing **manage** code |
| `DELETE admin/modules/:moduleId/features/:featureId/tenants/:tenantId` | revoke one grant | the registry's existing **manage** code |

**No new permission code is introduced.** The registry controller already guards `admin/modules/**`
with a read code and a manage code; the feature routes reuse those two, so entitlement administration
is RBAC-administered with the tools that already exist and no permission matrix has to be re-seeded.
Every route carries `@Roles(...)`, and a gate asserts it on this controller the same way it is
asserted on the registry controller — a route that forgets its `@Roles` on `admin/modules/**` is a
route anyone can call.

Mutations write the platform audit trail through `AuditService`, with the same shape the registry's
mutations already use: actions `module.feature.declared`, `module.feature.updated`,
`module.feature.enabled`, `module.feature.disabled`, `module.feature.granted`,
`module.feature.revoked`; the resource is the feature row, with the tenant id carried for grants and
revocations. One vocabulary, one trail, one place to answer *"who turned Leave off, and when?"* —
the same discipline `module.registration.*` follows.

The grant body names tenants, and that is not a contradiction of §25 rule 7: that rule forbids a
client from *selecting the tenancy of a request* (§43.5 reads the request's tenant from the actor and
nothing else), whereas an admin grant states a **configuration fact** about tenants the caller
administers, under a manage permission, and the audit trail records it. The distinction is stated in
the code's own comment so a reader does not "fix" one into the other.

The web surface extends the existing console rather than adding a new one: `CoreModulesView.tsx`
gains a features section on the module detail — one row per feature with the platform on/off control,
the granted-tenant count, and the per-tenant effective state (**entitled** / **blocked by the module**
/ **blocked by the feature** / **not granted**), which is the operator's only honest way to see *why*
a tenant is refused without reading the database. `apps/web/src/lib/modules-api.ts` gains the client
functions for the six routes plus an `ENTITLEMENT_FAILURE_LABELS` record that covers **every** §43.2
failure code in Persian, so no raw code is ever rendered to a human. The module and feature id rules
are validated client-side with the same slug rule the DTO and the SQL `CHECK` enforce, so a form
discovers a bad id locally instead of through a `422` — the same three-way rule the registration
client already implements.

### 43.9 The hierarchy, the new tenant, and what is deliberately not built

**The hierarchy is exactly two levels: module → feature.** A feature belongs to a module through
`ModuleFeature.moduleId`; a request is refused at the module level before any feature is considered;
there is no third level, no feature-to-feature nesting, no inheritance between features and no tree
walking anywhere in the resolver. `HR → HR.Leave` is two levels and nothing more, and the storage
says so.

**A tenant that was not provisioned is refused, and absence stays the default.** New tenants get
nothing from any hook, trigger, default or lazy creation (§43.7). These are the state transitions an
operator can observe, and the whole of the model:

| Module row | Module `enabled` | Tenant in scope | Feature row | Grant | Result |
|---|---|---|---|---|---|
| absent | — | — | — | — | `403 MODULE_NOT_FOUND` |
| present | `false` | — | — | — | `403 MODULE_DISABLED` |
| present | `true` | `RESTRICTED`, tenant not listed | — | — | `403 MODULE_FORBIDDEN` |
| present | `true` | in scope | absent | — | `403 FEATURE_NOT_FOUND` |
| present | `true` | in scope | `enabled = false` | — | `403 FEATURE_DISABLED` |
| present | `true` | in scope | `enabled = true` | absent | `403 FEATURE_NOT_GRANTED` |
| present | `true` | in scope | `enabled = true` | present | **allowed** |

Deliberately **not** built in this amendment, each with its reason:

- **No per-tenant module grant table.** The module level keeps the registry's existing
  `tenantScope` + `tenantIds` shape. If a deployment needs per-tenant module entitlement beyond the
  64-tenant bound, that is a new decision (§42 rule 1) with its own table, not a silent extension of
  this one.
- **No feature-level scope enum.** Feature entitlement is a row per tenant (`ModuleFeatureGrant`),
  because a feature grant is expected to be narrower than a module scope, and a bounded array would
  only make that harder to express as it grows.
- **No coupling between entitlement and permission.** Holding a permission never implies entitlement,
  and entitlement never implies a permission; the two are checked separately and in that order
  (§43.5). Nothing in this amendment reads `Role`/`Permission`, and nothing in RBAC reads entitlement.
- **No rule-engine awareness in either direction.** No rule reads entitlement; entitlement reads no
  rule, no rule version and no rule evaluation result. §5's separation of the two layers is intact —
  an amendment about *access* changes nothing about *policy*, and D12's purity is untouched because
  the resolver is not the rule engine.
- **No observable, event, metric, scheduler job or notification for entitlement.** Refusals are
  `403`s (§43.5); grants and revocations are audit rows written in the request that made them. A
  cross-module event for entitlement would invite a business module to react to it, which is exactly
  the coupling §43.6 forbids — and a module that reacts to entitlement would make entitlement a
  business dependency.
- **No change to `hr_db`.** This amendment adds no HR table, no HR column, no HR migration and no HR
  index. `hr_db` is untouched, which is what §5 rule 5 requires and what the HR isolation gates
  continue to enforce.

### 43.10 The gates — one per claim, each able to fail

Every claim in this section has a check that can fail. A check that cannot fail is not a check, so
each row names the falsifying failure it would catch, not just the file it lives in:

| # | Gate | The failure it catches | Where |
|---|---|---|---|
| 1 | Resolver truth table: all seven rows of §43.9, plus the frozen order (a disabled module cannot be rescued by a feature, a tenant-less caller cannot match a grant) | a branch that allows by default, or a reordered step that lets an unprovisioned module through | `platform-entitlement.service.spec.ts` |
| 2 | Guard spec: decorated-without-metadata ⇒ `403`; a `?tenantId=` query param, body field or header cannot influence the decision; refusal status and body shape | a surface that opens when its decorator is forgotten; a tenant that can be claimed by a caller | `module-entitlement.guard.spec.ts` |
| 3 | HR source gate: every HR controller carries `@RequiresModule(HR_MODULE_ID)`; every Leave controller additionally carries `@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)`; `ModuleEntitlementGuard` is listed in `HrModule.providers`; entitlement imports appear **only** in HR controllers and `hr.module.ts`, never in an HR service or repository | a new HR controller that ships ungated; entitlement leaking into HR's application layer | `apps/api/src/modules/hr/hr-isolation.spec.ts` |
| 4 | Constant ↔ provisioning drift: the provisioning migration's SQL, read as text, seeds exactly `HR_MODULE_ID` and `HR_FEATURE.LEAVE` | a constant renamed without moving the provisioned row — which would refuse a working module in production | `apps/api/src/modules/hr/hr-isolation.spec.ts` |
| 5 | Migration gates: the DDL migration is additive only (no `DROP`, `DELETE`, `ALTER … TYPE`, no narrowed `CHECK`); both migrations are idempotent (`ON CONFLICT … DO NOTHING` on every insert); the >64-tenant stop-guard exists | a destructive provisioning step; a non-idempotent seed that fails or duplicates on a second run; a silent truncation of the tenant list | a Core-side spec reading the migration SQL, beside the existing module-platform specs |
| 6 | Admin controller gate: every route on the feature controller carries `@Roles(...)`; every mutation writes its audit action; no route lets a caller change the tenancy of a request | an `admin/modules/**` route anyone can call; an unrecorded grant or revocation | `module-feature.controller.spec.ts` |
| 7 | Boundary gates stay green with the two new allowlist entries: `architecture-boundaries.spec.ts` (platform ⊥ business, Core ⊥ HR, module-platform ⊥ business) and `hr-isolation.spec.ts` (HR holds no Core database handle) | the amendment quietly becoming a way for HR to read Core's database | `apps/api/src/architecture-boundaries.spec.ts`, `hr-isolation.spec.ts` |
| 8 | Web gate: `ENTITLEMENT_FAILURE_LABELS` is a complete record over the failure union (adding a code is a type error, and the existing spec's key-iteration discipline is reused), and the client slug rule matches the server's | a raw machine code rendered to an operator; a form that discovers the id rule through a `422` | `apps/web/src/lib/__tests__/modules-api.spec.ts` |

Gates 3, 4 and 5 read **files as text** rather than importing across the boundary, which is the same
technique the HR isolation specs already use for migration SQL — it makes a cross-boundary fact
checkable without creating the import the boundary forbids.

### 43.11 What this amendment does not change

Each of these was checked against this document before the amendment was written, so that the
amendment is additive in the document's own terms and not merely in its tone:

- **§5 rules 1–4 stand untouched.** Entitlement is still honoured by the **boundary**, never by a
  rule; a rule still cannot read entitlement; the registry/entitlement authority is still Core and
  still `core_db`; and no business module gains a new source of truth.
- **RBAC is unchanged.** No permission code, no role, no guard order. `JwtAuthGuard` and `RolesGuard`
  remain the only global guards, and they still run first (§43.5).
- **D12 purity is unchanged.** The rule engine stays free of Prisma, HTTP, DB, env, clock, audit,
  notification and mutation, and the entitlement resolver is a platform service that the engine does
  not import.
- **§24 isolation is unchanged.** HR keeps TEXT tenant ids, composite `(tenant_id, …)` keys, tenant
  from the actor, no cross-database FK — and now also no cross-database entitlement read.
- **`DISABLE ≠ DELETE` is honoured.** Turning a feature off refuses *access*; it deletes nothing. No
  leave request, balance, type, policy or history is touched by this amendment, and re-enabling a
  feature restores exactly the data the tenants had before, because nothing was removed from it.
- **The audit and identity gateways are untouched.** `HrAuditGateway` and `HrIdentityGateway` keep
  their shapes; audit for entitlement changes is a **platform** trail written by the admin surface
  (§43.8), not a new HR gateway call.
- **No scheduler, no workflow, no notification** is introduced anywhere in this amendment, and no HR
  migration is created — `hr_db` receives nothing.

### 43.12 Scope limits, and the order the work is done in

Three limits are recorded here so they are read as decisions rather than found later as surprises:

1. **The module level is bounded by the registry's existing 64-tenant array** for a `RESTRICTED`
   registration, with the stop-guard described in §43.7. The feature level has no such bound, because
   it stores one row per tenant.
2. **Provisioning is an operator act, not an automatic one.** Nothing in the amendment provisions a
   module implicitly, including for tenants created after the seed. A deployment that wants
   `tenantScope = 'ALL'` for HR can say so; the amendment's seeded choice is the narrower one.
3. **This amendment provisions HR only.** Other modules get a registry row when someone provisions
   them, through the admin surface that already exists. That HR is the first module with a feature
   registry is a fact about this phase, not a claim about the others.

The work is done in this order, each step leaving the tree green:

1. the entitlement port, service and guard with their unit specs (no consumer yet — nothing to break);
2. the admin controller and its spec (**no permission code added**; reuse the registry's read/manage
   codes);
3. the two migrations, with the Core-side migration gates;
4. `HR_MODULE_ID` / `HR_FEATURE` in `hr.constants.ts`, the decorators and guard on the HR controllers,
   the module wiring in `hr.module.ts`, and the extended `hr-isolation.spec.ts` gates;
5. the web client functions, the failure-label record and the features section in `CoreModulesView.tsx`
   with the extended web spec;
6. the full gate suite, run rather than reasoned about, including the boundary specs which must stay
   green **without** amendment.

The last step is the one that makes the rest of this section true: a spec that was never run is a
claim, not a gate.

<!-- end of PHASE 54-C amendment (D14) — §43 closed -->

---

## 44. AMENDMENT 2 — MODULE-ENTITLEMENT TENANT SCOPE (D15)

### 44.1 The decision

HR's module entitlement is provisioned as `tenantScope = 'RESTRICTED'`, seeded with the tenants that
exist at migration time. Three consequences are frozen:

1. **Explicit membership is the whole model.** `tenant ∈ HR entitlement ⇒ HR available`;
   `tenant ∉ HR entitlement ⇒ HR unavailable`. There is no third state and no implicit membership.
2. **`tenantScope = 'ALL'` is rejected for this purpose.** `ALL` would make HR the default for every
   tenant created afterwards, so "this customer did not buy HR" would need a second, deny-shaped
   mechanism. `ALL + exclusions` is strictly weaker and strictly more complex than
   `RESTRICTED + membership`.
3. **New tenants get nothing automatically.** HR arrives by explicit provisioning; before that
   provisioning the answer is a refusal — §43.1's fail-closed rule, now with the scope that makes it
   reachable.

The feature level is unchanged: Leave stays explicit and tenant-scoped, and its effective state still
requires HR effective **and** Leave's own grant (§43.9), so a Leave grant under a non-entitled HR is
**OFF**. No billing, subscription, pricing or metering surface is introduced — this phase consumes the
entitlement mechanism, it does not price it.

### 44.2 Execution gate D15-G1 — REQUIRED, RUN, **FAILED**

The decision carries a precondition: seeding "the tenants that exist at migration time" must fit the
storage `RESTRICTED` actually has. It was measured against the live database, not assumed:

| What was checked | Evidence | Result |
|---|---|---|
| The storage bound | `ModuleRegistration_tenantScope_consistent`, read from `pg_constraint` on the live `core_db`: `ALL` ⇒ `array_length("tenantIds",1) = 0`; `RESTRICTED` ⇒ `BETWEEN 1 AND 64`. The same bound is in `20260905120000_add_module_platform/migration.sql` L166–L167 and in the DTO (`MAX_TENANT_IDS = 64`, `module.dto.ts` L69, enforced at L332/L372) | **64, enforced by the database** |
| Tenants existing today | `count(*) from "Tenant"` on the live `core_db` — the container instance and the host instance (`.env`, port 5544) agree exactly | **162** (statuses: 160 `NULL`, 2 `ACTIVE`) |
| Whether HR already has a registration | `ModuleRegistration` holds **one** row: `gate-finance` (`enabled=false`, `ALL`, 0 ids, created 2026-09-08 — a 49M-2 gate artifact). No `hr` row exists | **nothing to reuse** |
| Feature storage | `to_regclass` for `ModuleFeature` / `ModuleFeatureGrant` | **absent**, as §43.3 expects |

**Verdict: FAILED — 162 > 64.** A `RESTRICTED` HR registration cannot list the tenants that exist at
migration time, and the database refuses such a row rather than accepting a partial one. The two
readings that would still fit were considered and **not** taken silently: seeding only the 2 `ACTIVE`
tenants (who counts as a purchaser is a product question, and 160 rows carry the `NULL` status the schema
itself declares undecided) and seeding a truncated prefix (a silent denial of entitlement). Note also
what the D14 rationale's bullets mean after measurement: "no migration has ever inserted a
`ModuleRegistration` row" still stands, while "there is no registration to read today" is true of **HR**
rather than of the table, which holds the one 49M-2 artifact named above.

### 44.3 What this stops, and what it does not

**Blocked** until a decision corrects the storage: the **seed** half of §43.12 step 3
(`…_seed_hr_leave_feature_entitlement`), the Core-side gate asserting it, and therefore step 6's
migration gates.

**Deliberately not done** to get past it: truncating the list to 64, splitting HR across several
registrations, or inventing an overflow rule. Each turns "entitled" into "entitled if your id sorted
early" — the failure mode this surface exists to prevent.

**Not blocked:** §43.12 steps 1 and 2 (port/service/guard, admin controller) and step 5 (web surface).
The **DDL** half of step 3 also stands — it creates the two feature tables and touches no tenant list.
Step 4 (HR decorators, guard, wiring) may be written but must **not** be the state at rest in any
environment until an entitlement row exists there: with fail-closed semantics and no `hr` registration,
it would refuse every HR request.

The correction is **D16** in the register, and it is not taken here, because it changes a constraint on a
frozen table and has three real shapes: a membership **child table** (unbounded, presence = membership,
keeps fail-closed and leaves the array's 64-cap for every other module); a **raised or removed cap** on
the existing array (a change to a frozen invariant, and it makes one row carry every tenant); or `ALL`
for HR, already rejected in §44.1. §43.7's stop-guard — raise and stop, never truncate — is the shape all
three inherit.

### 44.4 What this amendment does not change

No `ALL` scope for HR. No billing, subscription, pricing or metering. No change to the §43.9 hierarchy,
the §43.2 failure codes, the §43.5 gate order or the fail-closed default. No `hr_db` schema change, no
cross-database FK, no new permission code (§43.11). No code, migration or schema change of any kind is
made by this amendment.

<!-- end of PHASE 54-C amendment 2 (D15) — §44 closed -->

## 45. AMENDMENT 3 — MODULE / TENANT MEMBERSHIP STORAGE (D16)

### 45.1 What this corrects, and why it is a new decision

D15 said HR is provisioned `RESTRICTED` with "the tenants that exist at migration time", and its
execution gate **D15-G1 failed**: 162 tenants exist against a live `CHECK` that admits between 1 and
64 `RESTRICTED` ids (§44.2). What has to give way is a **constraint on a frozen table**, and §42
rule 1 does not allow that to be edited quietly, so the correction is a new numbered decision —
**D16** — recorded in the same append-only shape as amendments 1 and 2.

It is also the branch §43.7 already named. That section's own clause reads: if more than 64 tenants
exist, the seed "raises and stops instead of truncating the list", and "the operator then either
widens the row to `tenantScope = 'ALL'` or records a new decision for a per-tenant module grant table
(D15)" (§43.7, the first of the two costs it accepts knowingly). `ALL` was rejected in §44.1; D16 takes the second branch — and takes it as a **child table of the
existing registration** rather than a second registry, so the platform keeps exactly one answer to
"does this module exist, and for whom".

### 45.2 The pre-migration check — run, and what it measured

Every fact below was read from the live `core_db` (the container `aria-erp-postgres` and the host
instance at `.env`'s port agreed exactly) or from the frozen files, **before** any code was written:

| Check (D16) | Measured | Verdict |
|---|---|---|
| All existing tenants representable | `Tenant` holds **162** rows, **162** distinct ids, **0** null ids, **2** with `status = 'ACTIVE'` (the other 160 are `NULL`) | ✓ representable — an unbounded child table carries no 64-entry bound |
| No competing membership source exists | `ModuleFeature` / `ModuleFeatureGrant` **absent**; `ModuleRegistration` holds **one** row (`gate-finance`, `enabled = false`, `ALL`, 0 ids — a 49M-2 gate artefact); **no** `hr` row; no other table keys a module by tenant | ✓ nothing to reconcile, nothing to migrate from |
| Target unique constraint | `ModuleRegistrationTenant(registrationId, tenantId)` — the tenant is the discriminator, so one row per tenant per module, and idempotency has a key to target | ✓ named, not invented |
| Migration is idempotent | `ON CONFLICT … DO NOTHING` against that key and `INSERT … SELECT` over `Tenant` — the idiom `…_seed_module_permission_grants` and `…_seed_hr_leave_permission_grants` already use | ✓ the same class of row: the platform's registry, not business configuration |
| Existing HR behaviour preserved | Today HR has **no** gate at all (no registration row, no feature tables, no inbound entitlement check), so "preserved" means every tenant existing at migration time gets a membership row, and the gate is wired nowhere until that row exists | ✓ state-preserving by construction |
| New tenants remain unentitled | The gate reads membership; a tenant created after the seed has no row | ✓ fail-closed |
| Tenant/membership deletion semantics inspected | Live: the FKs into `Tenant` are `Lead` → `ON DELETE CASCADE` (`schema.prisma` L378) and `User` → `ON DELETE SET NULL` (L189); the only child of `ModuleRegistration` (`ModuleInstance.registrationId`) → `ON DELETE CASCADE` (L2113); `RESTRICT` appears exactly twice in the core schema (`SurveyAnswer.option` L1037, `ModuleProvisioningExecution.target` L2504). Declared, not yet implemented: §43.3's `ModuleFeatureGrant` → `CASCADE` on both parents | see §45.5 — `CASCADE` on both FKs is the **repository-consistent** choice and is therefore not the invention D16-14 prohibits |
| No duplicate tenant/module membership | impossible by the PK on `Tenant.id` (162 distinct of 162) and by the unique key above | ✓ |

Two of D16's conditions could **not** be met by the storage as frozen. Those are the conflicts §45.3
reports, and they are why no migration exists yet.

### 45.3 The two exact coexistence conflicts (reported, not worked around)

Both were found by reading the frozen DDL and the implemented service, and each is an instance of
§39 stop condition 10 — a contradiction between the frozen text and the code is "reported and
resolved by a decision — not by narrowing the rule inside an implementation".

**Conflict 1 — the `CHECK` cannot express "`RESTRICTED`, with membership held elsewhere."**
`ModuleRegistration_tenantScope_consistent` (live, and verbatim in
`20260905120000_add_module_platform/migration.sql` L164–L167) is:

```sql
("tenantScope" = 'ALL' AND coalesce(array_length("tenantIds", 1), 0) = 0)
OR ("tenantScope" = 'RESTRICTED' AND coalesce(array_length("tenantIds", 1), 0) BETWEEN 1 AND 64)
```

`ModuleTenantScope` has exactly two members (`migration.sql` L86). So for an `hr` row: `ALL` is
rejected by D15/D16-3; `RESTRICTED` **requires** between 1 and 64 ids in the array; and putting the
membership in the array as well is the two-sources-of-truth D16-4 forbids. There is no third
representation — and the pair invariant is deliberate, not accidental: the schema comment on
`tenantIds` says the constraint is what makes "restricted to nobody" and "restricted to everybody"
both unrepresentable (`schema.prisma` L1972–L1975), and the DDL comment above the constraint names the
second of the two mistakes it prevents — "ALL with a stale leftover list" — as "the dangerous one"
(`migration.sql` L159–L163).

**Conflict 2 — `resolve()` admits any scope it does not recognise.** The outbound path's tenant check
(`module-registry.service.ts` L1081) is
`if (registration.tenantScope === ModuleTenantScope.RESTRICTED)`. A registration carrying a scope that
is **not** `RESTRICTED` therefore passes the tenant check **unconditionally**. Introducing a third
member without touching that line would leave a silent widening: the new scope would be admitted for
every tenant in the outbound path. That is not a claim about HR today — HR has no instance row, so
`resolve('hr')` is `MODULE_NOT_FOUND` — it is a hole that would exist in the code the moment the
member exists. §43.11's "the gate is not `resolve()`" is a statement about the **inbound** path; it is
not a licence to leave the outbound one non-exhaustive. Both conflicts are consequences of D16, so
both are resolved by D16 and not by an implementation shortcut.

### 45.4 The mechanism — the smallest change that satisfies all of D16

Derived from the two conflicts rather than picked from a menu; each element answers a numbered
condition of D16, and none of it is a workaround:

1. **A third member, `RESTRICTED_MEMBERS`, on `ModuleTenantScope`** — "membership is enumerated explicitly, in
   the child table". Added by `ALTER TYPE "ModuleTenantScope" ADD VALUE IF NOT EXISTS 'RESTRICTED_MEMBERS'` in
   **its own migration file**: PostgreSQL allows the `ADD` inside a transaction but forbids *using* a
   freshly added enum value in the same transaction (SQLSTATE 55P04) — the rule
   `…_seed_hr_leave_permission_grants` already records at L57–L58. No existing row changes value, and
   `ADD VALUE` only appends to the enum's ordering.
2. **One added branch to the `CHECK`, and nothing else in it:**

```sql
-- D16: membership is enumerated in "ModuleRegistrationTenant".
-- The ALL and RESTRICTED branches below are byte-identical to the frozen constraint.
OR ("tenantScope" = 'RESTRICTED_MEMBERS' AND coalesce(array_length("tenantIds", 1), 0) = 0)
```

   The change **widens** the accepted set (a third case) and **narrows nothing**: the `ALL` branch and
   the `RESTRICTED … BETWEEN 1 AND 64` branch are copied unchanged, which is what D16-1 requires. It is
   performed as a `DROP CONSTRAINT` + `ADD CONSTRAINT` **under the same name**, so the constraint a
   reader greps for is still the constraint that exists. That `DROP` is the only one in this
   amendment and it destroys no data and no accepted set: every row that satisfied the old constraint
   satisfies the new one, so §39 stop condition 11's concern ("any drop, any rewrite of existing rows,
   any narrowing of a `CHECK` against live data") is not met by it.
3. **`resolve()` becomes exhaustive** — the tenant check is inverted so that *every* non-`ALL` scope
   must prove membership: `RESTRICTED` reads the array exactly as it does today (behaviour
   byte-identical), `RESTRICTED_MEMBERS` reads the child table. The `ALL` path keeps its zero-query behaviour, so
   the registry's own one-query property — "ONE QUERY … No probe, no fan-out, no N+1"
   (`module-registry.service.ts` L1054–L1056) — is preserved for every module that has not opted into
   `RESTRICTED_MEMBERS`.
4. **One Core-owned membership read**, used by both the inbound gate (§43.5) and `resolve()`. This is
   the single source of truth D16-5 demands: for an `RESTRICTED_MEMBERS` module, membership is read from
   `ModuleRegistrationTenant` and from nowhere else. No `hr_db` table, no column on `Tenant`, no
   cross-database FK, no new permission code (§43.11 unchanged).
5. **`RESTRICTED_MEMBERS` is not writable through the admin API.** Neither `TENANT_SCOPES` nor `MAX_TENANT_IDS`
   (`module.dto.ts` L74/L69) is extended: an operator cannot move a module **into** `RESTRICTED_MEMBERS` (that
   would be a grant decision expressed as a scope edit) and cannot move one **out of** it (that would
   silently widen an enumerated set to every tenant). `enabled` stays the platform's switch. The
   membership table is provisioned by migration, and an operator surface for it is deliberately not
   built (§45.9).
6. **"Restricted to nobody" stays unrepresentable for `RESTRICTED`**, and becomes representable only
   as an `RESTRICTED_MEMBERS` module with zero membership rows — exactly the fail-closed state D15 asks for
   ("new tenants receive nothing automatically"), never a state that silently means "everyone".

**The alternative that was rejected.** Relaxing the `RESTRICTED` branch from `BETWEEN 1 AND 64` to
`BETWEEN 0 AND 64` would have avoided the enum member. It is worse in three ways: it makes "restricted
to nobody" silently representable **for every module**, so an empty array stops being a detectable
error; it leaves one representation whose *meaning* now depends on whether a child row happens to
exist, which is exactly the two competing sources D16-4 forbids; and it would force **every**
`RESTRICTED` read path to consult the membership table, changing the semantics of modules that have
nothing to do with HR. It is recorded here as considered and not taken.

### 45.5 Storage — the child table, and the deletion semantics D16-14 asks about

```prisma
/// Phase 54-C (D16): PRESENCE IS MEMBERSHIP. One row = this tenant is entitled to this module.
/// The authoritative membership source for an `RESTRICTED_MEMBERS` registration; the legacy `tenantIds`
/// array keeps its 64-entry bound and its meaning for every module that is not RESTRICTED_MEMBERS.
model ModuleRegistrationTenant {
  id             String   @id @default(uuid())
  registrationId String
  tenantId       String
  createdAt      DateTime @default(now())

  registration   ModuleRegistration @relation(fields: [registrationId], references: [id], onDelete: Cascade)
  tenant         Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([registrationId, tenantId])
  @@index([tenantId])
}
```

The table is **Core-owned, in `core_db`**, exactly like the two feature tables of §43.3. It adds two
**relation fields** (`tenantMembers ModuleRegistrationTenant[]` on `ModuleRegistration`,
`moduleMemberships ModuleRegistrationTenant[]` on `Tenant`) and **no column** to either, so no existing
row is rewritten (§39 stop condition 11). The unique key is what makes migration 3 idempotent and
what makes "the same tenant cannot be granted the same module twice" a database fact rather than a
convention (D16-13). The tenant is the discriminator, deliberately: a customer's identity is exactly
what this table exists to record, so unlike the registry's own "COUNT, not the ids" rule for the
legacy array (`module-registry.service.ts` L467), this table holds the id — that is its purpose.

**One drafting correction, reported rather than silently fixed.** This sketch types `tenantId` as a
plain `String`, and only that can be implemented: `Tenant.id` is `String @id @default(uuid())` with no
native type (`schema.prisma` L150), and `@db.` appears exactly once in the whole core schema
(`CalendarOccasion.jalaliDate`, L1181). §43.3's `ModuleFeatureGrant` sketch (Amendment 1, L2084) types
the same column `String @db.Uuid`, which a foreign key to a `text` column cannot accept — a drafting
error in that amendment's Prisma, not in its decision, recorded here because earlier amendment text is
not rewritten. When §43.3 is implemented, `ModuleFeatureGrant.tenantId` is a plain `String`, exactly
like this table's.

**Deletion behaviour, inspected rather than assumed.** D16-14 requires the repository-consistent
behaviour and forbids *inventing* cascades. What exists, measured: the only child of
`ModuleRegistration` today is `ModuleInstance`, and its FK is
`ON DELETE CASCADE ON UPDATE CASCADE` (`20260905120000_add_module_platform/migration.sql`
L270–L271); the FKs into `Tenant` are `Lead` → `CASCADE` and `User` → `SET NULL`; and §43.3's
`ModuleFeatureGrant` is `CASCADE` on both parents, with its reason stated ("a statement about a tenant
that no longer exists must not outlive it"). `CASCADE` on both FKs is therefore **the repository's own
convention for this parent and for `Tenant`-referencing rows** — so choosing it is not the invention
D16-14 prohibits, and `RESTRICT` would in fact be the novel choice here: it appears exactly twice in
the whole core schema — `SurveyAnswer.option` (L1037) and `ModuleProvisioningExecution.target` (L2504)
— and the one module-platform use protects a *machine-identity record* ("deleting a target that has
executions would destroy the only record of which machine was touched", L2500–L2502), which is not a
row *about a tenant*; choosing it here would also make tenant deletion fail for the first time in the
repository *because of entitlement data*, and would contradict §43.3's stated rule for the sibling
table. The consequence is accepted and
stated: deleting a tenant removes its membership rows, and a tenant re-created under a new id starts
**unentitled** — the same fail-closed direction as everything else in this layer. **No migration
deletes anything** ("no data deletion": the phrase is about what the migrations do). This is the one
point where D16-14's two sentences can be read against each other; it is flagged here, not buried, and
§45.9 carries it into the confirmation.

### 45.6 The migrations — three files, ordered, idempotent, state-preserving

| # | Migration | Does | Why it is its own file |
|---|---|---|---|
| 1 | `…_add_module_tenant_scope_explicit` | `ALTER TYPE "ModuleTenantScope" ADD VALUE IF NOT EXISTS 'RESTRICTED_MEMBERS'` | 55P04: the value cannot be *used* in the transaction that adds it |
| 2 | `…_add_module_registration_tenant_membership` | the `ModuleRegistrationTenant` table, its unique key, index and FKs, and the `CHECK` replaced with the identical constraint **plus** the `RESTRICTED_MEMBERS` branch | it *uses* the new value, so it must be a later transaction |
| 3 | `…_seed_hr_module_tenant_membership` | the `hr` registration row and one membership row per existing tenant, `INSERT … SELECT` over `Tenant` | it is the state-preserving provisioning act, and the only file that touches data |

Ordering against the code: migrations 1 and 2 are the **DDL half** and may land at any time — they
touch no tenant list and refuse no request. Migration 3 must be applied **before** the HR wiring of
§43.12 step 4 exists at rest anywhere, for the reason §44.3 gives: with fail-closed semantics and no
membership row, the gate would refuse every HR request. On an installation whose tenant set is empty,
migration 3 has nothing to seed and the module stays fail-closed for everyone — the state D15 asks
for, not an error (the §43.7 clause on the tenant-less case is unchanged).

**What migration 3 must never do**, restated because this is the gate that failed once already: it
does not truncate to 64, it does not split HR across several registrations, it does not invent an
overflow rule, and it does not fall back to `ALL`. Its insert is shaped so that the tenant set is
*read*, not *listed*; if a bound it depends on ever turns out to be smaller than the tenant set, it
**raises and stops** (§43.7's clause, kept as written).

And it is not the seed §39 stop condition 11 forbids. What migration 3 writes is the platform's own
registry — the registration row and its enumerated membership — the same class of row §43.7 already
accepted and §43.3 already calls "the platform's registry, not business configuration". No leave
policy, no working hours, no accrual, no monetary rule and no new permission code is seeded, which is
what that clause is aimed at.

### 45.7 What this amendment does not change

The whole of D15's decision: HR is explicit membership, fail-closed for tenants created later, `ALL`
rejected, no billing/subscription/pricing/metering. §43.9's Leave precedence, §43.2's failure codes,
§43.5's gate order and the §43.3 feature tables are untouched. `ModuleRegistration.tenantIds` keeps its
64-entry cap and remains the membership source **for every module that is not `RESTRICTED_MEMBERS`** — not
raised, not removed, not re-scoped, and no live row is rewritten. `MAX_TENANT_IDS`, `TENANT_SCOPES` and
the admin DTOs stay as frozen. No `hr_db` schema change, no cross-database FK, no new permission code,
and the rule engine does not become entitlement-aware in any direction.

### 45.8 The gates this amendment owes

Each claim above gets one gate that can fail (§43.10's rule):

| Gate | Asserts |
|---|---|
| migration-text gate (Core side) | migration 2 replaces the constraint and the replacement still contains the frozen `RESTRICTED … BETWEEN 1 AND 64` branch verbatim, and none of the three files contains `DROP TABLE`, `DELETE`, `TRUNCATE` or a narrowed bound — the same read-the-SQL-as-text technique `correspondence-isolation.spec.ts` and `hr-isolation.spec.ts` already use |
| enum-separation gate | the `ADD VALUE 'RESTRICTED_MEMBERS'` sits in a file that contains no statement *using* `'RESTRICTED_MEMBERS'` (55P04), and the value is added with `IF NOT EXISTS` |
| service spec | `resolve()` refuses a non-`ALL` registration with no proven membership, for **both** non-`ALL` members, and keeps the `ALL` path query-free |
| DTO spec | `RESTRICTED_MEMBERS` is refused by the admin API in both directions — it cannot be written into `tenantScope` and cannot be read back out as a manageable scope |
| seed gate | the seed's membership insert is `INSERT … SELECT` over `Tenant` with `ON CONFLICT … DO NOTHING` — not a literal list, not a truncation, and the row count it produces equals the tenant count at that moment |
| representation gate | the `RESTRICTED_MEMBERS` branch of the constraint requires an **empty** `tenantIds` array, so the same row cannot carry a second membership source |
| column-type gate | no table or column introduced by D16 carries a `@db.` native type, and no foreign-key column's type differs from the type of the column it references — the check that catches Amendment 1's `ModuleFeatureGrant.tenantId` slip (§45.5) before `prisma migrate` compiles it |

These join the gate set §43.10 and §43.12 already name; none of them replaces one of those.

### 45.9 The one thing still open before the migrations are written

§45.4 changes a frozen enum and one branch of a frozen `CHECK` on `ModuleRegistration`, and §45.5
chooses `CASCADE` where a `RESTRICT` was conceivable. D16 asked for exactly this report, so the
migrations wait for a yes to the mechanism — and with it to the three consequences stated above:
`resolve()` gains an `RESTRICTED_MEMBERS` branch (so the outbound path cannot be silently widened), `RESTRICTED_MEMBERS`
is not writable through the admin API, and tenant deletion cascades the membership rows.

Two boundaries are deliberate and are **not** opened by this amendment: there is no operator UI or
endpoint for editing membership rows (provisioning a new tenant is an operator act against a
Core-owned table, and building half a surface now would be the "permission granted into nothing"
mistake in a different costume), and there is no billing, subscription, pricing or metering of any
kind.

<!-- end of PHASE 54-C amendment 3 (D16) — §45 closed -->
