# PHASE PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION

**I-1 / RB-1-P — Product Tree Code Source. Contract resolution only.**

This document answers exactly one question: *can an authoritative source for the Product Tree
code — the prefix of every `standardPartCode` — now be established?* It is a discovery artifact.
No source, schema, migration, route or frontend file was created or modified.

---

## 1. Scope

**In scope.** A fresh repository-wide search for Product Tree evidence; an external/source audit
for `Test_WP.aspx` and the Product Tree list itself; a full trace of `CodeStandardDarSanat`
against the eight supplied SharePoint form exports; a recomputed readiness for BOM Item, code
generation and their neighbours; and a decision matrix.

**Out of scope.** Everything that would change the system — see §16.

**The two acceptable outcomes.**

* **OUTCOME A** — an authoritative Product Tree code contract/source is found.
* **OUTCOME B** — the business owner explicitly accepts that BOM V1 cannot generate standard
  part codes until such a contract exists.

**RESULT: OUTCOME B.** No third outcome is produced.

---

## 2. Existing blocker

| ID | Statement as it stands |
| --- | --- |
| **I-1** | The Product Tree *code* source is unknown, so the prefix of every standard part code cannot be produced from authority. |
| **RB-1-P** (sub-item of RB-1) | `BLOCKED` — the tree `code`'s format, validity, authority and change behaviour live in a page (`Test_WP.aspx`) that was never supplied and in a list whose schema is unknown. |
| **RB-1** (the parent) | `RESOLVED-BY-EXISTING-CONTRACT` — `productTreeRef` is an opaque external identifier, tenant-safe, read/reference only. Production does not own the tree. **This phase does not reopen RB-1.** |

The distinction matters: RB-1 (may Production *point at* a tree?) is closed and the BOM Header
ships on it. RB-1-P (may Production *read a tree code*?) is the one this document re-examines.

---

## 3. Repository investigation

A fresh search was run over every `.ts`, `.tsx`, `.prisma`, `.sql`, `.json`, `.md`, `.txt`,
`.yml`, `.yaml` and `.ps1` file in `apps`, `packages`, `docs`, `scripts`, `database`, `initdb`,
`infrastructure`, `lovable`, `.github`, `tools` and `secrets`, excluding `node_modules`,
`.next`, `dist`, `coverage` and the generated Prisma client.

**The decisive count — 1,305 code files scanned (`.ts`/`.tsx`/`.prisma`/`.sql`/`.json` in
`apps`, `packages`, `lovable/src`):**

| Pattern | Hits in code | Where |
| --- | ---: | --- |
| `ProductTree` | **10** | *all ten are Production's own opaque-reference material* (schema comment, generated client, DTO/repository/service files and their specs) |
| `product_tree` | **4** | Production's migration, schema, generated client, schema spec |
| `Test_WP` | **0** | — |
| `CodeStandardDarSanat` | **0** | — |
| `TREECODE` | **0** | — |
| `JazeDerakhteMahsol` | **0** | — |
| `ProdID` | **0** | — |
| `productTreeCodeSnapshot` | **0** | — |

The ten `ProductTree` files, exhaustively:

```
apps/api/prisma/production/schema.prisma
apps/api/src/generated/production-client/index.d.ts
apps/api/src/generated/production-client/schema.prisma
apps/api/src/modules/production/bom/bom.dto.ts
apps/api/src/modules/production/bom/bom.dto.spec.ts
apps/api/src/modules/production/bom/bom.repository.ts
apps/api/src/modules/production/bom/bom.repository.spec.ts
apps/api/src/modules/production/bom/bom.service.ts
apps/api/src/modules/production/bom/bom.service.spec.ts
apps/api/src/modules/production/database/production-prisma.service.ts
```

Every one of them says the same thing: *there is no Product Tree table, and `productTreeRef` is
an opaque `VARCHAR(128)`*. Not one carries a code value, a format, a hierarchy or a contract.

**Full-tree results (`docs/`, all 35 markdown files included):** `CodeStandardDarSanat` 55 hits,
`Test_WP` 12, `TREECODE` 14, `ProdID` 3, `JazeDerakhteMahsol` 13 — **100% inside the
repository's own five BOM documents**. `treeCode` / `tree_code` / `productCode` /
`productStructure` / `productHierarchy` / `treeNode` resolve to HR's `OrganizationTreeNode` (an
*organisational* hierarchy) and `lovable/src`'s `TreeNode` (a UI component). Neither has product
semantics, and neither is treated as Product Tree evidence here.

**Schema and data.** All six Prisma schemas and all 123 `CREATE TABLE`s contain **0**
ProductTree / Project / Part / BOM objects outside Production's single `BomHeader`. The five SQL
dumps in `backups/` (`core_db_pre_49h/49i/49j`, `aria_erp_pre_49j`, `cms_db_pre_49j`) contain
**0** occurrences of `ProductTree`, `product_tree` or `CodeStandardDarSanat` — there is no
data-level tree either.

**Git.** `git rev-list --all --objects` contains **no** object whose path matches `Test_WP`,
`.aspx` or `ProductTree`. The page was never in this repository's history.

**Route inventory.** `nav-catalogue.ts` holds 32 routes; **no** project or product-tree route.

**What the repository therefore contains, in total, about Product Tree:** the fact that an
opaque id may be pointed at (RB-1, closed), and the fact that a `code` field exists and was used
as a prefix (a *source fact*, reconfirmed in §5). It contains **no** code value, no format, no
assignment rule, no ownership and no read contract.


---

## 4. External / source investigation

**PRODUCT TREE CODE SOURCE NOT AVAILABLE.**

