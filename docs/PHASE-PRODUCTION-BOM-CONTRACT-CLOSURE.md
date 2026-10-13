# PHASE PRODUCTION-BOM — CONTRACT CLOSURE

**Status:** `CONTRACT CLOSURE ONLY — NO IMPLEMENTATION. No schema, no migration, no route, no
frontend, no Project domain, no Product Tree domain, no workflow engine, no Purchase coupling.`

**Module:** Production / «تولید»  **Capability:** BOM / «فهرست مواد و قطعات»
**Authoritative preflight:** `docs/PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md`

**Classification tags:** `[CONFIRMED]` (read directly in source or an approved ADR/schema),
`[DERIVED]`, `[OPEN]`, `[DECISION REQUIRED]`.
**Status vocabulary (§13):** `RESOLVED` · `RESOLVED-BY-EXISTING-CONTRACT` ·
`REQUIRES-BUSINESS-DECISION` · `BLOCKED-BY-MISSING-CONTRACT` · `LEGACY-NOT-REQUIRED` · `DEFERRED`.
**Readiness vocabulary (§14):** `READY` · `READY-WITH-EXPLICIT-ASSUMPTION` · `BLOCKED`.

**Git baseline:** HEAD `840226b8a00e960098e7e868740adbc64710d6d7`, branch `master`. No commit,
reset, clean, checkout or revert was performed.

**THE ONLY NEW ARTIFACT OF THIS PHASE IS THIS DOCUMENT.** Nothing under `apps/api/**`,
`apps/web/**`, `packages/**`, `infrastructure/**` or any schema/migration was touched.

---

## 1. SCOPE

This phase takes the ten blockers the preflight left open and **separates them into four
dispositions** (the goal statement):

| Disposition | Meaning |
| --- | --- |
| **A.** Resolvable from existing repository contracts | an approved ADR, schema, platform port or enforced architecture test already answers it |
| **B.** Resolvable from supplied authoritative source material | the eight SharePoint form files answer it |
| **C.** Requires an explicit product/business decision | neither evidence base answers it; only Ariya can |
| **D.** Must remain blocked until another module/domain exists | the contract it depends on does not exist |

**Closure is not the objective — correct closure is.** Where the evidence does not reach, this
document records `BLOCKED-BY-MISSING-CONTRACT` rather than promoting a blocker to `RESOLVED` so
that implementation may start. Three blockers are resolved by evidence, four require a business
decision, and three stay blocked.

### 1.1 What this phase re-inspected

- **Every Prisma schema and every migration** in the repository (six databases, **123 `CREATE
  TABLE` statements**, plus the generated mirrors).
- The whole API, web and shared-package source tree for `project` / `Project` / `ProjectTree` /
  `ProductTree` / `part` / `material` / `supplier` / `tree` concepts.
- `runtime-datasources.ts`, `runtime-policy.projection.ts`, `architecture-boundaries.spec.ts`,
  `env.validation.ts`, `package.json` scripts, the initdb SQL and ADR-0005 / ADR-0006.
- `nav-catalogue.ts`, the module registry seeds and the module-list UI.
- All eight supplied SharePoint files, re-parsed for workflow artefacts, every `StateNext` write,
  every `State == 5` occurrence, every `CodeStandardDarSanat` / `Code_Ghatae` write, criterion and
  label, and every approver-related field and lookup criterion.

---

## 2. PREVIOUS PREFLIGHT BLOCKERS

The preflight's §25/§26 handed this phase ten open items, restated verbatim as the work list:

| # | Blocker | Preflight classification |
| --- | --- | --- |
| 1 | Project contract | `BLOCKED` (G-3) |
| 2 | Product Tree contract | `BLOCKED` (G-4) |
| 3 | SharePoint workflow definition | `OPEN` — "not supplied" (§11.4, §22.3) |
| 4 | **D-1** — meaning/ownership of `CodeStandardDarSanat` | `DECISION REQUIRED` (§13.5, §26) |
| 5 | **D-2** — `Code_Ghatae` vs `CodeStandardDarSanat` | `OPEN` (§5.3, §26 D-2) |
| 6 | **D-3** — `State == 5` | `OPEN` (§11.4, §26 D-3) |
| 7 | **D-4** — V1 approver semantics | `OPEN` (§26 D-4) |
| 8 | **D-5** — Production persistence boundary | `DECISION REQUIRED` (§25 G-17, §26 D-5) |
| 9 | **D-7** — code-generation algorithm | `DECISION REQUIRED` (§13.4, §26 D-7) |
| 10 | **D-8** — total consumption coefficient | `OPEN` (§14.2, §26 D-8) |

