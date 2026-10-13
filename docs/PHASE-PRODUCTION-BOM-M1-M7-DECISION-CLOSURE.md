# PHASE PRODUCTION-BOM — M-1…M-7 DECISION CLOSURE

**Status:** `DECISION / CONTRACT-CLOSURE ONLY — NO IMPLEMENTATION. No tables, no migrations, no
routes, no frontend, no Project Management, no Product Tree, no Procurement coupling.`

**Module:** Production / «تولید»  **Capability:** BOM / «فهرست مواد و قطعات»
**Authoritative inputs:**
`docs/PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md` →
`docs/PHASE-PRODUCTION-BOM-CONTRACT-CLOSURE.md` → **this document**

**Evidence classes (§2):** `SOURCE FACT` · `CONTRACT FACT` · `BUSINESS DECISION` ·
`ARCHITECTURAL DECISION`.
**Gate vocabulary (§11):** `READY` · `READY-WITH-EXPLICIT-DECISION` · `BLOCKED`.

**Git baseline:** HEAD `840226b8a00e960098e7e868740adbc64710d6d7`, branch `master`. No commit,
reset, clean, checkout or revert.

**THE ONLY NEW ARTIFACT OF THIS PHASE IS THIS DOCUMENT.**

---

## 1. SCOPE

Convert **M-1 … M-7** — the seven decisions the Contract Closure left open — into explicit,
source-backed architectural and business decisions, with nothing implemented.

**Starting state (from the closure):**

```
PRODUCTION → BOM = NOT READY FOR IMPLEMENTATION
READY                        : Search, Audit
READY-WITH-ASSUMPTION        : BOM persistence boundary, basic validation
BLOCKED                      : Item model, CRUD, Lifecycle, Approval,
                               Code generation, Frontend
```

**Ending requirement:** each of M-1…M-7 carries a stated resolution, its evidence class, whether it
needs explicit business approval, and whether it still blocks V1 — with a decision matrix (§10) and
an implementation gate (§11).

**The governing restraint:** *do not convert an assumption into a fact.* Three of the seven resolve
to a firm architectural decision, three resolve to a firm **shape** with a business sub-decision
still open, and one (M-3) honestly remains **BLOCKED** because the evidence does not reach.

### 1.1 The user's architecture, honoured

```
Project Management          ← a FUTURE INDEPENDENT MODULE
        └── Project                      (does not exist today)

Production
   └── BOM
        ├── reference → Project          (M-1: opaque, Production does NOT own it)
        └── reference → Product Tree     (M-3: opaque, Production does NOT own it)

Procurement
   └── consumes approved BOM             (out of scope here)
```

No `Project` and no `Product Tree` is created inside `Production` at any point in this document.

---

## 2. DECISION METHODOLOGY

### 2.1 The four evidence classes

| Class | Definition | May it close a decision alone? |
| --- | --- | --- |
| **`SOURCE FACT`** | Read verbatim from the eight supplied SharePoint files (form XML, `ValueChangeScript`, `LoadCompletedScript`, `ListQuery`, action scripts) | **Yes** — for *what the legacy system did* |
| **`CONTRACT FACT`** | Read verbatim from an APPROVED ADR, a Prisma schema, an executable architecture/isolation test, or a platform port in this repository | **Yes** — for *what Ariya already guarantees* |
| **`BUSINESS DECISION`** | Neither evidence base answers it; only the business owner can | **No** — options presented, then **STOP** |
| **`ARCHITECTURAL DECISION`** | Derivable from `CONTRACT FACT`s (which existing rule forces which boundary) | **Yes**, provided the forcing facts are cited |

### 2.2 The five-step principle, applied to every decision

1. Inspect repository evidence. 2. Inspect SharePoint source evidence. 3. Separate the four
classes. 4. Do not silently fill missing semantics. 5. If it belongs to the business owner,
**present explicit options and STOP** — never converting an assumption into a fact.

### 2.3 SOURCE FACTS baseline (carried from the two prior phases)

- Two SharePoint lists joined by `BomAddRelated` → header and items are **separate** (preflight §6).
- States observed: `0, 1, 2, 50, 100`; `5` is a shared-template ordinal, excluded (closure §8).
- Approver = **requester-selected manager**, stored (`ModirTaeedKonandeh` → `TaeedKonandeh`);
  candidate filter `LevelManager ∈ {1,2}` (closure §9).
- The approval task writes **no `State`** on approve/reject and carries **no auth gate** (§5.3).
- `CodeStandardDarSanat` = generated, read-only, scoped `(project, product tree)` (§6).
- `Code_Ghatae` = **0 writes, 0 criteria, 0 labels** (§7).
- Three contradictory code generators; **zero** locking / transaction / retry (§11).
- Two coefficients are **manually entered**; five are **read-projections with no writer** (§12).
- `Title` is **calculated** as `'اقلام پروژه - ' + <project name>` (§3.3).

---


### 2.4 CONTRACT FACTS baseline, plus the nine found this phase

**Carried from the closure:** no platform workflow port (`src/platform/**` → **0** workflow hits);
Commerce's `WorkflowSubjectType` is a **closed** enum `{PURCHASE_DOCUMENT, PURCHASE_LINE}` living in
`commerce_db`; HR's approval engines are FK-bound to `LeaveRequest` / `MissionRequest`;
ADR-0005 mandates that a new independent module owns its own Prisma schema (6 precedents).

**New this phase — the decisive evidence for M-1, M-5 and M-6:**

| # | Contract fact | Where |
| --- | --- | --- |
| **CF-1** | *"There is **NO cross-database foreign key**. `tenantId`, `userId`, `employeeId`, `supplierId`, `requesterId` and `approverId` are **PLAIN STRING columns holding opaque values**"* · *"Commerce does NOT duplicate authoritative state"* · *"A purchase document's requester is an **opaque reference, not a second personnel table**"* | `prisma/commerce/schema.prisma` header |
| **CF-2** | *"`subjectId` — The subject's id — **OPAQUE, like every external reference in this schema**"* | `model WorkflowInstance` |
| **CF-3** | **DC-CORR-01** — *"identity columns are plain Strings, and there is no cross-database foreign key"*; enforced by `correspondence-isolation.spec.ts`: *"declares **NO identity model** and **NO relation into identity**"* | `user-directory.contract.ts` + isolation spec |
| **CF-4** | **ADR-0006 A4** — *"HR stores identity columns as plain strings with no cross-database foreign key"*; HR e2e: *"**EVERY** foreign key declared in `hr_db` points at another table of `hr_db`"*; PHASE_54: *"**No cross-database foreign keys, ever.**"* | ADR + e2e |
| **CF-5** | **Concurrency-safe numbering already exists**: `PurchaseDocumentCounter` — `INSERT … ON CONFLICT ("tenant_id","kind","jalali_year") DO UPDATE SET "counter" = "counter" + 1 RETURNING "counter"` **inside the insert transaction**, so *"two concurrent creates cannot receive the same number and a create that rolls back never burns one"*, plus CHECK `counter >= 0`, and *"**Nothing reads `counter` to build a number outside that statement**: a `SELECT … then UPDATE` pair would reintroduce exactly the race the single statement removes."* | `prisma/commerce/schema.prisma` |
| **CF-6** | *"a prefix, a per-unit or per-category series and a format are **the formatter's business**"* · *"The counter TABLE **is not created** … The first step that mints numbers brings the counter, its CHECK and its concurrency spec together."* | Commerce + HR schemas |
| **CF-7** | Snapshots alongside opaque references are an established pattern: `conditionInputSnapshot`, the per-row `currency` snapshot, `SearchDocument.tenantId` — *"copied from whatever the source treats as its isolation key"* | all schemas |
| **CF-8** | Money/quantity convention is uniformly `Decimal(18, 4)` with exact arithmetic in `purchase-money.ts` — **an available convention, not an authority for coefficients** | Commerce schema |
| **CF-9** | `commerce-isolation.spec.ts` (A1–E11) and `architecture-boundaries.spec.ts` are the **executable enforcement** of module boundaries | tests |

