PHASE C1 EXECUTION PROMPT — COMMERCE / PROCUREMENT
ARIA ERP — ARCHITECTURE-FIRST / IMPLEMENTATION

Repository:
E:\ERP

AUTHORITATIVE SPECIFICATION:
E:\ERP\docs\PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md

============================================================
0. AUTHORITATIVE SPECIFICATION — NON-NEGOTIABLE
============================================================

The authoritative specification for this phase is:

E:\ERP\docs\PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md

The specification has already been structurally restored and validated.

It contains:

- §0 through §32 in canonical order
- §5.1 through §5.17 contiguous
- I1 through I20
- G1 through G18
- the complete Commerce bounded-context architecture
- domain model requirements
- API requirements
- configuration requirements
- implementation order A–X
- stop conditions
- test requirements
- lifecycle-separation examples
- purchase-completion requirements

Treat this file as the source of truth.

DO NOT:

- regenerate it
- rewrite it
- summarize it instead of reading it
- reorder it
- invent omitted requirements
- replace business terminology
- reinterpret ambiguous business rules
- silently resolve conflicts
- weaken gates
- create a new architecture beside it

Read the actual file before writing implementation code.

============================================================
1. GLOBAL ARIA ENGINEERING INVARIANTS
   — MANDATORY IN THIS PHASE AND ALL FUTURE PHASES
============================================================

These invariants are permanent Aria engineering rules.

They MUST survive:

- every implementation step
- every sub-phase
- every refactor
- every migration
- every commit
- every future domain

------------------------------------------------------------
1.1 NO-GUESS RULE
------------------------------------------------------------

Never invent:

- business rules
- domain semantics
- role semantics
- manager hierarchy
- organization behavior
- permission names
- workflow behavior
- entity relationships
- persistence architecture
- migration strategy
- runtime behavior
- resolver semantics
- API contracts
- naming conventions

Required process:

ACTUAL REPOSITORY
      ↓
INSPECT
      ↓
FIND EXISTING PRECEDENT
      ↓
UNDERSTAND
      ↓
REUSE / ADAPT
      ↓
IMPLEMENT
      ↓
TEST

If repository evidence is absent, contradictory, or ambiguous:

STOP.

Report the exact ambiguity.

Do NOT choose the most convenient interpretation.

------------------------------------------------------------
1.2 TENANT ISOLATION
------------------------------------------------------------

Aria is multi-tenant.

Tenant isolation is structural.

Required flow:

HTTP
 ↓
Controller
 ↓
Actor
 ↓
Service
 ↓
Repository
 ↓
Prisma
 ↓
Tenant-scoped database query

Rules:

- tenantId is server-derived
- DTOs MUST NOT accept tenantId
- repository public methods take tenantId FIRST
- every tenant-scoped query is tenant-qualified
- every tenant-scoped write is tenant-qualified
- no cross-tenant lookup
- no global fallback query
- no unsafe id-only access
- no tenant context inferred from DTO/body/query parameters

Where required by the existing architecture:

- `findUnique` is forbidden
- use tenant-qualified access patterns
- compound unique constraints begin with tenantId
------------------------------------------------------------
1.3 ADDITIVE / SAFE MIGRATIONS
------------------------------------------------------------

Migration invariant:

ADD, DON'T DESTROY.

Default behavior:

- new additive migration
- new tables
- new columns
- new indexes
- new constraints
- preserved history/data

Forbidden unless explicitly justified by authoritative repository evidence:

- editing old migrations
- dropping existing tables for convenience
- destructive data migration
- destructive schema rewrite
- rollback/recreate merely to simplify development
- schema-push when repository convention requires migrations

If destructive change appears necessary:

STOP.

Report exactly why.

------------------------------------------------------------
1.4 REPOSITORY BOUNDARY
------------------------------------------------------------

Persistence access MUST remain behind repositories.

Forbidden:

Controller → Prisma
Controller → database
Service → Core Prisma
Service → HR Prisma
Commerce → foreign generated client
Cross-database SQL
Cross-database join
Shared persistence implementation

Expected:

Controller
 ↓
Application Service
 ↓
Repository
 ↓
