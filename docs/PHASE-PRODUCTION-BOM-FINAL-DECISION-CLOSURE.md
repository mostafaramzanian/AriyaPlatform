# PHASE PRODUCTION-BOM — FINAL DECISION CLOSURE

**Status:** `FINAL DECISION / CONTRACT CLOSURE — NO IMPLEMENTATION. No schema, no migrations, no
routes, no frontend, no Project Management, no Product Tree, no Procurement change, no Commerce
change.`

**Module:** Production / «تولید»  **Capability:** BOM / «فهرست مواد و قطعات»

**Authoritative inputs:**
`docs/PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md` →
`docs/PHASE-PRODUCTION-BOM-CONTRACT-CLOSURE.md` →
`docs/PHASE-PRODUCTION-BOM-M1-M7-DECISION-CLOSURE.md` → **this document**

**Status vocabulary (§8):** `RESOLVED` · `RESOLVED-BY-EXISTING-CONTRACT` ·
`BUSINESS-DECISION-CLOSED` · `BLOCKED` · `DEFERRED` · `NOT-IN-V1`.
**Evidence classes (§2):** `SOURCE FACT` · `EXISTING ARIYA CONTRACT` · `BUSINESS DECISION` ·
`ARCHITECTURAL CONSEQUENCE`.

**Git baseline:** HEAD `840226b8a00e960098e7e868740adbc64710d6d7`, branch `master`. No commit, reset,
clean, checkout or revert.

**THE ONLY NEW ARTIFACT OF THIS PHASE IS THIS DOCUMENT.**

---

## 1. SCOPE

Close exactly **five** remaining implementation blockers — RB-1, M-4, M-5b, M-6d, M-7a — and then
recompute the implementation gate. This phase does **not** re-open the BOM: everything already
closed stays closed.

**Inherited, already-resolved state:** Production owns BOM · the BOM Header is the aggregate root ·
the BOM Item is a child of exactly one BOM · Project is an external opaque reference the Production
module does not own · Production has its own bounded-context persistence boundary · Production owns
its own lifecycle/state machine · Search uses `SEARCH_SOURCE_PORT` · Audit uses `AUDIT_PORT` · code
allocation must follow the repository's transaction-safe counter precedent.

**The five open items:**

| ID | Blocker |
| --- | --- |
| **RB-1** | Product Tree authority / code contract |
| **M-4** | `Code_Ghatae` final disposition |
| **M-5b** | Final approval authority |
| **M-6d** | BOM code-generation business policy |
| **M-7a** | Numeric semantics of consumption coefficients |

### 1.1 Outcome, stated up front

Three of the five close outright, one closes as a business decision with a defined rule, and one
**narrows to a single, precisely-described technical blocker**: the Product Tree's **code source**
(`RB-1-P`). After this phase, **every** other path to implementation is either closed or gated only
by an explicit business approval — no remaining item requires inventing a subsystem.

---

## 2. DECISION METHODOLOGY

### 2.1 The four evidence classes

| Class | Definition | Can it close a decision alone? |
| --- | --- | --- |
| **`SOURCE FACT`** | Read verbatim from the eight supplied SharePoint files (control XML, `ValueChangeScript`, `LoadCompletedScript`, `ListQuery`, action scripts) | **Yes** — for what the legacy system *did* |
| **`EXISTING ARIYA CONTRACT`** | Read verbatim from an APPROVED ADR, a Prisma schema, an executable isolation/architecture test, or a platform port in this repository | **Yes** — for what Ariya *already guarantees* |
| **`BUSINESS DECISION`** | Neither evidence base answers it — only the business owner can | **No** — options presented, then closed only if the brief authorises it |
| **`ARCHITECTURAL CONSEQUENCE`** | Follows unavoidably from a contract or a source fact | **Yes**, with the forcing fact cited |

### 2.2 The strict rules applied

1. Search the repository. 2. Re-check the SharePoint evidence already identified. 3. Distinguish the
four classes. 4. **Do not convert an inference into a fact.** 5. **Do not create a temporary
contract just to unblock implementation.** 6. If a required business answer cannot be established →
mark it as requiring explicit business approval. 7. If a technical contract can be established from
existing architecture → close it without inventing a new subsystem.

### 2.3 How `RESOLVED` differs from `BUSINESS-DECISION-CLOSED`

- `RESOLVED` — the evidence determines the answer; no party needs to approve it.
- `BUSINESS-DECISION-CLOSED` — the evidence *constrains* but does not determine the answer; this
  phase closes it with a stated rule and rationale, and §13 lists which closures the business should
  formally ratify.
- `RESOLVED-BY-EXISTING-CONTRACT` — Ariya already owns the mechanism; nothing new is designed.

### 2.4 Deliberate non-actions

No inference was promoted to a fact. In particular: `total = drawing + spare` was **not** adopted;
no tree schema, hierarchy, code format or ownership was invented; no self-approval was assumed; no
temporary Project, Product Tree or prefix contract was created.

---

## 3. RB-1 — PRODUCT TREE CONTRACT

**DETERMINATION: `B` — AN EXTERNAL CONTRACT CAN BE DEFINED WITHOUT IMPLEMENTING PRODUCT TREE.**
**Status: `RESOLVED-BY-EXISTING-CONTRACT` (for `productTreeRef`).**
**Mandatory sub-result `RB-1-P` — the tree-derived CODE SOURCE — remains `BLOCKED`.**

### 3.1 The re-run investigation

| Search | Scope | Result |
| --- | --- | --- |
| `ProductTree` / `productTree` / `product_tree` / `product-tree` | every `.ts/.tsx/.prisma/.sql/.json/.md` excluding `node_modules`, `.next`, `dist`, `coverage`, mirrors | **56 hits — 100% inside this repository's own three BOM documents. Zero in code, schema, SQL, tests or JSON.** |
| `treeCode` / `tree_code` / `productCode` / `productStructure` / `productHierarchy` / `treeNode` / `tree_node` | same scope | **27 hits** → HR's `OrganizationTreeNode` (an organisational hierarchy) and `lovable/ArchiveModal.tsx`'s `TreeNode` (a UI component). **No product semantics.** |
| `Test_WP.aspx` (the tree-picker page) | same scope | **0 outside this document** — the page source was never supplied |
| All 123 `CREATE TABLE`s, all 6 Prisma schemas, all model declarations | — | **0** product-tree objects (prior phase, re-confirmed) |
| `nav-catalogue.ts`, module registrations, platform ports | — | **0** routes, **0** registrations, **0** ports |

**Conclusion:** there is **no** Product Tree model, table, route, port, service, generator, or test
anywhere in Ariya. `[EXISTING ARIYA CONTRACT — by absence]`

### 3.2 Why `B` and not `A`, `C` or `D`

| Option | Verdict | Reason |
| --- | --- | --- |
| **A.** Existing authoritative contract found | **NO** | §3.1 — nothing exists |
| **B.** External contract definable without implementing Product Tree | **YES — chosen** | Ariya already has a general, tested rule for exactly this situation (§3.3). BOM needs only *to point at* a tree, not to own or render one. |
| **C.** Business/platform decision required | **Partial** — applies only to `RB-1-P` (§3.4) | the *reference* needs no decision; the *code source* does |
| **D.** Still blocked | **Partial** — `RB-1-P` only | the reference is not blocked; the prefix is |

`B` is correct because the reference question and the code question are **different questions**.
The reference can be closed by an existing contract today; the code cannot.

### 3.3 The external reference contract for `productTreeRef` `[EXISTING ARIYA CONTRACT]`

Defined **without** implementing Product Tree, because Ariya already enforces this pattern in four
places:

- **CF-1** — Commerce schema: *"There is **NO cross-database foreign key**. … are **PLAIN STRING
  columns holding opaque values**"* · *"does NOT duplicate authoritative state"* · *"an opaque
  reference, not a second personnel table."*
- **CF-2** — `WorkflowInstance.subjectId`: *"**OPAQUE, like every external reference in this
  schema**."*
- **CF-3** — DC-CORR-01 + `correspondence-isolation.spec.ts`: *"declares **NO identity model** and
  **NO relation into identity**."*
- **CF-4** — ADR-0006 A4 + HR e2e: *"**EVERY** foreign key declared in `hr_db` points at another
  table of `hr_db`"*; *"**No cross-database foreign keys, ever.**"*

```
productTreeRef
  · opaque external identifier          — a string; format never inspected by Production
  · tenant-safe reference               — NEVER an input to tenant resolution. The BOM row's
                                           OWN tenantId isolates it; fail-closed actor resolution
  · read / reference semantics ONLY     — no join, no FK, no local tree table, no cache of the
                                           tree's structure, no ownership
  · no tree schema · no hierarchy · no code format · no prefix format · no ownership
```

**Architectural consequence:** BOM may *point at* a Product Tree exactly as it points at a Project
(M-1). Production does **not** become the owner of the tree.

### 3.4 `RB-1-P` — the tree-derived CODE SOURCE: still `BLOCKED`

> **Explicit determination, as the brief requires: yes — BOM code generation MUST remain blocked
> until the Product Tree code source is authoritative. The prefix must not be faked.**

The legacy code is `<product tree code>-<sequence>` — the prefix is read from `ProductTree.code`.
That `code` field's **format, assignment rule, change behaviour and authority** live in a SharePoint
page (`SitePages/Test_WP.aspx`) that was **never supplied**, and in a list whose schema is unknown.
Ariya therefore knows a code is used as a prefix, but not **what a valid one is**.

| Sub-question | Can it be answered today? |
| --- | --- |
| Does a tree-derived prefix participate in code generation? | **YES** — `SOURCE FACT` (three generators) |
| What is the exact source? | **Partially** — `ProductTree.code`, but that list has no Ariya counterpart |
| What is its format / validity / ownership? | **NO** → `BLOCKED` |
| Does the prefix change if the Product Tree changes? | **NO** → `BLOCKED` (depends on the tree contract + M-6d immutability) |