### 2.5 How STOP works

Wherever §13 lists a decision as **required business approval**, this document presents the options
and **stops**. It does not pick for the business owner, and it does not proceed to implementation on
the strength of its own recommendation.

---


## 3. M-1 — PROJECT REFERENCE POLICY

**DECISION: `OPTION A` — store the Project id as an opaque external reference. Production does not
own Project.**
**Class: `ARCHITECTURAL DECISION` (forced by CF-1…CF-4). No business approval required.**

### 3.1 Option evaluation

| Criterion | **OPTION A** — opaque external reference | **OPTION B** — wait for the authoritative Project Management contract |
| --- | --- | --- |
| **Future Project Management module** | Clean: PM later owns `Project`, and BOM's already-stored opaque id resolves against it with **no BOM table change** (CF-1's whole point) | Also clean, but **V1 cannot start at all** — and V1's header, both duplicate rules and `Title` all require the field today |
| **Tenant isolation** | **Stronger.** BOM is scoped by *its own* `tenantId` and never derives it from a reference (preflight §17.4). The reference is data, not an isolation key — exactly how Commerce treats `requesterId` (CF-1) | N/A — nothing is built, so nothing can leak |
| **Future Gantt / project tracking** | Unaffected: Gantt needs *Project's* data, not BOM's. BOM contributes only "this BOM belonged to project X" | Unaffected |
| **Migration compatibility** | **1:1.** SharePoint's `NameProje` *is* an id (`Lookup_ValueFieldName="ID"`); the legacy field was already opaque | Migration must **wait**, or write a temporary value that is later reinterpreted — the worst of both |
| **Purchase integration** | Procurement reads BOM's project **through BOM**, not through a join — matching CF-1's *"never through a join"* | Procurement blocked behind PM as well |
| **Cost of being wrong** | Low: an unresolved opaque string is honest and re-pointable | High: V1 stalls behind a module with no owner, no date and no schema |

**Why A preserves the cleanest ownership boundary:** A keeps `Project` **outside** Production *and*
lets BOM exist. B delays BOM but does **not** make Production the owner of Project either — so B
trades away V1 entirely to gain a boundary that A already achieves. **A dominates B on ownership and
on delivery.**

### 3.2 The four evaluation lenses, stated explicitly

- **Future Project Management module** → PM becomes an independent module exactly as the user's plan
  shows; BOM holds a reference it did not have to invent or migrate. `[ARCHITECTURAL DECISION]`
- **Tenant isolation** → never inherited from the project: `tenantId` is BOM's own, resolved from the
  request context, fail-closed (preflight §17.1/§17.4). `[ARCHITECTURAL DECISION]`
- **Future Gantt/project tracking** → lives entirely inside PM; BOM exposes only the stored id.
  `[ARCHITECTURAL DECISION]`
- **Migration compatibility** → the SharePoint field is a lookup **id**, so carrying it verbatim is
  the preflight §22.1 migration rule, unchanged. `[SOURCE FACT]`

### 3.3 THE REFERENCE CONTRACT (Option A) — the only thing defined here

```
projectRef : opaque identifier
             - type: string, not derived, not validated against a Project table
             - scope: stored on the BOM row; NEVER used to derive tenantId
             - authorization: a BOM row is readable/writable ONLY by its OWN tenantId;
               projectRef is never an authorization input
             - no local Project table, ever
             - no Project-name derivation rule
```

**On `Title`:** the legacy `Title` is *calculated* from the project **name**
(`'اقلام پروژه - ' + <project name>`), which BOM cannot obtain from an opaque id. Therefore:

> **`Title` is a STORED value, not a derived one.** Deriving it from a Project name is
> **explicitly refused** unless a formal, authoritative Project read contract supplies the name —
> at which point it becomes a *snapshot*, and **snapshots are the established pattern** (CF-7).

This is a deliberate **behavioural divergence from SharePoint**, recorded as a decision rather than
silently adopted: BOM must not depend on a domain that does not exist in order to name its own row.

### 3.4 What M-1 does NOT define

No Project fields of any kind — no status, no code, no manager, no dates, no hierarchy, no Gantt
columns, no local `Project` table, no project-name lookup. `[SOURCE FACT: none of these exist in
the repository — closure §3.1]`

---


## 4. M-2 — PROJECT CONTRACT

**RESULT: `PROJECT-CONTRACT = EXTERNAL DEPENDENCY / FUTURE MODULE`.**
**Class: `CONTRACT FACT` (the domain does not exist) + `ARCHITECTURAL DECISION` (BOM does not
create it). Does NOT block V1 — M-1 absorbs it.**

### 4.1 Classification, stated as required

```
PROJECT-CONTRACT = EXTERNAL DEPENDENCY / FUTURE MODULE
```

Evidence: **0 models, 0 of 123 `CREATE TABLE`s, 0 of 32 nav routes, 0 module registrations**
(closure §3.1). The only look-alike — `'Project Management'` in `packages/config` — is a marketing
`FEATURES` array. **BOM does not implement Project.**

### 4.2 The minimum interface BOM actually needs

BOM's real needs are four, and three of them are already satisfied without a Project contract:

| # | BOM's need | Satisfied by | Status |
| --- | --- | --- | --- |
| 1 | **Project identifier** — carry which project a BOM belongs to | M-1's opaque `projectRef` | **SATISFIED by M-1** |
| 2 | **Tenant ownership** — never derive BOM's tenant from the project | BOM's own `tenantId` + fail-closed actor resolution (preflight §17.1) | **SATISFIED today** |
| 3 | **Authorized reference / readability** — "may this caller act on a BOM pointing at project X?" | **Answered by the BOM row's own tenant scope**, not by the project. A reference cannot widen access (M-1 §3.3) | **SATISFIED today** |
| 4 | **Optional display metadata** — a project *name* for `Title` / list rendering | **Not required** if `Title` is stored (M-1 §3.3) | **DEFERRED** — becomes a *snapshot* only if a formal Project read contract appears (CF-7) |

**The shape of a future Project read contract** (recorded, not built) mirrors the one Ariya already
has for people — `USER_DIRECTORY.filterTenantMembers(tenantId, userIds) → string[]` + a batched
projection. A future `PROJECT_DIRECTORY` would need no more than:

```
filterTenantMembers(tenantId, projectIds) → projectIds[]     // membership: yes/no
findProjects(projectIds) → [{ id, displayName? }]            // display only, allowlisted
```

Anything beyond those two methods (status, code, manager, dates, hierarchy, Gantt) is **not** a BOM
need and is **not** specified here.

### 4.3 Explicitly NOT invented

`project status` · `project code` · `project manager` · `project dates` · `hierarchy` ·
`Gantt fields` · a local Project table · a project-name lookup on write.

> Note on `projectCodeSnapshot`: the legacy header *does* copy `ProjectCode` into
> `NameProje_x003A_ProjectCode`. Carrying such a snapshot is **permitted** (CF-7) but its **value
> can only come from the future Project contract** — it is therefore **DEFERRED**, not invented.

---


## 5. M-3 — PRODUCT TREE CONTRACT