Commerce Prisma
 ↓
commerce_db

Business logic must not leak into controllers.

------------------------------------------------------------
1.5 REAL / FALSIFIABLE TESTS
------------------------------------------------------------

Tests MUST detect realistic regressions.

Do NOT create:

- vacuous assertions
- placeholder tests
- tests that only prove mocks call mocks
- tests that pass when the architecture is broken
- assertions added merely to increase apparent coverage

Every important architecture assertion must explain:

1. What concrete regression it prevents.
2. Why compiler/type checking cannot catch that regression.

Existing architectural assertions MUST be preserved.

If a legitimate change alters an existing expected count/list:

- update ONLY the affected expectation
- add a comment explaining the new legitimate value
- never delete the assertion

Never lower assertion strength to make tests green.

------------------------------------------------------------
1.6 SMALL COMMITS / SMALL CHANGES
------------------------------------------------------------

Changes must remain:

- coherent
- phase-specific
- reviewable
- minimal

Do NOT mix:

- unrelated refactors
- broad formatting
- opportunistic cleanup
- unrelated bug fixes
- unrelated UI changes

Use small commits.
------------------------------------------------------------
1.7 PHASE-BASED IMPLEMENTATION
------------------------------------------------------------

Current scope:

PHASE C1 — COMMERCE / PROCUREMENT

Respect the authoritative implementation order.

Do not expand C1 into:

- complete frontend
- advanced reporting
- asynchronous workers
- queues
- schedulers
- cron
- unrelated Finance implementation
- unrelated Warehouse implementation
- unrelated HR work

When C1 is complete:

STOP.

Report.

------------------------------------------------------------
1.8 EXISTING-PATTERN-FIRST
------------------------------------------------------------

HR is the primary architectural precedent.

Also inspect:

- Correspondence
- platform-port implementations
- Rule Engine
- runtime datasource architecture
- permission/entitlement architecture
- existing migration conventions

Do not invent a new pattern when an existing one can be reused.

If an existing pattern cannot be reused:

prove why from the repository.

------------------------------------------------------------
1.9 BOUNDED-CONTEXT INTEGRITY
------------------------------------------------------------

Hard invariants:

COMMERCE != CORE
COMMERCE != HR
COMMERCE != SECOND RULE ENGINE

Commerce is a PEER bounded context.

------------------------------------------------------------
1.10 NO SILENT ARCHITECTURAL DRIFT
------------------------------------------------------------

Never:

- weaken a gate
- bypass a repository
- lower test thresholds
- remove isolation checks
- create duplicate platform capabilities
- duplicate HR state
- inject Commerce persistence into Core
- create a second Rule Engine
- hard-code configurable workflow behavior

------------------------------------------------------------
1.11 UX / UI QUALITY (ARIA)
------------------------------------------------------------

UX is a permanent engineering invariant — mandatory in every future phase
that ships UI, alongside every invariant above.

Rules:

- the interface must be genuinely UX-centered, not only visually clean;
- what looks simple must actually be simple, and what looks usable must
  actually be usable at first contact;
- hidden, layered or implicit controls are forbidden as the PRIMARY
  interaction model — the main flow must be visible;
- functional complexity may exist only inside an Advanced mode;
- Basic mode: a first-time user must complete the main flow without training;
- no feature may sit behind expert-only interaction patterns;
- aesthetics serve usability — never the reverse.

Acceptance criteria for any UI work:

- the main flow is obvious without explanation;
- the interface is judged by someone who sees it for the FIRST time,
  not by its author (designer or developer);
- if a first-time user needs training for the main flow, the UI fails.

============================================================
2. STEP 0 — READ THE AUTHORITATIVE SPEC
============================================================

Read:

E:\ERP\docs\PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md

Read the entire specification before implementation.

Use the actual section titles from that file.

Particular attention is required for:

