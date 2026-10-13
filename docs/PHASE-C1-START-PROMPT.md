ARIA ERP — START PHASE C1 EXECUTION
COMMERCE / PROCUREMENT

Repository:
E:\ERP

============================================================
AUTHORITATIVE FILES
============================================================

Execution prompt:

E:\ERP\docs\PHASE-C1-EXECUTION-PROMPT.md

Authoritative Commerce specification:

E:\ERP\docs\PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md

These two files already exist and have been validated.

DO NOT regenerate them.
DO NOT rewrite them.
DO NOT reorder them.
DO NOT create a replacement specification.
DO NOT copy the 2394-line specification into your response.

You MUST read both files directly from disk before making implementation changes.

============================================================
YOUR ROLE
============================================================

You are the implementation agent for:

PHASE C1 — COMMERCE / PROCUREMENT

The Commerce domain has NOT yet been implemented.

HR/Mission and the existing Core architecture are already implemented and must
be treated as existing production architecture and precedent.

Your job is to implement C1 against the REAL repository.

You are NOT being asked to redesign Aria.

============================================================
MANDATORY GLOBAL INVARIANTS
============================================================

The following rules are non-negotiable and continue through every step:

NO-GUESS RULE
TENANT ISOLATION
ADDITIVE / SAFE MIGRATIONS
REPOSITORY BOUNDARY
REAL / FALSIFIABLE TESTS
SMALL COMMITS
PHASE-BASED IMPLEMENTATION
EXISTING-PATTERN-FIRST
NO SILENT ARCHITECTURAL DRIFT
BOUNDED-CONTEXT INTEGRITY
UX / UI QUALITY

Hard boundaries:

COMMERCE != CORE
COMMERCE != HR
COMMERCE != SECOND RULE ENGINE

Never solve ambiguity by assumption.

When repository evidence is missing or contradictory:

STOP
→ explain the exact ambiguity
→ cite the files inspected
→ state the smallest required decision
→ do not improvise

============================================================
STEP 1 — READ THE TWO AUTHORITATIVE FILES
============================================================

Read completely:

1.
E:\ERP\docs\PHASE-C1-EXECUTION-PROMPT.md

2.
E:\ERP\docs\PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md

The second file is the authoritative business/architecture specification.

The first file defines execution discipline.

Respect the actual section numbering in the specification.

Important verified references include:

§4  → Commerce Isolation Specification
§6  → Configuration as a Product Capability
§7  → Commercial Configuration
§8  → API DESIGN
§10 → ENTITLEMENT / PERMISSIONS
§18 → REQUIRED FILE STRUCTURE
§19 → PREFLIGHT
§20 → BASELINE TESTS
§21 → IMPLEMENTATION ORDER A–X
§22 → STOP CONDITIONS
§23 → TEST REQUIREMENTS
§26 → REQUIRED LIFECYCLE SEPARATION EXAMPLES
§29 → PURCHASE COMPLETION

============================================================
STEP 2 — DO NOT IMPLEMENT YET
============================================================

Before changing any source file:

perform the complete §19 PREFLIGHT.

Inspect the REAL repository.

At minimum inspect the actual precedents named there, including:

- HR isolation architecture
- HR module
- HR actor
- HR constants
- HR audit gateway
- HR Prisma module/service
- HR schema
- runtime datasource architecture
- architecture boundary specifications
- runtime policy
- env validation
- Rule Engine interfaces/service
- entitlement contract
- package scripts
- Core HR permission/module-registration migrations
- any other file explicitly named by §19

Read the actual files.

Do not infer from memory.

============================================================
STEP 3 — VERIFY CURRENT GIT STATE
============================================================

Before any implementation:

record:

- current HEAD
- branch
- git status
- staged files
- modified tracked files
- relevant untracked files

Do NOT:

git clean -fd

git reset --hard

Do NOT remove unrelated local files.

Do NOT add:

ERP_Structure_v23.xml

lovable/

to Git or architecture.

Do not destroy backups/secrets/local work.

============================================================
STEP 4 — VERIFY ARCHITECTURE
============================================================

Determine from the real repository:

