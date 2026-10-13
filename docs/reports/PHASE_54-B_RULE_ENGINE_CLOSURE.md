# PHASE 54-B — PLATFORM RULE ENGINE — PURE CORE AND ENGINE TIER

Scope: the engine half of the 54-A freeze (`docs/reports/PHASE_54_PLATFORM_RULE_ENGINE_SPEC.md`).
What is implemented here is the layer that document freezes as *the engine*: the pure, clock-free
evaluation core (§6.1, D12), the typed vocabulary (§7, §8, §9), rule versioning and the publish
lifecycle (§10, §11), conflict resolution (§12), explanation (§13) and simulation (§14) — together
with the §38.2 gates that are about that layer: gate 1 (pure evaluator), gate 2 (versioning), gate 3
(conflict resolution), and the engine halves of gate 9 (simulation) and gate 11 (explanation).

What this phase is **not**: the leave-domain implementation phases of §15–§37 and their gates 4–8,
10 and 12. Nothing here stores a leave row, opens an approval, resolves an approver, counts a limit
window, renders a screen or runs a migration; no leave route, DTO, notification, seed or CHECK was
added or changed. Those phases consume this engine; they are not inside it. §39's stop conditions
were not met, and none of them was resolved by guessing.

## 1. THE LINE THIS PHASE HAD TO HOLD

Five properties decide whether this is the engine the specification describes or a convenient
approximation of it. Each one is held by code, not by convention:

1. **A refusal is a value, never an exception (§6.4).** The typed tier answers
   `RuleEvaluationOutcome` / `RuleSimulationOutcome`: either a decision, or the reason no version
   could make one (`RULE_SET_VERSION_UNKNOWN` when nothing is stored under that identity,
   `RULE_SET_VERSION_NOT_EVALUABLE` when the version exists but may not decide — carrying the frozen
   lifecycle issue of §11 plus the version's own validation report). The legacy tier keeps
   `NotFoundException` and `InternalServerErrorException`, and the two tiers never share a code path.
2. **Published policy is immutable and pinned (§10.2, §10.5).** `registerVersion` refuses a version
   that already claims `PUBLISHED`; `updateDraft` refuses anything that is not a `DRAFT`; publishing
   computes a plan and applies it in one synchronous act, archiving the predecessor; a version is
   frozen on the way into the store, so no caller holds a handle that can mutate stored text. A
   caller that must not be affected by a later publish names the version it was opened with —
   `evaluateVersion` never resolves "latest" again.
3. **The engine reads no clock, and no environment (§6.3, D12).** There is no `Date`, no `now()`,
   no `Math.random`, no `process.env` and no logger anywhere in `src/rules`; the instant is a member
   of the caller's context, so the engine cannot be handed two different instants for one decision
   and its explanation. This is asserted by scanning the import graph, not by a comment (§3, gate 1).
4. **Simulation is the real engine, labelled (§14).** `simulateSync`/`simulateVersion` run the same
   evaluation, ordering and match history, and answer with `mode` and the simulation banner so no
   response can be mistaken for an applied decision; they apply nothing — no store write, no action
   executed — which is asserted by diffing the store across the call.
5. **One engine, two tiers (§6.2, §6.3).** The pure module provides the *same*
   `RuleEngineService`/`RuleRegistryService` classes, narrowed only in what is registered. No second
   engine class exists, and no runtime gets its own private registry.

## 2. WHAT WAS BUILT

### 2.1 The pure core — `apps/api/src/rules/core/` (new, 11 files, 3,654 lines)

| File | Lines | What it decides |
|---|---|---|
| `rule-validator.ts` | 1,154 | structural + vocabulary validation of a version, per rule, with field paths (§7, §8) |
| `rule-condition-evaluator.ts` | 537 | the three-valued condition evaluation (§8.1, §8.2, §8.4) — `UNKNOWN` is a real answer |
| `rule-evaluator.ts` | 429 | one version + one context → `EvaluationResult`, including match history and ordering |
| `rule-conflict.ts` | 385 | the conflict vocabulary and detection (§12.3) |
| `rule-facts.ts` | 255 | typed fact access over the caller's context (§8.3): a missing fact is never `false` |
| `rule-explanation.ts` | 237 | the explanation projection, by level (§13.3) |
| `rule-versioning.ts` | 230 | the publish lifecycle: transition table, editability, publish plan (§10, §11) |
| `rule-error.ts` | 134 | typed error/issue shapes used by validation, never thrown by the typed tier |
| `rule-ordering.ts` | 131 | the frozen ordering and tie-break (§12.1, D11) |
| `rule-limits.ts` | 124 | bounded execution: limits are declared and reported, never silently truncated (§34) |
| `rule-simulation.ts` | 38 | the simulation entry over the pure evaluator (§14.2) |

The folder imports nothing but its own files: no Prisma, no Nest runtime, no HTTP, no logger, no
clock, no randomness, no environment. That is the D12 property, and §3 measures it.

### 2.2 The typed vocabulary — `apps/api/src/rules/` (new, 6 files, 728 lines)

| File | Lines | What it freezes |
|---|---|---|
| `rule-condition.interface.ts` | 161 | the condition node kinds and operators (§8.1, §8.2) |
| `rule-evaluation.interface.ts` | 154 | `EvaluationContext`, `EvaluationResult`, match history, `SimulationResult` (§13, §14) |
| `rule-validation.interface.ts` | 147 | validation results, lifecycle issues, publish outcome (§10.4, §11) |
| `rule-action.interface.ts` | 127 | the frozen action vocabulary (§9) |
| `rule-spec.interface.ts` | 73 | `RuleSetVersion` / `RuleVersion` — the value the engine takes (§7) |
| `rule-engine.interface.ts` | 66 | the engine tier's outcome contract (§6.1, §6.3, §6.4) |

`rule.types.ts` (modified, +101) carries the shared vocabulary these reference: statuses, field
types, action types, counting basis, three-valued outcomes. All of it is additive; the legacy
`RuleContext`/`RuleResult` declarations above it are untouched, and no new symbol collides with an
existing one.

### 2.3 The engine tier — `rule-engine.service.ts` (modified, 36 → 219 lines)

The same class carries both tiers, because §6.2/§7 forbid a second engine:

| Method | Tier | Contract |
|---|---|---|
| `evaluate(ruleSetId, context)` | legacy, unchanged | synchronous, first match, throws as before (§6.3) |
| `evaluateVersion(ruleSetId, version, context)` | typed | one named version decides, or a typed refusal (§10.1, §10.5, §14) |
| `evaluateLatest(ruleSetId, context)` | typed | the version new decisions use (§10.3) |
| `evaluateSync(ruleSetVersion, context)` | pure door | version as a **value** — nothing is read from the store, so a draft can be evaluated and no later publish can affect it (§6.3) |
| `simulateVersion(ruleSetId, version, context)` | typed | the stored version simulated, labelled (§14) |
| `simulateSync(ruleSetVersion, context)` | pure door | a version supplied as a value — the authoring path (§14, §32) |

`evaluateSync`/`simulateSync` are the deterministic core of §6.3: no `await`, no I/O, no clock. The
async surface stays where the specification puts it — at the caller, who assembles context and then
crosses this door.

### 2.4 The version store — `rule-registry.service.ts` (modified, 22 → 196 lines)

The registry is the store the owning runtime supplies (D1): it holds what it is handed, reads no
database, no config and no clock, and enforces the lifecycle as refusals.

| Method | What it refuses |
|---|---|
| `registerVersion(version)` | a version claiming `PUBLISHED` (a publish comes from applying a plan, §10.4); a duplicate identity — published and archived keys are terminal (§10.2, §11) |
| `updateDraft(version)` | editing anything that is not a `DRAFT`; an unregistered identity |
| `publishVersion(candidate)` | anything the pure lifecycle does not plan; a refusal stores **nothing**, never a partial success (§10.4) |
| `getVersion` / `getPublishedVersion` / `listVersions` / `versionStatus` | read paths; `getPublishedVersion` cannot be ambiguous because a publish archives its predecessor in the same act (§10.3) |

`publishVersion` is the only way a version becomes `PUBLISHED`, it returns the typed plan outcome so
a caller can render the refusal, and after applying a plan it re-asserts the invariant the whole
selection rests on — exactly the planned version decides — and raises loudly if this store ever
broke it, rather than deciding under a version nobody selected.

### 2.5 The module boundary — `pure-rule-engine.module.ts` (new, 26 lines), `rules.module.ts` (modified)

`PureRuleEngineModule` provides and exports the two engine providers and nothing else: no example
set, no legacy registration, no configuration. `RulesModule` now imports and re-exports it and
registers only the example set — so the registry a consumer sees is the registry the example set
registers into, and a runtime that must not carry example policy (the HR runtime, §6.1) imports the
pure module instead. It is a plain static module rather than a dynamic one on purpose: a
`register(...)` factory would hand each importer its own registry instance and silently split the
store in two.

## 3. GATES THIS PHASE ADDS (§38.2), EACH ABLE TO FAIL

| Gate | Spec | `it()` | The failure it can detect |
|---|---|---|---|
| 1 — pure evaluator | `rule-pure-evaluator.spec.ts` | 8 | nondeterminism; order dependence; a clock/randomness/environment/logger read; a forbidden import in the engine folder |
| 2 — versioning | `rule-version-storage.spec.ts` | 6 | a published version that can be edited; a second published version; a lost pin; a refusal delivered as an exception |
| 3 — conflict resolution | `rule-conflict-resolution.spec.ts` | 4 | an equal-authority incompatibility that publishes; a tie that depends on insertion order |
| 9 — simulation (engine half) | `rule-simulation.spec.ts` | 4 | a simulation that writes to the store; a draft that decides; a refusal as an exception |
| 11 — explanation (engine half) | `rule-explanation-levels.spec.ts` | 5 | a level that leaks internals; a level missing what it is entitled to |

Notes on the two gates that could most easily have passed by construction (§39.12):

* **Gate 1's purity half is an assertion about the folder**, not a restatement of intent: the spec
  reads every `.ts` file under `src/rules`, computes its import graph, and fails when a file outside
  the pure tier is imported by it, when the folder reaches outside itself (Nest decorators aside),
  or when a forbidden read (`Date`, `now`, `Math.random`, `process.env`, a logger) appears. Two of
  its cases exist purely to prove the detectors work: one asserts the scan actually covers the files
  it claims to (and that the pure tier holds no test files), and one feeds the detectors a file that
  *would* break the contract and requires them to flag it.
* **Gate 11 does the same for its leak check**: one case asserts that the check flags a payload
  containing JSON, SQL, a leaf path or the condition tree — so a green result above means "this
  payload is clean", not "this check matches nothing".
* **Gate 3's tie-break is asserted by permutation**: the same rules are inserted in different orders
  and must produce one identical outcome, which is the §12.1 property, not the implementation's
  incidental map order.

## 4. STANDING GATES (§38.1) — EVIDENCE, RUN ON THIS TREE

| Gate | Command (from the path shown) | Result |
|---|---|---|
| Engine suite | `apps/api`: `npx jest src/rules --silent` | 7 suites, **39 tests passed**, 15.0s, 0 snapshots — no skipped, no todo |
| Architecture boundaries | `apps/api`: `npx jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | 2 suites, **55 tests passed** |
| HR isolation, HR application boundaries, audit contract | `apps/api`: `npx jest --runInBand src/modules/hr/hr-isolation.spec.ts src/modules/hr/hr-application-boundaries.spec.ts src/platform/audit` | 5 suites, **88 tests passed** |
| API build / types | `apps/api`: `npx tsc --noEmit -p tsconfig.json` then `npx nest build` | both **exit 0** |
| Lint, phase-scoped | `apps/api`: `npx eslint src/rules` | **exit 0**, no findings |
| Format, phase-scoped | `apps/api`: `npx prettier --check src/rules` | the phase's 27 files clean; **5 warnings, all pre-existing** (`rule-definition.interface.ts`, `rule-engine.service.spec.ts`, `rule-engine.service.integration.spec.ts`, `rule-set.interface.ts`, `rules/example.rule.ts`) |

The 39 engine tests are the phase's 27 new `it()` plus the 12 that already existed in
`rule-engine.service.spec.ts` and `rule-engine.service.integration.spec.ts`. **Those two specs were
not modified and were not weakened**: the legacy tier they cover (`NotFoundException`, first match,
priority order, error isolation) passes unchanged, which is what §6.3 requires of it.

### 4.1 Three honest notes about the lint/format gate

1. **The five prettier warnings are the repository's baseline, not this phase's.** All five files are
   unmodified from `HEAD` (`git status --porcelain apps/api/src/rules` lists only the four files in
   §5.2), so their formatting state is what it was before this phase began. §38.1's own note already
   records that this gate applies to files an implementing phase writes or touches; those five are
   neither. Reformatting them here would be exactly the isolated-reformat churn that note forbids.
2. **The root `npm run format:check` is not a meaningful gate as written, and `npm run lint` writes.**
   Measured on this tree: root `npm run format:check` exits **2** with ~818 files flagged and 3
   unparsable — because there is **no root `.prettierrc`**, so the repo-root pattern measures every
   file against prettier's defaults (print width 80, double quotes), while `apps/api/.prettierrc` and
   `apps/web/.prettierrc` exist and are what the workspace checks (and what this phase's files were
   measured against). Of the flagged files, exactly five are under `apps/api/src/rules`, and they are
   the five above. Separately, `apps/api`'s `lint` script is `eslint "src/**/*.ts" --fix` — it mutates
   the tree — so it was **not** run repo-wide or workspace-wide for evidence; the read-only
   `npx eslint src/rules` was run instead. §39.10 asks for a contradiction between this document and
   the code to be reported rather than narrowed silently: §38.1 says "the repository has no
   `.prettierrc`", and at the workspace level that is not what the repository contains.
3. **The report you are reading is subject to the same convention.** Root-default prettier flags all
   21 files under `docs/reports/`, this one and 54-A's specification included; the report is written
   in the same shape as its predecessors, not reflowed to prettier's defaults.

## 5. THE CHANGE, FILE BY FILE

### 5.1 New — 23 files, 5,558 lines

| Group | Files | Lines |
|---|---|---|
| Pure core `src/rules/core/` (11 files) | `rule-validator`, `rule-condition-evaluator`, `rule-evaluator`, `rule-conflict`, `rule-facts`, `rule-explanation`, `rule-versioning`, `rule-error`, `rule-ordering`, `rule-limits`, `rule-simulation` | 3,654 |
| Typed vocabulary (6 files) | `rule-condition.interface`, `rule-evaluation.interface`, `rule-validation.interface`, `rule-action.interface`, `rule-spec.interface`, `rule-engine.interface` | 728 |
| The phase's specs (5 files) | `rule-pure-evaluator.spec`, `rule-version-storage.spec`, `rule-conflict-resolution.spec`, `rule-simulation.spec`, `rule-explanation-levels.spec` | 1,150 (27 `it()`) |
| Module boundary (1 file) | `pure-rule-engine.module` | 26 |

### 5.2 Modified — 4 tracked files, +476 / −6

| File | HEAD → working tree | `+` | `−` | What changed |
|---|---|---|---|---|
| `src/rules/rule-engine.service.ts` | 36 → 219 | 185 | 2 | the typed tier added beside the untouched legacy tier; the two doc-comments on `evaluate` |
| `src/rules/rule-registry.service.ts` | 22 → 196 | 174 | 0 | the version store, the lifecycle refusals, `publishVersion` |
| `src/rules/rule.types.ts` | 15 → 116 | 101 | 0 | the shared typed vocabulary; nothing existing changed |
| `src/rules/rules.module.ts` | 10 → 22 | 16 | 4 | imports/re-exports `PureRuleEngineModule`; registers only the example set |

No existing spec was modified, and **no file outside `apps/api/src/rules` was touched** — the twelve
`apps/api/test/*.e2e-spec.ts` files that show as modified in `git status` were already modified
before this phase and are not its evidence either way (§38.3).

### 5.3 Reproducing every figure above

Run from the repository root (`E:\ERP`) unless a path is named.

```powershell
# §5.1, §5.2 - the phase's whole change, new against modified.
git status --porcelain apps/api/src/rules      # 4 ' M' lines, one '??' core/ and 12 '??' files
git diff --numstat apps/api/src/rules          # 185/2, 174/0, 101/0, 16/4  => +476 / -6
$f='apps/api/src/rules/rule-engine.service.ts'
@(git show "HEAD:$f").Count; @(Get-Content $f).Count        # 36, then 219

# §5.1 - sizes of the new files (core in §2.1, the rest in §2.2 and §5.1).
Get-ChildItem apps/api/src/rules/core -File | % { $_.Name, (Get-Content $_.FullName).Count }
Get-ChildItem apps/api/src/rules/*.spec.ts |
  % { $c=(Select-String -Path $_.FullName -Pattern '\bit\(' | Measure-Object).Count; "$($_.Name): $c" }

# §4 - every gate, in the order of the table.
cd apps/api
npx jest src/rules --silent
npx jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts
npx jest --runInBand src/modules/hr/hr-isolation.spec.ts `
  src/modules/hr/hr-application-boundaries.spec.ts src/platform/audit
npx tsc --noEmit -p tsconfig.json ; npx nest build
npx eslint src/rules
npx prettier --check src/rules

# §4.1 - the baseline claim, and the root-config finding.
git status --porcelain apps/api/src/rules      # the five warned files are absent from this list
@(git show 'HEAD:apps/api/src/rules/rule-set.interface.ts').Count   # equals the working-tree count
cd E:/ERP ; npm run format:check               # exit 2: ~818 flagged, 3 unparsable
Test-Path .prettierrc ; Test-Path apps/api/.prettierrc              # False, True
```

### 5.4 Status of the working tree when this report was written

The phase's 27 files (§5.1, §5.2) plus this report are **unstaged and uncommitted**; `HEAD` is
`ca9c1fa` ("Phase 54-A: Platform Rule Engine Specification Freeze"). The scratch files written while
producing §4's evidence (`apps/api/p54-*.txt`, `p54-format-root.txt`) have been deleted; §5.3
regenerates every number above.

## 6. WHAT IS NOT HERE, AND WHY THAT IS THE PHASE BOUNDARY

Not implemented in 54-B, and not claimed: §15–§22 (the leave policy model, limits, the approval model,
routing and the rejection reason), §23–§26 (snapshot semantics, tenant isolation, authorization, the
audit boundary), §27–§32 (the three UX levels), §33–§37 (security, performance, concurrency,
idempotency, migration) — and with them §38.2's gates 4, 5, 6, 7, 8, 10 and 12. Those are the phases
that build the leave domain *on top of* this engine. Gate 13 (the optional documentation guard) was
not added: §38.2 makes it optional, this phase modified no existing spec, and a guard nothing in the
repository needs is noise.

What the next phase can rely on, because it is asserted here and not merely intended:

* same version + same context + same instant ⇒ the same answer, under any rule insertion order;
* a missing fact is `UNKNOWN`, and an undecidable rule neither decides nor blocks a winner;
* a published version cannot be edited, cannot be duplicated, and archives its predecessor in the
  same act; an in-flight instance keeps the version it opened under, and a version that may not
  decide says so as a value;
* an equal-authority incompatibility is refused at publish, and the tie-break never depends on the
  order the rules were written in;
* a simulation is the real engine, labelled and write-free;
* an explanation is a projection of one decision, with a leak check that can fail.