The eight supplied SharePoint form exports live *outside* the repository at `E:\Very Mohem`,
exactly as the four prior documents record:

| File | Bytes |
| --- | ---: |
| `BomAdd.txt` | 133,928 |
| `BomEdit.txt` | 94,303 |
| `Kartable Bomadd.txt` | 106,874 |
| `kartable bomEdit.txt` | 71,109 |
| `kharid.txt` | 316,002 |
| `kartabl karid.txt` | 387,639 |
| `sooderCheck.txt` | 94,558 |
| `kartabl SoderCheck.txt` | 104,275 |

That directory contains **exactly those eight files — no subdirectory, no `.aspx`, no
`Test_WP.aspx`, no list export, no CSV/JSON/XML of tree rows.** A recursive search of `E:\` to
depth 6 for `Test_WP.aspx` returned nothing. `E:\Very Mohem` is therefore **not** a place where
the tree-picker source has appeared since the prior closures.

**What the eight files DO contain about the tree** — five reference it (`BomAdd` 23 lines,
`Kartable Bomadd` 9, `kharid` 5, `BomEdit` 4, `kartabl karid` 4):

* The tree-picker buttons open `SitePages/Test_WP.aspx?ProdID=` — present in `BomAdd.txt` at
  lines **573, 709, 817** and in the sibling controls of the other files. **The URL is there; the
  page is not.**
* The tree is read with `form.LoadRecords("http://sari-sharepoint/", "ProductTree", "", criteria,
  …)` — list GUID `{24C41644-1165-4A73-87B0-6CA9556A388B}`, criterion `ID = <selection>`,
  `Lookup_DisplayFieldName="Title"`, `Lookup_ValueFieldName="ID"`.
* **There is not one `SaveRecord(…, "ProductTree", …)` anywhere in the eight files.** The forms
  read the tree; nothing in them creates, edits or assigns a tree or a tree code.

**Sample values: zero.** All eight files were HTML-decoded and scanned for a literal
`<word>-<NNN>` code. **0 matches in every file.** No tree code value, and therefore no example of
a complete `standardPartCode`, exists anywhere in the supplied source, in the repository, or in
the backups.

**Not reconstructed.** Nothing in this document is inferred from a screenshot, a UI label or a
column caption. The conclusion is drawn only from what the files state.


---

## 5. CodeStandardDarSanat trace

Every line below was read from the source this phase re-opened — not carried forward on trust.
The field is «کد استاندارد قطعه» (`standardPartCode`), and the eight questions the brief asks are
answered from `BomAdd.txt` and `Kartable Bomadd.txt` directly.

### 5.1 The eight questions

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | **Who owns it?** | The SharePoint list `BOM_فهرست اقلام پروژه` (`{14BC644C-8F2F-4AC6-A1D7-3B7AE024200D}`) — an **item** field, not a header field. No ERP module owns it; 0 tables, 0 routes. | `SOURCE FACT` — ownership in the ERP is **unsettled** |
| 2 | **Who generates it?** | Two form-side generators, both in client script inside a save button: `BomAdd.txt` → `btn_Save` (the requester adds an item) and `Kartable Bomadd.txt` → `btn_Save` (the manager's task form). **Five write sites total** — `BomAdd` ×3, `Kartable Bomadd` ×2. | `SOURCE FACT` |
| 3 | **Where does the prefix come from?** | `c_ProductTreeRef_Code` / `cr_ProductTreeRef_Code` — a control bound to `ProductTreeRef_x003A_code`, populated at *tree-selection* time from `e.ListItems[0].code` of the `ProductTree` list. | `SOURCE FACT` — **the value itself is unknown** |
| 4 | **Where does the sequence come from?** | Per **(project, product tree)** — `ListQuery2` / `ListQuery3` criteria are `NameProje_MortabetBaBOM = project AND JazeDerakhteMahsol = tree`. **The two generators disagree on WHICH row they read** (see 5.2). | `SOURCE FACT`, disputed (previously `D-7`) |
| 5 | **Is the Product Tree code actually the prefix?** | **Yes.** Both generators compute `c + "-" + <seq>` where `c` is the tree code. Verified in both files. | `SOURCE FACT` |
| 6 | **Exact delimiter / format** | Single ASCII hyphen `-`, exactly one, between prefix and sequence. Full form: `<tree code>-<3-digit sequence>`. | `SOURCE FACT` for the **separator**; `UNKNOWN` for the prefix |
| 7 | **Are leading zeros required?** | **Yes, for the sequence — 3 digits.** `001` … `099`, then `100`, `101`, … | `SOURCE FACT` |
| 8 | **Scope / immutability** | Scope `(project, product tree)`; uniqueness checked by `ListQuery3` on the exact string. **Immutability is NOT enforced by the source** — it overwrites codes in two places. Immutability is an *ERP decision* (M-6d: immutable, renumbering prohibited). | scope = `SOURCE FACT`; immutability = `BUSINESS DECISION` |

### 5.2 The two generators, verbatim

**Generator 1 — `BomAdd.txt`, inside `btn_Save`:**

```js
var codeTree = form.GetControl("c_Control31").GetValue();   // ListQuery2 result
var c        = form.GetControl("c_ProductTreeRef_Code").GetValue();  // tree code = prefix