Two more open items were tracked by the preflight and are closed here where the evidence allows:
`D-6` (code immutability — folded into D-1's decision) and `D-15` (the renumber tool — unchanged).

**Closure outcome: 3 resolved, 4 require a business decision, 3 remain blocked.**

---

## 3. PROJECT CONTRACT RESULT

**STATUS: `BLOCKED-BY-MISSING-PLATFORM-DOMAIN` (Disposition D).**

### 3.1 The search, exhaustively `[CONFIRMED — zero results]`

| Where | Search | Result |
| --- | --- | --- |
| All 6 Prisma schemas + generated mirrors | `model <X>Project` / `model Project` | **0** |
| **All 123 `CREATE TABLE` statements** in every migration of every database | `CREATE TABLE … Project` | **0** |
| All 6 schemas, case-insensitive `project` | every hit inspected | 56 hits, **100% false positives**: the phrase "Prisma project" in comments, and the word "projection" (`CommercialProjectionPolicy`, read-time projection, search projection) |
| `apps/api/src`, `apps/web/src`, `packages`, case-sensitive `\bprojects?\b` | every hit inspected | 173 hits, **100% false positives**: `project()` DTO-projection helper methods plus "Prisma project" comments |
| `nav-catalogue.ts` — every `/admin/*` href | route ownership | 32 hrefs, **no project route** |
| `apps/web/src/app/admin/**` | route directory | no `projects/` folder |
| `ModuleRegistration` seeds | registered module ids | only `hr` and `commerce` membership seeds exist |
| All repository `docs/**` | project-domain wording | the only substantive hits are in the preflight this phase closes; **no ADR, contract or spec defines a Project** |
| `lovable/src` (the second application) | `productTree` / `BOM` | **0** |

### 3.2 The one look-alike, and why it is not a contract `[CONFIRMED]`

`packages/config/src/index.ts` line 25 contains `'Project Management'` inside:

```ts
export const FEATURES = ['Accounting & Finance', 'Inventory Management', 'Sales & CRM',
  'Supply Chain', 'Human Resources', 'Manufacturing', 'Project Management', 'BI & Analytics'];
```

This is a **marketing feature list** consumed by `(marketing)/*` pages and by `CoreModulesList`
tests. It declares no model, no route, no permission and no module. It is **not** a Project
contract, and reading it as one would be exactly the inference this phase forbids.

### 3.3 What the SharePoint source does know about a project `[CONFIRMED]`

The legacy solution references a separate list `لیست پروژه ها` (`{BD9B53B8-AA77-4300-B367-4F02B30AD55C}`)
with three observed fields — `Title`, `ProjectCode`, `ProjectState` — consumed as:

| Consumer | Field | Observed use |
| --- | --- | --- |
| BOM header | `NameProje` | required lookup; on change, `ProjectCode` → `c_Cod`, `ProjectState` → `c_Vazeyat` |
| BOM header | `NameProje_x003A_ProjectCode` | snapshot («کد پروژه») |
| BOM item | `NameProje_MortabetBaBOM` | denormalised; **the scope of both duplicate rules** |
| Purchase | `NameProjeKala` | hidden when `NoeDarkhastKala = 'غیر پروژه ای'` |
| BOM header | (derived) | **`Title` is calculated as `'اقلام پروژه - ' + project name`** — see §16 M-1 |

### 3.4 Classification

**`BLOCKED-BY-MISSING-PLATFORM-DOMAIN`.** There is no owner, no identifier contract, no tenant
behaviour, no read contract, no authorization and no lifecycle to report, because the domain does
not exist.

**Production MUST NOT create Project inside Production** (§17). The dependency stays explicitly
blocked, with the V1 consequence carried forward: `projectRef` is an **opaque, unvalidated**
reference, and a BOM's `Title` cannot be derived without the project *name* (§18, §19).

---


## 4. PRODUCT TREE CONTRACT RESULT

**STATUS: `BLOCKED-BY-MISSING-PLATFORM-DOMAIN` (Disposition D).**

### 4.1 The search `[CONFIRMED — zero results]`

| Where | Search | Result |
| --- | --- | --- |
| All Prisma schemas + all 123 `CREATE TABLE`s | `ProductTree` / `tree` / `product_structure` / `tree_node` / `parent-child` | **0** product-tree objects |
| Whole source tree | `ProductTree`, `product-tree`, `product_tree` | only the preflight document itself |
| Whole source tree | `productStructure`, `treeNode`, `parentChild` | **HR's organization tree** (`OrganizationTreeNode`) and the web `TreeNode` UI component — an organisational hierarchy, not a product structure |
| `lovable/src` | `ProductTree` / `BOM` | **0** |
| Route / nav / module registry | product tree | **0** |

There is **no product structure, no tree node, no tree code and no product-code generator**
anywhere in the repository.

### 4.2 Does the tree's code participate in `CodeStandardDarSanat` generation? `[CONFIRMED — but only inside SharePoint]`

The participation is **real and fully traceable inside the source — and it exists nowhere else:**

1. The tree's `code` is read from the `ProductTree` list by a `ValueChangeScript`
   (`e.ListItems[0].code → c_ProductTreeRef_Code`).
2. `btn_Save` then uses it as the **prefix**:

   ```js
   var c = form.GetControl("c_ProductTreeRef_Code").GetValue();  // base = tree code
   code = c + "-" + lastPart;                                    // e.g. TREECODE-001
   form.GetControl("c_code_part").SetValue(code);
   ```

3. The bulk renumber tool (`c_Control41`) repeats the same from `c_nametree`:
   `var final = code + "-" + num;  item.CodeStandardDarSanat = final;`

**Answering the brief's three options:**

- **Explicitly documented?** **No.** No document, comment or ADR in the repository states this rule.
- **Implemented elsewhere?** **No.** The only two copies are the two *disagreeing* SharePoint
  fragments (§11); there is no second implementation anywhere in Ariya.
- **Only inferred from SharePoint?** **Yes** — inferred from form script that *consumes* a code read
  from a list whose own source was **not supplied**.

And one level deeper: the tree is chosen through a **popup to `SitePages/Test_WP.aspx?ProdID=<project>`**
— a separate SharePoint page **whose source was not provided**. What the tree actually *is* (a flat
catalogue? a hierarchy? how `code` is structured or assigned?) is therefore **unknown**.

### 4.3 Classification

**`BLOCKED-BY-MISSING-PLATFORM-DOMAIN`, and the code-generation dependency stays BLOCKED.**

Building a speculative Product Tree inside BOM purely to unblock code generation is forbidden by the
brief and by §14: it would make Production the accidental owner of a domain whose identity, tenancy,
hierarchy and code semantics are all unknown. The dependency stays blocked.

---


## 5. WORKFLOW CONTRACT RESULT

**STATUS: `WORKFLOW-CONTRACT-MISSING`.**

### 5.1 Search for a workflow definition — all eight files `[CONFIRMED — zero results]`

| Pattern | Occurrences across all 8 supplied files |
| --- | --- |
| `WorkflowDefinition`, `StateMachine`, `transitions`, `Transition`, `ApprovalWorkflow`, `workflow.xml`, `XomlWorkflow`, `SetState`, `SetWorkflowVariable` | **0** |
| `CreateWorkflow`, `StartWorkflow`, `WorkflowAssociation`, `WorkflowTemplate`, `.xoml`, `.wsp`, `EventReceiver`, `SPWorkflow` | **0** |
| `StateNext` | 15 (form fields and writes) |
| `NazarModir` | 111 (fields, filters, guards) |

No workflow definition, transition table, condition set, actor configuration or persistence contract
exists in the supplied material — nor anywhere in the repository (§3.1, §4.1).

### 5.2 What the source *does* show about states — traced, not recreated `[CONFIRMED]`

| Where | What it writes |
| --- | --- |
| `BomAdd` → `c_Control2` («تایید و انتقال به مرحله بعد», enabled only when `State == 0`) | requires ≥1 item; resolves the selected manager's `PersonUser`; then `TaeedKonandeh = teedPerson`, **`StateNext = 2`, `State = 1`**, `SaveAndExit()` |
| `Kartable Bomadd` → `btn_true`, `EnabledFormula = cr_State == "2"` | `st == 0` → `item.StateNext = 2` (if the grid is non-empty); `st == 2` → requires an opinion, then writes `NazarModir`, `Tozihat`, `TarikhTaedModir`; **only the `نیاز به اصلاح` branch writes a state: `item.State = 0`** |
| `Kartable Bomadd` → completion | `c_WorkflowOutcome = "Rejected"`, `c_Status = "Completed"`, `SaveAndExit()` — **SharePoint task-completion fields** |

**The decisive gap:** for `تایید` and `رد` the approval task writes **no `State` value at all** — it
records the opinion and completes the *task*. The engine that consumed `StateNext = 2` and produced
`State = 100` / `State = 50` (and `State = 2` in the first place) is **the SharePoint approval
workflow, outside every supplied file.**

Corroborating that this vocabulary is shared legacy rather than BOM-specific: `sooderCheck.txt` runs a
**sequential multi-stage chain** with `item.StateNext = st + 1` over states `1..7` plus `50` for
rejection — i.e. `State` is a *stage ordinal* field reused across BOM, Purchase and Cheque forms.

### 5.3 Actors, permissions, conditions `[CONFIRMED]`

- **Actors:** the requester (auto-filled from the current user's `PersonUser`) and one
  requester-selected manager. Nothing else.
- **Authorization:** the approval task form contains **no gate at all** — no `UserInGroup`, no role
  check; its only authorization-related token is a localization string (`Form_ManagePermissions`).
  In the source, approval authorization came **entirely from SharePoint's task assignment** to
  `TaeedKonandeh` — precisely the mechanism that was not supplied.
- **Transition conditions:** only the two observable ones — "≥1 item at submit", "opinion present at
  the manager step".
- **Persistence expectations:** `State` / `StateNext` / `NazarModir` / `Tozihat` /
  `TarikhTaedModir` on the header, plus the workflow-task fields `WorkflowOutcome` / `Status` /
  `WorkflowItemId` on the task.

### 5.4 Classification

**`WORKFLOW-CONTRACT-MISSING`.** Per the brief: **do not recreate the workflow from UI behaviour
alone.** The observable fields and the two observable conditions are recorded above as *source
facts*; the transition ownership (`1 → 2`, `2 → {100, 50}`) is **not** reproducible from them and
therefore stays an open business decision (§16, **D-4b**), not a derived design.

---


## 6. D-1 RESOLUTION — `CodeStandardDarSanat`

**STATUS: `RESOLVED` (Disposition B — from supplied source material).** Its *enforcement* remains
upstream-blocked (§15, B-1).

### 6.1 Every usage traced `[CONFIRMED]`

| Dimension | Finding | Evidence |
| --- | --- | --- |
| **Write sites** | **5** — `BomAdd.txt` ×3, `Kartable Bomadd.txt` ×2 | `listitem.CodeStandardDarSanat = codeStandardDarSanat`; `item.CodeStandardDarSanat = final` (bulk renumber) |
| **Query criteria** | **2, both in `BomAdd`** — one `Contains` search, one `Equals` uniqueness | §6.2 |
| **Used by Purchase for filtering?** | **No.** `kharid.txt` / `kartabl karid.txt` carry it only in `Attributes=` read-projections | zero Purchase criteria reference it |
| **Label** | **«کد استاندارد قطعه»** (`BomAdd` ×3, `Kartable Bomadd` ×1) **and «کد استاندارد قطعه در صنعت»** (`BomEdit`, `Kartable Bomadd`, `kharid`) | label drift across forms — both recorded, neither invented |
| **Editable in the UI?** | **No.** `c_code_part` carries `IsEnabled="False"` **and** `IsEnabledOnEdit="False"` | the control is read-only |
| **Generated?** | **Yes — three generators**: `btn_Save`, the approval task's `btn_Save`, the bulk renumber tool | all produce `<tree code>-<zero-padded sequence>` |
| **Product-tree relationship** | the prefix is `ProductTreeRef_x003A_code` | §4.2 |

### 6.2 The uniqueness scope, exactly `[CONFIRMED]`

`ListQuery3` — the only uniqueness query:

```
NameProje_MortabetBaBOM = {project}   AND
JazeDerakhteMahsol       = {tree}     AND
CodeStandardDarSanat     = {candidate}     (Equals, Text)
```

`ListQuery2` — the generation input, **not** a uniqueness verdict:

```
NameProje = {project} AND JazeDerakhteMahsol = {tree} AND Author != {me}
MaxRows = 1, SortField = CodeStandardDarSanat, SortAsc = False
```

### 6.3 Answers to the seven questions, evidence only

| Question | Answer |
| --- | --- |
| **What entity does it identify?** | **A BOM item row within one (project, product-tree) pair.** Each item carries its own distinct value, generated as the next sequence number for that pair — it does **not** identify a shared entity reused across rows. |
| **Is it globally unique?** | **No — and never checked.** No query compares it without the project and tree predicates; two different trees may legitimately produce identical suffixes. |
| **Tenant-unique?** | **Not enforced.** `tenantId` appears in **no** criterion of either query. |
| **Project-unique?** | Not project alone — the predicate always includes the product tree. |
| **Product-tree-unique?** | **Yes, within a project: the enforced scope is `(project, product tree, code)`.** |
| **Human-assigned or generated?** | **Generated.** The control is read-only and three separate sites compute the value; a user cannot type one. |
| **Procurement / engineering / standard / other?** | The label says **«کد استاندارد قطعه در صنعت» — a "standard part code (in the industry)"**. It is **not** a procurement code (Purchase never filters on it). Mechanically it is a **per-(project, tree) sequence reference for a BOM line**. |

### 6.4 What D-1 does *not* settle

1. **Whether "standard" implies a cross-project / cross-tenant standard registry.** The source never
   checks beyond `(project, tree)`; nothing proves a wider registry exists.
2. **Immutability** (the preflight's D-6): the source overwrites codes in the bulk renumber tool and
   the approval-task save path, so "immutable once assigned" is **not** a rule the source holds →
   **`REQUIRES-BUSINESS-DECISION`**, carried to §16 as **D-1a**.
3. **Creating a database unique constraint** stays blocked upstream, because its scope predicates are
   two references to domains that do not exist (§15, B-1/B-2).

**D-1 is therefore RESOLVED for *meaning*, with D-1a (immutability) and the constraint left open.**

---


## 7. D-2 RESOLUTION — `Code_Ghatae` vs `CodeStandardDarSanat`

**STATUS: `BLOCKED-BY-MISSING-CONTRACT`.**

### 7.1 Every usage of `Code_Ghatae` traced `[CONFIRMED]`

| Dimension | Finding |
| --- | --- |
| **Write sites** | **0** — across all eight files |
| **Query criteria** | **0** — never filtered, never searched |
| **Generated values** | **0** |
| **Labels bound to it** | **0** |
| **Read projections** | **8 occurrences across 5 files** (`BomAdd` ×2, `BomEdit` ×1, `kartabl karid` ×1, `Kartable Bomadd` ×2, `kharid` ×2) — always inside `Attributes="…"` |
| **Kept distinct from `CodeStandardDarSanat`?** | **Yes** — both appear side by side in the same attribute list, so the source treats them as **two distinct fields** |

### 7.2 The label trap, investigated and rejected `[CONFIRMED]`

`kharid.txt` does contain the Persian label **«کد قطعه»** — the obvious candidate meaning for
`Code_Ghatae`. Tracing it: it binds to `GhataeDarkhastiKharid_x003a__x061`, a **different field on
the purchase part-request lookup**, and that control is `IsHidden="True"` / `IsEnabled="False"`.

Surrounding it, the purchase form reveals a whole code vocabulary that is **not** the BOM's:

| Legacy field | Persian label |
| --- | --- |
| `…x06` | «کد نقشه قطعه» (part **drawing** code) |
| `…x060` | «کد نقشه مونتاژی مرتبط با قطعه» (related **assembly drawing** code) |
| `…x061` | «کد قطعه» (part code) |
| `…x062` | «نام قطعه در صنعت» (industry part name) |

So the legacy solution distinguishes *standard*, *part*, *drawing* and *assembly-drawing* codes —
which makes it **plausible** that `Code_Ghatae` is the «کد قطعه» of that family. But **no form binds
that label to `Code_Ghatae`**, and the field is never written by anything supplied. Per the brief —
*"Do NOT assume they are synonyms. Do NOT collapse them into one field. If semantics remain
unclear: mark D-2 BLOCKED."* — **D-2 stays BLOCKED.**

### 7.3 Why it cannot be guessed

Neither evidence base can answer it:

- **Source material:** shows only that six forms *read* it and nobody *writes* it. That is equally
  consistent with "computed by an unsupplied process", "a stale legacy column", and "a lookup
  carry-over".
- **Repository:** has no part domain at all (§3.1, §4.1), so no Ariya contract defines it.

A fourth option — **drop the field from V1** — is a business decision, not a discovery, and is
recorded as **D-2a** in §16. **It must not be collapsed into `standardPartCode`.**

---

## 8. D-3 RESOLUTION — `State == 5`

**STATUS: `LEGACY-NOT-REQUIRED`.**

### 8.1 Every occurrence of `state == 5` in the BOM forms `[CONFIRMED]`

| File | Occurrence | Context |
| --- | --- | --- |
| `BomAdd.txt` | **1** | `EnabledFormula` on the **project combo**: `parseInt(c_state) <= 1 \|\| parseInt(c_state) == 5` |
| `BomAdd.txt` | — | **no writer.** The BOM header writes only `State = 0` and `State = 1` |
| `BomEdit.txt` | 0 | uses `0 / 1 / 2 / 50 / 100` only |
| `Kartable Bomadd.txt` | 0 | writes only `StateNext = 2` and `State = 0` |

### 8.2 Why the token exists at all `[CONFIRMED]`

`5` is not BOM-specific. It is an **approval-stage ordinal of a shared legacy template**:

- `sooderCheck.txt` highlights section `05` when `c_status == '5'`, alongside a full sequential
  chain `1,2,3,4,5,6,7` (sections `01`–`11`), and its submit writes `item.StateNext = st + 1`.
- `kartabl karid.txt` / `kartabl SoderCheck.txt` likewise branch on `cr_state == "5"`.
- The BOM uses a **different, non-sequential vocabulary**: `0`, `1`, `2`, `50`, `100`.

So `state <= 1 || state == 5` on the BOM's project combo is a **copy-paste guard from the
sequential-stage family**, in which value `5` is **unreachable** — no BOM form writes it, and the
field it guards (`NameProje`) is `IsEnabledOnEdit="False"` anyway.

### 8.3 Classification

**`LEGACY-NOT-REQUIRED`** — resolved from the source, and the resolution is that it is *not*
required. **State `5` is NOT introduced into the Ariya domain model.** The V1 BOM status vocabulary
stays `0 / 1 / 2 / 50 / 100` as evidenced (§13), and any future state machine must be defined by an
explicit contract rather than by a template artifact.

---


## 9. D-4 RESOLUTION — V1 APPROVER SEMANTICS

Split deliberately: **D-4a = who approves**, **D-4b = who owns the transitions**.

**D-4a STATUS: `RESOLVED-BY-EXISTING-CONTRACT` (Disposition A).**
**D-4b STATUS: `BLOCKED-BY-MISSING-CONTRACT` (Disposition D).**

### 9.1 What the source says the approver IS `[CONFIRMED]`

Read verbatim from `BomAdd.txt`:

| Fact | Evidence |
| --- | --- |
| The approver is the **requester's manager**, explicitly labelled «مدیر درخواست کننده» | `Value="مدیر درخواست کننده" LabelForControl="ModirTaeedKonandeh"` |
| It is **manually selected by the requester**, not resolved from a hierarchy | the control is editable; no script auto-fills it (unlike the requester, which is auto-filled from `form.UserID()`) |
| The candidate list is **filtered to employees with `LevelManager ∈ {1, 2}`** | `Lookup_Criteria="LevelManager;1;Equals;Text;OR;No;;\|LevelManager;2;Equals;Text;OR;No;;"` on `لیست کارکنان` |
| It is **stored** on the record as `ModirTaeedKonandeh` | `TargetFieldName="ModirTaeedKonandeh"`, `IsEnabledOnEdit="False"` |
| On submit, the manager's **system account** is resolved and stored separately | `TaeedKonandeh = e.ListItem.PersonUser` (`TargetFieldName="TaeedKonandeh"`, PeoplePicker, hidden) |
| Missing account blocks submission | `«یوزر مدیر پروژه در سامانه ست نشده است»` |

**So the source's approver is: a requester-selected manager, frozen onto the record at submit — not
a project manager, not a production manager, not a configurable matrix, not a workflow-assigned
approver.**

### 9.2 Two traps, both rejected `[CONFIRMED]`

1. **The error message says «مدیر پروژه» (project manager) while the field is «مدیر درخواست
   کننده» (requester's manager).** This is a **template artifact**, proven by `sooderCheck.txt` and
   `kartabl SoderCheck.txt`, which have a *separate, real* «مدیر پروژه» field
   (`c_ModireProject` / `cr_ModireProject`) gated by `NoaeKharid == 'پروژه ای'`. The BOM has no such
   field. The **field label wins**; the message does not redefine the role.
2. **The `LevelManager ∈ {1,2}` filter is not an Ariya contract.** Searching HR's schema for
   `level` / `Level` / `rank` / `grade` returns **0 hierarchy fields** — the only person-to-manager
   edge is `EmploymentRecord.managerEmployeeId`. So the *filter* is legacy data-shaping over a
   SharePoint list column that Ariya does not have.

### 9.3 Can Ariya represent it? `[CONFIRMED]`

| Needed capability | Exists? | Where |
| --- | --- | --- |
| Store an explicitly chosen approver user id on the BOM | **Yes** | plain opaque id + tenant scope |
| Validate that id belongs to the tenant | **Yes** | `USER_DIRECTORY` (`filterTenantMembers`) |
| Resolve the id to a displayable person | **Yes** | `USER_DIRECTORY` (`findProfiles`) — exposes `jobTitle`, **not** a manager |
| Gate who may act on it | **Yes** | RBAC (`Permission` / `@Roles`) + the `PRODUCTION` domain (§10.3) |
| Supply the candidate filter `LevelManager ∈ {1,2}` | **No** | no hierarchy-level field in HR |
| Resolve "who is this person's manager" at runtime | **Not from the platform** | HR has `EmploymentRecord.managerEmployeeId`, but `DirectoryUserProfile` does **not** expose it |

**The last row does not block V1**, because the source **does not resolve the manager at runtime**
— it stores the selected person. HR's own schema comment records the same philosophy: approvers are
stated on a definition *"rather than an inferred manager chain."*

### 9.4 Classification

- **D-4a = `RESOLVED-BY-EXISTING-CONTRACT`.** The V1 approver is an **explicitly selected, stored
  user id**, authorized by RBAC and validated by `USER_DIRECTORY`. No new contract is required.
  (The `LevelManager` filter is **`LEGACY-NOT-REQUIRED`**.)
- **D-4b = `BLOCKED-BY-MISSING-CONTRACT`.** §5.4 stands: the source never writes `State` on
  approve/reject, so **who moves `1 → 2` and `2 → {100, 50}` is not derivable**. Recreating that
  from UI behaviour would be inventing a workflow. Carried to §16 as the explicit decision
  **D-4b**.

---


## 10. D-5 RESOLUTION — PRODUCTION PERSISTENCE BOUNDARY

**STATUS: `RESOLVED-BY-EXISTING-CONTRACT` (Disposition A).**

**REQUIRED ANSWER: `ESTABLISHED PATTERN EXISTS`** — *not* `NEW PLATFORM DECISION REQUIRED`.

### 10.1 The rule is already approved `[CONFIRMED]`

`docs/ADR/ADR-0005-ARCH-1-RUNTIME-AND-DATABASE-BOUNDARIES.md` (Status: **APPROVED**) states:

> "New independent business modules MUST live under `src/modules/<module>` and own their own Prisma
> schema, migrations and service."

and under *Module classification*:

> "A future independently deployable business module receives its own entrypoint and root module; it
> is **never added to `CoreAppModule`**."

That is an approved architectural rule that directly answers D-5. Nothing needs to be invented.

### 10.2 The pattern has six precedents `[CONFIRMED]`

| Owner | Schema | Environment variable | Migrations |
| --- | --- | --- | --- |
| Core | `prisma/core/schema.prisma` | `CORE_DATABASE_URL` | `prisma/core/migrations` |
| CMS | `prisma/cms/schema.prisma` | `CMS_DATABASE_URL` | `prisma/cms/migrations` |
| Observability | `prisma/observability/schema.prisma` | `OBSERVABILITY_DATABASE_URL` | `prisma/observability/migrations` |
| Correspondence | `prisma/correspondence/schema.prisma` | `CORRESPONDENCE_DATABASE_URL` | `prisma/correspondence/migrations` |
| **HR** | `prisma/hr/schema.prisma` | `HR_DATABASE_URL` | `prisma/hr/migrations` |
| **Commerce** | `prisma/commerce/schema.prisma` | `COMMERCE_DATABASE_URL` | `prisma/commerce/migrations` |

**123 `CREATE TABLE` statements** across these six databases prove the pattern is not aspirational.

### 10.3 The exact, mechanical checklist — already used twice `[CONFIRMED]`

ADR-0005's *"HR prerequisites"* section is, verbatim, the recipe for a new module. Applying it to
Production (each row is an existing mechanism, not a new idea):

| # | Artefact | Existing precedent |
| --- | --- | --- |
| 1 | `apps/api/prisma/production/schema.prisma` with `url = env("PRODUCTION_DATABASE_URL")` | `prisma/commerce/schema.prisma` |
| 2 | `apps/api/prisma/production/migrations/**` | `prisma/commerce/migrations/**` |
| 3 | `package.json`: `prisma:generate:production` + `prisma:migrate:production`, wired into `prisma:generate` and `db:migrate` | the six existing pairs |
| 4 | `.env.example`: `PRODUCTION_DATABASE_URL=…/production_db` with a "MUST NOT POINT AT core_db" comment | `COMMERCE_DATABASE_URL` |
| 5 | `src/modules/production/database/production-prisma.{module,service}.ts` | `commerce-prisma.{module,service}.ts` |
| 6 | `src/runtime-datasources.ts`: add `'PRODUCTION_DATABASE_URL'` to `Datasource` + `DATASOURCES`, and a row in `RUNTIME_DATASOURCE_MATRIX` | the Commerce note: *"it joins the declaration here as a TARGET owner first — artifacts arrive in the same phase"* |
| 7 | Regenerate `runtime-policy.json` via `npm run arch:policy`; drift checked by `runtime-policy.spec.ts` | existing tooling |
| 8 | `architecture-boundaries.spec.ts`: `INDEPENDENT_MODULE_OWNER_REGISTRY` / `requiredDatasources()` / `notUsedDatasources()` expectations | the Commerce/HR edits recorded in the spec's own comments |
| 9 | `src/config/env.validation.ts`: `PRODUCTION_DATABASE_URL: z.string().optional()` | the `COMMERCE_DATABASE_URL` entry |
| 10 | `infrastructure/postgres/initdb/01-create-databases.sql`: `CREATE DATABASE production_db` guarded by `NOT EXISTS` | the ownership-contract comment block listing all six |
| 11 | A `RuntimeId` **only if** Production becomes its own process | `future-hr` declares a `target` before it exists; **Commerce shipped `commerce_db` inside `combined` first**, so a standalone runtime is optional |
| 12 | A row in ADR-0005's *Persistence source of truth* table | the existing rows |

**Note the two-phase freedom already established:** Commerce shipped `commerce_db` **hosted by the
`combined` runtime** with `RuntimeId` untouched; HR declared `future-hr` as a `target` *before* its
`hr-app.module.ts` exists, with `architecture-boundaries.spec.ts` failing if an artefact appears
without the declaration. **Production has both options; neither requires a platform decision.**

### 10.4 Classification

`RESOLVED-BY-EXISTING-CONTRACT` → **`ESTABLISHED PATTERN EXISTS`**.

No new database boundary is invented "because it appears clean": the boundary is mandated by an
approved ADR, exercised six times, and **enforced by executable architecture tests**. What remains
is mechanical declaration (§16, **D-5a**) — an *implementation step*, not an open question.

---


## 11. D-7 RESOLUTION — BOM CODE GENERATION

**STATUS: `BLOCKED-BY-MISSING-CONTRACT` (Disposition D), with a
`REQUIRES-BUSINESS-DECISION` sub-item (D-7a).**

### 11.1 Does the source define an algorithm? `[CONFIRMED]` — it defines **three, and they disagree**

**Generator A — `BomAdd.btn_Save` (per-row save):**

```js
codeTree = c_Control31;               // ListQuery2: MAX(CodeStandardDarSanat) WHERE Author != me
                                       //             AND project = p AND tree = t, MaxRows=1, DESC
base     = ProductTreeRef_x003A_code;  // the product tree's code
n        = codeTree != "" ? parseInt(lastSegment(codeTree)) + 1 : 1;
code     = base + "-" + zeroPad3(n);   // e.g. TREECODE-001
```

**Generator B — `Kartable Bomadd.btn_Save` (approval-task save):**

```js
str = e.ListItems[len-1].CodeStandardDarSanat;  // LAST element of the full filtered list
                                                 // (no sort declared, no Author exclusion)
n   = parseInt(lastSegment(str)) + 1;
code = base + "-" + n.padStart(3, '0');
```

**Generator C — bulk renumber tool (`c_Control41`):**

```js
for (i = 0; i < listItems.length; i++) {
  final = base + "-" + zeroPad3(i + 1);   // POSITIONAL index, list order
  if (listItems[i].CodeStandardDarSanat != final) item.CodeStandardDarSanat = final;
}
```

| Question | A | B | C |
| --- | --- | --- | --- |
| Which row is "the previous code"? | **max excluding my own authorship** | **last row of the list** | **the row's own position** |
| Ordering declared? | `SortField=CodeStandardDarSanat`, `SortAsc=False`, `MaxRows=1` | none | none (list order) |
| Author exclusion? | yes | no | no |
| Scope | project + tree | project + tree | tree only |

**These are three different rules.** A and B disagree about *the source of the next number*; C
rewrites history positionally.

### 11.2 Concurrency, edit, delete `[CONFIRMED]`

| Aspect | Finding |
| --- | --- |
| **Locking / transaction / retry** | **None.** Searching both files for `lock`, `transaction`, `retry`, `race`, `BEGIN`, `serializable` yields **only CSS `display:"block"`** (5 hits). |
| **The save is a find-then-act race** | The save body is wrapped in `setTimeout(..., 1300)` so the asynchronous uniqueness query can populate the hidden `c_Control27` before the check runs — a **timing hack around a read-then-write race**, not a concurrency control. |
| **Edit behaviour** | Code generation runs **unconditionally at the top of `btn_Save`**, before the `if (id)` assignment — so editing a row **re-derives its code**. The source therefore does **not** hold "code is stable on edit". |
| **Delete behaviour** | `btn_Delete` removes the row with **no renumbering**, so sequences gain permanent gaps — which generator C later "repairs" positionally. |
| **Overflow** | `zeroPad3` pads to 3 digits; behaviour past `999` is undefined (nothing truncates, nothing guards). |

### 11.3 Why it cannot be closed here

1. **`base` is the Product Tree code — and Product Tree does not exist** (§4). The single most
   important input to the algorithm comes from a missing domain. Choosing a generator without it
   would mean inventing the prefix.
2. **A, B and C disagree**, and nothing in the material ranks them. Picking one would be *choosing*,
   not *discovering* — a business decision (D-7a).
3. **No concurrency story exists at all.** Any sequence generator must answer "what happens when two
   BOM items are saved simultaneously"; the source's answer is "whichever `setTimeout` fires first".
   Inventing a generator with locking, gaps, retries or an overflow policy is exactly what the brief
   forbids.

### 11.4 Classification

**`BLOCKED-BY-MISSING-CONTRACT`** on the prefix (Product Tree), plus
**`REQUIRES-BUSINESS-DECISION`** on which algorithm and which concurrency rule (D-7a).
**No sequence generator is invented in this phase.**

---


## 12. D-8 RESOLUTION — TOTAL CONSUMPTION COEFFICIENTS

**STATUS: PER-FIELD. Two `DEFINED`, five `BLOCKED`, and the surrounding semantics `AMBIGUOUS`.**

### 12.1 Per-field classification `[CONFIRMED]`

| # | Field | Persian label | Class | Basis |
| --- | --- | --- | --- | --- |
| 1 | `ZaribMasraf_DarNaghshe` | ضریب مصرف (درنقشه) | **`DEFINED`** | a **source input**: written by the item save, validated non-empty (V16), read back into the form, and used as an arithmetic operand |
| 2 | `ZaribMasraf_YadakiDorriz` | ضریب مصرف (یدکی/تست) | **`DEFINED`** | identical: written, validated non-empty (V17), used as an operand |
| 3 | `ZaribMasraf_KoleGhatae` | ضریب مصرف کل قطعه | **`BLOCKED`** | **read-projection only.** Appears in `Attributes=` of 6 queries; **0 write sites, 0 criteria, 0 arithmetic use** anywhere in the eight files |
| 4 | `ZaribMasraf_DarNaghshe_DarHalSef` | … (در نقشه) در حال سفارش | **`BLOCKED`** | same: projection only, no writer, no formula |
| 5 | `ZaribMasraf_YadakiDorriz_DarHalS` | … (یدکی/تست) در حال سفارش | **`BLOCKED`** | same |
| 6 | `ZaribMasraf_DarNaghshe_Kharidsho` | … (در نقشه) خریداری شده | **`BLOCKED`** | same; plausibly Purchase-owned, but **no writer is supplied** to prove it |
| 7 | `ZaribMasraf_YadakiDorriz_KharidS` | … (یدکی/تست) خریداری شده | **`BLOCKED`** | same (appears only in `kharid.txt`'s BOM projection) |

### 12.2 The only formula the source ever computes `[CONFIRMED]`

```js
// BomEdit (change-request entry) — display + a deliberately disabled guard:
total = parseInt(previousDrawing) + parseInt(deltaDrawing)
if (total < 0) alert("… مجموع ضریب مصرف (درنقشه) نمی تواند کمتر از 0 شود.")   // `error` NOT set

// kartable bomEdit (change-request approval) — a hard refusal:
total  = parseInt(deltaDrawing)  + parseInt(item.ZaribMasraf_DarNaghshe)
total1 = parseInt(deltaSpareTest) + parseInt(item.ZaribMasraf_YadakiDorriz)
if (total  < 0) → "میزان کل ضریب مصرف (در نقشه) برای قطعه <name> نمی تواند کمتر از 0 شود."
if (total1 < 0) → "میزان کل ضریب مصرف (یدکی / تست) برای قطعه <name> نمی تواند کمتر از 0 شود."
```

**This computes `previous + delta` for the change-request path only. It is *not* a definition of
`ZaribMasraf_KoleGhatae`** — that field is never an operand, never assigned, never displayed as a
result of it. Reading "total" as "sum of the two base coefficients" would be an inference, and the
brief forbids inventing formulas.

### 12.3 The surrounding semantics `[AMBIGUOUS]`

| Aspect | Finding |
| --- | --- |
| **Rounding** | **No rounding rule exists.** The only numeric operation is `parseInt`, which *truncates*; nothing declares decimals, precision or a rounding mode. Whether the coefficients are integers by contract or merely by accident of `parseInt` is unresolved. |
| **Units** | **None declared.** The coefficients carry no unit of their own; `Vahade_Andazegiri` («واحد اندازه گیری») is the *item's* unit of measure, free text, and nothing states that a coefficient is expressed in it. |
| **Null** | At creation, **empty is refused** (V16/V17). A stored `NULL` is therefore not a legal input state for the two base coefficients. |
| **Zero** | **Never explicitly forbidden.** The item save refuses only *empty*; the negative floor applies only in the change-request path. A stored `0` is therefore legal but unexplained. |
| **Negative** | Refused **only** at change-request approval — never at item creation. The source permits a *negative* base coefficient to be written. |
| **Integer vs decimal** | Unresolved: every operand is `parseInt`, but nothing declares the column type. |

### 12.4 Classification

- **Fields 1–2: `DEFINED`** as required, non-empty, integer-parsed **inputs** owned by the BOM item.
- **Fields 3–7: `BLOCKED-BY-MISSING-CONTRACT`.** No formula, no writer and no consumer exist in
  either evidence base; the fields are read-only projections of a process outside the supplied
  material. Whether the Purchase side writes them is a hypothesis, not a finding — `kharid.txt`
  supplies no such write.
- **Formula/rounding/units/zero: `AMBIGUOUS` → `REQUIRES-BUSINESS-DECISION` (D-8a, §16).**

**No formula, rounding rule or unit convention is created in this phase.**

---


## 13. DECISION MATRIX

| Decision | Status | Evidence | Owner | Blocks V1? |
| --- | --- | --- | --- | --- |
| **D-1** — meaning/ownership of `CodeStandardDarSanat` | **`RESOLVED`** | §6: read-only control, 5 write sites, 3 generators, 2 criteria; scope `(project, tree)`; label «کد استاندارد قطعه( در صنعت)»; never filtered by Purchase | — | **No** (meaning); yes for the DB constraint (B-1/B-2) |
| **D-1a** (was D-6) — is the code immutable once assigned? | `REQUIRES-BUSINESS-DECISION` | §6.4: the source **overwrites** it in the renumber tool and the approval-task save | Ariya (business) | No — V1 may default to the source's mutability |
| **D-2** — `Code_Ghatae` semantics | **`BLOCKED-BY-MISSING-CONTRACT`** | §7: 0 writes, 0 criteria, 0 labels in all eight files; the «کد قطعه» label binds a *different* field | Ariya + a part/field contract | **YES** — blocks the item model |
| **D-2a** — keep, rename or drop `Code_Ghatae` in V1? | `REQUIRES-BUSINESS-DECISION` | §7.3 | Ariya (business) | **YES** (until answered, the column's fate is unknown) |
| **D-3** — `State == 5` | **`LEGACY-NOT-REQUIRED`** | §8: one unreachable `EnabledFormula` occurrence; `5` belongs to a shared sequential-stage template (`1..7`) used by other forms | — | **No** — state `5` is excluded |
| **D-4a** — who approves | **`RESOLVED-BY-EXISTING-CONTRACT`** | §9: a **requester-selected manager**, stored (`ModirTaeedKonandeh` + resolved `TaeedKonandeh`); the `LevelManager ∈ {1,2}` candidate filter is legacy | — | **No** |
| **D-4b** — who owns the transitions `1→2` and `2→{100,50}` | **`BLOCKED-BY-MISSING-CONTRACT`** | §5.4 + §9.4: the approval task writes **no `State`** on approve/reject | Ariya (business) | **YES** — blocks lifecycle + approval |
| **D-5** — Production persistence boundary | **`RESOLVED-BY-EXISTING-CONTRACT`** → **`ESTABLISHED PATTERN EXISTS`** | §10: ADR-0005 (APPROVED) mandate + 6 precedents + `architecture-boundaries.spec.ts` enforcement | — | **No** |
| **D-5a** — declare the module/db (12 mechanical artefacts) | *implementation step, not a decision* | §10.3 checklist | Architecture (executes) | **No** |
| **D-7** — code-generation algorithm | **`BLOCKED-BY-MISSING-CONTRACT`** | §11: the prefix comes from the missing Product Tree | a Product Tree contract | **YES** — blocks code generation |
| **D-7a** — which of generators A/B/C, and the concurrency rule | `REQUIRES-BUSINESS-DECISION` | §11.1–§11.2: three disagreeing algorithms, **zero** locking/transaction/retry, a `setTimeout(…,1300)` race | Ariya (business) + architecture | **YES** |
| **D-8** — total consumption coefficient | **per-field:** 2× `DEFINED`, **5× `BLOCKED-BY-MISSING-CONTRACT`** | §12.1–§12.2 | — | **No** if fields 3–7 are deferred; **YES** if kept |
| **D-8a** — rounding / units / zero / negative / integer-vs-decimal | `REQUIRES-BUSINESS-DECISION` | §12.3: `parseInt` only; no rounding, no unit, no zero rule; negative refused only in the change-request path | Ariya (business) | No — V1 can adopt the source's `>= 0` floor |
| **Project** | **`BLOCKED-BY-MISSING-PLATFORM-DOMAIN`** | §3: 0 models, 0 of 123 tables, 0 routes, 0 registrations; the `'Project Management'` string is a marketing list | a platform/domain owner | **YES** — required header ref, duplicate scope, `Title` derivation |
| **Product Tree** | **`BLOCKED-BY-MISSING-PLATFORM-DOMAIN`** | §4: 0 objects; the tree-picker source (`Test_WP.aspx`) was not supplied; participation in code generation is SharePoint-only | a platform/domain owner | **YES** — required header ref, duplicate scope, code prefix |
| **Workflow** | **`WORKFLOW-CONTRACT-MISSING`** (= `BLOCKED-BY-MISSING-CONTRACT`) | §5: 0 workflow artefacts in the 8 files; the approval task has no auth gate | Ariya (business) | **YES** |

**Tally: 4 `RESOLVED`/`RESOLVED-BY-EXISTING-CONTRACT`, 1 `LEGACY-NOT-REQUIRED`, 4
`REQUIRES-BUSINESS-DECISION` sub-items, 5 `BLOCKED-BY-MISSING-CONTRACT` (3 of them whole domains).**

---


## 14. IMPLEMENTATION READINESS MATRIX

| # | Area | Status | Reason |
| --- | --- | --- | --- |
| **A** | **BOM persistence model** | **`READY-WITH-EXPLICIT-ASSUMPTION`** | D-5 gives the database boundary (§10), D-3 removes state `5` (§8), D-1 gives the code column's meaning (§6). **The assumption (§16, D-5b):** `projectRef` and `productTreeRef` are stored as **opaque, unvalidated** strings, and `Title` is **stored as a value** rather than derived — because deriving `'اقلام پروژه - ' + <project name>` (§3.3) needs a project contract that does not exist. Without accepting that assumption, A is `BLOCKED`. |
| **B** | **BOM Item model** | **`BLOCKED`** | D-2 leaves an unresolved column (`Code_Ghatae`, §7); D-7 leaves the item's *required* `standardPartCode` ungenerated (§11); D-8 leaves five projection columns undefined (§12). |
| **C** | **CRUD API** | **`BLOCKED`** | Depends on B, and on E for the state guards that decide when a write is legal (§5.2, §9.4). |
| **D** | **Validation** | **`READY-WITH-EXPLICIT-ASSUMPTION`** | V11–V17 and V8 (preflight §10) are pure field/existence checks, fully evidenced. **The assumption:** the uniqueness scope `(project, product tree, code)` from `ListQuery3` remains authoritative once Project and Product Tree exist. V18/V19 cannot be *exercised* until G produces a code. |
| **E** | **Lifecycle** | **`BLOCKED`** | `WORKFLOW-CONTRACT-MISSING` (§5.4): the states `0/1/2/50/100` are known, but the source never writes `2`, `100` or `50`. Owning those transitions is a **business decision (D-4b)**, not a discovery. |
| **F** | **Approval** | **`BLOCKED`** | D-4a gives *who* (§9.4); D-4b denies *what happens next*. The approval task's own authorization came from the missing workflow, so even the enforcement point is undetermined (§5.3). |
| **G** | **Code generation** | **`BLOCKED`** | Prefix from a missing domain (§4.3) + three disagreeing algorithms + no concurrency rule (§11). |
| **H** | **Frontend** | **`BLOCKED`** | Depends on A, B, C, E and F. No screen can render an approval state that has no owner, or a code it cannot generate. |
| **I** | **Search** | **`READY`** | `SEARCH_SOURCE_PORT` exists and is reusable (preflight §18.1): a `production.bom` key, platform-owned retrieval/ranking/paging, source-owned authorization. Optional for V1. |
| **J** | **Audit** | **`READY`** | `AUDIT_PORT.record` / `.read` exist; the `CommerceAuditGateway` pattern (envelope from the actor, resource vocabulary, never-throw) is a direct template (preflight §18.2). Required for V1. |

**Ready now: I, J.  Ready under a stated assumption: A, D.  Blocked: B, C, E, F, G, H.**

**Nothing classified `BLOCKED` is to be implemented.**

---


## 15. EXACT REMAINING BLOCKERS

Six, each with the precise reason it cannot be guessed.

### B-1 · Project domain — `BLOCKED-BY-MISSING-PLATFORM-DOMAIN`

**Why it cannot be guessed.** A BOM header must carry `projectRef` (required by V2), the duplicate
rules are scoped by `NameProje_MortabetBaBOM` (§6.2), and `Title` is *derived from the project name*
(§3.3). Fabricating a Project inside Production would give Production a domain it must not own
(§17) with an unknown identifier, tenancy and lifecycle — and the moment a real Project domain
arrives, every row written against the fabricated one becomes a migration liability. **Guessing it
converts a data problem into a data-corruption problem.**

### B-2 · Product Tree domain — `BLOCKED-BY-MISSING-PLATFORM-DOMAIN`

**Why it cannot be guessed.** The tree is simultaneously (a) a required header reference (V3),
(b) half of both uniqueness scopes, and (c) **the prefix of every standard part code** (§4.2). Its
`code` format, hierarchy and assignment rules live in a SharePoint page (`Test_WP.aspx`) that was
never supplied. Inventing the tree to unblock code generation means inventing the *format of every
code ever generated afterwards* — an irreversible, unauditable business identifier.

### B-3 · Workflow definition — `WORKFLOW-CONTRACT-MISSING`

**Why it cannot be guessed.** The source writes `State = 1` and `State = 0`, and writes
`StateNext = 2` — and then, on approve/reject, writes **no state at all** (§5.2). The values
`2`, `100` and `50` are *observed*, never *produced*, by any supplied file. Reconstructing the
transition table from UI colouring and an `EnabledFormula` would be inventing a workflow from its
visual side-effects — explicitly forbidden, and it would silently fix who is allowed to approve.

### B-4 · `Code_Ghatae` semantics — `BLOCKED-BY-MISSING-CONTRACT` (D-2)

**Why it cannot be guessed.** Eight reads, zero writes, zero criteria, zero labels (§7.1). The one
Persian label «کد قطعه» that would answer it binds a *different* field on the purchase form (§7.2).
Both "keep it" and "drop it" change the item model, and equating it with `CodeStandardDarSanat`
would destroy a distinction the source demonstrably maintains.

### B-5 · Code-generation algorithm — `BLOCKED-BY-MISSING-CONTRACT` + `REQUIRES-BUSINESS-DECISION` (D-7/D-7a)

**Why it cannot be guessed.** Three mutually inconsistent generators (§11.1), no locking, no
transaction, no retry, and a `setTimeout(1300)` race (§11.2) — plus a prefix from B-2. Choosing
among A/B/C *is* the business decision; inventing a sequence generator additionally requires
inventing overflow, gap and concurrency policies the source never states.

### B-6 · Five consumption projections — `BLOCKED-BY-MISSING-CONTRACT` (D-8 fields 3–7)

**Why it cannot be guessed.** `ZaribMasraf_KoleGhatae` and the four `DarHalSef` / `Kharidsho`
siblings have no writer, no formula and no arithmetic use anywhere (§12.1). The only formula in the
source computes `previous + delta` for a *change request*, which is a different quantity (§12.2).
Defining "total = drawing + spare" would be inventing a formula from a field's name.

**Not blockers any more:** D-1 (resolved), D-3 (`LEGACY-NOT-REQUIRED`), D-4a (resolved), D-5
(resolved).

---


## 16. MINIMUM DECISIONS REQUIRED BEFORE IMPLEMENTATION

Only decisions that change **V1 correctness**. Everything already closed (D-1, D-3, D-4a, D-5,
search, audit) is deliberately absent.

| # | Decision to take | Accepted answer that unblocks | Gates |
| --- | --- | --- | --- |
| **M-1** | **`D-5b` — reference policy.** Do we accept `projectRef` / `productTreeRef` as **opaque, unvalidated, tenant-stored** strings, and `Title` as a **stored value** rather than `'اقلام پروژه - ' + <project name>`? | "Yes, opaque + stored" → A becomes `READY`. "No" → B-1/B-2 must be closed first. | **A** (and part of D) |
| **M-2** | **Project contract** (B-1) — or formal acceptance of M-1 | an authoritative Project domain **or** an explicitly recorded accepted limitation | **A, C, D** |
| **M-3** | **Product Tree contract** (B-2) — or, if M-1 is accepted, a **source for the tree's `code` string** | an authoritative Product Tree domain **or** a declared tree-code provider | **A, D, G** |
| **M-4** | **`D-2a` — the fate of `Code_Ghatae`.** Keep as an optional unknown column / rename once defined / drop from V1 | any one of the three, stated | **B** |
| **M-5** | **`D-4b` — transition ownership.** Who writes `State = 2`, `100`, `50`? Options: a Production-owned guarded state machine; a platform Workflow contract; a Commerce-engine port (rejected by the preflight as a dependency inversion). | one owner named, with the actor and permission for each of `1→2` and `2→{100,50}` | **E, F, C, H** |
| **M-6** | **`D-7a` + `D-1a` — the code rule.** Which generator (A, B or C of §11.1), what happens on edit (the source re-derives; is that intended?), what happens on delete, what happens past `999`, and what guarantees uniqueness under concurrency | one algorithm + one concurrency rule + an immutability answer | **G, B** |
| **M-7** | **`D-8a` — coefficient numerics** for the two `DEFINED` inputs: integer or decimal; is `0` legal; is `negative` legal (the source refuses it only in the change-request path) | a type + a range rule | **B, D** |

**Deliberately NOT in this list:** D-3 (closed — state `5` excluded), D-4a (closed — approver is a
stored user id), D-5 (closed — the pattern exists), Global Search and Audit (contracts exist), any
Purchase/Quality/Supplier decision (out of scope by §17).

**M-1 through M-7 are seven decisions. No hypothetical future decision is included.**

---

## 17. NON-GOALS

This phase did **not**, and the next phase must not treat it as permission to:

1. **Create any schema, Prisma model, migration, table or database.** `[CONFIRMED — git status]`
2. **Create any API route, controller, DTO or service.**
3. **Build any frontend screen, route, component or label file.**
4. **Create a Project domain** — inside Production or anywhere else (§3.4).
5. **Create a Product Tree domain** — "merely to unblock code generation" (§4.3).
6. **Invent BOM code semantics** — no prefix, no sequence, no padding, no overflow, no locking rule
   was chosen (§11).
7. **Recreate the SharePoint workflow from UI behaviour** (§5.4).
8. **Connect BOM to Purchase** (preflight §20; unchanged).
9. **Create a new workflow / approval engine**, or import Commerce's or HR's (preflight §12).
10. **Collapse `Code_Ghatae` into `CodeStandardDarSanat`**, or into any other field (§7.2).
11. **Introduce `State == 5` into the Ariya domain model** (§8.3).
12. **Carry any hard-coded SharePoint identity** (usernames, the `مالکان پژوهشکده هوا خورشید` group,
    the `LevelManager ∈ {1,2}` candidate filter) into Ariya authorization (§9.2).
13. **Define any consumption formula, rounding rule or unit convention** (§12.4).
14. **Modify Commerce, HR, Core, the frontend, or any existing test.**
15. **Produce a second new artifact.** This document is the only one.

---


## 18. FINAL RECOMMENDATION

### 18.1 What this phase accomplished

The ten blockers were separated into the four dispositions the brief asked for, **without forcing
closure**:

| Disposition | Count | Items |
| --- | --- | --- |
| **A — resolvable from existing repository contracts** | **4** | D-4a (approver, via `USER_DIRECTORY` + RBAC), D-5 (persistence, via ADR-0005 + 6 precedents + architecture tests), Search (exists), Audit (exists) |
| **B — resolvable from the supplied source** | **2** | D-1 (`CodeStandardDarSanat` meaning/scope/generation), D-3 (state `5` → legacy, excluded) |
| **C — requires an explicit product/business decision** | **4** | D-2a, D-4b, D-7a (+D-1a), D-8a — grouped as **M-4, M-5, M-6, M-7** |
| **D — must stay blocked** | **5** | Project, Product Tree, Workflow, D-2, code generation — **B-1…B-6** |

### 18.2 The three answers the brief most needed

1. **Project does not exist — `BLOCKED-BY-MISSING-PLATFORM-DOMAIN`.** 0 models, **0 of 123
   tables**, 0 routes, 0 module registrations. The lone `'Project Management'` string is a marketing
   array. Production must not create it.
2. **Product Tree does not exist — `BLOCKED-BY-MISSING-PLATFORM-DOMAIN`.** Its `code` *does*
   participate in `CodeStandardDarSanat` generation — but **only inside SharePoint**, inferred from
   form script over a list whose source (and whose tree-picker page) was never supplied. Not
   documented, not implemented elsewhere.
3. **The workflow definition is missing — `WORKFLOW-CONTRACT-MISSING`.** Zero workflow artefacts in
   all eight files; the approval task writes **no `State`** on approve/reject and carries **no auth
   gate** — both lived in SharePoint's task assignment. It must not be recreated from UI behaviour.

### 18.3 Readiness verdict

```
A  BOM persistence model .... READY-WITH-EXPLICIT-ASSUMPTION   (M-1/M-2/M-3)
B  BOM Item model ........... BLOCKED                          (M-3, M-4, M-6, M-7)
C  CRUD API ................. BLOCKED                          (B)
D  Validation ............... READY-WITH-EXPLICIT-ASSUMPTION   (M-3)
E  Lifecycle ................ BLOCKED                          (M-5)
F  Approval ................. BLOCKED                          (M-5)
G  Code generation .......... BLOCKED                          (M-3, M-6)
H  Frontend ................. BLOCKED                          (A, B, C, E, F)
I  Search ................... READY                            (optional for V1)
J  Audit .................... READY                            (required for V1)
```

**Lifecycle/approval: NOT implementation-ready. Code generation: NOT implementation-ready.**
**BOM persistence: implementation-ready only under an explicitly accepted assumption (M-1).**

### 18.4 The recommendation

> **Do not start implementation yet.** Take the seven minimum decisions (M-1…M-7) first — they are
> business and architecture choices, not engineering work, and every one of them changes a column, a
> state or an identifier that is expensive to change later.
>
> The single highest-leverage decision is **M-1**. If Ariya accepts opaque, unvalidated project and
> tree references with a stored `Title`, then **A and D become ready immediately** and the remaining
> blockers shrink to the item model, the lifecycle and code generation. If Ariya declines, then
> **Project and Product Tree must be built first**, as platform domains outside Production, before
> any BOM table exists.
>
> **Recommended order once M-1…M-7 are answered:** D-5a declaration (§10.3, mechanical) →
> persistence + item model → validation → lifecycle/approval (M-5) → code generation (M-6) → CRUD →
> audit wiring → frontend → optional search.
>
> **The alternative — implementing the header today with assumed semantics — is rejected.** It would
> fix a project reference, a tree reference, a title derivation, a code prefix and a transition table
> into data that later contracts have to undo.

### 18.5 What would change this recommendation

- **A Project and Product Tree contract arriving** (or being commissioned) removes M-1/M-2/M-3 and
  makes A, D, G approachable without an assumption.
- **Ariya choosing a platform Workflow contract for M-5** re-opens the preflight's G-6 question and
  would make E and F depend on that contract instead of a Production-owned state machine.
- **A decision to defer the item model's code fields entirely** (no `standardPartCode`, no
  `Code_Ghatae`) would unblock B and C while G stays blocked — a legitimate partial V1, but it would
  ship a BOM that cannot satisfy V18/V19, so it requires an explicit business acceptance.

---


## FILES CHANGED BY THIS PHASE

**Created (the only new artifact):**

- `docs/PHASE-PRODUCTION-BOM-CONTRACT-CLOSURE.md` — this document.

**Modified:** none. No file under `apps/api/**`, `apps/web/**`, `packages/**`,
`infrastructure/**`, any Prisma schema, any migration, any Commerce/HR/Core file, any test or any
frontend file was touched. No route, permission, schema or module registration was added.

## SOURCE FILES READ (outside the repository)

All eight, re-parsed in full: `E:\Very Mohem\BomAdd.txt`, `BomEdit.txt`, `Kartable Bomadd.txt`,
`kartable bomEdit.txt`, `kharid.txt`, `kartabl karid.txt`, `sooderCheck.txt`,
`kartabl SoderCheck.txt`.

## REPOSITORY FILES INSPECTED (read-only)

`apps/api/prisma/{core,cms,observability,correspondence,hr,commerce}/schema.prisma` and
`prisma/schema.prisma`; **every** `migration.sql` across all six databases;
`docs/ADR/ADR-0005-ARCH-1-RUNTIME-AND-DATABASE-BOUNDARIES.md`,
`docs/ADR/ADR-0006-ARCH-3-CROSS-RUNTIME-CONTRACTS.md`;
`apps/api/src/runtime-datasources.ts`, `runtime-policy.projection.ts`,
`architecture-boundaries.spec.ts`, `config/env.validation.ts`, `preferences/nav-catalogue.ts`;
`apps/api/package.json`; `infrastructure/postgres/initdb/01-create-databases.sql`;
`apps/api/src/platform/{audit,entitlement,search-source,user-directory}/**`;
`apps/api/src/modules/{commerce,hr}/**`; `packages/config/src/index.ts`;
`apps/web/src/{app,lib,components}/**`; `lovable/src/**`.

## CHECKS PERFORMED

| # | Check | Result |
| --- | --- | --- |
| 1 | Every Prisma schema: `model <X>Project` / `ProductTree` / `Part` / `Bom` / `Material` / `Supplier` / `Vendor` / `Warehouse` / `Tree` | **0 models** |
| 2 | **All 123 `CREATE TABLE` statements** in every migration, pattern-matched for those names | **0 matches** |
| 3 | Case-insensitive `project` in all schemas (56 hits) and case-sensitive `\bprojects?\b` in API/web/packages (173 hits) | **100% false positives** — "Prisma project", "projection", `project()` DTO helpers |
| 4 | `nav-catalogue.ts` `/admin/*` hrefs | 32 routes, **no project, no product tree** |
| 5 | `ModuleRegistration` seeds | only `hr` and `commerce` |
| 6 | Whole source tree + `lovable/src` for `ProductTree` / `product-tree` / `productStructure` / `treeNode` | only the preflight doc; tree hits are **HR organization** nodes |
| 7 | `packages/config` `'Project Management'` traced to its consumers | a **marketing** `FEATURES` list (`(marketing)/*` pages, `CoreModulesList` tests) |
| 8 | All 8 SharePoint files × workflow patterns (`WorkflowDefinition`, `StateMachine`, `.xoml`, `StartWorkflow`, `SetState`, …) | **0** |
| 9 | All `StateNext` writes (15) and every `State == 5` occurrence | approval task writes `StateNext=2` / `State=0` only; `5` is a shared-template ordinal |
| 10 | `CodeStandardDarSanat`: all writes (5), criteria (2), labels (2 variants), control flags | `IsEnabled=False` — **generated, never typed** |
| 11 | `Code_Ghatae`: all writes, criteria, labels | **0 / 0 / 0** — 8 read-projections only |
| 12 | The Persian label «کد قطعه» traced to its control | binds `GhataeDarkhastiKharid_x003a__x061`, **not** `Code_Ghatae` |
| 13 | Approver field: `Lookup_Criteria`, control flags, autofill behaviour | `LevelManager ∈ {1,2}` filter; requester autofilled, manager **manually selected** |
| 14 | `Kartable Bomadd` authorization surface | **no gate** — only the `Form_ManagePermissions` localization key |
| 15 | HR schema: `manager` / `level` / `rank` / `grade` | `managerEmployeeId` exists; **0 hierarchy-level fields** |
| 16 | `DirectoryUserProfile` fields | `jobTitle` only — **no manager** |
| 17 | Concurrency in `BomAdd` / `Kartable Bomadd` (`lock`, `transaction`, `retry`, `BEGIN`) | **0** — only CSS `display:"block"` (5 hits) |
| 18 | D-5 pattern: datasources, env, initdb, package scripts, ADR-0005, architecture tests | **6 precedents**, 12-step checklist confirmed |
| 19 | `git status --short` before and after | **identical** except this document |
| 20 | `git log --oneline -1` | HEAD `840226b` — unchanged, no commit |

---


## FINAL IMPLEMENTATION READINESS STATUS

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PRODUCTION → BOM :  NOT READY FOR IMPLEMENTATION                            │
│                                                                              │
│  READY                                    I  Search  (optional for V1)      │
│                                          J  Audit   (required for V1)       │
│  READY-WITH-EXPLICIT-ASSUMPTION           A  BOM persistence (M-1/M-2/M-3)  │
│                                          D  Validation       (M-3)          │
│  BLOCKED                                 B  BOM Item model   (M-3,4,6,7)    │
│                                          C  CRUD API         (B)            │
│                                          E  Lifecycle        (M-5)          │
│                                          F  Approval         (M-5)          │
│                                          G  Code generation  (M-3, M-6)     │
│                                          H  Frontend         (A,B,C,E,F)    │
│                                                                              │
│  BLOCKERS THAT CANNOT BE GUESSED                                             │
│    B-1  Project ............ BLOCKED-BY-MISSING-PLATFORM-DOMAIN             │
│    B-2  Product Tree ....... BLOCKED-BY-MISSING-PLATFORM-DOMAIN             │
│    B-3  Workflow ........... WORKFLOW-CONTRACT-MISSING                       │
│    B-4  Code_Ghatae ........ BLOCKED-BY-MISSING-CONTRACT   (D-2)            │
│    B-5  Code generation .... BLOCKED + REQUIRES-BUSINESS-DECISION (D-7a)     │
│    B-6  Five coefficients .. BLOCKED-BY-MISSING-CONTRACT   (D-8)            │
│                                                                              │
│  MINIMUM DECISIONS BEFORE ANY IMPLEMENTATION:  M-1 … M-7   (§16)            │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Closed by this phase:** **D-1** (meaning/scope/generation of `CodeStandardDarSanat`),
**D-3** (state `5` excluded as legacy), **D-4a** (approver = stored user id, existing contracts),
**D-5** (persistence boundary = established pattern). Search and Audit confirmed reusable.

**Still open:** business decisions **D-2a, D-4b, D-7a, D-8a** (= M-4…M-7), and the three domains
that do not exist (**B-1 Project, B-2 Product Tree, B-3 Workflow**).

---

**END OF DOCUMENT —** `CONTRACT CLOSURE COMPLETE — NO IMPLEMENTATION PERFORMED`