1. How independent databases are declared.
2. How HR owns hr_db.
3. How independent Prisma projects are structured.
4. How generated clients are produced.
5. How Prisma datasource services are isolated.
6. How independent modules are discovered.
7. How application composition registers modules.
8. How Actor resolution works.
9. How tenant isolation is enforced structurally.
10. How repositories are structured.
11. How User Directory is consumed.
12. How Audit Port is consumed.
13. How Notification is consumed.
14. How Entitlement is consumed.
15. How Core permissions are seeded.
16. How ModuleRegistration / ModuleFeature are seeded.
17. How runtime policy is generated.
18. Whether `future-commerce` is structurally required.
19. How existing Rule Engine conditions are represented.
20. What the repository's real package/test commands are.

Do not assume any of these.

============================================================
STEP 5 — RUN BASELINE
============================================================

Run the actual baseline commands required by §20 after verifying their names
from package.json.

Record exact results.

Do not report PASS unless the command actually ran.

Distinguish:

- pre-existing failure
- unrelated failure
- environmental failure
- potential C1 regression

============================================================
STEP 6 — PREFLIGHT REPORT
============================================================

STOP after preflight.

Before implementation, report:

CURRENT HEAD:
<sha>

GIT STATUS:
<actual output>

PREFLIGHT:

Datasource architecture:
PASS / FAIL / AMBIGUOUS

HR bounded-context precedent:
PASS / FAIL / AMBIGUOUS

Prisma isolation:
PASS / FAIL / AMBIGUOUS

Migration pattern:
PASS / FAIL / AMBIGUOUS

Generated client pattern:
PASS / FAIL / AMBIGUOUS

Actor pattern:
PASS / FAIL / AMBIGUOUS

Tenant isolation:
PASS / FAIL / AMBIGUOUS

Repository boundary:
PASS / FAIL / AMBIGUOUS

Identity gateway:
PASS / FAIL / AMBIGUOUS

Audit gateway:
PASS / FAIL / AMBIGUOUS

Notification gateway:
PASS / FAIL / AMBIGUOUS

Entitlement:
PASS / FAIL / AMBIGUOUS

Rule Engine compatibility:
PASS / FAIL / AMBIGUOUS

Runtime wiring:
PASS / FAIL / AMBIGUOUS

Permission/module registration:
PASS / FAIL / AMBIGUOUS

Package/test scripts:
PASS / FAIL / AMBIGUOUS

Baseline tests:
PASS / FAIL / AMBIGUOUS

`future-commerce`:
REQUIRED / FORBIDDEN / TARGET / NOT REQUIRED
+ repository evidence

UNRESOLVED AMBIGUITIES:
NONE
or exact list

============================================================
STEP 7 — STOP GATE
============================================================

Do NOT begin implementation if:

- a required architecture pattern is unclear
- a business rule requires invention
- an existing precedent contradicts the proposed implementation
- a required Rule Engine capability is unavailable
- a required Core/HR relationship would require duplicated state
- a migration would need destructive behavior
- a gate requires unrelated files
- implementation would violate the repository boundary

In these cases:

STOP and report.

============================================================
STEP 8 — ONLY AFTER PREFLIGHT PASSES
============================================================

If and only if preflight is clean and there are no unresolved blocking
ambiguities, continue with the exact implementation order from §21:

A datasource ownership
B Prisma project
C migration infrastructure
D generated Commerce client
E Commerce Prisma service/module
F runtime/health wiring
G Commerce module shell
H platform gateways
I actor resolution
J permission/entitlement wiring
K initial schema/migration
L Purchase domain
M Workflow configuration
N Workflow execution
O Line-level routing
P Commercial foundation
Q Payment history
R Receiving foundation
S Return foundation
T isolation tests
U tenant tests
V lifecycle tests
W integration tests
X full validation

There are exactly 24 implementation items.

Do not replace this sequence with another sequence.

============================================================
STEP 9 — IMPLEMENTATION BOUNDARIES
============================================================

Commerce must own its own:

commerce_db
Prisma schema
generated client
migrations
module
repositories
business state
workflow configuration
workflow execution state
procurement lifecycle

Core continues to own:

identity
RBAC
entitlement
platform contracts
platform composition

HR continues to own:

personnel
employment
organization/personnel state

External identities are opaque references unless an explicit approved contract
states otherwise.

No cross-database FK.

No cross-database join.

No shared Prisma client.

No shared migration history.

No Core Prisma inside Commerce.

No HR Prisma inside Commerce.

============================================================
STEP 10 — WORKFLOW RULE
============================================================

Commerce Workflow is a Commerce-owned orchestration subsystem.

It is NOT a generic workflow platform.

It is NOT a second Rule Engine.

Use the existing pure Rule Engine.

Forbidden:

CommerceRuleEngine
eval
new Function
dynamic executable rules
duplicated rule evaluator
SQL rule language

Published workflow configuration is immutable.

Running workflow instances remain pinned to their starting version.

Configuration must be capable of changing business workflow behavior without
source-code deployment where the specification requires it.

But configuration can NEVER bypass:

tenant isolation
authorization
audit
financial integrity
entity integrity
history protection
versioning
repository boundaries

============================================================
STEP 11 — TENANT / REPOSITORY RULE
============================================================

Every public Commerce repository method:

tenantId FIRST

Every tenant-scoped query:

tenant-qualified

DTOs:

NO tenantId

Services:

NO req access

Controllers:

use server-derived Commerce actor

Do not use unsafe id-only persistence.

Where the specification requires it:

NO findUnique

NO lifecycle delete
NO deleteMany

============================================================
STEP 12 — LINE-LEVEL RULE
============================================================

Purchase Request may contain:

STANDARD
NON_STANDARD
SERVICE

in the same document.

Workflow/routing can be:

document-level
line-level
mixed

Different lines may route to different commercial actors.

Do not collapse line-level execution into document-only state.

============================================================
STEP 13 — LIFECYCLE RULE
============================================================

Preserve the lifecycle separation required by §26.

Do not collapse:

workflow
commercial state
purchase/fulfillment
payment
receiving progress

into one enum.

Where state is derived from append-only history:

the append-only records are authoritative.

Returns are child lifecycles.

Purchase completion follows §29.

Do not invent completion semantics outside the specification.

============================================================
STEP 14 — TEST RULE
============================================================

Tests must be falsifiable.

Especially verify:

- tenant isolation
- repository boundaries
- Commerce database isolation
- no cross-db FK
- no identity duplication
- single identity gateway
- single audit gateway
- no second Rule Engine
- line-level routing
- workflow version immutability
- running instance pinning
- lifecycle separation
- append-only history
- permission/entitlement enforcement
- actor-derived tenant context

Every important static architecture assertion needs a falsifiability comment.

============================================================
STEP 15 — MIGRATION RULE
============================================================

Never modify old migrations simply to add Commerce.

Create additive Commerce migrations.

Commerce business tables belong in:

apps/api/prisma/commerce/

Core migrations may contain only the platform registration that the existing
architecture requires, such as Commerce permissions/module/feature registration.

Follow the actual HR migration precedent.

============================================================
STEP 16 — COMMIT RULE
============================================================

Use small, coherent commits.

Never create one giant implementation commit.

Do not mix unrelated changes.

After each coherent block:

- run focused tests
- inspect git diff
- verify no unrelated files changed

============================================================
STEP 17 — FINAL VALIDATION
============================================================

Once A–X is complete:

run the exact §23 TEST REQUIREMENTS.

Before execution confirm actual script names.

Run all required:

- architecture tests
- policy tests
- Commerce tests
- HR regression tests
- runtime policy regeneration/validation
- build
- migration verification when live commerce_db exists

If live commerce_db is unavailable:

state:

Migration runtime verification:
NOT PERFORMED — commerce_db unavailable.

Never pretend it passed.

============================================================
STEP 18 — FINAL GATE VERIFICATION
============================================================

Verify:

I1–I20

G1–G18

Every PASS must have evidence.

If a gate cannot be verified:

UNVERIFIED

Do not convert UNVERIFIED to PASS based on intent.

============================================================
STEP 19 — FINAL REPORT
============================================================

At completion report:

1. HEAD before implementation
2. final HEAD
3. branch
4. final git status
5. files created
6. files modified
7. files intentionally untouched
8. preflight results
9. A–X results
10. I1–I20 results
11. G1–G18 results
12. baseline tests
13. focused tests
14. final §23 tests
15. typecheck
16. lint
17. format
18. build
19. migration result
20. runtime-policy result
21. deviations
22. unresolved ambiguities
23. stop conditions encountered
24. commit SHAs
25. worktree status

Use actual commands and actual results.

Do not fabricate success.

============================================================
FINAL COMMAND
============================================================

BEGIN WITH:

1. Read both authoritative files.
2. Audit the real repository.
3. Verify Git.
4. Run baseline tests.
5. Report PREFLIGHT ONLY.

DO NOT IMPLEMENT BEFORE THE PREFLIGHT REPORT.

After a clean preflight, continue automatically through §21 A–X,
respecting all global invariants.

When C1 is complete:

STOP.

Do not proceed to a later Commerce phase.

END.