if (codeTree != "") {
    var index    = codeTree.lastIndexOf("-");
    var lastPart = parseInt(codeTree.substring(index + 1));
    lastPart += 1;
    if (lastPart < 10)       lastPart = `00${lastPart}`;
    else if (lastPart < 100) lastPart = `0${lastPart}`;
    else                     lastPart = `${lastPart}`;

    var code = c + "-" + lastPart.toString();
    form.GetControl("c_code_part").SetValue(code);
} else {
    form.GetControl("c_code_part").SetValue(c + "-" + "001");
}
```

`c_Control31` is `Detail_ListQueryName="ListQuery2"`, `Value_ListQueryField="CodeStandardDarSanat"`.

```
ListQuery2: MaxRows=1, SortField=CodeStandardDarSanat, SortAsc=False
Criteria   = NameProje_MortabetBaBOM = {c_NameProje}
             AND JazeDerakhteMahsol   = {c_ProductTreeRef}
             AND Author               <> {c_Control32}     (NotEquals — "not authored by me")
Attributes = CodeStandardDarSanat
```

So generator 1 takes the **MAXIMUM** code already in scope (excluding rows I authored), parses
its numeric tail, and increments.

**Generator 2 — `Kartable Bomadd.txt`, inside `btn_Save`:**

```js
var str  = e.ListItems[e.ListItems.length - 1].CodeStandardDarSanat;  // LAST row in the list
var c    = form.GetControl("cr_ProductTreeRef_Code").GetValue();
var lastPart = parseInt(str.substring(str.lastIndexOf("-") + 1)) + 1;
lastPart = lastPart.toString();
if (lastPart.length < 3) lastPart = lastPart.padStart(3, '0');
form.GetControl("cr_code_part").SetValue(c + "-" + lastPart);
// empty case:
form.GetControl("cr_code_part").SetValue(c + "-" + "001");
```

Its criteria are `NameProje_MortabetBaBOM = project AND JazeDerakhteMahsol = tree`, with **no
`Author` exclusion and no sort** — so "last in list" is order-undefined.

### 5.3 What the trace proves, and what it does not

**Proved (source-backed):**

* the **separator** is `-`, single, always;
* the **sequence** is 3-digit zero-padded, starts at `001`, increments by 1;
* the **sequence scope** is `(project, product tree)` — the tree is half of the key, not decoration;
* the **uniqueness probe** is `ListQuery3` = project + tree + exact code, refusing with
  «کد استاندارد قطعه نمیتواند تکراری باشد!»;
* the **prefix is the tree's `code` field**, read into the header's `ProductTreeRef_x003A_code`
  snapshot at selection time — **generation does not perform a live tree lookup**;
* the two sequence sources **disagree** (`max-in-scope` vs `last-in-list`), which is the earlier
  `D-7` question.

**NOT proved:**

* **the prefix's own format, assignment rule, authority, lifecycle and immutability** — unknown;
* **any concrete value**, for the tree or for a complete code — zero samples;
* **who maintains `ProductTree.code`** — no writer exists in any of the eight forms, and the
  page that might expose one (`Test_WP.aspx`) was never supplied.

**The assumption is NOT promoted.** The prior closure recorded `CODE = ProductTree-derived prefix
+ sequence`. This phase confirms the *mechanism* from source and does **not** convert it into a
contract for the *prefix value*, because nothing in the repository or the supplied source
supplies one.


---

## 6. Product Tree contract result

| Attribute | Evidence found | Enough to consume? |
| --- | --- | --- |
| **Product Tree ID** | `SOURCE FACT` — list `{24C41644-1165-4A73-87B0-6CA9556A388B}`, `Lookup_ValueFieldName="ID"` | **Yes, as an opaque id** — RB-1 closed on this |
| **A `code` field exists** | `SOURCE FACT` — `e.ListItems[0].code` read into `ProductTreeRef_x003A_code` | **Yes** — the field exists |
| **A `code` VALUE** | **0 samples** in the 8 forms, the repo, the 5 SQL dumps or git history | **NO** |
| **`code` FORMAT** | lives in `Test_WP.aspx`, **never supplied, not present anywhere** | **NO** |
| **Who assigns / generates `code`** | **0 writers** for `ProductTree` in all 8 forms | **NO** |
| **Validity / change behaviour / immutability of `code`** | nothing | **NO** |
| **Tenant behaviour** | SharePoint is one site with no tenant concept | **NO** — the ERP must decide tenancy itself |
| **Read contract (port / model / route)** | 0 models, 0 ports, 0 registrations, 0 routes | **NO** |
| **Authorization contract** | none | **NO** |

**RESULT: `PRODUCT-TREE-CODE-CONTRACT = BLOCKED`.** Not `RESOLVED`, and not `PARTIAL` — the
field's *existence* is a source fact; its *value and format* are absent everywhere that was
searched. This is not OUTCOME A.

---

## 7. Product Tree ownership boundary

**Unchanged, and re-affirmed by this phase: Production must NOT become Product Tree owner.**

| Allowed | Forbidden |
| --- | --- |
| hold `productTreeRef` as an opaque, tenant-safe, read-only `VARCHAR(128)` | a `ProductTree` table or model |
| point at the tree by id | product-tree nodes, hierarchy, parent/child |
| — | product-tree CRUD (create/read/update/delete routes, DTOs or services) |
| — | product-tree code generation or code assignment |
| — | any join, foreign key or cache of tree *structure* |

**Compliance verified this phase** (`apps/api/prisma/production/schema.prisma`,
`apps/api/src/modules/production/**`): one model, `BomHeader`; the column is
`"product_tree_ref" VARCHAR(128) NOT NULL`; **no** `ProductTree` model, **no** `@relation`, **no**
foreign key, **no** hierarchy. The ten files found in §3 are exactly this boundary restated in
comments — none is a tree implementation.

**RB-1 is not reopened.** Nothing found here gives Production a reason, or a right, to hold more
than the reference.

---

## 8. Prefix / code format result

**What is FIXED (source-backed, may be relied on):**

| Element | Value |
| --- | --- |
| Full shape | `<tree code> <sep> <sequence>` |
| Separator | `-` (single ASCII hyphen) |
| Sequence width | 3 digits, zero-padded |
| First sequence | `001` |
| Increment | `+1` |
| Sequence scope | `(project, product tree)` — the tree is half of the key |
| Uniqueness probe | project + tree + exact code → refuse with «کد استاندارد قطعه نمیتواند تکراری باشد!» |
| Where the prefix is read at generation time | the **snapshot on the BOM header** (`ProductTreeRef_x003A_code`), **not** a live tree lookup |
| Cap adopted by the ERP (M-6d / B-3) | padding 3, renumbering prohibited, values beyond **999 refused** |
| Immutability of an assigned code | **ERP decision, closed**: immutable once assigned |

**What is UNKNOWN (and may not be guessed):**

| Element | Status |
| --- | --- |
| The prefix itself — `ProductTree.code` value | **0 samples anywhere** |
| Its format / pattern / length / character set | **unknown** (`Test_WP.aspx` never supplied) |
| Its assignment rule and who owns assignment | **unknown** — 0 writers in the source |
| Whether it is immutable, and what happens on change | **unknown** |
| Whether the prefix is itself tenant-scoped | **unknown** — SharePoint has no tenant concept |
| Whether the source's two sequence generators disagree is *resolved* | settled by the ERP (max-in-scope per `D-7`/M-6); **does not affect the prefix** |

**Not inferred.** `TREECODE-001` appears in the prior documents only as an *illustrative
placeholder* in a code comment. It is not a value, not a sample and not a format — and it is not
adopted here.


---

## 9. I-1 decision

### OUTCOME B — the source does not exist, so I-1 REMAINS BLOCKED

> **"I-1 remains blocked because the Product Tree code/prefix contract is not authoritative."**

**Why OUTCOME A is unavailable.** An authoritative source requires, at minimum, a *value* or a
*format* reachable from authority. This phase searched:

* every code, schema, SQL, JSON and markdown file in the repository (`Test_WP`, `CodeStandardDarSanat`,
  `TREECODE`, `JazeDerakhteMahsol`, `ProdID` → **0 hits in code**);
* all 6 Prisma schemas and all 123 `CREATE TABLE`s (**0** Product Tree objects);
* all 5 SQL dumps in `backups/` (**0** matches);
* the whole git object history (`Test_WP`, `.aspx`, `ProductTree` → **0** objects);
* the eight supplied source files, HTML-decoded (**0** sample codes);
* `E:\Very Mohem` in full (**8 files, no `.aspx`**);
* a recursive search of `E:\` for `Test_WP.aspx` (**0**).

Every avenue returns the same result: the *consumption* of the tree code is documented from
source (§5), the tree code *itself* is nowhere.

**Why OUTCOME B is the honest second outcome.** The brief states it as an acceptable close: the
business owner explicitly accepts that BOM V1 cannot generate standard part codes until a
Product Tree code contract exists. Nothing in this document pre-empts that acceptance — it is
recorded in §15 as the exact input required.

**Explicitly not done.** No prefix was invented, no format assumed, no `TREECODE` placeholder
promoted to a contract, no tree reconstructed from a label, and no third outcome manufactured.

---

## 10. BOM Item readiness

Recomputed for the four pieces the brief names, plus their neighbours. `BLOCKED` means no
implementation may start; `READY` means it could start today without any further decision;
`READY-WITH-EXPLICIT-DECISION` means one named decision unblocks it.

| Capability | Status | Depends on I-1? | Why |
| --- | --- | --- | --- |
| **BOM Item persistence** | **`BLOCKED`** | **Yes** | `standardPartCode` is a **required** field of the item aggregate in the source, and its contract is I-1. The Item cannot be modelled while its identity field has no rule. |
| **Validation (item fields other than the code)** | **`READY`** | No | Every other item field is fully specified: title, industry name, part-type enum `ساختی;استاندارد`, specifications, manufacturer, material, unit, the two coefficients, the header link. |
| **Validation (`standardPartCode` itself)** | **`BLOCKED`** | **Yes** | Required, unique-in-scope, generated — all three depend on the unknown prefix. |
| **Uniqueness — duplicate part NAME within project** | **`READY`** | No | `SOURCE FACT`, independent of the code. |
| **Uniqueness — duplicate `standardPartCode`** | **`BLOCKED`** | **Yes** | The scope is fixed, but there is no value to make unique. |
| **Code generation** | **`BLOCKED`** | **Yes** | No authoritative prefix ⇒ no generation. Per the brief's rule, it is **not** marked READY. |
| **CRUD (item read/write routes)** | **`BLOCKED`** | Partially | Gated by Item persistence (I-1) and by the lifecycle guards. |
| **Frontend** | **`BLOCKED`** | Partially | No item screen exists; it depends on the item model and on lifecycle. |

**Exactly which pieces become READY if I-1 closes:** everything in the table above marked
`BLOCKED`, **at once** — persistence, code validation, code uniqueness, generation, CRUD and the
frontend. That is the whole reason I-1 is on the critical path.

### Item fields still blocked *independently* of I-1

| # | Item facet | Status | Owner |
| --- | --- | --- | --- |
| 1 | **`Code_Ghatae`** (M-4) | `BUSINESS-DECISION-CLOSED` — column **persists verbatim**, excluded from the V1 domain; flagged `legacy-unverified`, promotable later | Business |
| 2 | **Five deferred coefficients** (`KoleGhatae`, `DarHalSef`, `DarHalS`, `Kharidsho`, `KharidS`) | `NOT-IN-V1`, preserved verbatim (M-7a / B-5) | Business |
| 3 | **Coefficient range** | `>= 0`, integer, scale 0, no maximum, no unit claim (B-4) — **decided** | Business (ratify) |
| 4 | **"A BOM must have items before submit"** | Deferred with the Item; deliberately not faked in the Header phase | Module |
| 5 | **Bulk renumber tool** | Not in V1; and M-6d forbids renumbering outright | Module |
| 6 | **`productTreeRef` / `projectRef` on the item** | **`READY`** as opaque, denormalised, tenant-validated-only (RB-1 / M-1) | — |

None of these six is an I-1 input; none of them unblocks I-1.


---

## 11. Code generation readiness

**Status: `BLOCKED`.** Not marked READY — the brief's rule is that code generation may not be
called READY without an authoritative prefix.

### The approved policy, preserved unchanged

Every one of these decisions stands exactly as ratified. This phase did not touch them, and only
the prefix source was examined.

| # | Policy element | Approved value | Status |
| --- | --- | --- | --- |
| 1 | **Scope** | `(tenant, project, product tree)` — tenant added by the Ariya counter rule (CF-5) on top of the source's `(project, tree)` | `CLOSED` |
| 2 | **Start** | `1` (renders `001`) | `CLOSED` |
| 3 | **Increment** | `1` | `CLOSED` |
| 4 | **Padding** | `3` digits, zero-padded | `CLOSED` |
| 5 | **Immutability** | an assigned code never changes | `CLOSED` (B-3) |
| 6 | **Renumbering** | prohibited | `CLOSED` (B-3) |
| 7 | **Counter pattern** | single-statement `INSERT … ON CONFLICT … DO UPDATE … RETURNING`, following the existing **CF-5** precedent | `CLOSED` |
| 8 | **Rollback** | a rolled-back create **never burns a sequence** (a consequence of #7) | `CLOSED` |
| 9 | **Capacity** | values beyond **999** are refused | `CLOSED` (B-3) |
| 10 | **Collision rule** | refuse the save with an explicit message | `CLOSED` (source fact) |
| 11 | **Sequence derivation** | max-in-scope, not last-in-list (the source's two generators disagreed; the ERP picked max-in-scope) | `CLOSED` |
| — | **Prefix source** | the Product Tree's `code` — **whose value and format are unknown** | **`BLOCKED` → I-1** |

### Why it cannot proceed

The counter can allocate the *sequence* safely today: policies 1–10 are all closed, CF-5 exists
in this repository, and a correct implementation is writeable. What it **cannot** do is emit a
string, because `<tree code>-001` has no `<tree code>`.

A code generator with a placeholder prefix would produce codes that are (a) not the ones the
legacy system would have produced, (b) not parseable back into "which tree is this", and
(c) **printed on drawings and quoted in purchase requests** — after which the format can never
be corrected without renumbering, which policy 6 forbids. That is precisely why the prefix is
the single remaining question and why it must not be guessed.

### What `OUTCOME B` would mean here

If the business accepts the deferral, code generation leaves V1 entirely: `standardPartCode`
becomes absent or nullable in the item model, policies 1–11 are **retained as written** and
simply *not executed* until the prefix arrives, and no counter table is created. The policy is
preserved, not discarded — it starts the day the prefix is known.

---

## 12. Migration consequences

No migration was made or altered. The four questions the brief poses are answered from what is
already decided; nothing is invented.

| Question | Answer | Basis |
| --- | --- | --- |
| **Would the resolved Product Tree code be stored?** | **Undecided, and deliberately so.** The legacy schema kept `ProductTreeRef_x003A_code` as a *raw* column on the BOM **header**; the closure permits preserving it as **raw data** (`CF-7` pattern) but explicitly **does not assert it authoritative**. Whether the ERP stores it at all awaits the contract. | RB-1, DF-3 |
| **Would BOM Item store only `productTreeRef`?** | **Yes for the reference.** The item denormalises `projectRef` and `productTreeRef` (`NameProje_MortabetBaBOM`, `JazeDerakhteMahsol`) as opaque ids, verbatim — exactly as the header does. It would store **no** tree structure and no tree table. | RB-1 · M-1 |
| **Is the prefix copied / snapshotted into Item?** | **The source carries no tree-code column on the item.** The item holds only the *whole* `CodeStandardDarSanat`, which embeds the prefix inside the string. So "snapshot into the item" is **not a decision the source makes**, and it is **not invented here**. | source (§5) |
| **Does code generation require a live lookup?** | **No — and this is now a *source fact*, not an assumption.** Both generators read `c_ProductTreeRef_Code` / `cr_ProductTreeRef_Code`, a control bound to the header's `ProductTreeRef_x003A_code` snapshot populated at *selection* time. Generation itself never calls the `ProductTree` list. The only tree read in the whole flow is `LoadRecords(…, "ProductTree", …)` at picker time. | `BomAdd.txt` line 430 / 814 · `Kartable Bomadd.txt` line 587 |

**Consequence stated plainly:** the *shape* of the solution is known — a header-side snapshot
read once, no live lookup at generate time — but **the value that would populate that snapshot
still has no source**, so the semantics of storing it are not settled and are not settled here.


---

## 13. Decision matrix

| Decision | Result | Evidence | Owner | Blocks Item? |
| --- | --- | --- | --- | --- |
| **I-1** — Product Tree **code source** | **`BLOCKED` (OUTCOME B)** | `Test_WP` / `CodeStandardDarSanat` / `TREECODE` / `ProdID` / `JazeDerakhteMahsol` = **0 hits in 1,305 code files** · **0** Product Tree objects in 6 schemas / 123 tables · **0** matches in 5 SQL dumps · **0** git objects · **0** sample codes in the 8 source files · the page itself absent from `E:\` and from the repo | **Business owner (Ariya)** — either supply the source or accept the deferral | **YES** |
| **RB-1-P** — Product Tree **code format** | **`BLOCKED`** — unchanged | The format lives in an unsupplied page; the mechanism (prefix + `-` + 3-digit sequence) is now re-verified from source, but no prefix value or pattern exists anywhere | Platform / future Product Tree | **YES** |
| **Product Tree ownership** | **`RESOLVED` — Production does NOT own it** | Production's schema holds one model and one `product_tree_ref VARCHAR(128)`; **no** `ProductTree` model, **no** `@relation`, **no** foreign key, **no** hierarchy; only 2 `LoadRecords` reads and **0 writes** in the source | Architecture (RB-1, already closed) | **No** |
| **Product Tree code format** | **`KNOWN`: `-` separator, 3-digit padded sequence, scope `(project, tree)`** — **`UNKNOWN`: the prefix** | Both generators verified verbatim (§5.2); `ListQuery2`/`ListQuery3` criteria verified | Architecture + Business | **YES** (the prefix half only) |
| **Product Tree reference contract** | **`READY`** — opaque, tenant-safe, read-only, carried verbatim | RB-1 closed; the column already exists in `production_db` and the BOM Header ships on it | Architecture | **No** |

---

## 14. Remaining blockers

### 14.1 Blocks BOM Item and code generation

1. **I-1 / RB-1-P — the Product Tree code source.** The one blocker this phase was asked to
   close. It did not close, and the reason is evidence, not omission.

### 14.2 Does NOT block anything the Header ships

* RB-1 (the reference) — closed.
* Lifecycle, approver snapshot, self-approval, permissions, entitlement, audit, tenant
  isolation — all shipped in `PHASE-PRODUCTION-BOM-HEADER-IMPLEMENTATION.md`.
* The BOM Header remains a **stable, working, fully tested** foundation and is unaffected.

### 14.3 Settled-but-unratified (a business ratification queue, not an I-1 input)

M-4 (`Code_Ghatae` excluded), M-5b (self-approval refused), M-6d (padding/capacity/immutability),
M-7a (coefficient range), and the preservation rules. These are **decisions**, not discoveries;
they need formal approval, and none of them unblocks I-1.

### 14.4 Deferred, not blocked (DF-1 … DF-5)

Project Management, a Product Tree module, authoritative code snapshots, the change-request
capability, and BOM versioning. Each is a future module, not an input to this decision.

---

## 15. Exact required business input

**Two mutually exclusive inputs will close I-1. Neither can be substituted by another.**

### Input 1 — an authoritative Product Tree code source / format

Any ONE of the following, stated by the owner, is sufficient:

| Option | What must be supplied | What it yields |
| --- | --- | --- |
| **1a** | The `SitePages/Test_WP.aspx` page source **plus** a full export of the `ProductTree` list (`ID`, `Title`, `code` for every row) | format, sample values, assignment rule |
| **1b** | A written statement of the rule: *character set, pattern, length, who assigns `code`, whether it is immutable, and 3+ real example values* | a contract Production can read |
| **1c** | A platform **Product Tree read contract** (a port exposing `(id → code)` with an authorization and tenant story) | an operational source, no local table required |

Minimum content, in all three cases: **the exact format of `ProductTree.code`, at least three
real values, who owns assignment, and whether it may change.**

### Input 2 — explicit acceptance of the deferral

A statement to this effect:

> *"BOM V1 does not generate standard part codes. `standardPartCode` is out of scope for V1. The
> code-generation policy (scope, start, increment, padding 3, immutability, no renumbering, CF-5
> counter, cap 999) is retained and takes effect only when an authoritative Product Tree code
> contract exists."*

**What each input unblocks:**

| | I-1 | Item persistence | Code generation | Policies 1–11 |
| --- | --- | --- | --- | --- |
| Input 1 | closes | **READY** | **READY** | take effect |
| Input 2 | formally deferred | **READY** (code field absent/nullable) | out of scope | retained, dormant |
| neither | **BLOCKED** | **BLOCKED** | **BLOCKED** | retained |

---

## 16. Non-goals

Nothing in this phase did, or will do, any of the following:

1. Modify Production code or the BOM Header. **(0 source files touched)**
2. Create BOM Item, Product Tree or Project.
3. Create any migration, route, DTO, module registration or frontend.
4. Invent a Product Tree code, a prefix format or a sample value.
5. Implement a code generator or a counter table.
6. Add a product-tree table, nodes, hierarchy or CRUD to Production.
7. Change the Product Tree ownership boundary (§7).
8. Alter any of the approved code-generation policies (§11).
9. Manufacture a third outcome between A and B.


---

## 17. Final recommendation

**I-1 does not close. OUTCOME B stands.**

The Product Tree code source does not exist in this repository, in the supplied source, in the
backups, or in the git history. What *was* confirmed this phase is the mechanism — prefix +
`-` + 3-digit sequence, scoped to `(project, product tree)`, generated from a header-side
snapshot with no live tree lookup — and that confirmation strengthens rather than weakens the
case for stopping: the mechanism is now precise enough that a wrong prefix would be wrong
permanently.

**Recommended sequence:**

1. **The BOM Header stays exactly where it is.** It is implemented, tested and stable; nothing in
   this decision touches it.
2. **Do not start BOM Item or code generation.** Both are `BLOCKED` by I-1 under the current
   contract, and the brief's rule forbids calling code generation READY without an authoritative
   prefix.
3. **Ask the business owner for exactly one thing** (§15): *either* an authoritative Product Tree
   code source/format (1a, 1b or 1c), *or* an explicit acceptance that V1 generates no standard
   part codes.
4. **Whichever arrives, treat it as a new phase gate.** Input 1 unblocks Item + generation
   together and may begin immediately; Input 2 unblocks Item persistence alone (with the code
   field absent or nullable) and leaves generation dormant with its policy intact.
5. **Do not partially unblock.** An Item without its identity field, or a generator with a
   placeholder prefix, would create exactly the irreversible artefacts §11 describes.

**The decision, stated once:** *I-1 remains blocked because the Product Tree code/prefix
contract is not authoritative. Production continues to hold `productTreeRef` as an opaque
reference and owns nothing of the tree.*

---
---

# Appendices

## Appendix A — Sources inspected

**Repository (discovery only):**

| Path | What was inspected |
| --- | --- |
| `apps/api/src` | `.ts` — every production, platform, health, auth and module file |
| `apps/api/prisma/*` | all 6 schemas, all 123 `CREATE TABLE`s, the Production baseline |
| `apps/api/runtime-policy.json` | the datasource / owner projection |
| `apps/web`, `lovable/src` | `.ts`/`.tsx` — route inventory, UI components |
| `packages`, `tools`, `infrastructure`, `secrets`, `.github` | file-name and content scan |
| `docs/` (35 `.md`) | all five BOM documents + every other phase contract |
| `initdb/`, `backups/*.sql` | 5 SQL dumps — `ProductTree`/`CodeStandardDarSanat` scan |
| `docker-compose.yml` | initdb mount, database bootstrap |
| git | `rev-list --all --objects`, `status`, `log` |

**Supplied source (outside the repository):**

| Path | Content |
| --- | --- |
| `E:\Very Mohem\` | exactly 8 files: `BomAdd.txt`, `BomEdit.txt`, `Kartable Bomadd.txt`, `kartable bomEdit.txt`, `kharid.txt`, `kartabl karid.txt`, `sooderCheck.txt`, `kartabl SoderCheck.txt` — **no `.aspx`, no subdirectory, no list export** |
| `E:\` (recursive, depth 6) | searched for `Test_WP.aspx` — **0 results** |

**Not present anywhere:** `Test_WP.aspx`, a `ProductTree` list export, any tree-code sample.


## Appendix B — Search / check results

| # | Check | Result |
| --- | --- | --- |
| 1 | `ProductTree` / `productTree` / `product_tree` / `product-tree` in **1,305 code files** | **10 + 4**, 100% Production's own opaque-reference material |
| 2 | `Test_WP` in code | **0** |
| 3 | `CodeStandardDarSanat` in code | **0** |
| 4 | `TREECODE` in code | **0** |
| 5 | `JazeDerakhteMahsol` in code | **0** |
| 6 | `ProdID` in code | **0** |
| 7 | `productTreeCodeSnapshot` in code | **0** |
| 8 | `treeCode` / `productCode` / `productStructure` / `treeNode` | HR `OrganizationTreeNode` + a UI `TreeNode` — no product semantics |
| 9 | All 6 Prisma schemas + 123 `CREATE TABLE`s | **0** ProductTree / Project / Part objects |
| 10 | 5 SQL dumps in `backups/` | **0** matches |
| 11 | `git rev-list --all --objects` for `Test_WP` / `.aspx` / `ProductTree` | **0** objects |
| 12 | `.aspx` / `.ascx` / `.master` files in the repo | **0** |
| 13 | `E:\Very Mohem` — decoded scan for a `<word>-<NNN>` code | **0 matches in all 8 files** |
| 14 | `SaveRecord(…, "ProductTree", …)` in the 8 forms | **0 writes** |
| 15 | `LoadRecords(…, "ProductTree", …)` in the 8 forms | **2 reads**, both in `BomAdd.txt` |
| 16 | `SitePages/Test_WP.aspx?ProdID=` in `BomAdd.txt` | lines **573, 709, 817** (page itself absent) |
| 17 | `nav-catalogue.ts` route inventory | **32 routes, 0** project / product-tree |
| 18 | Production schema compliance (§7) | 1 model, `product_tree_ref VARCHAR(128)`, no relation, no FK |
| 19 | Code-format evidence | separator `-`, padding 3, start `001`, scope `(project, tree)` — **verified in both generators** |

**Excluded as non-evidence** (per the brief's own rule): HR's `OrganizationTreeNode` and
`lovable`'s `TreeNode` (organisational / UI, not product); every Prisma or SQL `project_ref` /
`product_tree_ref` column (Production's own opaque reference, not a tree); and the five BOM
documents' own restatements of these facts (they are *reports* of the source, not new sources).

---


## Appendix C — Evidence

**The generation formula, as it appears in `BomAdd.txt` inside `btn_Save` (decoded):**

```js
var codeTree = form.GetControl("c_Control31").GetValue();
var c        = form.GetControl("c_ProductTreeRef_Code").GetValue();
if (codeTree != "") {
    var index    = codeTree.lastIndexOf("-");
    var lastPart = parseInt(codeTree.substring(index + 1));
    lastPart += 1;
    if (lastPart < 10)       lastPart = `00${lastPart}`;
    else if (lastPart < 100) lastPart = `0${lastPart}`;
    else                     lastPart = `${lastPart}`;
    form.GetControl("c_code_part").SetValue(c + "-" + lastPart.toString());
} else {
    form.GetControl("c_code_part").SetValue(c + "-" + "001");
}
```

**The tree-code read, as it appears in `BomAdd.txt` (~line 430):**

```js
var ss = e.ListItems[0].code;                    // ← the tree's code: the prefix
form.GetControl("c_ProductTreeRef_Code").SetValue(ss);
...
form.LoadRecords("http://sari-sharepoint/", "ProductTree", "", criteria, null, null, false, 0, callback);
```

**The second generator, `Kartable Bomadd.txt` inside `btn_Save`** — note the different sequence
source and the same prefix:

```js
var str  = e.ListItems[e.ListItems.length - 1].CodeStandardDarSanat;   // LAST row, no sort
var c    = form.GetControl("cr_ProductTreeRef_Code").GetValue();
var lastPart = parseInt(str.substring(str.lastIndexOf("-") + 1)) + 1;
lastPart = lastPart.toString();
if (lastPart.length < 3) lastPart = lastPart.padStart(3, '0');
form.GetControl("cr_code_part").SetValue(c + "-" + lastPart);
// empty case:
form.GetControl("cr_code_part").SetValue(c + "-" + "001");
```

**The uniqueness scope — `ListQuery3` (`BomAdd.txt` line 834):**

```
Criteria = NameProje_MortabetBaBOM = {c_NameProje}
           AND JazeDerakhteMahsol   = {c_ProductTreeRef}
           AND CodeStandardDarSanat = {c_code_part};Equals
```

**The sequence input — `ListQuery2` (`BomAdd.txt` line 833):**

```
MaxRows=1  SortField=CodeStandardDarSanat  SortAsc=False
Criteria = NameProje_MortabetBaBOM = {c_NameProje}
           AND JazeDerakhteMahsol   = {c_ProductTreeRef}
           AND Author               = {c_Control32};NotEquals
Attributes = CodeStandardDarSanat
```

**The missing page, as referenced by the three picker buttons in `BomAdd.txt` (lines 573, 709,
817) and their siblings in the other files:**

```
SitePages/Test_WP.aspx?ProdID=
```

**The absence:** no `Test_WP.aspx` anywhere in `E:\ERP` or on `E:\`; no sample code in any of the
eight supplied files; no `ProductTree` row anywhere.


## Appendix D — Files changed

**Exactly one new artifact. Zero source, schema, migration, route or frontend changes.**

| File | Kind |
| --- | --- |
| `docs/PHASE-PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION.md` | **NEW** — this document |

**Verified unchanged this phase:** every file under `apps/api/src/**`, `apps/api/prisma/**`,
`apps/web/**`, `packages/**`, `initdb/**`, `infrastructure/**` and `docker-compose.yml`. No
migration was created or applied, no model was edited, no test was added or modified, and the
BOM Header was not touched.

`git status` shows only the pre-existing working-tree changes carried over from the BOM Header
phase (the four Production Core migrations, `prisma/production/`, `src/modules/production/`, the
health/datasource/permissions wiring) plus this document. Nothing in this phase altered them.

### Adjacent observations — flagged, not acted on

Discovery surfaced two items that are **not I-1 inputs** and were deliberately left alone,
because this phase may not modify source:

1. **`infrastructure/postgres/initdb/01-create-databases.sql` (tracked, mounted by
   `docker-compose.yml` line 39) creates six databases and does NOT create `production_db`.**
   A fresh volume initialised through compose would not have it; the root-level
   `initdb/01-create-databases.sql` (untracked) does create it but is not the file compose
   mounts. *Recommendation: reconcile the two files in a normal implementation phase.*
   → **RESOLVED** in `docs/PHASE-PRODUCTION-DATABASE-DEPLOYMENT-RECONCILIATION.md`: the line was
   integrated into the authoritative mounted file and the competing untracked copy was removed.
2. Both initdb files and `docker-compose.yml` say "six databases"; after the BOM Header phase the
   platform owns seven (plus `app_e2e` in the untracked file). Documentation drift only.
   → **RESOLVED** in the same phase: every "six databases" reference now says seven, and
   `app_e2e` was confirmed unreferenced anywhere and was therefore not carried forward.

---

## Appendix E — Final status

| Item | Value |
| --- | --- |
| **I-1 status** | **`BLOCKED`** — OUTCOME B |
| **Authoritative Product Tree code exists?** | **NO** |
| **Prefix source, if found** | *not found* — the tree's `code` field is known to be read, its value is unknown |
| **Code-format contract, if found** | **Partially**: separator `-`, 3-digit padded sequence, start `001`, scope `(project, product tree)` — **prefix format unknown** |
| **BOM Item implementation-ready?** | **NO** (`BLOCKED` by I-1) |
| **Code generation implementation-ready?** | **NO** (`BLOCKED`; policies 1–11 retained and untouched) |
| **Product Tree ownership** | **unchanged** — Production holds `productTreeRef` only |
| **Remaining blockers** | I-1 / RB-1-P (the one blocker), plus the unratified decision queue in §14.3 |
| **Exact business input required** | §15: *either* an authoritative Product Tree code source/format (1a/1b/1c), *or* explicit acceptance that V1 generates no standard part codes |
| **Files changed** | **1 new document; 0 source files** |
| **Checks performed** | 19 (Appendix B) across the repo, the 8 supplied source files, the backups and git history |
| **Final status** | **`I-1 REMAINS BLOCKED — PRODUCT TREE CODE SOURCE NOT AVAILABLE`** |

**After this phase:** if `I-1` closes with Input 1, BOM Item and code generation may start
immediately and together. If it closes with Input 2, Item persistence may start with the code
field absent/nullable and generation stays dormant. Until one of them arrives, the BOM Header
remains the stable foundation and Item/code generation stay stopped.