**RESULT: `PRODUCT-TREE-CONTRACT = BLOCKED` (for an authoritative domain).**
**Class: `CONTRACT FACT` (insufficient evidence) + `ARCHITECTURAL DECISION` (BOM references without
owning). Still BLOCKS V1 — via M-6's prefix.**

### 5.1 Is there enough evidence to define each attribute?

| Attribute | Evidence | Enough? |
| --- | --- | --- |
| **Product Tree ID** | `SOURCE FACT` — `ProductTree` list `{24C41644-1165-4A73-87B0-6CA9556A388B}`, `Lookup_ValueFieldName="ID"` | **Yes as an opaque id** (same shape as M-1) |
| **Product Tree code** | `SOURCE FACT` — a `code` field, read by `ValueChangeScript` (`e.ListItems[0].code`), used as the code prefix | **Partially** — the field *exists*; its **format, assignment rule and lifecycle are unknown** (the tree-picker page `Test_WP.aspx` was never supplied — closure §4.2) |
| **Tenant scope** | **Nothing.** SharePoint is a single site with no tenant concept | **No** |
| **Ownership** | **Nothing.** No module claims it; 0 models, 0 tables, 0 routes (closure §4.1) | **No** |
| **Lookup / read contract** | **Nothing.** No port, no service, no adapter | **No** |

**Four of five are insufficient → `PRODUCT-TREE-CONTRACT = BLOCKED`.** The `code` field's
*existence* is a `SOURCE FACT`; everything that would make it authoritative is not.

### 5.2 Product Tree ownership vs BOM ownership — the explicit distinction

```
PRODUCT TREE OWNERSHIP                      BOM OWNERSHIP
──────────────────────                      ─────────────
  owns: tree identity,                        owns: the BOM header and its items,
        tree code,                                  the standard-part-code rule,
        hierarchy (if any),                          the lifecycle, validation,
        tenant scope                                  approval record, audit
  does NOT own: BOM rows                  does NOT own: the tree, its code,
  status: FUTURE MODULE / BLOCKED                its hierarchy, its tenant scope
```

**BOM may reference Product Tree without owning it** — precisely as M-1 lets BOM reference Project
without owning it. The reference is opaque; the *code* the tree contributes is a **read** of a
value BOM does not author.

### 5.3 The hard dependency, stated plainly

`CodeStandardDarSanat = <product tree code> + "-" + <sequence>` (closure §6.3, §11.1). The prefix
comes **from** the tree. Therefore:

> **While `PRODUCT-TREE-CONTRACT = BLOCKED`, the prefix cannot be finalized — and without a
> finalized prefix, code generation cannot be finalized (M-6).** Building a speculative tree inside
> BOM to unblock this would make Production the accidental owner of a domain whose format,
> tenancy and lifecycle are all unknown — forbidden by the brief and by §14 principle 2.

### 5.4 What BOM may do today, and what it may not

| Allowed (inherits M-1) | Not allowed |
| --- | --- |
| Store `productTreeRef` as an **opaque id** | Create a `ProductTree` table inside Production |
| Store a `productTreeCodeSnapshot` **only if** a value is supplied by an authoritative source | **Invent** a tree code format so generation can proceed |
| Read the tree's `code` through a future formal contract | Treat the legacy `code` string as a known format |

---


## 6. M-4 — `CODE_GHATAE`

**DECISION: `OPTION B` — exclude from V1 domain persistence until a business definition exists,
with mandatory raw-value preservation at migration.**
**Class: `BUSINESS DECISION` — REQUIRES EXPLICIT BUSINESS APPROVAL. Does NOT block V1's other
areas, but must be answered before the item model is written.**

### 6.1 Evidence recap `[SOURCE FACT]` (from closure §7)

| Dimension | Finding |
| --- | --- |
| Write sites | **0** (all eight files) |
| Query criteria | **0** |
| Generated values | **0** |
| Labels bound to it | **0** |
| Read projections | **8** across 5 files — always inside `Attributes="…"` |
| Kept distinct from `CodeStandardDarSanat`? | **Yes** — both appear side by side in the same attribute list |
| The «کد قطعه» label | binds **`GhataeDarkhastiKharid_x003a__x061`**, a *different* field on the purchase part-request lookup |
| Legacy code family nearby | «کد نقشه قطعه», «کد نقشه مونتاژی مرتبط با قطعه», «کد قطعه», «نام قطعه در صنعت» — four distinct codes exist in the source vocabulary |

**We do not reinterpret it.** It is not a synonym of `CodeStandardDarSanat`, and the two must never
be collapsed.

### 6.2 Option evaluation — migration and compatibility impact

| | **OPTION A** — keep, mark legacy/non-authoritative | **OPTION B** — exclude from V1 domain persistence |
| --- | --- | --- |
| **Domain-model honesty** | A typed column exists that **nobody can define** — it will be read as a fact by every future consumer, which is precisely the failure mode M-4 exists to prevent | V1's item model contains **only fields with established semantics** |
| **Migration mapping** | 1:1, zero loss, zero migration-time decision | Needs the **raw-value preservation rule** (below) — but migration is a **separate future phase** (preflight D-13, not yet scheduled) |
| **Data-loss risk** | **None** | **None**, *provided* the raw column is mandated — see 6.3 |
| **Compatibility with the source** | Direct | Preserved through the raw column + the retained field inventory (preflight §5.3 keeps it as `[OPEN]`) |
| **Cost if a definition later arrives** | Adopt the existing column; a rename is one migration | Create the typed column then; the legacy value stays in the raw column until mapped |
| **Risk** | A permanently-undefined column becomes **de facto authoritative by presence** | Requires the migration phase to remember the raw rule |

### 6.3 The safeguard that makes Option B safe

The preflight **already mandates** the mechanism Option B needs (preflight §22.2 rule 2):

> *"**Preserve unknown values verbatim, in a dedicated raw column**, rather than dropping them — the
> source has fields with no known writer … and their values are the only evidence of what the
> business meant."*

Therefore **Option B loses no data**: the SharePoint value is carried into a raw column at
migration, and `Code_Ghatae` gains a typed, authoritative column only when the business supplies a
definition. `[CONTRACT FACT — the rule pre-exists; nothing new is invented here]`

### 6.4 The source model is NOT deleted

The SharePoint source is untouched, and the field inventory (preflight §5.3) continues to list
`Code_Ghatae` with its `[OPEN]` marker. **Option B excludes a column from the V1 domain model; it
does not erase the field from the source record.** That distinction is the whole reason M-4 offers
both options.

### 6.5 STOP — the business question

**Recommendation: OPTION B** (cleanest domain model, zero data loss thanks to §6.3).
**Required business approval:** *keep as a legacy column (A), or exclude until defined (B)?*
Presented, then **STOP** — §13 records this as one of the decisions awaiting the owner.

---

## 7. M-5 — LIFECYCLE / TRANSITION OWNERSHIP