**Inventing a prefix would mean inventing the format of every part code ever printed on a drawing or
quoted in a purchase request. That is not recoverable — so it is refused here.**

### 3.5 Migration / implementation consequence

| Consequence | Detail |
| --- | --- |
| **Migration** | `productTreeRef` is carried verbatim as an opaque string (the legacy field was already a lookup **id**: `Lookup_ValueFieldName="ID"`). A `productTreeCodeSnapshot` may be preserved as **raw data** (CF-7 pattern) but is **not** asserted as authoritative. |
| **Implementation** | BOM Header: **not blocked** by RB-1. BOM Item / Code generation: **blocked** by `RB-1-P`. |
| **Blocks V1?** | **Partially** — blocks the item's `standardPartCode` and therefore code generation; does **not** block the header, lifecycle or approval. |

---


## 4. M-4 — `CODE_GHATAE`

**DECISION: `OPTION A` — keep the column in persistence for compatibility/migration, and exclude it
from the V1 domain model and business logic.**
**Status: `BUSINESS-DECISION-CLOSED`.**

### 4.1 Evidence re-confirmed `[SOURCE FACT]`

A fresh, dedicated sweep over all eight files:

| Dimension | Count | Meaning |
| --- | --- | --- |
| **write sites** (`listitem.X =` / `item.X =`) | **0** | nobody ever writes it |
| **query criteria** | **0** | never filtered, never searched, never a uniqueness predicate |
| **bound label** (`Value="…Code_Ghatae…"`) | **0** | no control ever displays it |
| **`Value_ListQueryField` binding** | **0** | no control ever receives it as a query result |
| **read projections** (`Attributes="…"`) | **8** across 5 files | it is *read* by `BomAdd`, `BomEdit`, `Kartable Bomadd`, `kharid`, `kartabl karid` — and only ever as a projection |

**And** the field that actually displays «کد قطعه» is a *different* field
(`GhataeDarkhastiKharid_x003a__x061` on the purchase part-request lookup), while
`CodeStandardDarSanat` is the generated standard part code. `Code_Ghatae` is a **ghost**: projected
everywhere, owned by nothing.

### 4.2 Option evaluation against the brief's rule

> *"The recommended default should be the smallest semantic commitment consistent with migration
> safety."*

| | Semantic commitment | Migration safety | Verdict |
| --- | --- | --- | --- |
| **A.** Keep in persistence, exclude from the V1 domain model | **Smallest** — no domain field, no business rule, no API surface, no UI | **Full** — the column exists, so the legacy value lands in it 1:1 | ✅ **chosen** |
| **B.** Keep as an explicit legacy-compatible domain field with no business rule | **Larger** — a typed domain field exists that no rule defines; consumers will read meaning into its presence | Full | ❌ exceeds the "smallest commitment" |
| **C.** Remove it completely from the V1 persistence model | Smallest | **Needs a new preservation mechanism**; risks losing an unknown historical value — and the brief says *"Do not delete historical data merely because the field is not part of V1"* | ❌ |

**A is the only option that is simultaneously the smallest commitment and provably migration-safe.**

### 4.3 The V1 rule, stated exactly

```
PERSISTENCE   : the column EXISTS in the V1 schema, nullable, with no default,
                named to preserve the legacy field name (no silent rename)
DOMAIN MODEL  : EXCLUDED — not a V1 BOM-Item domain field
BUSINESS LOGIC: no validation, no derived value, no display, no API projection,
                no search field, no audit resource
SOURCE MODEL  : UNTOUCHED — the SharePoint field and the preflight inventory keep it as [OPEN]
```

### 4.4 Migration / raw preservation, documented now

| Step | Rule |
| --- | --- |
| 1 | The migration maps SharePoint `Code_Ghatae` → the V1 column **verbatim**, with **no interpretation, no normalisation, no coercion** (preflight §22.2 rule 1–2: *"Preserve unknown values verbatim"*) |
| 2 | The column is recorded in the migration's field-mapping table as **`legacy-unverified`**, alongside its SharePoint name and GUID list (`BOM_فهرست اقلام پروژه`, `{14BC644C-…}`) |
| 3 | If the business later supplies a definition, the column **is promoted** to the domain model by an explicit, additive migration — the legacy value is already in place, so no back-fill is needed |
| 4 | If the field is instead dropped later, the value must be exported to the migration archive first — **never silently discarded** |
| 5 | **The field remains in the source record.** Excluding it from the V1 *domain* does not delete it from the *source model* |

### 4.5 Quality gate