- §1 — Greenfield confirmation
- §2 — I1–I20 isolation dimensions
- §3 — G1–G18 mandatory gates
- §4 — Commerce Isolation Specification
- §5 — Domain Model
- §6 — Configuration as a Product Capability
- §7 — Commercial Configuration
- §8 — API DESIGN
- §10 — ENTITLEMENT / PERMISSIONS
- §18 — REQUIRED FILE STRUCTURE
- §19 — PREFLIGHT
- §20 — BASELINE TESTS
- §21 — IMPLEMENTATION ORDER
- §22 — STOP CONDITIONS
- §23 — TEST REQUIREMENTS
- §26 — REQUIRED LIFECYCLE SEPARATION EXAMPLES
- §29 — PURCHASE COMPLETION
- all remaining validation/reporting sections through §32

Do not infer section contents from numbering.

The authoritative file is controlling.
============================================================
3. STEP 1 — PREFLIGHT
============================================================

Before writing implementation code, fully execute the preflight required by §19.

------------------------------------------------------------
3.1 Read all files explicitly named by §19
------------------------------------------------------------

Inspect the actual repository files named in the §19 preflight list, including
the actual:

- HR isolation spec
- HR module
- HR actor
- HR constants
- HR audit gateway
- HR Prisma module/service
- HR schema
- runtime datasource wiring
- architecture boundaries spec
- runtime policy spec
- env validation
- Rule Engine contracts/service
- entitlement contract
- package scripts
- every other file explicitly named by §19

Do not rely on memory.

Do not inspect only a truncated excerpt when §19 requires full inspection.

------------------------------------------------------------
3.2 Permission/module registration precedent
------------------------------------------------------------

Locate the actual Core migrations that establish the HR:

- permission namespace
- module registration
- feature registration

pattern.

Inspect those migrations directly.

Adapt the established pattern for Commerce.

Do not invent a registration architecture.

------------------------------------------------------------
3.3 Package scripts
------------------------------------------------------------

Inspect:

- repository root package.json
- apps/api/package.json

Determine actual:

- test script names
- Prisma script names
- architecture/policy script names
- build scripts

Do not assume names.

------------------------------------------------------------
3.4 Runtime propagation
------------------------------------------------------------

Inspect:

- runtime-datasources.ts
- runtime-policy.spec.ts
- architecture-boundaries.spec.ts
- runtime health composition
- Docker runtime mappings
- datasource probe registration
- relevant architecture assertions

Determine whether:

`future-commerce`

is:

- required
- forbidden
- required only as a declared target
- represented differently

Follow repository precedent.

Do not guess.

------------------------------------------------------------
3.5 Baseline tests
------------------------------------------------------------

Run baseline tests BEFORE making changes.

Record exact:

- command
- exit code
- suite count
- test count
- failures
- warnings relevant to implementation

============================================================
4. PREFLIGHT REPORT — BEFORE IMPLEMENTATION
============================================================

Report:

PREFLIGHT

Repository:
- current HEAD
- current git status

Architecture:
- datasource architecture: PASS/FAIL
- HR bounded-context precedent: PASS/FAIL
- Correspondence precedent: PASS/FAIL
- Prisma isolation pattern: PASS/FAIL
- migration pattern: PASS/FAIL
- generated-client pattern: PASS/FAIL
- actor pattern: PASS/FAIL
- tenant-isolation pattern: PASS/FAIL
- repository pattern: PASS/FAIL
- identity gateway pattern: PASS/FAIL
- audit gateway pattern: PASS/FAIL
- notification gateway pattern: PASS/FAIL
- entitlement pattern: PASS/FAIL
- Rule Engine compatibility: PASS/FAIL
- runtime propagation understood: PASS/FAIL
- Core registration pattern understood: PASS/FAIL
- package scripts verified: PASS/FAIL
- baseline tests: PASS/FAIL

Unresolved ambiguity:
- NONE
OR
- exact ambiguity

If a blocking item fails or remains genuinely ambiguous:

STOP.

Do not begin implementation.
============================================================
5. EXACT IMPLEMENTATION ORDER
============================================================

Implement in the exact order mandated by §21:

A. datasource ownership
B. Prisma project
C. migration infrastructure
D. generated Commerce client
E. Commerce Prisma service/module
F. runtime/health wiring
G. Commerce module shell
H. platform gateways
I. actor resolution
J. permission/entitlement wiring
K. initial schema/migration
L. Purchase domain
M. Workflow configuration
N. Workflow execution
O. Line-level routing
P. Commercial foundation
Q. Payment history
R. Receiving foundation
S. Return foundation
T. isolation tests
U. tenant tests
V. lifecycle tests
W. integration tests
X. full validation