**DECISION: `OPTION A` — a Production-owned, guarded state machine.**
**Class: `ARCHITECTURAL DECISION` (Option B is refuted by CF-2 + the closure's §5 findings).
The ACTOR matrix below is a `BUSINESS DECISION` where marked.**

### 7.1 Option evaluation

| | **OPTION A** — Production-owned simple state machine | **OPTION B** — existing platform workflow contract |
| --- | --- | --- |
| **Does it exist?** | It is constructible; **the source's observable behaviour is exactly this shape** (one step, one approver, three outcomes) | **There is no platform workflow port**: `src/platform/**` → **0** workflow hits `[CONTRACT FACT]` |
| **Can it express the semantics?** | Yes — 5 states, 3 outcomes, 1 actor | **Not without forcing BOM into Commerce's model**, whose subject vocabulary is a **closed** enum `{PURCHASE_DOCUMENT, PURCHASE_LINE}` in `commerce_db` `[CONTRACT FACT]` |
| **Dependency direction** | None — Production depends on nothing new | Would make **Production import Commerce** (or Commerce export its engine) — an inversion the preflight rejects (preflight §12.2/§12.3) |
| **Third engine?** | **No** — it is a state machine on BOM's own row, not an engine | No, but it would be a *shared* engine used by a non-owner |
| **Effort** | Small and local | A platform Workflow extraction: **a separate, much larger phase** |

**Option B is not merely unnecessary — it is currently impossible without either a dependency
inversion or a new platform contract.** `[CONTRACT FACT: CF-2's closed enum is the proof]`

### 7.2 The transition table `[SOURCE FACT + BUSINESS DECISION]`

| Transition | From → To | Actor | Class |
| --- | --- | --- | --- |
| **create** | ∅ → `DRAFT` | the requester | `SOURCE FACT` (`State = 0`) |
| **edit** (header + items) | while `DRAFT` | the requester | `SOURCE FACT` (`EnabledFormula = State == 0`; every item control gated identically) |
| **submit** | `DRAFT` → `SUBMITTED` | the requester | `SOURCE FACT` (`c_Control2` writes `State = 1`, `StateNext = 2`) |
| **approve** | `SUBMITTED` → `APPROVED` | the selected manager | **`BUSINESS DECISION`** — the source *records the opinion* but writes **no state** |
| **reject** | `SUBMITTED` → `REJECTED` | the selected manager | **`BUSINESS DECISION`** — same gap |
| **request correction** | `SUBMITTED` → `DRAFT` | the selected manager | `SOURCE FACT` — this is the **one** branch that writes a state (`item.State = 0`) |
| **edit after correction** | while `DRAFT` again | the requester | `SOURCE FACT` — consequence of the transition above |

**Why `approve`/`reject` are business decisions and not discoveries:** the approval task sets
`NazarModir` and completes the *SharePoint task* (`c_WorkflowOutcome = "Rejected"`,
`c_Status = "Completed"`) — it never writes `State = 100` or `State = 50`. The engine that did was
the SharePoint approval workflow, **which was never supplied** (closure §5.2, §5.4). Reconstructing
it from UI behaviour is forbidden.

### 7.3 The six questions the brief requires, answered

| Question | Answer | Basis |
| --- | --- | --- |
| **Who can submit?** | the requester (`DarkhastKonandeh`) | `SOURCE FACT` |
| **Who can approve?** | the **requester-selected manager** stored on the record (`TaeedKonandeh`) — gated by a permission (planned `production.bom.approve`) and same-tenant resolution | `SOURCE FACT` (identity) + `CONTRACT FACT` (RBAC/tenant) |
| **Who can reject?** | the same actor as approve | `SOURCE FACT` (same control, `"رد"` branch) |
| **Who can request correction?** | the same actor as approve | `SOURCE FACT` (`"نیاز به اصلاح"` branch) |
| **Who can edit after correction?** | the requester, because the record returns to `DRAFT` | `SOURCE FACT` |
| **Which transition freezes data?** | **`submit`** — from `SUBMITTED` onward the requester can no longer edit; only the approval outcome returns it to `DRAFT` | `SOURCE FACT` (`State == 0` is the only editable window) |

**Therefore the freeze point is NOT a business decision** — the source states it unambiguously, and
it is the single strongest piece of lifecycle evidence available.

### 7.4 What is a business decision (STOP)

The **actor/authorization semantics of the approve and reject outcomes**: *may anyone holding
`production.bom.approve` decide, or only the stored manager?* The preflight already flagged this as
**D-4**; M-5 does not resolve it. Both options preserve the state machine above.

### 7.5 Boundaries this decision preserves

- **No third workflow engine** (principle 9): the machine lives on the BOM row.
- **No reach into Commerce's** `WorkflowInstance` / `WorkflowSubjectType` (CF-2).
- The **domain outcome** (`managerOpinion ∈ {تایید, رد, نیاز به اصلاح}`) and the **status** stay two
  separate facts, exactly as Commerce keeps `PurchaseDocument.status` separate from
  `WorkflowInstance.status` — a state machine that owns both would make "which fact is this?"
  depend on which column a reader opened.

---
## 8. M-6 — BOM CODE GENERATION

**RESULT: the business invariant is stated, the mechanism pattern is a `CONTRACT FACT`, and the
prefix stays `BLOCKED` behind M-3.**
**Class: `SOURCE FACT` + `CONTRACT FACT` + `BUSINESS DECISION` (the invariant).**

### 8.1 The five candidate invariants, evaluated

| Candidate | Evidence | Verdict |
| --- | --- | --- |
| **A. Code is stable after creation** | **Refuted by the source**: generation runs unconditionally at the top of `btn_Save`, *before* the `if (id)` branch — so an edit **re-derives** the code (closure §11.2) | `SOURCE FACT` — not what the legacy system did |
| **B. Code can be regenerated after structural changes** | **Supported**: the bulk renumber tool (§10.7 of the preflight) rewrites codes positionally for a whole tree | `SOURCE FACT` — but it is an **unaudited mass update** |
| **C. Code is derived from Product Tree + sequence** | **Directly supported**: `code = <tree code> + "-" + <zeroPad3(n)>` in all three generators | `SOURCE FACT` — the strongest evidence in this decision |
| **D. Code must be unique within project + Product Tree** | **Directly supported**: `ListQuery3` is `project AND tree AND code` — the only uniqueness query that exists | `SOURCE FACT` — matches D-1's closure |
| **E. Code must be globally unique** | **Contradicted**: no query ever checks the code without the project and tree predicates | `SOURCE FACT` — rejected |

**Established invariant: `C` + `D`.** The code is *derived from the tree's code plus a sequence*,
and it is *unique within (project, product tree)* — never globally.

### 8.2 The seven mechanism questions

| Question | Answer | Class |
| --- | --- | --- |
| **Prefix source** | the **Product Tree's code** | `SOURCE FACT` — but **`BLOCKED`** (M-3): the code's format is unknown |
| **Sequence source** | **per-(project, tree)**, not per-tenant and not global | `SOURCE FACT` (`ListQuery2`/`ListQuery3` scope) |
| **Collision rule** | refuse the save, with an explicit message | `SOURCE FACT` (closure §6.2 — `CodeStandardDarSanat;{c_code_part};Equals`) |
| **Concurrency strategy** | **must be single-statement, allocation-inside-the-insert-transaction** — **the repository already owns this pattern** | `CONTRACT FACT` (**CF-5**) |
| **Retry behaviour** | **none needed** under CF-5: a single `INSERT … ON CONFLICT … DO UPDATE … RETURNING` cannot collide, and a rolled-back create **never burns a number** | `CONTRACT FACT` (CF-5's stated purpose) |
| **Is the code immutable?** | **A business decision** — the source mutates it, so mutability is the legacy default, but immutability is the safer invariant | `BUSINESS DECISION` → **M-6d** |
| **Can deleted codes be reused?** | **A business decision** — the source deletes without renumbering (gaps), then a tool renumbers positionally | `BUSINESS DECISION` → **M-6d** |

### 8.3 The minimum implementation-safe result

The brief asks for exactly this, and it is deliverable **without inventing anything**:

```
CODE = authoritative prefix  +  authoritative sequence

  authoritative prefix    = <PRODUCT TREE CODE>            ← BLOCKED (M-3)
  authoritative sequence  = the next integer for (tenant, project, product tree)

  concurrency-safe allocation (CONTRACT FACT — CF-5, already in this repository):
      INSERT INTO ...Counter (tenant_id, project_ref, product_tree_ref, counter)
      VALUES (..., 0)
      ON CONFLICT (tenant_id, project_ref, product_tree_ref)
      DO UPDATE SET counter = counter + 1
      RETURNING counter
      — executed INSIDE the transaction that inserts the BOM item
      — with CHECK (counter >= 0)
      — and NOTHING may SELECT then UPDATE outside that statement (CF-5 forbids it in writing)
```

**Three properties this inherits rather than invents** (`CONTRACT FACT`, CF-5/CF-6):

1. **The counter table arrives WITH the first step that mints numbers** — not earlier. CF-6:
   *"A counter with no caller is a table no test can falsify."* So this decision **legitimately
   defers** the table to the implementation step.
2. **The prefix and the format belong to a formatter, not the counter.** CF-6: *"a prefix, a
   per-unit or per-category series and a format are the formatter's business."* So the prefix is a
   **formatter concern** — which is exactly where M-3's blocked tree code plugs in.
3. **One series per key.** CF-5's reasoning on `kind`: two scopes sharing one series would mint the
   same code twice. Here the key is `(tenant, project, tree)` — one series per BOM scope.

**No mechanism is implemented in this phase**; only the *shape* is fixed, and it is fixed by
citing an existing, tested pattern rather than by inventing one.

### 8.4 What is a business decision (STOP)

| ID | Question | Options |
| --- | --- | --- |
| **M-6d** | Immutability and reuse | (i) code is **immutable** after creation and deleted codes are **never reused** (safest, diverges from legacy); (ii) code **may be regenerated** on structural change and gaps are acceptable (closest to legacy); (iii) hybrid — immutable during the BOM's life, regenerated only by an explicit, audited renumber action |

**Recommendation: (i).** It is the only option under which a code, once printed on a drawing or
quoted in a purchase request, keeps meaning the same thing — and it makes the preflight's
`T-11` (a Purchase consuming a stale BOM) strictly smaller. But the source did **not** hold this
invariant, so it is a **decision**, not a discovery.

### 8.5 What this decision does NOT do

It does **not** finalize the prefix (M-3 is `BLOCKED`), does **not** choose generator A, B or C
(they disagree and all three are unaudited), and does **not** create any counter table.

---
## 9. M-7 — CONSUMPTION COEFFICIENTS

**RESULT: 2 fields fully specified, 5 fields `SEMANTICS-DEFERRED`; the shared numeric semantics
carry one business decision (M-7a).**
**Class: `SOURCE FACT` + `CONTRACT FACT` + `BUSINESS DECISION`.**

### 9.1 (a) SOURCE FACTS — per field

| # | Field (legacy name) | Persian label | Manually entered or calculated? | Writer in the source | Arithmetic use |
| --- | --- | --- | --- | --- | --- |
| 1 | `ZaribMasraf_DarNaghshe` | ضریب مصرف (درنقشه) | **manually entered** | **yes** (`listitem.ZaribMasraf_DarNaghshe`) | operand in the change-request path |
| 2 | `ZaribMasraf_YadakiDorriz` | ضریب مصرف (یدکی/تست) | **manually entered** | **yes** (`listitem.ZaribMasraf_YadakiDorriz`) | operand in the change-request path |
| 3 | `ZaribMasraf_KoleGhatae` | ضریب مصرف کل قطعه | **unknown** | **no writer** | **never an operand** |
| 4 | `ZaribMasraf_DarNaghshe_DarHalSef` | … (در نقشه) در حال سفارش | **unknown** | **no writer** | none |
| 5 | `ZaribMasraf_YadakiDorriz_DarHalS` | … (یدکی/تست) در حال سفارش | **unknown** | **no writer** | none |
| 6 | `ZaribMasraf_DarNaghshe_Kharidsho` | … (در نقشه) خریداری شده | **unknown** | **no writer** | none |
| 7 | `ZaribMasraf_YadakiDorriz_KharidS` | … (یدکی/تست) خریداری شده | **unknown** | **no writer** | none |

Fields 3–7 appear **only** inside `Attributes="…"` read-projections. Their names describe
order-in-progress and purchased quantities, so they are *almost certainly* written by the purchase
solution — which is out of scope here and **was not supplied**. That is a hypothesis, not a finding.

### 9.2 (b) CONTRACT FACTS — the numeric conventions Ariya already has

- Money and quantity in Commerce are uniformly **`Decimal(18, 4)`** with **exact string arithmetic**;
  floats are never used (`[CONTRACT FACT — CF-8]`).
- The **only** numeric floor the source ever states is **`>= 0`**, and it appears **only** in the
  change-request path — never at item creation.
- **`total = drawing + spare` is NOT established.** The source computes `previous + delta` for a
  *change line*, and `ZaribMasraf_KoleGhatae` is **never** an operand or an assignment target of that
  computation. The brief forbids the assumption; the evidence supports the refusal.

### 9.3 (c) Per-field determination requested by the brief

| Aspect | Fields 1–2 (established) | Fields 3–7 (deferred) |
| --- | --- | --- |
| **manually entered or calculated** | **manually entered** | **unknown** |
| **numeric type** | integer at minimum (`parseInt` throughout) — **decimal is M-7a** | unknown |
| **decimal precision** | **not specified by the source**; `Decimal(18,4)` is an available convention, **not an authority** | unknown |
| **zero allowed** | **legal but unexplained** — the save refuses only *empty*; the `>= 0` floor appears only later | unknown |
| **negative allowed** | **refused** — the only floor the source states; adopted as `>= 0` | unknown |
| **null allowed** | **No** at creation (empty is refused; V16/V17) | unknown |
| **unit** | **not declared.** The item's `Vahade_Andazegiri` is a free-text *item* unit; nothing states a coefficient is expressed in it | unknown |
| **authoritative formula** | **none needed** — they are inputs | **none exists** → `SEMANTICS-DEFERRED` |
| **future Purchase meaning** | the purchase form takes its own requested quantities as **user input** (`TedadDarkhastiAznaghshe` / `…AzTest`), validated for plausibility | fields 4–7 are **probably** the purchase-side write-back — **unproven** |

### 9.4 (d) BUSINESS DECISION — the numeric semantics (STOP)

| ID | Question | Options |
| --- | --- | --- |
| **M-7a** | Type and range of fields 1–2 | **(i)** `Int`, `>= 0` — matches every `parseInt` in the source · **(ii)** `Decimal(18,4)`, `>= 0` — matches Ariya's one established numeric convention (CF-8) and permits fractional consumption |

**Recommendation: (ii).** It costs nothing, matches the repository's numeric convention, and avoids a
type migration the first time a fractional coefficient is required. But the source never establishes
decimals, so this is a **decision**, not a discovery.

### 9.5 (e) The five deferred fields — no formula invented

Fields 3–7 are classified **`SEMANTICS-DEFERRED`**. **No formula is created.** In particular the
brief's prohibition is honoured verbatim: *"Do NOT assume total = drawing + spare."*

---


## 10. DECISION MATRIX

| ID | Decision | Evidence | Recommended resolution | Requires explicit business approval | Blocks V1 |
| --- | --- | --- | --- | --- | --- |
| **M-1** | Project reference policy | `CONTRACT FACT` **CF-1/CF-2/CF-3/CF-4** — no cross-DB FK; every external reference is an opaque plain string; *"never through a join"* · `SOURCE FACT` — `NameProje` was already a lookup **id** | **OPTION A** — store an opaque `projectRef`; Production does **not** own Project; `Title` is a **stored** value, not derived from a project name | **No** | **No** — unblocks PERSISTENCE + VALIDATION |
| **M-2** | Project contract | `CONTRACT FACT` — 0 models, 0/123 tables, 0/32 routes, 0 registrations; `'Project Management'` is a marketing string | **`EXTERNAL DEPENDENCY / FUTURE MODULE`** — BOM needs only (1) an id, (2) its own tenant, (3) row-scoped authorization; (4) display metadata **DEFERRED** to a future snapshot | **No** | **No** — absorbed by M-1 |
| **M-3** | Product Tree contract | `CONTRACT FACT` — 0 objects, no port · `SOURCE FACT` — the `code` field exists, but its format lives in an unsupplied page | **`PRODUCT-TREE-CONTRACT = BLOCKED`.** The id may be opaque (as M-1); code / tenant scope / ownership / read contract are **insufficient**. BOM **references without owning** | **No** — a missing contract, not a choice | **YES** — via M-6's prefix |
| **M-4** | `Code_Ghatae` | `SOURCE FACT` — 0 writes, 0 criteria, 0 labels; the «کد قطعه» label binds a *different* field | **OPTION B** — exclude from V1 domain persistence, **with mandatory raw-value preservation at migration** (a rule the preflight already mandates, §22.2 rule 2) | **YES** — A (keep as legacy) vs B (exclude until defined) | **No** — but must be answered before the item model is written |
| **M-5** | Lifecycle ownership | `CONTRACT FACT` — **0** platform workflow hits; Commerce's subject enum is **closed** (CF-2) · `SOURCE FACT` — one step, one approver, three outcomes, `submit` freezes | **OPTION A** — Production-owned guarded state machine `DRAFT → SUBMITTED → APPROVED \| REJECTED \| CORRECTION(→DRAFT)`; freeze at **submit** | **Partial** — the *actor semantics* of approve/reject (D-4) is a business decision | **No** — unblocks LIFECYCLE; APPROVAL is `READY-WITH-EXPLICIT-DECISION` |
| **M-6** | Code generation | `SOURCE FACT` — invariant **C+D**; **3** disagreeing generators; **0** locking · `CONTRACT FACT` — **CF-5** (single-statement `ON CONFLICT … RETURNING` counter) + **CF-6** (the counter arrives with its first minter; the prefix is the formatter's business) | Invariant **C+D**; `CODE = <tree code> + <per-scope sequence>`; allocation via the **existing CF-5 pattern**; the prefix stays **BLOCKED** (M-3) | **YES** — **M-6d**: immutable + no reuse (i) · regenerable (ii) · hybrid (iii) | **YES** — the prefix is blocked by M-3 |
| **M-7** | Consumption coefficients | `SOURCE FACT` — fields 1–2 written and validated; fields 3–7 projection-only; `total = drawing + spare` **not established** · `CONTRACT FACT` — the `Decimal(18,4)` convention exists | Fields 1–2 = required, `>= 0` inputs; fields 3–7 = **`SEMANTICS-DEFERRED`**; **no formula invented** | **YES** — **M-7a**: integer vs `Decimal(18,4)` | **No** if fields 3–7 are deferred; **YES for those fields** if kept |

**Tally: 3 decisions closed by evidence (M-1, M-2, M-5) · 1 blocked by a missing domain (M-3) ·
3 carrying a business sub-decision (M-4, M-6d, M-7a) · 1 partially specified (M-7).**

---


## 11. IMPLEMENTATION GATE

Evaluated honestly — **nothing is marked `READY` merely because code could technically be written.**

| Area | Gate | Reason |
| --- | --- | --- |
| **PERSISTENCE** | **`READY-WITH-EXPLICIT-DECISION`** | D-5 supplies the boundary (ADR-0005 + 6 precedents). **M-1 decides the reference policy (Option A)** and makes `Title` a stored value. The explicit decision required *is M-1 itself*; once taken, the header can be written. |
| **ITEM MODEL** | **`BLOCKED`** | Depends on **M-3** (`standardPartCode`'s prefix), **M-4** (the fate of `Code_Ghatae`) and **M-7** (coefficient types). All three must be answered first. |
| **VALIDATION** | **`READY-WITH-EXPLICIT-DECISION`** | The source's validations (V1–V17, V8) are pure field/existence checks and fully evidenced. The explicit decision is M-1's uniqueness-scope acknowledgement — `(project, tree, code)` is the intended scope once those domains exist. V18/V19 remain blocked behind M-3/M-6. |
| **LIFECYCLE** | **`READY-WITH-EXPLICIT-DECISION`** | **M-5 Option A** defines the states, the freeze point (**submit**) and the single correction loop — all `SOURCE FACT`-backed. Requires M-5 to be formally adopted. |
| **APPROVAL** | **`READY-WITH-EXPLICIT-DECISION`** | **M-5** gives *who* and *what*; the outstanding **actor semantics (D-4)** must be decided. |
| **CODE GENERATION** | **`BLOCKED`** | **M-3** blocks the prefix; **M-6d** must be decided; the counter table legitimately waits for its first minter (CF-6). |
| **CRUD** | **`BLOCKED`** | Depends on ITEM MODEL and on LIFECYCLE's guards. |
| **AUDIT** | **`READY`** | `AUDIT_PORT.record` / `.read` exist; the `CommerceAuditGateway` pattern (envelope from the actor, resource vocabulary, never-throw) is a direct template. Required for V1. |
| **SEARCH** | **`READY`** | `SEARCH_SOURCE_PORT` exists, with a documented `EXTERNAL` + `sourceKey` mechanism. Optional for V1. |
| **FRONTEND** | **`BLOCKED`** | A screen cannot render a code it cannot generate, an item model that is undecided, or a lifecycle that is not adopted. |

**Summary: `READY` ×2 · `READY-WITH-EXPLICIT-DECISION` ×4 · `BLOCKED` ×4.**

---

## 12. REMAINING BLOCKERS

Three, and only three, after this phase:

| ID | Blocker | Class | Why it cannot be guessed |
| --- | --- | --- | --- |
| **RB-1** | **Product Tree contract** — an authoritative domain **or** a declared tree-code source | `BLOCKED` | The `code` field exists in the source, but its **format, assignment rule, tenant scope and lifecycle** live in an unsupplied page. Inventing them would fix the format of *every future part code*. |
| **RB-2** | **Real Workflow source** — the missing approval-workflow definition | `WORKFLOW-CONTRACT-MISSING` | The transition engine was SharePoint's, and no artefact was supplied (**0** hits across 8 files). **Mitigated, not removed**, by M-5 Option A: V1 can adopt a source-backed state machine, but the *actor semantics* of approve/reject remain undecided. |
| **RB-3** | **Business decisions M-4 / M-6d / M-7a (+ D-4)** | `BUSINESS DECISION` | These are choices, not discoveries. This document presents the options and **stops**. |

**No longer blockers:** Project (M-1/M-2 absorb it) · `Code_Ghatae`'s semantics *as an obstacle*
(M-4 offers a safe option) · the lifecycle *shape* (M-5 fixes it) · concurrency (CF-5 supplies the
pattern) · the persistence boundary (closed in the previous phase).

---

## 13. REQUIRED BUSINESS DECISIONS

Exactly the ones that affect V1 correctness — no hypothetical future decisions.

| ID | Decision | Options | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| **M-4** | The fate of `Code_Ghatae` | **A.** keep as a legacy / non-authoritative column · **B.** exclude from V1 domain persistence until defined (raw value preserved at migration) | **B** | ITEM MODEL |
| **M-5b (D-4)** | Approval actor semantics | **(i)** only the stored manager may decide · **(ii)** anyone holding `production.bom.approve` | **(i)** — closest to the source | APPROVAL, CRUD |
| **M-6d** | Code immutability and reuse | **(i)** immutable, deleted codes never reused · **(ii)** regenerable, gaps accepted · **(iii)** hybrid (immutable in-life, explicit audited renumber) | **(i)** | ITEM MODEL, CODE GENERATION |
| **M-7a** | Coefficient numeric semantics | **(i)** `Int`, `>= 0` · **(ii)** `Decimal(18,4)`, `>= 0` | **(ii)** | ITEM MODEL, VALIDATION |

**Four decisions.** M-1, M-2, M-3 and M-5's lifecycle *shape* are already closed by evidence.

---


## 14. ARCHITECTURAL CONSEQUENCES

The ten principles the brief asked to preserve, each with the decision that preserves it and the
evidence that backs it. **None is weakened by M-1…M-7.**

| # | Principle | Preserved by | Evidence |
| --- | --- | --- | --- |
| 1 | **Project is not owned by Production** | **M-1 Option A** — an opaque `projectRef`, no local table, no name derivation | CF-1 (*"does NOT duplicate authoritative state"*)· CF-3 (DC-CORR-01: *"NO identity model"*) |
| 2 | **Product Tree is not accidentally duplicated inside BOM** | **M-3** — the domain stays `BLOCKED`; BOM only ever *references* it | closure §4.3 · §5.2's ownership split |
| 3 | **Supplier is not owned by Production** | the preflight's supplier classification is untouched (suggested supplier / price are informational BOM metadata, no `Supplier` table, no FK to Commerce) | CF-1 lists `supplierId` as an **opaque string** in Commerce itself — even the procurement module does not own a supplier master |
| 4 | **Procurement consumes BOM; it does not own BOM** | out of scope here, and M-1/M-3 keep every reference pointing **into** Production | preflight §20.1 (`ID_BOM` written *by* the purchase form) |
| 5 | **Quality is an integration boundary, later an independent module** | `hasControlPlan` stays a self-contained two-value indicator; no control-plan entity is created | preflight §16 |
| 6 | **Project Management can later become an independent module** | M-2 classifies Project as `EXTERNAL DEPENDENCY / FUTURE MODULE`, and M-1's opaque id resolves against it with **no BOM table change** | CF-1's whole design intent |
| 7 | **BOM remains a Production-owned aggregate** | the header + items, the code rule, the lifecycle and the audit vocabulary are all Production-owned | preflight §3, §4 |
| 8 | **Search and Audit reuse existing Platform contracts** | no new search engine and no second audit trail | `SEARCH_SOURCE_PORT`, `AUDIT_PORT` |
| 9 | **No third workflow engine is created** | **M-5 Option A** is a state machine on BOM's own row, not an engine; Option B was refuted (0 platform hits + CF-2's closed enum) | CF-2 · closure §5 |
| 10 | **No SharePoint username/group rule becomes Ariya authorization** | the legacy `UserInGroup` / three-name rules and the `LevelManager ∈ {1,2}` candidate filter are all classified legacy; authorization is RBAC + stored approver | closure §10.5, §9.2 |

### 14.1 One consequence worth stating explicitly

**The single most important architectural consequence of this phase** is M-1's `Title` decision:

> SharePoint **derived** the BOM's title from the project's *name*; Ariya **stores** it. That is a
> deliberate divergence. It is the price of not owning Project — and it is the *correct* price,
> because the alternative is a BOM whose own name depends on a module that does not exist.

The same logic governs M-3: BOM will not invent a tree-code format merely so that generation can
run, because a code prints on drawings and appears in purchase requests, and **an invented format is
unrecoverable**.

### 14.2 Ownership map after this phase

```
Project Management  (FUTURE MODULE)     ─── owns Project
Product Tree        (FUTURE / BLOCKED)  ─── owns the tree + its code
Core / Platform     ─── owns Tenant, RBAC, Identity, Audit, Search, Notification
HR                  ─── owns EmploymentRecord.managerEmployeeId (NOT exposed by USER_DIRECTORY)
Commerce            ─── owns PurchaseDocument / PurchaseLine (+ an opaque supplierId)

Production  ─── owns BOM (header + items), its lifecycle, its code RULE, its audit vocabulary
             ─── references Project (opaque) · references Product Tree (opaque)
             ─── owns NO Project · NO Product Tree · NO Supplier · NO Purchase · NO Quality model
```

---

## 15. NON-GOALS

This phase did **not**, and the next phase must not treat it as permission to:

1. **Create any table, schema, migration or database** — no counter table, no BOM table. `[CONFIRMED — git status]`
2. **Create any route, controller, DTO, service or module registration.**
3. **Build any frontend screen, component or label file.**
4. **Create Project Management**, or any `Project` table anywhere. (M-1, M-2)
5. **Create Product Tree**, or invent a tree-code format to unblock generation. (M-3)
6. **Invent a workflow** from the UI, or extend Commerce's closed `WorkflowSubjectType`. (M-5)
7. **Create a third workflow/approval engine.** (M-5, principle 9)
8. **Implement the counter mechanism** — only its *shape* was fixed, by citing CF-5. (M-6)
9. **Choose the code generator** or finalize the prefix. (M-6, M-3)
10. **Define any consumption formula** — `total = drawing + spare` is explicitly refused. (M-7)
11. **Reinterpret or delete `Code_Ghatae` from the source model.** (M-4)
12. **Connect BOM to Procurement.**
13. **Carry `State == 5`** or any legacy identity/level filter into the Ariya domain or its
    authorization.
14. **Modify Commerce, HR, Core, the frontend, or any existing schema/test.**
15. **Produce a second artifact.** This document is the only one.

---


## 16. FINAL RECOMMENDATION

### 16.1 The seven answers, in one place

| ID | Answer | Class | Business approval? |
| --- | --- | --- | --- |
| **M-1** | **OPTION A** — `projectRef` as an **opaque external reference**; Production does not own Project; `Title` is **stored**, never derived from a project name | `ARCHITECTURAL DECISION` (CF-1…CF-4) | No |
| **M-2** | **`PROJECT-CONTRACT = EXTERNAL DEPENDENCY / FUTURE MODULE`**; BOM needs only an id, its own tenant and row-scoped authorization | `CONTRACT FACT` + `ARCHITECTURAL DECISION` | No |
| **M-3** | **`PRODUCT-TREE-CONTRACT = BLOCKED`**; BOM references it without owning it; the tree code's format stays unknown | `CONTRACT FACT` | No |
| **M-4** | **OPTION B** — exclude `Code_Ghatae` from V1 domain persistence **with migration-time raw-value preservation** | `BUSINESS DECISION` | **YES** |
| **M-5** | **OPTION A** — a Production-owned guarded state machine; **`submit` is the freeze point**; approve/reject actor semantics remain a business decision | `ARCHITECTURAL DECISION` | Partial (D-4) |
| **M-6** | Invariant **C+D**; `CODE = <tree code> + <per-scope sequence>`; allocation uses the **existing CF-5 pattern**; the prefix is **BLOCKED**; **M-6d** open | `SOURCE FACT` + `CONTRACT FACT` | **YES** (M-6d) |
| **M-7** | Fields 1–2 = required `>= 0` inputs; fields 3–7 = **`SEMANTICS-DEFERRED`**; **no formula invented**; **M-7a** open | `SOURCE FACT` + `CONTRACT FACT` | **YES** (M-7a) |

### 16.2 The recommendation

> **Take the four business decisions — M-4, M-5b (D-4), M-6d and M-7a — and close RB-1 (a Product
> Tree contract, or a declared tree-code source). Then implementation can begin in this order:
> persistence → validation → lifecycle → **item model** → approval → code generation → CRUD →
> audit → frontend → optional search.**
>
> **Three things are already true and need no further decision:** the reference policy (M-1), the
> Project classification (M-2) and the persistence boundary (closed in the previous phase). They are
> enough to write the **BOM header** today.
>
> **The item model must not be written before M-3, M-4, M-6d and M-7a are answered** — it is the one
> table where every open question lands.

### 16.3 Why this is the honest stopping point

- The repository's own rule — **CF-1**: *"Commerce does NOT duplicate authoritative state"* — already
  answers M-1 and M-2. Adopting it is not invention; it is consistency.
- The 0-hit platform-workflow search plus **CF-2**'s closed enum make M-5 a **forced choice**, not a
  preference.
- **CF-5** answers M-6's concurrency question *by pointing at tested code* — the strongest form of
  closure available short of implementing it.
- M-3, M-4, M-6d and M-7a are **not** closable from evidence. Each has explicit options with a
  reasoned recommendation, and the document **stops** there, as the decision principle requires.

### 16.4 What would change this recommendation

- **An authoritative Product Tree contract** removes RB-1 and unblocks the code prefix (M-6), the
  item model and code generation at once.
- **The original SharePoint approval-workflow definition** would upgrade RB-2 from *mitigated* to
  *closed*, and would likely settle D-4 outright.
- **A business decision to drop `standardPartCode` from V1** would unblock the item model without
  M-3 — at the cost of a BOM that cannot satisfy V18/V19, which would need explicit acceptance.
- **A decision to build Project Management next** does not change M-1 (already reference-only), but
  would let `Title` derivation and `projectCodeSnapshot` become real snapshots instead of deferred
  ones.

### 16.5 Readiness, restated

```
PRODUCTION → BOM :  STILL NOT READY FOR IMPLEMENTATION
                    (improved from 6 blocked areas to 4)

READY                           2 : Audit, Search
READY-WITH-EXPLICIT-DECISION    4 : Persistence, Validation, Lifecycle, Approval
BLOCKED                         4 : Item model, Code generation, CRUD, Frontend

NEXT, IN ORDER:
  1. Business: M-4 · M-5b(D-4) · M-6d · M-7a          (four decisions)
  2. Contract: RB-1 — a Product Tree domain OR a declared tree-code source
  3. Then:    implement, starting from the BOM header
```

---


## FILES CHANGED BY THIS PHASE

**Created (the only new artifact):**

- `docs/PHASE-PRODUCTION-BOM-M1-M7-DECISION-CLOSURE.md` — this document.

**Modified:** none. Nothing under `apps/api/**`, `apps/web/**`, `packages/**`,
`infrastructure/**`, any Prisma schema, any migration, or any Commerce/HR/Core/frontend/test file
was touched. No route, permission, schema or registration was added.

## SOURCE FILES READ (outside the repository)

The eight SharePoint files were re-inspected for the facts each decision rests on:
`E:\Very Mohem\BomAdd.txt`, `BomEdit.txt`, `Kartable Bomadd.txt`, `kartable bomEdit.txt`,
`kharid.txt`, `kartabl karid.txt`, `sooderCheck.txt`, `kartabl SoderCheck.txt`.

## CHECKS PERFORMED

| # | Check | Result |
| --- | --- | --- |
| 1 | Every Prisma schema + all **123** `CREATE TABLE`s re-checked for Project / ProductTree / Part / Bom / Supplier | **0** — M-2 and M-3 rest on this |
| 2 | `nav-catalogue.ts` route inventory | 32 routes, **no project / product-tree route** |
| 3 | `src/platform/**` searched for `Workflow` (case-insensitive) | **0 hits** → M-5 Option B refuted |
| 4 | `WorkflowSubjectType` re-read | **closed** enum `{PURCHASE_DOCUMENT, PURCHASE_LINE}` (CF-2) |
| 5 | Commerce schema header re-read | **CF-1** — *"NO cross-database foreign key"*, *"PLAIN STRING columns holding opaque values"*, *"does NOT duplicate authoritative state"* |
| 6 | Opaque-reference precedent searched across all schemas | **CF-2** (`subjectId` OPAQUE) · **CF-3** (DC-CORR-01 + isolation spec) · **CF-4** (ADR-0006 A4 + HR e2e) |
| 7 | Counter / sequence precedent searched across all schemas | **CF-5** `PurchaseDocumentCounter` full concurrency contract · **CF-6** (*"counter TABLE is not created"*, *"the formatter's business"*) |
| 8 | Snapshot-alongside-reference precedent searched | **CF-7** (`conditionInputSnapshot`, per-row `currency`, `SearchDocument.tenantId`) |
| 9 | Numeric / decimal convention searched | **CF-8** — uniform `Decimal(18, 4)` |
| 10 | `packages/config` `'Project Management'` traced to its consumers | a **marketing** `FEATURES` array — not a domain (M-2) |
| 11 | `commerce-isolation.spec.ts` + `architecture-boundaries.spec.ts` inventoried | **CF-9** — the executable enforcement pattern Production would follow |
| 12 | `git status --short` before and after | **identical** except this document |
| 13 | `git log --oneline -1` | HEAD `840226b` — unchanged, no commit |

---

## FINAL STATUS

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PRODUCTION → BOM :  NOT READY FOR IMPLEMENTATION   (4 blocked → 4 blocked,  │
│                      but 4 areas moved to READY-WITH-EXPLICIT-DECISION)      │
│                                                                              │
│  DECISIONS CLOSED BY EVIDENCE                                                │
│    M-1  OPTION A — opaque projectRef; Production owns no Project             │
│    M-2  PROJECT-CONTRACT = EXTERNAL DEPENDENCY / FUTURE MODULE               │
│    M-5  OPTION A — Production-owned guarded state machine; submit freezes    │
│                                                                              │
│  BLOCKED BY A MISSING DOMAIN                                                 │
│    M-3  PRODUCT-TREE-CONTRACT = BLOCKED   → blocks the code prefix           │
│                                                                              │
│  AWAITING EXPLICIT BUSINESS APPROVAL (4)                                     │
│    M-4   keep vs exclude Code_Ghatae                                         │
│    M-5b  approval actor semantics (D-4)                                      │
│    M-6d  code immutability & reuse                                           │
│    M-7a  coefficient numeric semantics                                       │
│                                                                              │
│  REMAINING BLOCKERS:  RB-1 Product Tree · RB-2 Workflow source · RB-3 the    │
│                       four business decisions                                │
│                                                                              │
│  GATE:  READY ×2 · READY-WITH-EXPLICIT-DECISION ×4 · BLOCKED ×4              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Most important outcome:** the repository's own established rule — *"a bounded context does not
duplicate authoritative state; every external reference is an opaque string"* (CF-1…CF-4) —
**already answers M-1 and M-2**. Adopting it keeps `Project` and `Product Tree` outside Production,
lets BOM reference them without owning them, and unblocks the BOM header without inventing a single
field.

---

**END OF DOCUMENT —** `M-1…M-7 DECISION CLOSURE COMPLETE — NO IMPLEMENTATION PERFORMED`