| Field | Value |
| --- | --- |
| Decision ID | **M-4** |
| Status | **`BUSINESS-DECISION-CLOSED`** |
| Exact evidence | 0 writes · 0 criteria · 0 labels · 0 bindings · 8 projections; «کد قطعه» binds a different field |
| Final decision | **Option A** — persist, exclude from the domain |
| Rationale | smallest semantic commitment + full migration safety (the brief's own default rule) |
| Owner of decision | Business (ratification listed in §13) |
| Implementation consequence | the column may exist in the schema; **no** V1 domain field, validation, projection or UI |
| Migration consequence | verbatim 1:1 mapping, flagged `legacy-unverified`, promotable later |
| Blocks V1? | **No** |

---


## 5. M-5b — FINAL APPROVAL AUTHORITY

**DECISION: `OPTION A` — the manager selected and stored by the requester is the authoritative
approver, snapshotted at submission.**
**Status: `BUSINESS-DECISION-CLOSED` (with one sub-rule defaulted, §5.6).**

### 5.1 The four options, against the evidence

| Option | Evidence | Verdict |
| --- | --- | --- |
| **A.** The stored manager selected by the requester is the authoritative approver | `SOURCE FACT`: `ModirTaeedKonandeh` («مدیر درخواست کننده») is a **manual picker** the requester fills, persisted as `TargetFieldName="ModirTaeedKonandeh"`; its `PersonUser` is resolved and frozen into `TaeedKonandeh` at submit | ✅ **chosen** |
| **B.** Production resolves an approver dynamically from an authoritative org hierarchy | **Cannot be done.** Ariya's `USER_DIRECTORY.DirectoryUserProfile` exposes only `id` + `jobTitle` — **no manager edge**. HR's `EmploymentRecord.managerEmployeeId` exists but is **not** exposed through any platform contract, and the source's `LevelManager ∈ {1,2}` filter has **no Ariya equivalent** (0 hierarchy fields in HR) | ❌ would require inventing hierarchy resolution |
| **C.** Approval configurable through an existing authorization/workflow contract | **No platform workflow exists** (`src/platform/**` → 0 workflow hits); Commerce's `WorkflowSubjectType` is closed to purchase subjects; HR's approval definitions are FK-bound to `LeaveRequest` / `MissionRequest` | ❌ |
| **D.** Another source-backed rule | No other approver rule exists in any of the 8 files | ❌ none exists |

**A is the only source-backed rule, and the only one implementable without inventing hierarchy
resolution.** `[SOURCE FACT + EXISTING ARIYA CONTRACT]`

### 5.2 The snapshot evidence `[SOURCE FACT]`

| Control | Target field | Flags | Consequence |
| --- | --- | --- | --- |
| `c_DarkhastKonandeh` (requester) | `DarkhastKonandeh` | `IsEnabledOnEdit="False"` | set at creation, **frozen thereafter** |
| `c_ModirTaeedKonandeh` (approver) | `ModirTaeedKonandeh` | `IsEnabledOnEdit="False"` | set at creation, **frozen thereafter** |
| `c_TaeedKonandeh` (resolved system account) | `TaeedKonandeh` | `IsEnabled="False"` + `IsEnabledOnEdit="False"` + hidden | **never user-editable** |

**All three identities are frozen at creation.** That is the source's own answer to *"is the approver
mutable after submit?"* — **no**.

### 5.3 The six required statements

| Question | V1 rule | Basis |
| --- | --- | --- |
| **Who can submit?** | the **requester** — stored `requesterUserId`, holding the submit permission, while `status = DRAFT` | `SOURCE FACT` (`c_Control2`, `EnabledFormula = State == 0`) |
| **Who can approve?** | the **stored approver** — `approverUserId` snapshotted at submit, holding the approve permission, same tenant | `SOURCE FACT` (§5.2) |
| **Who can reject?** | **the same stored approver** — the `"رد"` branch of the same control | `SOURCE FACT` |
| **Who can request correction?** | **the same stored approver** — the `"نیاز به اصلاح"` branch, returning the BOM to `DRAFT` | `SOURCE FACT` |
| **What happens after correction?** | `status` returns to `DRAFT`; the **requester** may edit header and items again; the approver identity is **unchanged** | `SOURCE FACT` (`item.State = 0` is the only state the approval task writes) |
| **Is the approver mutable after submit?** | **NO** — frozen at creation (`IsEnabledOnEdit="False"`); later organisational changes **never silently redirect a pending approval** | `SOURCE FACT` §5.2 |

### 5.4 The formal rule (Option A, as the brief specifies it)

```
1. APPROVER IS SNAPSHOTTED ON SUBMISSION
   the approverUserId recorded when the requester submits is the approver for that BOM —
   captured as a value, never re-resolved from any hierarchy at decision time.

2. APPROVAL IS EVALUATED AGAINST THAT STORED IDENTITY
   the actor must match approverUserId AND hold production.bom.approve AND resolve within
   the BOM's own tenant.

3. LATER ORGANISATIONAL CHANGES DO NOT REDIRECT A PENDING APPROVAL
   no job/manager/role change re-routes an in-flight decision; only an explicit, audited
   re-assignment could — and none exists in V1.

4. APPROVER MUST BE A VALID TENANT MEMBER
   validated through USER_DIRECTORY (filterTenantMembers) — mirroring the source's own
   refusal to submit when PersonUser cannot be resolved.

5. SELF-APPROVAL IS NOT PERMITTED
   the actor may not be both requester and approver unless the business explicitly opts in.

6. APPROVE / REJECT / CORRECTION REMAIN PRODUCTION TRANSITIONS
   they are transitions of Production's own state machine (M-5 Option A) — not workflow
   tasks, not Commerce steps, not a third engine.
```

---


### 5.5 What was deliberately NOT done

- **No hierarchy resolution invented** — `LevelManager ∈ {1,2}` is legacy data-shaping over a
  SharePoint list column Ariya does not have (HR has **0** level/rank/grade fields).
- **No third workflow engine** — approve / reject / correction are Production state transitions.
- **No approver-as-configuration** — no matrix, no delegate, no substitute in V1. (HR's
  `availabilitySignal` / substitution machinery is HR-owned and unreachable from Production.)

### 5.6 Self-approval — the one sub-rule defaulted, not discovered

**Search result:** **NO** self-approval token of any kind exists in the eight files — no `self`, no
equality check between requester and approver, no «تایید خود».

Therefore the brief's own directive governs: *"actor cannot approve unless the business rule
explicitly permits self-approval."* **V1 sets self-approval = NOT PERMITTED**, because:

1. the source neither permits nor forbids it — and the brief forbids assuming it **is** allowed;
2. refusing is the **fail-closed** direction, consistent with how every other Ariya guard behaves;
3. permitting it later is a **one-line business opt-in**, while disallowing it after a self-approval
   has already happened is not.

**Recorded as a business ratification item (§13), not as a discovery.**

### 5.7 Quality gate

| Field | Value |
| --- | --- |
| Decision ID | **M-5b** |
| Status | **`BUSINESS-DECISION-CLOSED`** |
| Exact evidence | 3 frozen identity controls (§5.2) · **0** self-approval tokens · `USER_DIRECTORY` has no manager edge · 0 platform workflow hits |
| Final decision | **Option A** + snapshot-on-submit + immutable `approverUserId` + tenant-member validation + **self-approval NOT permitted** |
| Rationale | the only source-backed rule, and the only one not requiring an invented hierarchy |
| Owner of decision | Business (ratification in §13) |
| Implementation consequence | an approval guard comparing the actor with the stored `approverUserId`, plus RBAC; no org-tree dependency |
| Migration consequence | migrate `ModirTaeedKonandeh` + `TaeedKonandeh` into `approverUserId`; both legacy ids preserved |
| Blocks V1? | **No** |

---


## 6. M-6d — BOM CODE BUSINESS POLICY

**OVERALL STATUS: `BLOCKED`** — because the prefix source is `RB-1-P`.
**Six of the seven sub-questions are closed; only the prefix is not.**
The brief's separation is honoured literally: *"the sequence mechanism is technically known"* is kept
strictly apart from *"the business code policy is approved."*

### 6.1 1. CODE SCOPE — `RESOLVED`

| Evidence | Result |
| --- | --- |
| `SOURCE FACT` — the only uniqueness query is `project AND tree AND code` (`ListQuery3`); the generation input is scoped identically (`ListQuery2`) | the code is unique **within (project, product tree)** |
| `EXISTING ARIYA CONTRACT` — every Ariya counter key leads with `tenantId` (CF-5) | **tenant must be part of the key** |

```
CODE SCOPE = (tenantId, projectRef, productTreeRef)
             one series per BOM scope — never tenant-global, never global
```

This is the shape the existing counter pattern already implements:
`@@unique([tenantId, kind, jalaliYear])` → here `@@unique([tenantId, projectRef, productTreeRef])`.

### 6.2 2. PREFIX — **`BLOCKED` (RB-1-P)**

| Aspect | Finding |
| --- | --- |
| Exact source | `ProductTree.code` — **read from a list whose schema and authority were never supplied** |
| Exact format | **unknown** — no sample, no length, no alphabet, no validity rule exists anywhere |
| Separator | `-` — **`RESOLVED`** (`SOURCE FACT`: all three generators emit `<base>-<n>`) |
| Does the prefix change if the Product Tree changes? | **undeterminable** — depends on the tree contract (unknown) *and* on immutability (§6.4) → `BLOCKED` |

> **The exact prefix remains BLOCKED. It must not be faked.** Until an authoritative Product Tree
> code source exists, `standardPartCode` cannot be minted, and a BOM Item cannot satisfy the source's
> required-code validation (V18).

### 6.3 3. SEQUENCE — `RESOLVED` + `RESOLVED-BY-EXISTING-CONTRACT`

| Property | Value | Basis |
| --- | --- | --- |
| **Start** | **1** | `SOURCE FACT` (the first code is `<base>-001`) **and** `EXISTING ARIYA CONTRACT` — `formatPurchaseDocumentNumber` refuses `sequence < 1` because *"A counter is allocated by the database and **starts at 1**"* |
| **Increment** | **1** | both |
| **Zero padding** | **3** for BOM | `SOURCE FACT` (`zeroPad3`, `padStart(3,'0')`). The repository's own convention is **5** (`PURCHASE_DOCUMENT_NUMBER_WIDTH`), so the width is **a business choice** → §13 |
| **Maximum** | no business maximum; the **integer column** is the natural bound | `SOURCE FACT` — **0** `Maximum` / `MaxValue` attributes exist in any of the 8 files. The 3-digit padding implies a silent wrap past `999`, which is a defect, not a rule → §13 |
| **Deleted numbers reused?** | **NO** | `EXISTING ARIYA CONTRACT` — *"The last sequence number handed out for this key. **Never decremented**; never a value a document was not created under."* (CF-5). Matches the source: `btn_Delete` removes a row without renumbering |

### 6.4 4. IMMUTABILITY — `BUSINESS-DECISION-CLOSED`

The source **re-derives** the code on edit (generation runs unconditionally at the top of
`btn_Save`), and a bulk tool overwrites codes positionally.

**V1 rule: the code is IMMUTABLE after the BOM item is created.**
Rationale: a code is printed on drawings and quoted in purchase requests; a value whose meaning can
change after publication makes every downstream reference untrustworthy (preflight threat `T-11`).
**This deliberately diverges from the legacy behaviour and is recorded as a decision.**

### 6.5 5. RENUMBERING — `BUSINESS-DECISION-CLOSED`

**V1 rule: FORBIDDEN.**
The legacy bulk renumber (`c_Control41`) rewrites codes positionally with no audit and no per-row
confirmation, and is **not** carried into V1.

- If renumbering is ever needed it must be an **explicit, permission-gated, audited Production
  action** — a separate future decision, not part of V1.
- Migration **never** regenerates codes (preflight §22.2 rule 1).

---


### 6.6 6. CONCURRENCY — `RESOLVED-BY-EXISTING-CONTRACT`

**Reuse the repository's existing pattern verbatim. No custom locking mechanism is designed.**

```sql
INSERT INTO "<ProdCounter>" ("id","tenant_id","project_ref","product_tree_ref","counter")
VALUES (gen_random_uuid(), ${tenantId}, ${projectRef}, ${productTreeRef}, 1)
ON CONFLICT ("tenant_id","project_ref","product_tree_ref")
DO UPDATE SET "counter" = "<ProdCounter>"."counter" + 1
RETURNING "counter"
```

Exactly the statement `purchase.repository.ts` runs today (CF-5), with a different key.

Three properties Ariya already guarantees, which BOM inherits:

1. **A single atomic statement inside the creating transaction** — *"two concurrent creates cannot
   receive the same number."*
2. **`Nothing reads counter to build a number outside that statement`** — a `SELECT … then UPDATE`
   pair would reintroduce the exact race the source had (and the source's `setTimeout(1300)` is
   proof that race was real).
3. **A `CHECK counter >= 0` in the database** — an invariant stated in the schema, never trusted to
   application arithmetic.

### 6.7 7. ROLLBACK — `RESOLVED-BY-EXISTING-CONTRACT`

**Does a rolled-back create burn a sequence number? NO.**

> CF-5: *"...so two concurrent creates cannot receive the same number and **a create that rolls back
> never burns one**."*

This is **compatible with the business rule**: under §6.4 the code is immutable, so no number is ever
spent outside a row that still exists, and the absence of reuse costs nothing. Had we chosen a
mutable / regenerable policy, a burned number would produce permanent gaps — which is exactly why the
repository states the concurrency contract and the numbering policy *together*.

### 6.8 999 and the padding conflict — `BUSINESS-DECISION-CLOSED`

- **V1 rule: the counter REFUSES allocation past the field's capacity** rather than wrapping. The
  source's `zeroPad3` silently yields a 4-digit `1000` with no guard; Ariya must reject rather than
  produce a code that sorts unpredictably.
- **Padding = 3 is retained for BOM** (source truth), **not** 5: changing the padding changes the
  text form of every code already published, and there is no business reason to adopt another
  module's width. The repository's *pattern* (`<prefix>-<…>-<padded sequence>`) is adopted; its
  **width constant is not**.

### 6.9 Quality gate

| Field | Value |
| --- | --- |
| Decision ID | **M-6d** |
| Status | **`BLOCKED`** (prefix only) — scope, sequence, immutability, renumbering, concurrency and rollback are **closed** |
| Exact evidence | 3 generators · 0 locking in source · CF-5 / CF-6 · `purchase-number.ts` + `purchase.repository.ts` · 0 `Maximum` attributes |
| Final decision | scope `(tenant, project, tree)` · start 1 / step 1 / pad 3 · **immutable** · **renumber forbidden** · **CF-5 counter** · **no number burned on rollback** · **prefix BLOCKED** |
| Rationale | the mechanism is already owned by Ariya; only the prefix is missing, and faking it would fix the format of every future part code |
| Owner of decision | Mechanism → architecture (closed). Padding / capacity → business (§13). Prefix → **blocked** (RB-1-P) |
| Implementation consequence | the counter table and formatter arrive **with the first minting step** (CF-6), not earlier; **no generator is written while RB-1-P stands** |
| Migration consequence | codes migrate **verbatim**; never regenerated, never renumbered |
| Blocks V1? | **YES — for the BOM Item and code generation only** |

---


## 7. M-7a — CONSUMPTION COEFFICIENT SEMANTICS

**STATUS: `BUSINESS-DECISION-CLOSED`** — fields 1–2 are `DEFINED` for V1; fields 3–7 are `NOT-IN-V1`.
**No formula was inferred. `total = drawing + spare` was NOT adopted.**

### 7.1 New evidence found this phase `[SOURCE FACT]`

| Finding | Evidence |
| --- | --- |
| The source **declares 0 decimals** for numeric inputs | `Decimals = 0` on **every** `NumberTextBox` in all five files that have any (`BomEdit`, `kharid`, `kartabl karid`, `kartabl SoderCheck`, `sooderCheck`) |
| **`Step = 1`** throughout | the same five files |
| The BOM **coefficient delta** is a `NumberTextBox` with `Decimals="0"` `Step="1"` | `BomEdit.txt` → `c_Control7`, `c_Control10` |
| The **stored coefficient itself is a plain `TextBox`** — never a `NumberTextBox` | `BomAdd.c_ZaribMasrafInMap` / `c_zaribMasrafYadaki`, and their read-only mirrors in `BomEdit` / `Kartable Bomadd` |
| **No** precision / min / max attribute exists anywhere | **0** matches for `NumberOfDecimals`, `DecimalPlaces`, `MaxValue`, `MinValue`, `Maximum`, `Minimum`, `Precision`, `FormatString` across all 8 files |
| A **strictly-positive intent existed but was disabled** | inside a `/* … */` block: *"باید عدد باشد"* (must be a number) and *"باید بیشتر از 0 باشد"* (must be **greater than 0**) |
| The **only active** range check is `total < 0` — and even that has `//error = true;` **commented out** | it warns, it does not refuse |

**Net:** the source *declares integers* for these quantities, but *enforces no range at all*.

### 7.2 Classification of all seven fields

| # | Field (legacy) | Persian label | Class |
| --- | --- | --- | --- |
| **1** | `ZaribMasraf_DarNaghshe` | ضریب مصرف (درنقشه) | **`DEFINED`** (in V1) |
| **2** | `ZaribMasraf_YadakiDorriz` | ضریب مصرف (یدکی/تست) | **`DEFINED`** (in V1) |
| **3** | `ZaribMasraf_KoleGhatae` | ضریب مصرف کل قطعه | **`NOT-IN-V1`** |
| **4** | `ZaribMasraf_DarNaghshe_DarHalSef` | … (در نقشه) در حال سفارش | **`NOT-IN-V1`** |
| **5** | `ZaribMasraf_YadakiDorriz_DarHalS` | … (یدکی/تست) در حال سفارش | **`NOT-IN-V1`** |
| **6** | `ZaribMasraf_DarNaghshe_Kharidsho` | … (در نقشه) خریداری شده | **`NOT-IN-V1`** |
| **7** | `ZaribMasraf_YadakiDorriz_KharidS` | … (یدکی/تست) خریداری شده | **`NOT-IN-V1`** |

**Why `NOT-IN-V1` for fields 3–7:** they are **not inputs** — nothing in the eight files writes them —
so the brief's permission to *"keep the field as a persisted numeric input"* does not apply, because
there is no input to persist. They are order-in-progress / purchased **projections**, most plausibly
owned by the future Procurement contract. Persisting them in V1 would mean a column Production can
neither write nor define.

---


### 7.3 Fields 1–2 — the twelve determinations

| # | Dimension | Value for fields 1–2 | Class |
| --- | --- | --- | --- |
| 1 | **manually entered or derived** | **manually entered** (`listitem.* =` in `btn_Save`; no computation at creation) | `SOURCE FACT` |
| 2 | **integer or decimal** | **INTEGER** | `SOURCE FACT` (`Decimals="0"`, `Step="1"`, `parseInt` in every arithmetic use) |
| 3 | **precision / scale** | **scale = 0** | `SOURCE FACT` |
| 4 | **minimum** | **`0`** (`>= 0`) | `BUSINESS DECISION` closed — §13 |
| 5 | **maximum** | **none** (column capacity only) | `BUSINESS DECISION` closed — §13 |
| 6 | **zero semantics** | **legal** — the save refuses only *empty*; a `0` has never been rejected | `SOURCE FACT` |
| 7 | **negative semantics** | **refused** — the source's only floor is `>= 0`; negatives then become impossible by construction | `BUSINESS DECISION` closed — §13 |
| 8 | **null semantics** | **NOT ALLOWED at creation** — empty is refused (V16 / V17) | `SOURCE FACT` |
| 9 | **unit** | **not declared anywhere; V1 makes no unit claim** — a bare number is persisted | `DEFERRED` |
| 10 | **formula** | **none — it is an input** | `SOURCE FACT` |
| 11 | **relationship to other coefficients** | fields 3–7 have **no evidenced** formulaic relationship to fields 1–2; the only relationship the source shows is `previous + delta → total` **for a change line** | `SOURCE FACT` — **`total = drawing + spare` is explicitly NOT adopted** |
| 12 | **future Procurement impact** | the purchase form takes **its own** quantities as user input (`TedadDarkhastiAznaghshe` / `…AzTest`, a `NumberTextBox`), validated *"باید مقداردهی بیش از 0 گردد"* → Procurement reads the coefficients but does not derive them here | `SOURCE FACT` |

**`ZaribMasraf_KoleGhatae` is the field to re-examine first when a formula is finally defined:** its
label («ضریب مصرف کل قطعه») *suggests* a BOM-side total, but the brief forbids converting a field name
into a formula, and no formula exists.

### 7.4 Migration consequence

Fields 3–7 are **not deleted from the source record.** They follow the same preservation rule as
M-4: mapped **verbatim** into raw columns, flagged `legacy-unverified`, promotable to the domain later
by an explicit migration. Nothing historical is discarded.

### 7.5 Quality gate

| Field | Value |
| --- | --- |
| Decision ID | **M-7a** |
| Status | **`BUSINESS-DECISION-CLOSED`** (fields 1–2) + **`NOT-IN-V1`** (fields 3–7) |
| Exact evidence | `Decimals="0"` / `Step="1"` · **0** precision/min/max attributes · disabled `> 0` intent · `total < 0` with `//error=true` commented · **0** writers for fields 3–7 |
| Final decision | fields 1–2: **INTEGER, scale 0, required, `>= 0`, no max, no unit claim, no formula**; fields 3–7: **NOT-IN-V1**, preserved verbatim at migration |
| Rationale | adopt the source's *enforced* rules, not its *disabled* intents; never persist a field Production can neither write nor define |
| Owner of decision | Business (ratification in §13) |
| Implementation consequence | two `INTEGER` columns with a `>= 0` check; **no coefficient column carries a formula** |
| Migration consequence | fields 1–2 verbatim; fields 3–7 verbatim into raw columns |
| Blocks V1? | **No** |

---


## 8. DECISION MATRIX

| ID | Current status | Exact evidence | Final decision | Rationale | Owner | Implementation consequence | Migration consequence | Blocks V1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **RB-1** (determination **B**) | **`RESOLVED-BY-EXISTING-CONTRACT`** | 56 `ProductTree` hits = **100% inside these documents** · **0** of 123 tables · **0** routes / ports / registrations · `Test_WP.aspx` never supplied · CF-1…CF-4 | `productTreeRef` = **opaque external identifier**, tenant-safe, **read/reference only**; Production does not own the tree; **no** schema, hierarchy, code format or ownership invented | Ariya already mandates exactly this pattern for every cross-boundary reference | Architecture | the BOM **Header** may store the reference; no FK, no tree table | id carried **verbatim**; `productTreeCodeSnapshot` kept as raw data only | **No** (header) |
| **RB-1-P** (sub-item) | **`BLOCKED`** | the tree `code`'s format/authority live in an unsupplied page · **0** sample values anywhere | **BOM code generation STAYS BLOCKED until an authoritative Product Tree code source exists. The prefix is NOT faked.** | inventing a prefix fixes the format of every future part code — unrecoverable | Platform / future Product Tree | blocks `standardPartCode`, the BOM Item and code generation | codes migrate verbatim, never regenerated | **YES** (item + code) |
| **M-4** | **`BUSINESS-DECISION-CLOSED`** | **0** writes · **0** criteria · **0** labels · **0** bindings · **8** projections; «کد قطعه» binds a *different* field | **Option A** — the column **persists**, but is **excluded** from the V1 domain model and business logic | the brief's own default: smallest semantic commitment + full migration safety | Business (§13) | no domain field, no validation, no projection, no UI | verbatim 1:1, flagged `legacy-unverified`, promotable later | **No** |
| **M-5b** | **`BUSINESS-DECISION-CLOSED`** | 3 identity controls frozen (`IsEnabledOnEdit="False"`) · **0** self-approval tokens · `USER_DIRECTORY` has no manager edge · **0** platform workflow hits | **Option A** — snapshot the approver on submit; immutability after submit; tenant-member check; **self-approval NOT permitted**; approve/reject/correction remain Production transitions | the only source-backed rule, and the only one not requiring invented hierarchy | Business (§13) | an approval guard against stored `approverUserId` + RBAC; **no org-tree dependency** | `ModirTaeedKonandeh` + `TaeedKonandeh` → `approverUserId`, both legacy ids preserved | **No** |
| **M-6d** | **`BLOCKED`** (prefix) — **6 of 7** sub-questions closed | 3 generators · **0** locking · `setTimeout(1300)` race · CF-5 / CF-6 · `purchase-number.ts` + `purchase.repository.ts` · **0** `Maximum` attrs | scope `(tenant, project, tree)` · start **1** / step **1** / pad **3** · **immutable** · **renumber forbidden** · **CF-5 counter** · **no burn on rollback** · capacity-guarded (refuses past 999) · **prefix BLOCKED** | the mechanism is already Ariya's; only the prefix is missing | Mechanism → architecture (closed). Padding/capacity → Business (§13). Prefix → blocked | counter + formatter arrive **with the first minting step** (CF-6); **no generator while RB-1-P stands** | codes verbatim; never regenerated or renumbered | **YES** (item + code) |
| **M-7a** | **`BUSINESS-DECISION-CLOSED`** (fields 1–2) + **`NOT-IN-V1`** (fields 3–7) | `Decimals="0"` / `Step="1"` · **0** precision/min/max attributes · disabled `>0` intent · `total<0` with `//error=true` commented · **0** writers for fields 3–7 | fields 1–2 = **INTEGER, scale 0, required, `>= 0`, no max, no unit claim, no formula**; fields 3–7 = **NOT-IN-V1**, preserved verbatim | adopt *enforced* rules, not *disabled* intents; never persist what Production can neither write nor define | Business (§13) | two `INTEGER` columns + a `>= 0` check; **no coefficient formula anywhere** | fields 1–2 verbatim; fields 3–7 into raw columns | **No** |

**Tally: 2 `RESOLVED-BY-EXISTING-CONTRACT` (RB-1, and M-6d's mechanism) · 3
`BUSINESS-DECISION-CLOSED` (M-4, M-5b, M-7a) · 1 `NOT-IN-V1` set (M-7a fields 3–7) · 1 `BLOCKED`
(RB-1-P → M-6d prefix).**

---


## 9. IMPLEMENTATION READINESS MATRIX

| Area | Status | Reason |
| --- | --- | --- |
| **BOM HEADER** | **`READY-WITH-EXPLICIT-ASSUMPTION`** | Project and Product Tree are both **opaque references** (M-1, RB-1); `Title` is stored; requester/approver/date/status/opinion are all resolved (M-5b). **The assumption:** an unvalidated reference is acceptable for V1 — which M-1 and RB-1 both record as a deliberate, reversible choice |
| **BOM ITEM** | **`BLOCKED`** | `standardPartCode` is **required** (V18) and its **prefix is unknown** (RB-1-P). Every other item field is now resolved: `Code_Ghatae` excluded (M-4), coefficients defined (M-7a), part attributes evidenced |
| **VALIDATION** | **`READY-WITH-EXPLICIT-ASSUMPTION`** | V1–V17 + V8 are pure field/existence checks, fully evidenced. **The assumption:** the uniqueness scope `(project, tree, code)` stands. V18/V19 cannot be *exercised* until code generation runs |
| **LIFECYCLE** | **`READY-WITH-EXPLICIT-DECISION`** | M-5 Option A fixes the states, the freeze point (`submit`) and the correction loop — all source-backed. Requires formal adoption of M-5 |
| **APPROVAL** | **`READY-WITH-EXPLICIT-DECISION`** | M-5b fixes *who*, *what* and *mutability*; only formal ratification (§13) remains |
| **CODE GENERATION** | **`BLOCKED`** | **RB-1-P** — the prefix. All six other sub-questions are closed (§6) |
| **CRUD** | **`BLOCKED`** | depends on BOM ITEM and on LIFECYCLE's guards |
| **AUDIT** | **`READY`** | `AUDIT_PORT.record` / `.read` exist; `CommerceAuditGateway` is a direct template |
| **SEARCH** | **`READY`** | `SEARCH_SOURCE_PORT` exists (`EXTERNAL` + `sourceKey`); optional for V1 |
| **FRONTEND** | **`BLOCKED`** | cannot render an item model that is undecided or a code that cannot be minted |

**Ready: 2 · Ready-with-explicit-assumption/decision: 4 · Blocked: 4.**
The blocked four all reduce to **one** technical blocker (`RB-1-P`) plus **CRUD/FRONTEND** which are
downstream of the BOM Item.

---

## 10. REMAINING BLOCKERS

**After this phase there is exactly ONE technical blocker and ONE set of ratifications.**

| ID | Blocker | Class | Why it cannot be guessed |
| --- | --- | --- | --- |
| **RB-1-P** | **Product Tree code source** — an authoritative `ProductTree.code` (format, validity, authority, change behaviour) | **`BLOCKED`** | The prefix determines the text of every part code ever printed or quoted. Its format lives in a page (`Test_WP.aspx`) that was never supplied and in a list whose schema is unknown. Faking it makes the format **unrecoverable**. |
| **RATIFY** | The five business closures of §13 (M-4, M-5b-self-approval, M-6d-padding/capacity, M-7a-range, and the M-4/M-7a preservation rules) | `BUSINESS DECISION` | They are choices, not discoveries. This document closes them with rationale; §13 lists them for formal approval. |

**Nothing else blocks V1.** Concretely:

- ✅ **Project** — no longer a blocker (M-1 + RB-1 both close it as an opaque reference).
- ✅ **`Code_Ghatae`** — no longer a blocker (M-4 Option A).
- ✅ **Approval authority** — no longer a blocker (M-5b Option A).
- ✅ **Coefficient semantics** — no longer a blocker (M-7a).
- ✅ **Concurrency / rollback / immutability / renumbering** — no longer blockers (M-6d).
- ❌ **Tree-derived prefix** — still a blocker (RB-1-P).

### 10.1 The honest reading of RB-1-P

Two paths exist, and **neither is taken unilaterally**:

1. **Authoritative Product Tree code source supplied/created** → RB-1-P closes → code generation
   becomes implementable.
2. **Business explicitly changes V1 scope** so that `standardPartCode` is not required at creation
   (e.g. generated lazily, or the item model defers the code) — this would violate the source's V18
   rule and **requires explicit business acceptance**, not a quiet reinterpretation.

This document does **not** choose between them.

---

## 11. MIGRATION CONSEQUENCES

One consolidated table. Migration remains a **future, separately-scheduled phase** (preflight D-13);
nothing here is executed now.

| Source field / concept | V1 target | Preservation rule | Status |
| --- | --- | --- | --- |
| `NameProje`, `NameProje_MortabetBaBOM` | `projectRef` (opaque) | **verbatim** — the legacy value was already a lookup **id** (`Lookup_ValueFieldName="ID"`); never normalised, never re-derived | M-1 · RB-1 |
| `NameProje_x003A_ProjectCode` | `projectCodeSnapshot` (raw) | **verbatim**, flagged `legacy-unverified`; not asserted authoritative | M-1 |
| `ProductTreeRef`, `JazeDerakhteMahsol` | `productTreeRef` (opaque) | **verbatim** — legacy id | RB-1 |
| `ProductTreeRef_x003A_code` | raw column | **verbatim**; **never** used to regenerate a code | RB-1-P |
| `Code_Ghatae` | raw column, **excluded from the domain** | **verbatim**, flagged `legacy-unverified`, promotable by a later additive migration; **the source record keeps the field** | **M-4** |
| `CodeStandardDarSanat` | `standardPartCode` | **verbatim — NEVER regenerated, NEVER renumbered.** Regenerating a business code silently renumbers a production BOM | preflight §22.2 rule 1 · M-6d §6.5 |
| `ZaribMasraf_DarNaghshe`, `ZaribMasraf_YadakiDorriz` | `INTEGER` columns (`>= 0`) | **verbatim**; a legacy empty or negative value is a **data-quality finding to report**, never to coerce | **M-7a** |
| `ZaribMasraf_KoleGhatae` + the four `DarHalSef` / `Kharidsho` fields | **NOT-IN-V1** raw columns | **verbatim**, flagged `legacy-unverified`, promotable later | **M-7a** |
| `DarkhastKonandeh`, `DarkhastKonnade` | `requesterUserId` | **verbatim**; an unresolved user must not break a BOM | M-5b · preflight §18.5 |
| `ModirTaeedKonandeh`, `ModirTaeadKonande` + `TaeedKonandeh`, `TaeadKonnade` | `approverUserId` | **verbatim**; **both** legacy ids preserved (the manager-record id *and* the resolved system account) | **M-5b** |
| `State` (`0/1/2/50/100`) | V1 lifecycle status | mapped; **unmapped values must FAIL LOUDLY, never default** | closure §8 · preflight §22.1 |
| `State == 5` | **excluded** | dropped as legacy; never introduced into the domain | closure §8 |
| `NazarModir` (`تایید` / `رد` / `نیاز به اصلاح`) | manager opinion enum | **verbatim — the Persian literals are preserved exactly** | M-5b |
| `Tarikh`, `TarikhDarkhast` | `requestDate` | verbatim | preflight §5.2 |
| `TarikhTaedModir`, `TarikhTaead` | `managerDecidedAt` | verbatim | M-5b |
| `Title` (calculated `'اقلام پروژه - ' + project`) | `title` | **carried as a stored value** — Ariya does **not** re-derive it (no Project name exists to derive from) | M-1 |
| SharePoint `ID` per row | `legacySharePointId` | **persisted**, so any row can be re-associated with its SharePoint origin | preflight §22.1 |
| SharePoint platform columns (`ContentType`, `FileRef`, `WorkflowOutcome`, …) | **not migrated** | recorded as evidence in the field-inventory mapping table only | preflight §5.1 |

### 11.1 The five migration rules this phase adds

1. **Never regenerate, normalise or renumber `CodeStandardDarSanat`.**
2. **Never coerce an unknown value** — empty or negative coefficients and unknown `State` values are
   **findings**, not defaults.
3. **Never discard a value because it is out of V1 scope** — raw columns for `Code_Ghatae` and the
   five deferred coefficients.
4. **Never invent a header for an orphan item** — an item whose `BomAddRelated` does not resolve is a
   data-quality finding.
5. **Never derive `Title`** from a Project name that no contract supplies.

---
## 12. ARCHITECTURAL CONSEQUENCES

### 12.1 Ownership map after this phase

```
Production   OWNS :  BOM (header + items) · BOM lifecycle · BOM approval state
                     · BOM code ALLOCATION MECHANISM (not the prefix value)
Production   REFERENCES (opaque, tenant-safe, read-only):
                     Project · Product Tree · User identity · Supplier · Purchase · future Quality
Production   OWNS NOTHING OF:  Project master · Product Tree master (or its code)
                     · Supplier master · Procurement lifecycle · Quality subsystem
```

### 12.2 The five boundaries this phase reinforced

| # | Boundary | Reinforced by |
| --- | --- | --- |
| 1 | **Production does not own Project** | M-1 — opaque reference only; `Title` stored rather than derived |
| 2 | **Production does not own Product Tree (or its code)** | RB-1 — reference only; the code source stays external and is **BLOCKED rather than faked** |
| 3 | **Production does not own Supplier** | untouched; suggested supplier / price remain informational BOM metadata (preflight §15) |
| 4 | **Procurement consumes BOM; it does not own BOM** | the five deferred coefficients are `NOT-IN-V1`, rather than a Procurement write-back Production would have to accept |
| 5 | **Quality stays an integration boundary** | `hasControlPlan` remains a two-value indicator; untouched here |

### 12.3 The four architectural consequences of these closures

1. **`Title` is a stored value** (M-1). A **deliberate divergence** from SharePoint, and the price of
   not owning Project. The alternative — deriving a BOM's own name from a module that does not
   exist — is strictly worse.
2. **The BOM Item carries an immutable code** (M-6d §6.4) and **renumbering is forbidden** (§6.5).
   This *narrows* legacy behaviour on purpose and shrinks preflight threat `T-11` (a Purchase
   consuming a stale BOM).
3. **The approver is a snapshot, not a resolution** (M-5b). Production therefore has **no dependency
   on an organisational hierarchy** and **no dependency on a workflow engine** — consistent with the
   "no third workflow engine" principle.
4. **The code counter is Ariya's existing pattern, not a new one** (M-6d §6.6). Production inherits
   CF-5's atomicity, its `CHECK counter >= 0`, and its "a rollback never burns a number" property
   **by adoption, not by invention**.

### 12.4 The ten principles preserved — all intact

| # | Principle | Status |
| --- | --- | --- |
| 1 | Project is not owned by Production | ✅ M-1 |
| 2 | Product Tree is not duplicated inside BOM | ✅ RB-1 (reference only; code source left external) |
| 3 | Supplier is not owned by Production | ✅ untouched |
| 4 | Procurement consumes BOM; it does not own BOM | ✅ M-7a (deferred fields `NOT-IN-V1`) |
| 5 | Quality is an integration boundary, later an independent module | ✅ untouched |
| 6 | Project Management can later be an independent module | ✅ M-1 (the id resolves against it with **no BOM change**) |
| 7 | BOM remains a Production-owned aggregate | ✅ all phases |
| 8 | Search and Audit reuse existing Platform contracts | ✅ `SEARCH_SOURCE_PORT` · `AUDIT_PORT` — **no new engine** |
| 9 | **No third workflow engine** | ✅ M-5b (transitions stay in Production's own state machine) |
| 10 | No SharePoint username/group rule becomes Ariya authorization | ✅ `LevelManager ∈ {1,2}` rejected as legacy; identity is RBAC + the stored `approverUserId` |

---
## 13. EXPLICIT BUSINESS DECISIONS

**The five closures this phase made that the business should formally ratify.** Each already has a
stated default in this document; ratification either confirms or replaces it.

| # | Ratification item | Default taken here | What changes if rejected |
| --- | --- | --- | --- |
| **B-1** | **`Title` is stored, not derived from a Project name** (M-1) | **stored** | rejecting it requires a Project read contract **before** the header can be written |
| **B-2** | **Self-approval is NOT permitted** (M-5b §5.6) | **not permitted** (fail-closed) | permitting it is a one-line opt-in, but it must be **explicit** |
| **B-3** | **Code immutability + renumbering forbidden + padding = 3 + refuse past 999** (M-6d) | immutable · forbidden · 3 · refuse | any change alters the text form of every published code — expensive after the fact |
| **B-4** | **Coefficient range `>= 0`, no maximum, no unit claim** (M-7a) | `>= 0` · none · none | a stricter or looser range is a validation change, not a schema change |
| **B-5** | **The five deferred coefficient fields stay out of V1** (M-7a) | `NOT-IN-V1`, preserved verbatim | keeping them requires a formula **and** a Procurement ownership decision |

**Also requiring an input (not a ratification — a missing datum):**

| # | Input needed | Why |
| --- | --- | --- |
| **I-1** | **The Product Tree code source** — an authoritative `ProductTree.code`, or a business acceptance that V1 does not mint `standardPartCode` | **RB-1-P** is the only technical blocker left; without it, code generation cannot start |

---

## 14. EXPLICIT DEFERRED ITEMS

Recorded so that none is mistaken for an omission.

| # | Deferred item | Reason | Owner of the future decision |
| --- | --- | --- | --- |
| **DF-1** | **A Project Management module** (and a Project read contract) | Project is an opaque reference in V1; nothing needs the master today | Platform / future module |
| **DF-2** | **A Product Tree module** (schema, hierarchy, code assignment) | only the **code source** is needed for V1; the tree itself is not | Platform / future module |
| **DF-3** | **`projectCodeSnapshot` / `productTreeCodeSnapshot` as authoritative values** | their values can only come from contracts that do not exist | Platform / future module |
| **DF-4** | **The BOM change-request capability** (`BomEdit`, `تغییر Bom`, `جزئیات تغییر Bom`) | a second capability, fully inventoried in the preflight (§5.4), not in V1 | Business |
| **DF-5** | **BOM versioning / effective dating** | the source has no version model; V1 is mutable-before-submit only | Business |
| **DF-6** | **A coefficient unit convention** (M-7a dimension 9) | the source declares no unit; V1 makes no claim | Business |
| **DF-7** | **The five deferred coefficient formulas** (fields 3–7) | no writer, no formula; the Purchase side was not supplied | Business + Procurement |
| **DF-8** | **Renumbering as an audited action** | forbidden in V1; if ever needed it must be explicit and audited | Business |
| **DF-9** | **Self-approval as an opt-in** | the default is refuse | Business |
| **DF-10** | **Any per-item lifecycle / item-level approval** | the source never writes the item's `state`; V1 models the **header** lifecycle only | Business |
| **DF-11** | **Procurement's consumption contract** (snapshot vs live, quantity derivation, which BOM state is consumable) | out of scope by instruction | Procurement + Production |
| **DF-12** | **Quality / control-plan evolution** | `hasControlPlan` stays a two-value indicator | Quality (future) |
| **DF-13** | **The SharePoint → ERP migration itself** | this is a read-only phase; the rules in §11 are its specification | Product |

---

## 15. NON-GOALS

This phase did **not**, and the next phase must not treat it as permission to:

1. **Create any schema, table, migration, database or counter table.**
2. **Create any route, controller, DTO, service or module registration.**
3. **Build any frontend screen, component or label file.**
4. **Create Project Management or Product Tree** — or a `Project` / `ProductTree` table anywhere.
5. **Invent a Product Tree code format, prefix, hierarchy or ownership** — RB-1-P is left BLOCKED.
6. **Implement a code generator** — only the *mechanism* was identified, by citing CF-5.
7. **Modify Procurement or Commerce** in any way.
8. **Create a third workflow engine**, or reuse Commerce's closed workflow subject model.
9. **Assume self-approval is allowed.**
10. **Adopt `total = drawing + spare`**, or convert any field name into a formula.
11. **Reinterpret, rename or delete `Code_Ghatae`** from the source model.
12. **Coerce any legacy value** into the V1 model instead of preserving it verbatim.
13. **Carry `State == 5`**, the `LevelManager` filter, or any SharePoint username/group into the
    Ariya domain or its authorization.
14. **Produce a second artifact.** This document is the only one.

---
## 16. FINAL IMPLEMENTATION GATE

| # | Area | Gate | Reason |
| --- | --- | --- | --- |
| 1 | **BOM HEADER** | **`READY-WITH-EXPLICIT-ASSUMPTION`** | M-1 + RB-1 close both references as opaque; `Title` stored; requester/approver/date/status/opinion all resolved (M-5b). **The assumption:** an unvalidated opaque reference is acceptable for V1 — recorded as deliberate and reversible |
| 2 | **BOM ITEM** | **`BLOCKED`** | `standardPartCode` is **required** by the source (V18) and its **prefix is unknown** (RB-1-P). **Per the brief's rule, the item is NOT marked READY while an item-level required field's semantics remain unresolved.** Everything else on the item *is* resolved: `Code_Ghatae` excluded (M-4), coefficients defined (M-7a), part attributes evidenced |
| 3 | **VALIDATION** | **`READY-WITH-EXPLICIT-ASSUMPTION`** | V1–V17 + V8 are pure field/existence checks, fully evidenced. **The assumption:** the uniqueness scope `(project, tree, code)` stands. V18/V19 cannot be *exercised* until code generation runs |
| 4 | **LIFECYCLE** | **`READY-WITH-EXPLICIT-DECISION`** | M-5 Option A fixes the states, the freeze point (`submit`) and the correction loop — all source-backed. Requires formal adoption of M-5 |
| 5 | **APPROVAL** | **`READY-WITH-EXPLICIT-DECISION`** | **M-5b fixes the approver rule** — no longer ambiguous: a snapshotted `approverUserId`, immutable after submit, tenant-validated, self-approval refused. Only ratification (§13 B-2) remains |
| 6 | **CODE GENERATION** | **`BLOCKED`** | **RB-1-P** — the prefix. Per the brief's rule, **Code Generation is NOT marked READY while the Product Tree prefix is unknown.** The other six sub-questions are closed (§6) |
| 7 | **CRUD** | **`BLOCKED`** | depends on BOM ITEM (2) and on LIFECYCLE's guards (4) |
| 8 | **AUDIT** | **`READY`** | `AUDIT_PORT.record` / `.read` exist; `CommerceAuditGateway` is a direct template (envelope from the actor, resource vocabulary, never-throw). Required for V1 |
| 9 | **SEARCH** | **`READY`** | `SEARCH_SOURCE_PORT` exists, with a documented `EXTERNAL` + `sourceKey` mechanism. Optional for V1 |
| 10 | **FRONTEND** | **`BLOCKED`** | cannot render an item model that is undecided or a code that cannot be minted |

**Summary: `READY` ×2 · `READY-WITH-EXPLICIT-ASSUMPTION/DECISION` ×4 · `BLOCKED` ×4.**

**The four blocked areas reduce to ONE technical blocker (`RB-1-P`) plus CRUD and FRONTEND, which are
downstream of the BOM Item.**

---
## 17. FINAL RECOMMENDATION

### 17.1 The five answers

| ID | Result |
| --- | --- |
| **RB-1** | **`B`** — an external reference contract **is** definable without implementing Product Tree: an opaque, tenant-safe, read-only `productTreeRef`. **`RESOLVED-BY-EXISTING-CONTRACT`**. Its sub-item **`RB-1-P` (the tree-derived code source) remains `BLOCKED`** — **code generation MUST stay blocked; the prefix must not be faked.** |
| **M-4** | **Option A** — the column persists for compatibility / migration, **excluded** from the V1 domain model and business logic. `BUSINESS-DECISION-CLOSED`. Raw-value preservation documented (§4.4). |
| **M-5b** | **Option A** — the requester-selected manager is the authoritative approver, **snapshotted at submission**, immutable after submit, tenant-member validated, **self-approval NOT permitted**; approve / reject / correction remain Production transitions. `BUSINESS-DECISION-CLOSED`. |
| **M-6d** | **6 of 7 sub-questions closed** — scope `(tenant, project, tree)`, start 1 / step 1 / pad 3, **immutable**, **renumber forbidden**, **CF-5 counter**, **no burn on rollback**, capacity-guarded. **The prefix is `BLOCKED` (RB-1-P).** Overall `BLOCKED`. |
| **M-7a** | Fields 1–2 = **INTEGER, scale 0, required, `>= 0`, no max, no unit claim, no formula**. Fields 3–7 = **`NOT-IN-V1`**, preserved verbatim. **No formula was inferred; `total = drawing + spare` was NOT adopted.** `BUSINESS-DECISION-CLOSED`. |

### 17.2 The recommendation

> **One input and five ratifications, then implementation can start.**
>
> **The single input (`I-1`):** an authoritative **Product Tree code source** — or an explicit
> business acceptance that V1 does not mint `standardPartCode`. It is the only technical blocker
> left, and it gates `standardPartCode`, the BOM Item, code generation, CRUD and the frontend.
>
> **The five ratifications (§13):** `Title` stored · self-approval refused · code immutability /
> no-renumber / pad-3 / refuse-past-999 · coefficient range `>= 0` with no unit claim · the five
> deferred coefficient fields stay `NOT-IN-V1`.
>
> **Implementation order, once those land:**
> `persistence` → `validation` → `lifecycle` → **`item model`** → `approval` → `code generation` →
> `CRUD` → `audit` → `frontend` → optional `search`.
>
> **The BOM Header and the lifecycle/approval surface do not wait for `I-1`** — they are ready today
> under the stated assumption.

### 17.3 Why this is the right stopping point

- **Nothing was invented.** Every closure either cites an existing Ariya contract (RB-1's reference
  pattern, M-6d's counter, M-6d's formatter) or a source fact (M-4's counts, M-5b's frozen controls,
  M-7a's `Decimals="0"`). Where the evidence ran out, the item is `BLOCKED` or awaits ratification —
  **never guessed**.
- **The one remaining blocker is real, not bureaucratic.** The tree's code format determines the text
  of every part code ever printed or quoted. Guessing it is **unrecoverable**.
- **The brief's instructions are honoured literally:** *"If Product Tree code itself remains
  undefined: the exact prefix remains BLOCKED"*, and *"must clearly separate 'sequence mechanism is
  technically known' from 'business code policy is approved'"* — §6.6/§6.7 state the former, §13
  **B-3** states the latter.

### 17.4 Readiness, restated

```
PRODUCTION → BOM :  STILL NOT READY FOR FULL IMPLEMENTATION
                    (blocked areas 4 → 4, but they now reduce to ONE blocker)

READY                                    2 : Audit · Search
READY-WITH-EXPLICIT-ASSUMPTION/DECISION  4 : BOM Header · Validation · Lifecycle · Approval
BLOCKED                                  4 : BOM Item · Code generation · CRUD · Frontend

  ▸ BOM Header is implementable TODAY (under the M-1 / RB-1 assumption)
  ▸ Approval is NO LONGER AMBIGUOUS (M-5b)
  ▸ The remaining blocker is exactly ONE: RB-1-P — the Product Tree code source

NEXT PHASE: collect I-1, ratify §13's five items, then implement.
            No further decision phase is required or warranted.
```

---
## APPENDIX A — SOURCE FACTS

Facts read verbatim from the eight supplied SharePoint files, restricted to those this phase relies on.

| ID | Source fact | Where |
| --- | --- | --- |
| SF-1 | `Code_Ghatae`: **0** writes · **0** criteria · **0** labels · **0** `Value_ListQueryField` bindings · **8** read-projections across 5 files | all 8 files |
| SF-2 | «کد قطعه» binds `GhataeDarkhastiKharid_x003a__x061`, **not** `Code_Ghatae`; the neighbouring family is «کد نقشه قطعه», «کد نقشه مونتاژی مرتبط با قطعه», «نام قطعه در صنعت» | `kharid.txt` |
| SF-3 | The requester (`c_DarkhastKonandeh`), the approver (`c_ModirTaeedKonandeh`) and the resolved account (`c_TaeedKonandeh`) are **all frozen**: `IsEnabledOnEdit="False"` (plus `IsEnabled="False"` + hidden for the third) | `BomAdd.txt` |
| SF-4 | The approver picker is filtered by `Lookup_Criteria="LevelManager;1;Equals;Text;OR;No;;\|LevelManager;2;Equals;Text;OR;No;;"` | `BomAdd.txt` |
| SF-5 | Submission resolves `PersonUser` and refuses when empty: «یوزر مدیر پروژه در سامانه ست نشده است» | `BomAdd.txt` |
| SF-6 | `State` observed `0, 1, 2, 50, 100`; only `0` and `1` are ever written; `State == 5` appears once, unreachable | `BomAdd.txt`, `Kartable Bomadd.txt` |
| SF-7 | The approval task writes **no `State`** on approve / reject — only `NazarModir`, `Tozihat`, `TarikhTaedModir`, `WorkflowOutcome`, `Status`; **only** `نیاز به اصلاح` writes `item.State = 0` | `Kartable Bomadd.txt` |
| SF-8 | **Three** code generators disagree: max-excluding-author (`BomAdd`), last-in-list (`Kartable Bomadd`), positional (`c_Control41`) | `BomAdd.txt`, `Kartable Bomadd.txt` |
| SF-9 | **Zero** locking / transaction / retry / race tokens; the save is wrapped in `setTimeout(…, 1300)` around an async uniqueness query | `BomAdd.txt`, `Kartable Bomadd.txt` |
| SF-10 | `Title` is **calculated**: `CalculationFormula="'اقلام پروژه - ' + project"`, `IsCalculated="True"` | `BomAdd.txt` |
| SF-11 | **`Decimals = 0`** on every `NumberTextBox` in all five files that have any; **`Step = 1`** throughout | `BomEdit`, `kharid`, `kartabl karid`, `kartabl SoderCheck`, `sooderCheck` |
| SF-12 | **0** `NumberOfDecimals` / `DecimalPlaces` / `MaxValue` / `MinValue` / `Maximum` / `Minimum` / `Precision` / `FormatString` attributes in any of the 8 files | all 8 files |
| SF-13 | The strictly-positive intent (`باید بیشتر از 0 باشد`, `باید عدد باشد`) sits **inside a `/* … */` block** — disabled | `BomEdit.txt` |
| SF-14 | The only active range check is `total < 0`, and its `error = true` is **commented out** — it warns, never refuses | `BomEdit.txt` |
| SF-15 | The two stored coefficients are plain **`TextBox`** controls, not `NumberTextBox` | `BomAdd.txt` |
| SF-16 | **NO** self-approval token (`self`, an equality check, «تایید خود») exists in any file | all 8 files |
| SF-17 | Fields 3–7 (`KoleGhatae`, `DarHalSef`, `DarHalS`, `Kharidsho`, `KharidS`) have **no writer**; they appear only in `Attributes=` projections | all 8 files |
| SF-18 | The project and product-tree references are lookup **ids** (`Lookup_ValueFieldName="ID"`) | `BomAdd.txt`, `kharid.txt` |
| SF-19 | The tree's `code` is read back into `ProductTreeRef_x003A_code` and **used as the code prefix** | `BomAdd.txt` |
| SF-20 | The tree-picker popup is `SitePages/Test_WP.aspx?ProdID=<project>` — **its source was never supplied** | `BomAdd`, `BomEdit`, `Kartable Bomadd` |

---
## APPENDIX B — REPOSITORY CONTRACT FACTS

| ID | Contract fact | Where |
| --- | --- | --- |
| CF-1 | *"There is **NO cross-database foreign key** … are **PLAIN STRING columns holding opaque values**"* · *"does NOT duplicate authoritative state"* · *"an opaque reference, not a second personnel table"* | `prisma/commerce/schema.prisma` header |
| CF-2 | `WorkflowInstance.subjectId` — *"**OPAQUE, like every external reference in this schema**"*; `WorkflowSubjectType` is a **closed** enum `{PURCHASE_DOCUMENT, PURCHASE_LINE}` | `prisma/commerce/schema.prisma` |
| CF-3 | **DC-CORR-01** — *"identity columns are plain Strings, and there is no cross-database foreign key"*; `correspondence-isolation.spec.ts`: *"declares **NO identity model** and **NO relation into identity**"* | contract + spec |
| CF-4 | **ADR-0006 A4**; HR e2e: *"**EVERY** foreign key declared in `hr_db` points at another table of `hr_db`"*; *"**No cross-database foreign keys, ever.**"* | ADR + e2e |
| CF-5 | `PurchaseDocumentCounter` — allocation is ONE `INSERT … ON CONFLICT … DO UPDATE SET counter = counter + 1 RETURNING counter` **inside the creating transaction**; *"a create that rolls back **never burns one**"*; CHECK `counter >= 0`; *"**Nothing reads `counter` to build a number outside that statement**"* | Commerce schema · `purchase.repository.ts` |
| CF-6 | *"a prefix, a per-unit or per-category series and a format are **the formatter's business**"* · *"The counter TABLE **is not created** … The first step that mints numbers brings the counter, its CHECK and its concurrency spec together."* | Commerce + HR schemas |
| CF-7 | Snapshots alongside opaque references are an established pattern (`conditionInputSnapshot`, per-row `currency`, `SearchDocument.tenantId`) | all schemas |
| CF-8 | The repository's numbering **formatter** pattern: `PURCHASE_DOCUMENT_NUMBER_PREFIX` (a total map) · `PURCHASE_DOCUMENT_NUMBER_WIDTH = 5` · `formatPurchaseDocumentNumber()` **refuses `sequence < 1`** because *"a counter … starts at 1"* | `purchase-number.ts` |
| CF-9 | **0** platform workflow hits (`src/platform/**`); no platform Workflow / approval port exists | platform tree |
| CF-10 | `USER_DIRECTORY.DirectoryUserProfile` exposes `id` + `jobTitle` only — **no manager edge**; HR's `EmploymentRecord.managerEmployeeId` exists but is **not** exposed | port + HR schema |
| CF-11 | HR has **0** `level` / `rank` / `grade` hierarchy fields → the legacy `LevelManager` filter has no Ariya equivalent | HR schema |
| CF-12 | ADR-0005 (APPROVED): a new independent module owns its own Prisma schema; 6 precedents; `architecture-boundaries.spec.ts` enforces it | ADR + tests |
| CF-13 | `AUDIT_PORT` (record + read) and `SEARCH_SOURCE_PORT` exist, with `CommerceAuditGateway` as the template | platform ports |
| CF-14 | **0** `ProductTree` in any `.ts/.tsx/.prisma/.sql/.json` outside these documents; **0** of 123 `CREATE TABLE`s | whole repository |

---

## APPENDIX C — DECISIONS

| ID | Status | One-line decision |
| --- | --- | --- |
| **RB-1** | `RESOLVED-BY-EXISTING-CONTRACT` | `productTreeRef` = opaque, tenant-safe, read-only; Production does not own the tree |
| **RB-1-P** | `BLOCKED` | the tree-derived **code prefix** stays blocked; **code generation must not start** |
| **M-4** | `BUSINESS-DECISION-CLOSED` | `Code_Ghatae` persists, is excluded from the V1 domain, preserved verbatim at migration |
| **M-5b** | `BUSINESS-DECISION-CLOSED` | snapshotted approver, immutable after submit, tenant-validated, self-approval refused |
| **M-6d** | `BLOCKED` (prefix) | scope / sequence / immutability / renumber / concurrency / rollback **closed**; prefix blocked |
| **M-7a** | `BUSINESS-DECISION-CLOSED` + `NOT-IN-V1` | fields 1–2 = INTEGER `>= 0` inputs, no formula; fields 3–7 out of V1, preserved |
| **B-1 … B-5** | awaiting ratification | `Title` stored · self-approval refused · code policy · coefficient range · five fields out of V1 |
| **I-1** | awaiting input | the Product Tree code source |

---
## APPENDIX D — CHECKS PERFORMED

| # | Check | Result |
| --- | --- | --- |
| 1 | `ProductTree` / `productTree` / `product_tree` / `product-tree` across all `.ts/.tsx/.prisma/.sql/.json/.md`, excluding `node_modules`, `.next`, `dist`, `coverage` and mirrors | **56 hits, 100% inside these three documents** — **zero** in code or schema |
| 2 | `treeCode` / `tree_code` / `productCode` / `productStructure` / `productHierarchy` / `treeNode` / `tree_node` | **27 hits** → HR's `OrganizationTreeNode` + a UI `TreeNode`. **No product semantics** |
| 3 | `Test_WP` (the tree-picker page) | **0** references outside these documents |
| 4 | All 6 Prisma schemas + all **123** `CREATE TABLE`s re-checked | **0** product-tree / part / bom / project objects |
| 5 | `Code_Ghatae` counted by category across all 8 files | writes **0** · criteria **0** · bound labels **0** · `Value_ListQueryField` **0** · attribute projections **8** (`BomAdd`, `BomEdit`, `kartabl karid`, `Kartable Bomadd`, `kharid`) |
| 6 | Approver / requester control flags for `c_DarkhastKonandeh`, `c_ModirTaeedKonandeh`, `c_TaeedKonandeh` | **all three frozen** (`IsEnabledOnEdit="False"`; the third also `IsEnabled="False"` + hidden) |
| 7 | Self-approval token sweep (`self`, an equality check, «تایید خود») | **0** matches → default fail-closed per the brief |
| 8 | `src/platform/**` searched for `Workflow` | **0 hits** → M-5b Option C refuted |
| 9 | `USER_DIRECTORY` profile fields + HR `manager` / `level` / `rank` / `grade` | `jobTitle` only · **0** level fields → M-5b Option B refuted |
| 10 | Counter / sequence precedent across all schemas | **CF-5** full contract; **CF-8** the formatter pattern |
| 11 | `purchase.repository.ts` allocation statement read verbatim | the exact `INSERT … ON CONFLICT … RETURNING` production runs |
| 12 | `purchase-number.ts` read in full | total prefix map · width 5 · refuses `sequence < 1` |
| 13 | `Decimals` / `Step` values across all 8 files | **`Decimals = 0`** and **`Step = 1`** everywhere |
| 14 | Precision / min / max attribute sweep | **0** matches in all 8 files |
| 15 | The disabled `> 0` block + the `total < 0` guard with `//error = true` | confirmed verbatim in `BomEdit.txt` |
| 16 | Coefficient control types | the stored coefficients are plain `TextBox`; the delta is `NumberTextBox` |
| 17 | `git status --short` before and after | **identical** except this document |
| 18 | `git log --oneline -1` | HEAD `840226b` — unchanged, **no commit** |

---

## APPENDIX E — FILES INSPECTED

**Source material (outside the repository, read-only):**
`E:\Very Mohem\BomAdd.txt` · `BomEdit.txt` · `Kartable Bomadd.txt` · `kartable bomEdit.txt` ·
`kharid.txt` · `kartabl karid.txt` · `sooderCheck.txt` · `kartabl SoderCheck.txt`

**Repository (read-only):**
`apps/api/prisma/{core,cms,observability,correspondence,hr,commerce}/schema.prisma` · every
`migration.sql` across the six databases ·
`apps/api/src/modules/commerce/purchase/purchase-number.ts` ·
`apps/api/src/modules/commerce/purchase/purchase.repository.ts` · the commerce audit + notification
gateways · `apps/api/src/platform/{audit,entitlement,search-source,user-directory}/**` ·
`apps/api/src/runtime-datasources.ts` · `architecture-boundaries.spec.ts` ·
`runtime-policy.projection.ts` · `apps/api/src/config/env.validation.ts` ·
`apps/api/src/preferences/nav-catalogue.ts` ·
`apps/api/src/modules/hr/organization/organization.service.ts` · `packages/config/src/index.ts` ·
`docs/ADR/ADR-0005-…` · `docs/ADR/ADR-0006-…` · the three preceding Production-BOM documents.

---

## FILES CHANGED BY THIS PHASE

**Created (the only new artifact):**

- `docs/PHASE-PRODUCTION-BOM-FINAL-DECISION-CLOSURE.md` — this document.

**Modified:** **none.** No file under `apps/api/**`, `apps/web/**`, `packages/**`,
`infrastructure/**`, any Prisma schema, any migration, or any Commerce / HR / Core / frontend / test
file was touched. No route, permission, schema, counter table or module registration was added.
**No scratch artifact was created or left behind.**

---

**END OF DOCUMENT —** `FINAL DECISION CLOSURE COMPLETE — NO IMPLEMENTATION PERFORMED`