There are exactly 24 items.

Do not reorder them.

Do not silently skip them.

Do not replace this sequence with a custom implementation sequence.

The following sections OVERLAY this order and provide their specific requirements:

- §5 → domain/schema semantics
- §6 → configuration as a product capability
- §7 → commercial configuration
- §8 → API DESIGN
- §10 → entitlement / permissions
- §18 → required file structure
- §19 → preflight
- §20 → baseline tests
- §22 → stop conditions
- §23 → final test requirements
- §26 → lifecycle separation examples
- §29 → purchase completion
============================================================
6. COMMERCE BOUNDED-CONTEXT RULE
============================================================

Commerce MUST be a peer bounded context.

Persistence ownership:

core_db
→ Platform / Identity / RBAC / Entitlement

hr_db
→ Personnel / Employment / Organization

commerce_db
→ Procurement / Purchase / Commercial / Workflow

Commerce MUST have:

- own database
- own Prisma project
- own generated client
- own migration history
- own module
- own permission namespace
- own isolation regression suite

There is:

NO shared Prisma client
NO shared migration history
NO cross-db FK
NO cross-db join
NO shared repository implementation

Commerce owns procurement business state.

============================================================
7. CORE / HR / COMMERCE BOUNDARY
============================================================

Core owns:

- identity
- tenant/platform identity
- RBAC
- entitlement
- platform audit contract
- platform notification contract
- composition responsibilities

HR owns:

- personnel
- employment
- organization/personnel state

Commerce owns:

- procurement
- purchase requests
- purchase lines
- commercial state
- procurement workflow
- Commerce configuration
- receiving/returns/payment history within Commerce scope

External identifiers may be opaque strings.

Do not duplicate authoritative identity/personnel models.

Do not create:

- User
- Tenant
- Role
- Permission
- credential storage
- duplicated HR security state

inside commerce_db.

If a Commerce feature cannot work without duplicating HR/Core authoritative state:

STOP.
============================================================
8. RULE ENGINE BOUNDARY
============================================================

Commerce Workflow is a Commerce-owned orchestration layer.

It is NOT:

- a generic Core workflow platform
- a second Rule Engine
- a replacement for the existing pure Rule Engine

Allowed Commerce workflow concerns:

- definitions
- versions
- steps
- transitions
- execution instances
- step instances
- routing
- actor resolution

Condition evaluation MUST use the existing pure Rule Engine.

Forbidden:

- CommerceRuleEngine
- duplicate condition evaluator
- eval
- new Function
- dynamic executable code
- SQL-as-rule-language
- duplicated rule-engine semantics

If the existing Rule Engine cannot express a required condition:

STOP under §22.

Propose the required platform extension instead of creating a parallel engine.

============================================================
9. CONFIGURATION AS PRODUCT CAPABILITY
============================================================

Configuration must allow business behavior to change without source-code
deployment where the authoritative specification requires it.

Examples include:

- workflow step order
- step name
- mandatory/optional
- actor
- commercial liaison
- conditions
- thresholds
- line routing
- visible fields

Configuration versions must be immutable once published.

Existing running purchases remain pinned to their starting version.

Do NOT hard-code organizational workflow behavior into TypeScript.

At the same time, configuration MUST NOT be allowed to bypass:

- authorization
- tenant isolation
- audit
- financial integrity
- entity integrity
- immutable history
- persistence boundaries
- versioning rules

============================================================
10. COMMERCIAL CONFIGURATION
============================================================

Follow §7 exactly.

Commercial liaison / group assignment and business-facing role labels are
configuration concerns where required by the authoritative specification.

Do not hard-code:

Group A → Liaison X
Group B → Liaison Y

unless repository evidence and explicit business configuration require seeded
defaults.

Do not invent organizational mappings.
============================================================
11. LINE-LEVEL WORKFLOW
============================================================

A PurchaseDocument may contain mixed line types.

Required line types:

STANDARD
NON_STANDARD
SERVICE

A single request can contain all three.

Workflow scope must support:

- document scope
- line scope
- mixed document + line scope

A document may route different lines to different actors.

A line may:

- route to Actor A
- route to Actor B
- move sequentially
- participate in parallel work
- be returned for correction
- complete independently

Document-level status must not overwrite line-level workflow history.

============================================================
12. LIFECYCLE SEPARATION
============================================================

Do not collapse the independent lifecycle dimensions.

Use the authoritative definition in §26.

The implementation must preserve separation among the required Commerce
lifecycle dimensions, including where the specification defines projections
derived from append-only child records.

Do not use one giant status enum.

Do not turn payment state into workflow state.

Do not turn receiving state into purchase-request workflow state.

Do not turn return state into parent mutation.

============================================================
13. PURCHASE COMPLETION
============================================================

Follow §29 exactly.

Completion/finalization must preserve the semantic distinction between:

- lifecycle state
- historical records
- completion/finalization

Where the specification requires finalization/locking:

- protect against accidental activation
- provide appropriate confirmation/warning
- prevent inappropriate historical mutation

Do not invent additional completion semantics.
============================================================
14. ACTOR / TENANT RULE
============================================================

Every Commerce controller must use established authentication,
authorization and entitlement patterns.

Use the established server-derived actor pattern:

- authentication guard
- Commerce permission
- ModuleEntitlementGuard
- resolveCommerceActor(req)

The actor carries authoritative:

- tenant
- user
- permissions
- request context required by Commerce

Services MUST NOT read `req`.

DTOs MUST NOT define caller-controlled tenantId.

============================================================
15. REPOSITORY RULE
============================================================

Every public Commerce repository method:

tenantId FIRST.

Every tenant-scoped query must contain tenantId.

Avoid:

`findUnique`

where tenant predicates are structurally required.

Do not use unsafe id-only update/delete operations.

Lifecycle rows must not be deleted.

Do not bypass repositories.

============================================================
16. PLATFORM GATEWAYS
============================================================

Identity:

Exactly one Commerce identity integration surface must consume the existing
User Directory contract.

Audit:

Exactly one Commerce audit integration surface must consume AUDIT_PORT.

Notification:

Use the established notification platform/gateway pattern.

Do not let arbitrary Commerce files import platform contracts directly when
the C1 specification requires a single gateway surface.

============================================================
17. MIGRATION RULE
============================================================

Commerce gets its own:

apps/api/prisma/commerce/schema.prisma

apps/api/prisma/commerce/migrations/

migration_lock.toml

generated client:

apps/api/src/generated/commerce-client

Commerce business tables MUST NOT be created inside core_db.

Core migrations may establish:

- Commerce permissions
- Commerce module registration
- Commerce feature registration

only where the existing platform architecture requires these records.

Use the real HR migration precedent.

============================================================
18. ISOLATION REGRESSION SPEC
============================================================

Create:

apps/api/src/modules/commerce/commerce-isolation.spec.ts

Model its reasoning style after the actual HR isolation spec.

It must make the Commerce architecture executable.

Verify the complete C1 §4 contract.

At minimum:

1. one identity integration surface
2. one audit integration surface
3. no Core Prisma access
4. no HR Prisma access
5. own Commerce Prisma project
6. own generated client
7. own migration history
8. own migration lock
9. no forbidden identity/security models
10. no cross-database relations
11. no lifecycle deletion path
12. actor-derived tenant/user context
13. structural tenant scoping
14. no forbidden async work
15. configuration-driven thresholds
16. no Core-domain-by-injection
17. no second rule engine
18. no DTO tenantId
19. no unsafe persistence pattern
20. required Commerce module composition
21. required datasource ownership
22. permission namespace boundaries
23. audit routing
24. versioning/immutability requirements where statically enforceable

Every important assertion must contain a falsifiability comment.
============================================================
19. STOP CONDITIONS — AUTHORITATIVE §22
============================================================

Use §22 of the authoritative specification as the source of truth.

STOP if any S1–S8 condition is triggered.

Do not continue simply because implementation can be forced through.

Especially STOP when:

- a required architecture pattern is unavailable
- a Rule Engine capability is insufficient
- identity duplication becomes necessary
- lifecycle separation cannot be maintained
- migration convention prevents safe implementation
- unrelated existing tests break materially
- a new architectural pattern must be invented
- repository evidence contradicts the requested implementation
- an unresolved business-policy decision is required

When stopping:

report:

- exact stop condition
- evidence
- files inspected
- why implementation cannot safely continue
- smallest decision/extension required

============================================================
20. BASELINE TESTS
============================================================

Before changing code:

Run the actual baseline test commands determined during §19 preflight.

Do not rely on assumed script names.

Record actual results.

Baseline failures must be distinguished from regressions introduced by C1.

============================================================
21. IMPLEMENTATION DISCIPLINE
============================================================

For each implementation item A–X:

1. inspect relevant precedent
2. make the smallest coherent change
3. run focused tests
4. inspect diff
5. verify boundary conditions
6. continue only after validation

Do not stack many speculative changes before testing.
============================================================
22. TEST IMPLEMENTATION DISCIPLINE
============================================================

Tests must cover actual behavior.

At minimum, where applicable:

- tenant isolation
- repository tenant scoping
- mixed line types
- line-level routing
- sequential workflow
- parallel workflow
- conditional workflow
- immutable published configuration
- running-instance version pinning
- append-only history
- lifecycle independence
- no cross-database relation
- no identity duplication
- actor-derived tenant
- permission/entitlement enforcement
- audit path
- invalid over-receipt constraints where within C1 scope
- return child lifecycle boundaries where within C1 scope

Do not create fake business logic solely for tests.

============================================================
23. FINAL TEST REQUIREMENTS
============================================================

At the end run the exact test commands defined by §23
(TEST REQUIREMENTS).

Before running them:

- verify package script names during §19 preflight
- verify workspace names
- verify command syntax against actual package.json

Do NOT use §8 as the source of final test commands.

§8 is API DESIGN.

Final validation is controlled by §23.

Run the actual commands specified there, including where applicable:

- architecture tests
- policy tests
- Commerce targeted tests
- HR regression tests
- runtime policy regeneration
- build
- Commerce migration against a live commerce_db when available

If commerce_db is unavailable:

state clearly:

Migration runtime verification:
NOT PERFORMED — commerce_db unavailable.

Do not claim it passed.
============================================================
24. BUILD / TYPECHECK / LINT / FORMAT
============================================================

Run the repository-required:

- TypeScript checks
- API build
- relevant frontend checks only if the authoritative C1 scope explicitly
  requires them
- ESLint
- Prettier
- architecture tests
- policy tests
- Commerce tests
- HR regression tests

Distinguish:

- pre-existing failure
- new failure
- unrelated failure
- actual C1 regression

Never hide a failure.

============================================================
25. GATE VERIFICATION
============================================================

At the end verify:

I1–I20

and:

G1–G18

Do not mark a gate PASS because the code was intended to satisfy it.

Each PASS must have evidence from:

- executed test
- actual source inspection
- filesystem inspection
- generated artifact
- migration result
- build result
- runtime validation where applicable

If a gate is not verifiable:

mark:

UNVERIFIED

not PASS.

============================================================
26. GIT SAFETY
============================================================

Before work record:

- HEAD
- git status
- tracked modifications
- staged changes
- relevant untracked files

Never use:

git clean -fd
git reset --hard

Never perform broad deletion.

Never overwrite unrelated local work.

Do not add local-only files such as:

- ERP_Structure_v23.xml
- lovable/

to Git or architecture merely because they exist.

Do not delete unrelated:

- backups
- secrets
- local files
- scratch/operator artifacts

without explicit evidence and scope.
============================================================
27. COMMIT DISCIPLINE
============================================================

Use small coherent commits.

Keep workstreams separated.

Suggested logical boundaries, subject to actual repository conventions:

1. datasource ownership
2. Prisma project
3. migration infrastructure
4. generated client
5. Commerce Prisma service/module
6. runtime/health
7. module shell
8. platform gateways
9. actor resolution
10. permission/entitlement
11. schema/domain
12. workflow configuration
13. workflow execution
14. line-level routing
15. commercial foundation
16. payment/receiving/return foundations as permitted by A–X
17. isolation tests
18. tenant/lifecycle/integration tests
19. final validation

Do not combine unrelated concerns.

Do not stage unrelated files.

============================================================
28. NO BROAD CLEANUP
============================================================

This phase is NOT a repository cleanup phase.

Do not:

- rename unrelated files
- reformat unrelated modules
- delete scratch files unrelated to C1
- refactor HR because of style preference
- rewrite existing Core architecture

Only change what is required by C1 and its verified architecture dependencies.

============================================================
29. REQUIRED FINAL REPORT
============================================================

At completion provide:

A. CURRENT HEAD BEFORE IMPLEMENTATION

B. FINAL HEAD

C. CURRENT GIT STATUS

D. FILES CREATED

E. FILES MODIFIED

F. FILES INTENTIONALLY NOT MODIFIED

G. PREFLIGHT RESULT

H. IMPLEMENTATION A–X
   - PASS/FAIL/UNVERIFIED
   - evidence

I. I1–I20
   - PASS/FAIL/UNVERIFIED
   - evidence

J. G1–G18
   - PASS/FAIL/UNVERIFIED
   - evidence

K. BASELINE TEST RESULTS
   - exact commands
   - exact output/result

L. FOCUSED TEST RESULTS
   - exact commands
   - exact output/result

M. §23 FINAL TEST RESULTS
   - exact commands
   - exact output/result

N. TYPECHECK

O. LINT

P. FORMAT

Q. BUILD

R. MIGRATION
   - created
   - generated
   - applied/not applied
   - exact verification status

S. RUNTIME POLICY
   - regenerated
   - validated

T. ARCHITECTURAL DEVIATIONS
   - NONE
   OR
   - exact deviation + evidence + reason

U. UNRESOLVED BUSINESS/ARCHITECTURAL AMBIGUITIES
   - NONE
   OR
   - exact ambiguity

V. STOP CONDITIONS
   - NONE
   OR
   - exact S# + evidence

W. COMMITS
   - SHA
   - purpose

X. WORKTREE
   - CLEAN
   OR
   - exact remaining changes and why
============================================================
30. SUCCESS CRITERIA
============================================================

C1 is complete only when all of the following are true:

- Commerce exists as an independent bounded context
- commerce_db is independently owned
- Commerce owns its own Prisma project
- Commerce owns its generated client
- Commerce owns its migration history
- Core and HR persistence are not bypassed
- tenant isolation is structurally enforced
- repositories remain persistence boundaries
- identity is consumed through explicit platform contracts
- audit is consumed through explicit platform contracts
- workflow is Commerce-owned
- existing pure Rule Engine is reused
- no second Rule Engine exists
- workflow configuration is versioned
- published configuration is immutable
- running workflow instances are version-pinned
- line-level routing is first-class
- lifecycle dimensions remain separated
- required history is append-only
- Commerce isolation tests are real and falsifiable
- tenant tests pass
- lifecycle tests pass
- integration tests pass
- HR remains healthy
- §23 final validation passes
- no unauthorized unrelated files are changed
- deviations are explicitly reported
- Git contains only intended work
- C1 does not silently expand into later phases

============================================================
31. FINAL DECISION RULE
============================================================

When there is any conflict between:

- assumption
- memory
- convenience
- generic framework knowledge
- repository evidence
- authoritative C1 specification

do NOT guess.

Use:

1. actual repository evidence
2. authoritative C1 specification
3. existing architectural precedent

If conflict remains unresolved:

STOP.

============================================================
32. FINAL EXECUTION RULE
============================================================

DO NOT IMPLEMENT THE ENTIRE PROCUREMENT SYSTEM AT ONCE.

Implement only C1.

Follow:

PRE-FLIGHT
   ↓
A–X implementation order
   ↓
focused validation
   ↓
§23 final tests
   ↓
G1–G18 verification
   ↓
I1–I20 verification
   ↓
Git review
   ↓
small commits
   ↓
FINAL REPORT
   ↓
STOP

END OF PHASE C1 EXECUTION PROMPT
