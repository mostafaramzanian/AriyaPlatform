# PHASE C1: COMMERCE / PROCUREMENT — BOUNDED CONTEXT
# ARCHITECTURE-FIRST — FINAL IMPLEMENTATION PROMPT

============================================================
0. HOW TO READ THIS PROMPT
============================================================

You are implementing Phase C1: Commerce / Procurement as a TRUE
BOUNDED CONTEXT in the Aria ERP monorepo at:

E:\ERP

Commerce must be implemented as the same architectural species as:

- HR (hr_db)
- CMS (cms_db)
- Correspondence (correspondence_db)
- Observability (observability_db)

Commerce therefore MUST have:

- its own database: commerce_db
- its own datasource: COMMERCE_DATABASE_URL
- its own Prisma project
- its own generated Prisma client
- its own migration history
- its own migration_lock.toml
- its own module tree
- its own permission namespace
- its own architectural isolation regression tests

The HR module is the normative precedent.

When this prompt says "mirror HR", open the named HR artifact and
follow its structure, invariants, falsifiability discipline, and
architectural reasoning style.

Do NOT copy HR business semantics blindly.
Copy the architectural mechanism and adapt it to Commerce.

Before writing a single line of implementation code:

1. Perform the complete preflight inspection in §19.
2. Report every required gate as PASS/FAIL.
3. If a gate FAILS, STOP.
4. Do not improvise around a failed architectural gate.
5. Do not silently invent a new architecture.

============================================================
MISSION
============================================================

Implement Phase C1 of Aria ERP Commerce / Procurement as a true
bounded context with:

- independent persistence
- independent Prisma
- strict tenant isolation
- configuration-driven procurement workflow
- mixed purchase line types
- first-class line-level routing
- commercial processing
- configurable approval thresholds
- append-only payment history
- receiving progress
- returns as child lifecycles
- immutable workflow versions
- auditable lifecycle transitions
- explicit integration boundaries with platform/Core/HR

The mission is NOT to create a simple "purchase form".

The mission is to establish the architectural and domain foundation
for the Commerce / Procurement subsystem.

============================================================
ARCHITECTURAL PRINCIPLE — COMMERCE IS A PEER BOUNDED CONTEXT
============================================================

Commerce is NOT a subdomain of Core.

Commerce is a PEER bounded context alongside:

- Core
- HR
- CMS
- Correspondence
- Observability

Conceptually:

                    ARIA PLATFORM
                         |
        +----------------+----------------+
        |                |                |
      CORE              HR            COMMERCE
    core_db            hr_db         commerce_db
        |                |                |
   Core Prisma       HR Prisma     Commerce Prisma
        |                |                |
   Core Client       HR Client     Commerce Client

Communication occurs through explicit contracts / ports.

There is:

NO shared persistence model
NO cross-database foreign key
NO shared Prisma client
NO shared migration history
NO cross-database join
NO shared repository implementation
NO shared database transaction

Commerce owns the complete procurement business state.

Core owns platform capabilities such as:

- identity
- RBAC
- entitlement
- platform-level audit
- platform-level notifications

HR owns personnel / employment / organization data.

Commerce must NEVER absorb HR data merely because procurement needs
an employee reference.

An employeeId in commerce_db is an opaque identifier.

Identity/person resolution must happen through an approved port/contract.

============================================================
COMMERCE MUST NOT BECOME A CORE DOMAIN BY INJECTION
============================================================

The following are FORBIDDEN:

- Purchase tables in core_db
- Commerce Prisma models inside prisma/core
- Commerce repository implementations using Core Prisma
- Core service methods directly manipulating Commerce tables
- Core domain entities containing Commerce persistence references
- Core Prisma relations to Commerce
- Commerce Prisma relations to Core
- Cross-database SQL joins
- Shared DB transactions between Core and Commerce
- Shared migration history
- Shared Prisma client
- Shared repository implementation
- Core-local copies of Commerce business state
- HR-local copies of Commerce business state

Core may know Commerce exists only through legitimate platform
composition mechanisms and explicit integration contracts.

Commerce owns procurement business state.

When Core needs Commerce information:
use a contract / port.

When Commerce needs Core information:
use an existing contract / port or introduce an explicit new port if
the capability is genuinely missing.

Never solve an integration problem by sharing a database.

============================================================
1. GREENFIELD CONFIRMATION
============================================================

Re-verify during preflight.

The repository is expected to be greenfield for Commerce / Procurement.

There must be no existing implementation that requires migration,
wrapping, reconciliation, or compatibility preservation.

Verify the repository before creation.

Search for:

COMMERCE_DATABASE_URL
commerce_db
future-commerce
CommerceModule
PurchaseOrder
procurement
commerce.

If existing artifacts are discovered:

STOP and report them.

Do not silently overwrite, wrap, migrate, or reuse them until their
architectural status is understood.

============================================================
2. COMMERCE ISOLATION DIMENSIONS
============================================================

All dimensions below are HARD constraints.

I1 — DATABASE

Commerce owns commerce_db.

It is reached only through:

COMMERCE_DATABASE_URL

Commerce must never use:

CORE_DATABASE_URL
HR_DATABASE_URL
CMS_DATABASE_URL
CORRESPONDENCE_DATABASE_URL
OBSERVABILITY_DATABASE_URL

for Commerce persistence.

------------------------------------------------------------

I2 — PRISMA PROJECT

Own schema:

apps/api/prisma/commerce/schema.prisma

Own migrations:

apps/api/prisma/commerce/migrations/

Own migration lock:

apps/api/prisma/commerce/migrations/migration_lock.toml

------------------------------------------------------------

I3 — GENERATED CLIENT

Own generated client:

apps/api/src/generated/commerce-client

Never import:

core-client
hr-client
cms-client
correspondence-client
observability-client

inside Commerce.

------------------------------------------------------------

I4 — CONNECTION CLASS

CommercePrismaService is the ONLY handle on commerce_db.

Mirror:

apps/api/src/modules/hr/database/hr-prisma.service.ts

Commerce must have:

CommercePrismaService
CommercePrismaModule
COMMERCE_PRISMA_CLIENT

The Commerce client token must be bound for datasource probing exactly
as HR is.

------------------------------------------------------------

I5 — NO CROSS-DATABASE FK

Commerce relations may exist only among Commerce-owned tables.

There must be NO relation from Commerce to:

Core
HR
CMS
Correspondence
Observability

References such as:

tenantId
userId
employeeId
supplierId
requesterId
approverId

are opaque values.

They are NOT cross-database foreign keys.

------------------------------------------------------------

I6 — NO IDENTITY DUPLICATION

commerce_db must NOT contain:

User
Tenant
Role
Permission

or credential-adjacent fields such as:

passwordHash
tokenVersion

Do not duplicate Core security state.

Do not create a Commerce-local RBAC system.

Do not create a Commerce-local identity system.

Do not create a Commerce-local audit table.

------------------------------------------------------------

I7 — IDENTITY THROUGH PORT

Core identity is reached only through:

USER_DIRECTORY

source:

src/platform/user-directory/user-directory.contract.ts

The Commerce module must have exactly one identity integration surface:

apps/api/src/modules/commerce/commerce-identity.gateway.ts

This is the ONLY Commerce file allowed to import
USER_DIRECTORY / user-directory.contract directly.

All other Commerce code uses the Commerce identity gateway.

------------------------------------------------------------

I8 — AUDIT THROUGH PORT

Audit must use:

AUDIT_PORT

source:

src/platform/audit/audit.contract.ts

Exactly one Commerce file may import that contract directly:

commerce-audit.gateway.ts

All mutating Commerce services use:

CommerceAuditGateway

Commerce contains NO audit table.

------------------------------------------------------------

I9 — NOTIFICATIONS THROUGH PORT

Notifications use the existing NotificationModule/platform mechanism.

Commerce must expose:

commerce-notification.gateway.ts

Business services must not directly access notification infrastructure
through arbitrary cross-module implementation details.

------------------------------------------------------------

I10 — ACTOR IS SERVER-DERIVED

Every protected Commerce controller route must use:

- JwtAuthGuard
- Commerce permission
- ModuleEntitlementGuard

The handler must resolve the actor first:

resolveCommerceActor(req)

Mirror:

resolveHrActor

in:

src/modules/hr/hr-actor.ts

The actor carries:

- tenant id
- user id
- effective permissions
- required actor context

Services must NEVER read req.

DTOs must NOT declare:

tenantId
requesterId
approverId
actorId
or other server-owned identity fields

unless a specific domain input is proven to be user-supplied rather than
server-derived.

The default rule is:
identity is server-derived.

------------------------------------------------------------

I11 — STRUCTURAL TENANCY

Every Commerce repository method takes tenantId as its FIRST argument.

Every tenant-bound query is structurally tenant-scoped.

Every where clause must carry tenantId.

findUnique is FORBIDDEN because it prevents the required tenant
predicate structure.

Compound unique constraints must be tenant-first:

[tenantId, ...]

Writes must be tenant-scoped by construction.

------------------------------------------------------------

I12 — HISTORY MUST NOT BE DELETED

No lifecycle history deletion.

Forbidden:

.delete(
.deleteMany(
@Delete
raw SQL delete escape hatches

Lifecycle history is preserved.

Relations should use:

onDelete: Restrict

unless the repository's proven architectural precedent makes another
choice unavoidable; if that happens, STOP and report.

------------------------------------------------------------

I13 — REUSE THE EXISTING RULE ENGINE

Aria already has a Rule Engine.

Reuse:

src/rules/rule-engine.service.ts
src/rules/rule-condition.interface.ts
src/rules/pure-rule-engine.module.ts

Do NOT create:

CommerceRuleEngine
CommerceRuleEngineService
second generic Rule Engine
local executable expression evaluator

No:

eval
new Function
Function(...)
embedded JavaScript rules
embedded TypeScript rules
embedded SQL rules
shell expressions

The rule vocabulary must remain typed and declarative.

------------------------------------------------------------

I14 — WORKFLOW LIVES IN COMMERCE

Commerce owns its procurement workflow configuration and execution.

Workflow tables belong in:

commerce_db

Examples:

WorkflowDefinition
WorkflowDefinitionVersion
WorkflowStep
WorkflowInstance
WorkflowStepInstance
WorkflowTransition / routing state

Core must NOT contain Commerce workflow persistence.

Published workflow versions are immutable.

A running purchase MUST remain pinned to the workflow version it started
with.

------------------------------------------------------------

I15 — LIFECYCLE SEPARATION

The following are DISTINCT lifecycle dimensions:

1. Workflow execution state
2. Commercial document state
3. Purchase / fulfillment state
4. Payment state
5. Per-line receiving progress

They must never be conflated.

Not every dimension must be stored as a mutable status column.

Where a lifecycle value is derived deterministically from append-only
child records, those child records remain the source of truth.

Example:

Workflow       = APPROVED
Commercial     = APPROVED
Purchase       = IN_PROGRESS
Payment        = PARTIAL
Receiving      = PARTIALLY_RECEIVED

This combination must be legal.

------------------------------------------------------------

I16 — APPEND-ONLY MONEY / RECEIVING HISTORY

Payments and receiving events are append-only.

Corrections use compensating records.

Settled payment rows are not overwritten.

Receiving rows are not rewritten to pretend that a previous receipt never
happened.

------------------------------------------------------------

I17 — RETURN IS A CHILD LIFECYCLE

A return is not merely:

PurchaseDocument.status = REJECTED

A return has its own lifecycle.

It references its origin and appends new business facts.

------------------------------------------------------------

I18 — LINE-LEVEL ROUTING IS FIRST-CLASS

A PurchaseDocument may have multiple lines.

Different lines may have different:

- actors
- routes
- approvals
- conditions
- commercial assignments
- completion states

The workflow must support:

document scope
line scope
mixed document + line scope

------------------------------------------------------------

I19 — NO ASYNC WORK IN C1

Do NOT implement in C1:

setInterval
timer-based schedulers
cron
queue consumers
background workers
scheduled jobs
upload middleware
arbitrary async orchestration infrastructure

Only the domain and its synchronous boundaries belong here.

------------------------------------------------------------

I20 — CONFIGURATION IS A PRODUCT CAPABILITY

Approval thresholds, routing, actor resolution, field visibility and
workflow behavior must be configuration-driven.

They must NOT be hard-coded developer constants.

They must NOT live in environment variables.

Configuration must be versioned and auditable.

============================================================
3. MANDATORY GATES
============================================================

ALL gates must PASS before Phase C1 is considered complete.

G1 — DATASOURCE OWNERSHIP

Add Commerce to:

runtime-datasources.ts

including:

Datasource
DatasourceOwner
DATASOURCES
DATASOURCE_OWNERS
DATASOURCE_OWNER_ORDER
RUNTIME_DATASOURCE_MATRIX
required runtime metadata

Ensure the datasource ownership is architecturally consistent.

------------------------------------------------------------

G2 — PRISMA PROJECT

Must exist:

prisma/commerce/schema.prisma
prisma/commerce/migrations/
migration_lock.toml

Add:

prisma:generate:commerce
prisma:migrate:commerce

Fold them correctly into existing aggregate scripts where the repository
convention requires.

------------------------------------------------------------

G3 — GENERATED CLIENT

Generate:

src/generated/commerce-client

Create:

commerce-prisma.service.ts
commerce-prisma.module.ts

Bind:

COMMERCE_PRISMA_CLIENT

to the datasource probe mechanism.

------------------------------------------------------------

G4 — AUTO-DISCOVERY

Creating:

src/modules/commerce/

and:

prisma/commerce/

must cause the existing independent-module discovery mechanism to
discover Commerce automatically.

Do NOT manually duplicate an independent-module registry entry if the
repository derives it automatically.

------------------------------------------------------------

G5 — COMPOSITION ROOT

Register Commerce in:

apps/api/src/app.module.ts

NOT:

core-app.module.ts

Do NOT modify core-app.module.ts to become a Commerce composition root.

------------------------------------------------------------

G6 — ENV VALIDATION

Add:

COMMERCE_DATABASE_URL: z.string().optional()

with the same architectural rationale style used by HR.

Add the Commerce database line to:

apps/api/.env.example

------------------------------------------------------------

G7 — RUNTIME MATRIX

Combined runtime must treat Commerce as:

required

Core-only runtime must treat Commerce as:

not-used

CMS-only runtime must treat Commerce as:

not-used

Follow the repository's actual runtime taxonomy discovered during
preflight.

------------------------------------------------------------

G8 — DOCKER / DATABASE OPERATIONS

Update:

infrastructure/docker/Dockerfile.backend

to include the Commerce Prisma project in the build/runtime image where
the repository convention requires it.

Update:

docker-compose.yml

with the operator database-creation instruction/comment for:

commerce_db

using the same proven style as HR.

Do not build a standalone Commerce runtime in C1.

------------------------------------------------------------

G9 — RUNTIME POLICY

Run:

npm run arch:policy --workspace=apps/api

Regenerate:

apps/api/runtime-policy.json

No drift.

------------------------------------------------------------

G10 — ISOLATION REGRESSION SPEC

Create:

apps/api/src/modules/commerce/commerce-isolation.spec.ts

This is the executable enforcement of Commerce architecture.

------------------------------------------------------------

G11 — SINGLE PLATFORM SURFACES

Exactly ONE file imports:

USER_DIRECTORY

Exactly ONE file imports:

AUDIT_PORT

Those files must be:

commerce-identity.gateway.ts
commerce-audit.gateway.ts

respectively.

------------------------------------------------------------

G12 — NO FOREIGN PRISMA

No Commerce file may import:

PrismaService
PrismaModule
core client
hr client
cms client
correspondence client
observability client

Only the Commerce client is allowed.

------------------------------------------------------------

G13 — PERMISSIONS / MODULE ENTITLEMENT

Commerce permission namespace:

commerce.*

Use a Core migration for permission registration because permission
catalogue and module entitlement remain Core/platform-owned.

Declare:

COMMERCE_MODULE_ID = 'commerce'
COMMERCE_FEATURE

in:

commerce.constants.ts

Use the same proven module/feature entitlement pattern as HR.

------------------------------------------------------------

G14 — AUDIT COVERAGE

Every mutating business service uses:

CommerceAuditGateway

and records audit events through the platform audit port.

Audit resources must be declared explicitly in:

commerce.constants.ts

using commerce.* resource names.

------------------------------------------------------------

G15 — CONFIG-DRIVEN WORKFLOW / PURE RULES

Workflow conditions are evaluated through the existing pure Rule Engine.

No Commerce-local evaluator.

No second engine.

No executable user rules.

The Commerce workflow subsystem is:

Commerce-owned orchestration

NOT:

generic enterprise workflow platform
second Rule Engine
Core workflow persistence

------------------------------------------------------------

G16 — LIFECYCLE INDEPENDENCE

Tests must prove that the five lifecycle dimensions can move
independently.

Examples:

workflow APPROVED while payment PARTIAL

workflow APPROVED while receiving PARTIALLY_RECEIVED

commercial APPROVED while purchase remains IN_PROGRESS

partial receiving without payment completion

payment completion without receiving completion

------------------------------------------------------------

G17 — TENANCY / HISTORY SAFETY

The following are forbidden:

findUnique
findUniqueOrThrow
findUniqueOn...
delete
deleteMany
cross-DB @relation
DTO tenantId

unless a specific repository precedent proves an exception is required.
If an exception is required:

STOP and report it.

------------------------------------------------------------

G18 — COMPLETE VALIDATION

The following must PASS:

architecture tests
policy tests
Commerce tests
HR tests
build/typecheck
runtime-policy regeneration

No collateral damage.

============================================================
4. COMMERCE ISOLATION SPEC
============================================================

Create:

apps/api/src/modules/commerce/commerce-isolation.spec.ts

Read the FULL:

apps/api/src/modules/hr/hr-isolation.spec.ts

before writing this test.

Mirror its reasoning style.

Every assertion must document:

1. What concrete architecture violation it prevents.
2. Why TypeScript/compiler checks cannot catch that violation.
3. What future developer behavior would make the assertion fail.

Mandatory checks:

1. Exactly one identity integration file.
2. Exactly one audit integration file.
3. No Core Prisma imports.
4. No HR Prisma imports.
5. No non-Commerce generated client imports.
6. Commerce schema exists.
7. Commerce migration history exists.
8. Commerce migration lock exists.
9. datasource uses COMMERCE_DATABASE_URL.
10. generated client points to commerce-client.
11. no Core/HR physical references in migration SQL.
12. no User/Tenant/Role/Permission model.
13. no credential-adjacent columns.
14. no Commerce lifecycle deletion.
15. no client-controlled tenant identity.
16. every repository method is tenant-first.
17. no findUnique.
18. tenant scope exists structurally.
19. no async worker/scheduler implementation.
20. threshold configuration is not hard-coded.
21. no second rule engine.
22. no Core injection of Commerce persistence.
23. no Commerce persistence in Core.
24. no Commerce persistence in HR.

Use non-vacuity tests where appropriate.

For example:

expect(inlineChecked).toBeGreaterThanOrEqual(N)

Do not create tests that technically exist but can pass because the scan
matches zero files or zero queries.

============================================================
5. DOMAIN MODEL
============================================================

Create:

apps/api/prisma/commerce/schema.prisma

The model names below are semantic minimums.

You may adapt names to repository conventions, but DO NOT remove the
semantics.

Every model and enum must have rich design comments explaining:

- ownership
- lifecycle
- invariant
- relationship
- what the entity must NOT become

The repository treats schema comments as durable architectural design
records.

------------------------------------------------------------
5.1 PURCHASE DOCUMENT
------------------------------------------------------------

PurchaseDocument

Minimum conceptual fields:

id
tenantId
documentNumber
kind
status
requesterId
supplier reference
currency
totals
timestamps
version if optimistic concurrency is warranted

Document numbering strategy must be decided once.

Document the decision in the schema.

Do not invent a second numbering style that conflicts with existing
repository precedent.

------------------------------------------------------------
5.2 PURCHASE LINE
------------------------------------------------------------

PurchaseLine

Each line is first-class.

lineType MUST be:

STANDARD
NON_STANDARD
SERVICE

Do NOT add:

EXPENSE

Current requirements do not establish Expense as an independent Commerce
line type.

A future addition is a migration, which is the correct architectural cost.

A single request may contain ALL three simultaneously.

Example:

Line 1 -> STANDARD / BOM
Line 2 -> STANDARD / BOM
Line 3 -> NON_STANDARD
Line 4 -> SERVICE

Fields should include as appropriate:

quantity
unit
unitPrice
tax
lineTotal
externalRef
item reference
technical description
timestamps

STANDARD/BOM references are opaque identifiers unless a Commerce-owned
catalogue is actually established.

------------------------------------------------------------
5.3 LINE-LEVEL WORKFLOW SCOPE
------------------------------------------------------------

A workflow execution may operate at:

- document scope
- line scope
- mixed document + line scope

A single PurchaseDocument may contain lines assigned to different
commercial actors.

The system MUST NOT assume one workflow actor owns the entire document.

Each line must be able to carry its own routing/execution context while
remaining attached to the same PurchaseDocument.

Document-level workflow state must not erase or overwrite line-level
workflow history.

A line may:

- be routed to Actor A
- be routed to Actor B
- move through sequential actors
- participate in a parallel branch
- return for correction
- complete independently

Document-level state is an aggregate/projection of these facts.

It is NOT their replacement.

This requirement is critical because the real procurement process allows
different items from the same request to be assigned to different
commercial actors.

------------------------------------------------------------
5.4 ATTACHMENTS / TECHNICAL EVIDENCE
------------------------------------------------------------

Requester must be able to provide exact technical requirements.

Support document/photo attachments at the domain level.

Do NOT build upload infrastructure in C1.

Store references/metadata through an appropriate storage contract if the
existing architecture supports it.

Do not create a new storage subsystem.

The purpose is to reduce wrong purchases and avoidable returns.

------------------------------------------------------------
5.5 WORKFLOW DEFINITION
------------------------------------------------------------

WorkflowDefinition

Owns the logical workflow definition.

WorkflowDefinitionVersion

Owns an immutable version.

Version lifecycle must follow the established Aria discipline:

DRAFT
VALIDATED
PUBLISHED
ARCHIVED

or the exact existing vocabulary if preflight confirms a different
repository standard.

Published versions are immutable.

Running purchases pin the version they started on.

------------------------------------------------------------
5.6 WORKFLOW STEP
------------------------------------------------------------

WorkflowStep must support:

stepKey
displayName
mandatory
executionMode
ordering
parallelGroup
condition
actor resolution
thresholds
line filters
relevant config metadata

executionMode:

SEQUENTIAL
PARALLEL
CONDITIONAL

MANDATORY / OPTIONAL is configuration.

Step order is configuration.

Step name is configuration.

Actor is configuration.

Conditions are configuration.

Thresholds are configuration.

Visible form fields are configuration.

------------------------------------------------------------
5.7 RULE CONDITION
------------------------------------------------------------

Conditions must use a typed declarative representation compatible with
the existing Rule Engine vocabulary.

Store structured rule configuration in JSON only where appropriate.

Validate on write.

Evaluate only through the existing pure Rule Engine.

Do not reimplement rule evaluation locally.

When evaluation happens:

- capture result
- capture relevant rule/version identity
- capture required input snapshot
- persist the outcome needed for reproducibility

Never silently re-evaluate historical results on read.

------------------------------------------------------------
5.8 ACTOR RESOLUTION
------------------------------------------------------------

Actor resolution must support configurable sources such as:

REQUESTER_MANAGER
GROUP_MANAGER
COMMERCIAL_LIAISON
CONFIGURED_USER
CONFIGURED_ROLE
RULE_RESOLVER
OTHER EXPLICITLY SUPPORTED SOURCES

Do not hard-code human identities into TypeScript.

Do not assume one person for all Commerce.

The commercial liaison for a group must be configuration-driven.

------------------------------------------------------------
5.9 WORKFLOW INSTANCE
------------------------------------------------------------

WorkflowInstance

Must contain:

version pin
subjectId
subjectType
status
timestamps

Workflow status is its OWN lifecycle.

Example:

RUNNING
APPROVED
REJECTED
CANCELLED
EXPIRED

Do not use this status as PurchaseDocument.status.

------------------------------------------------------------
5.10 WORKFLOW STEP INSTANCE
------------------------------------------------------------

WorkflowStepInstance

Must support:

step reference
status
resolvedApproverId
decidedAt
decision
decisionComment
conditionResult
conditionInputSnapshot
scopeType
scopeId

Step scope must support:

DOCUMENT
LINE

Statuses may include:

PENDING
APPROVED
REJECTED
SKIPPED
DELEGATED

Parallel branches require explicit join semantics.

Sequential paths activate ordered work.

Conditional steps evaluate at activation time.

The result is persisted and never recomputed on read.

------------------------------------------------------------
5.11 COMMERCIAL DOCUMENT STATE
------------------------------------------------------------

PurchaseDocument.status is the commercial/purchase document lifecycle.

Example vocabulary:

DRAFT
SUBMITTED
APPROVED
REJECTED
CANCELLED
CLOSED

Do not use this enum as workflow state.

Do not use it as payment state.

Do not use it as receiving state.

------------------------------------------------------------
5.12 PURCHASE / FULFILLMENT STATE
------------------------------------------------------------

The Purchase / Fulfillment lifecycle represents the progress of actual
fulfillment/receiving.

Example:

NOT_RECEIVED
PARTIALLY_RECEIVED
FULLY_RECEIVED

This is separate from workflow and payment.

------------------------------------------------------------
5.13 PAYMENT STATE
------------------------------------------------------------

Payment state may be a deterministic projection:

UNPAID
PARTIAL
PAID
OVERPAID

The authoritative source is PaymentRecord history.

A stored state column is allowed only if:

- it is explicitly declared a projection
- it can be rebuilt deterministically
- tests prove the projection

------------------------------------------------------------
5.14 PAYMENT HISTORY
------------------------------------------------------------

PaymentRecord

Child of the purchase document or explicit invoice entity.

Each row represents one payment event.

Fields may include:

amount
currency
method
paymentDate
payerRef
payeeRef
invoiceRef
externalReference
reversesPaymentId
createdAt

Payment history is append-only.

Settled payment rows MUST NOT be rewritten.

Corrections are compensating rows.

Example:

Original payment = 30%
Later payment = 40%
Later settlement = 30%

All remain on the SAME Purchase Request.

Do not create a new Purchase Request for a later payment.

------------------------------------------------------------
5.15 CASH / NON-CASH
------------------------------------------------------------

Cash/non-cash threshold is configuration.

Never hard-code business threshold values in TypeScript.

Commercial results may cause routing changes.

Example:

Initial route:
Cash path

Actual quotation:
above configured threshold

Result:
workflow transitions/reroutes to non-cash path

The original purchase request remains the same.

Do NOT create a duplicate Purchase Request.

------------------------------------------------------------
5.16 RECEIPTS
------------------------------------------------------------

Receipt

ReceiptLine

or another equally explicit append-only receiving model.

A receiving event represents actual received quantity.

Fields may include:

purchase reference
line reference
quantity
receivedAt
receiverId
conditionNotes
externalReference

Per-line received quantity is the SUM of receipt events.

Over-receipt beyond permitted quantity must be refused.

Use database/service enforcement and tests where appropriate.

------------------------------------------------------------
5.17 RETURNS
------------------------------------------------------------

ReturnDocument
ReturnLine

A return must reference its origin through opaque identifiers:

purchase
purchase line
receipt line/event

Return owns its lifecycle.

Possible states:

REQUESTED
APPROVED
RECEIVED_BACK
REFUNDED
REJECTED

Adapt to actual repository convention if needed.

A return may use the same Commerce workflow machinery.

Return activity must NOT erase or rewrite the parent purchase history.

Refunds append to payment history through compensating records.

============================================================
6. CONFIGURATION AS A PRODUCT CAPABILITY
============================================================

Configuration is NOT a developer constant.

Administrators must eventually be able to configure without deployment:

- workflow name
- workflow version
- step name
- step order
- mandatory/optional
- execution mode
- conditions
- actors
- commercial liaison
- thresholds
- line routing
- visible fields
- field validation
- routing behavior

Changing any of these MUST NOT require TypeScript source changes.

Configuration changes create new immutable versions.

Published versions are immutable.

Running purchases remain pinned to their original version.

No configuration change may silently rewrite historical workflow
behavior.

============================================================
7. COMMERCIAL CONFIGURATION
============================================================

Commerce configuration must support:

group -> commercial liaison

The liaison can be changed by configuration.

The liaison may also be a requester when business rules allow it.

Role labels that are business-facing and configurable must not be
hard-coded into domain behavior.

For example, if the organization later wants to rename a petty-cash role,
that must not require code changes.

Business-facing labels and routing semantics belong in configuration
where appropriate.

============================================================
8. API DESIGN
============================================================

Use existing repository conventions for:

- NestJS
- DTO validation
- route prefix
- authorization
- standard responses
- error handling
- API versioning

Confirm exact global prefix mechanics during preflight.

Expected namespace:

/api/commerce/**

Expected permission namespace:

commerce.*

At minimum establish API foundations for:

Purchase:
- create
- read
- list
- submit
- update while editable

Workflow:
- definition
- version
- validate
- publish
- configuration
- action/decision
- execution history

Commercial:
- assignment
- quotation entry
- quotation update
- requester confirmation
- correction
- commercial approval

Do not expose Prisma models directly.

============================================================
9. CROSS-BOUNDARY CONTRACTS
============================================================

Commerce must consume existing platform contracts.

At minimum:

USER_DIRECTORY
AUDIT_PORT
NotificationModule
Module entitlement
Pure Rule Engine

Commerce must not bypass these contracts.

If a required capability is missing:

STOP.

Propose:

- contract name
- ownership
- location
- input
- output
- failure semantics

Do not implement a direct DB shortcut.

============================================================
10. ENTITLEMENT / PERMISSIONS
============================================================

Commerce-specific permissions live in Core's permission catalogue.

Commerce does not own RBAC persistence.

Use the same proven pattern as HR.

Permissions may include:

commerce.read
commerce.manage
commerce.approve
commerce.configure
commerce.workflow.manage
commerce.commercial.manage

Do not blindly create every permission.

Each permission must be justified by actual API behavior.

Register them through a Core migration.

Commerce module entitlement must use the existing entitlement mechanism.

============================================================
11. TENANT SAFETY
============================================================

Every Commerce tenant-bound table must have:

tenantId

Every tenant-bound repository operation must use tenantId as the FIRST
argument.

Every query must structurally constrain tenantId.

findUnique is forbidden.

Compound unique structures must be tenant-first.

Cross-tenant references must fail closed.

Do not trust:

tenantId
requesterId
actorId

from the browser.

============================================================
12. AUDIT / OBSERVABILITY
============================================================

Important business mutations must have audit integration.

Use:

CommerceAuditGateway

which uses:

AUDIT_PORT

Do not create:

CommerceAuditLog
CommerceAuditEvent table

unless preflight proves an existing repository-wide architectural
necessity that cannot be satisfied by the platform port.

Do not write another module's database directly.

============================================================
13. PAYMENT / FINANCE BOUNDARY
============================================================

Phase C1 may establish the Commerce payment domain records and contract.

Do NOT build a fake full Finance module.

Commerce records:

payment events
payment history
payment status projection
payment references

Future financial accounting integration must happen through explicit
contracts.

Later payments continue on the same Purchase Request.

============================================================
14. RECEIVING / WAREHOUSE BOUNDARY
============================================================

Do not absorb Warehouse into Commerce.

Commerce may own:

requested quantity
purchased quantity
received quantity projection
receipt events
return references

Future Warehouse integration must use a contract/port.

Do not invent a Warehouse Prisma client merely to complete C1.

============================================================
15. RETURN / REJECTION BOUNDARY
============================================================

Rejected received goods create a return lifecycle.

Never simply overwrite:

PurchaseDocument.status

with REJECTED.

Return preserves:

origin
line
receipt
reason
requester
decision
resolution
replacement / repurchase requirement

History remains intact.

============================================================
16. DATABASE DESIGN PRINCIPLES
============================================================

Prefer normalized tables.

Do not put the whole Commerce domain into one giant JSON field.

Use JSON only for genuinely dynamic configuration structures where
normalization is not the correct fit.

Use:

- enums for closed vocabularies
- constraints for hard invariants
- tenant-first compound uniques
- indexes for actual access patterns
- explicit lifecycle tables
- append-only records where required

Critical invariants must not rely only on application code.

============================================================
17. MIGRATION RULES
============================================================

All Commerce migrations apply ONLY to:

commerce_db

through:

COMMERCE_DATABASE_URL

Do not:

schema-push
modify Core tables
modify HR tables
modify CMS tables
modify Correspondence tables
modify Observability tables

No Commerce migration may create a physical relation to another
database.

============================================================
18. REQUIRED FILE STRUCTURE
============================================================

Create according to repository conventions:

apps/api/prisma/commerce/schema.prisma

apps/api/prisma/commerce/migrations/
  <initial migration>/
    migration.sql

apps/api/prisma/commerce/migrations/migration_lock.toml

apps/api/src/generated/commerce-client/

apps/api/src/modules/commerce/
  commerce.constants.ts
  commerce.module.ts
  commerce-actor.ts
  commerce-identity.gateway.ts
  commerce-audit.gateway.ts
  commerce-notification.gateway.ts
  commerce-isolation.spec.ts

  database/
    commerce-prisma.module.ts
    commerce-prisma.service.ts

  workflow/
    ...

  purchase/
    ...

  commercial/
    ...

  payment/
    ...

  receiving/
    ...

  returns/
    ...

Repositories are provided internally.

Repositories are NOT exported directly when HR's pattern says they should
remain below services.

Services are the application-facing surface.

Adapt internal folders if repository precedent proves a better structure,
but do not weaken the bounded-context boundary.

============================================================
19. PREFLIGHT — MUST HAPPEN BEFORE CODING
============================================================

Before writing implementation code, fully inspect:

1. src/modules/hr/hr-isolation.spec.ts
2. src/modules/hr/hr.module.ts
3. src/modules/hr/hr-actor.ts
4. src/modules/hr/hr.constants.ts
5. src/modules/hr/hr-audit.gateway.ts
6. src/modules/hr/hr-notification.gateway.ts
7. src/modules/hr/database/hr-prisma.module.ts
8. src/modules/hr/database/hr-prisma.service.ts
9. prisma/hr/schema.prisma
10. src/runtime-datasources.ts
11. src/architecture-boundaries.spec.ts
12. src/runtime-policy.spec.ts
13. src/config/env.validation.ts
14. src/rules/rule-condition.interface.ts
15. src/rules/rule-engine.service.ts
16. src/rules/pure-rule-engine.module.ts
17. src/platform/entitlement/entitlement.contract.ts
18. src/platform/user-directory/user-directory.contract.ts
19. src/platform/audit/audit.contract.ts
20. package.json
21. apps/api/package.json
22. infrastructure/docker/Dockerfile.backend
23. docker-compose.yml
24. apps/api/.env.example

Also inspect the relevant Core migrations that seed:

- HR permissions
- HR module registration
- HR feature entitlement

Copy their mechanism, not their business semantics.

Determine:

- how datasource ownership is represented
- how runtime ids propagate
- whether future-commerce must exist as a target
- how health probes register
- how independent modules are discovered
- how permissions are registered
- how module entitlement is registered
- exact test command names
- exact build command
- exact migration command
- whether `arch:policy` must change
- how Docker handles independent Prisma projects

Do NOT infer.

============================================================
20. BASELINE TESTS
============================================================

Before modifying files:

Run the repository's baseline architecture/policy tests.

Record:

- command
- PASS/FAIL
- relevant output
- known pre-existing failures

Do not confuse a pre-existing failure with a Commerce regression.

============================================================
21. IMPLEMENTATION ORDER
============================================================

Implement in this order:

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

============================================================
22. STOP CONDITIONS
============================================================

STOP immediately if any occurs.

S1

A required gate cannot pass without modifying an unapproved architectural
file.

S2

The existing pure Rule Engine cannot express a required condition.

Do NOT fork it.

STOP and propose the minimum extension.

S3

The design requires duplicating identity/security state.

STOP.

S4

The design forces conflation of lifecycle dimensions.

STOP.

S5

Migration conventions conflict with the proposed initial migration.

STOP.

S6

Existing HR/CMS/Correspondence/Observability architecture tests break
and the reason is not clearly a legitimate consequence of Commerce.

STOP.

S7

You are about to invent a new pattern that is not supported by:

HR
CMS
Correspondence
Observability
existing platform ports
existing Rule Engine

STOP and report.

S8

A direct database shortcut appears easier than a contract-based
integration.

Do NOT take it.

STOP and report the missing contract.

============================================================
23. TEST REQUIREMENTS
============================================================

At minimum run and report:

npm run test:architecture --workspace=apps/api

npm run test:policy --workspace=apps/api

npm run test:api --workspace=apps/api -- modules/commerce

npm run test:api --workspace=apps/api -- modules/hr

npm run arch:policy --workspace=apps/api

npm run test:policy --workspace=apps/api

npm run build --workspace=apps/api

Confirm exact script names during preflight.

If the repository uses different names, use the repository's actual
commands and report them.

============================================================
24. REQUIRED DOMAIN TESTS
============================================================

Tests must prove:

1. mixed STANDARD / NON_STANDARD / SERVICE request
2. line-level routing
3. different commercial actors for different lines
4. sequential workflow
5. parallel workflow
6. conditional workflow
7. correction / return-to-step
8. immutable published workflow version
9. running request pinned to workflow version
10. persisted condition result
11. partial purchase
12. partial receipt
13. over-receipt rejected
14. partial payment
15. multiple payments on same request
16. compensating payment record
17. return child lifecycle
18. workflow state independent from payment state
19. payment state independent from receipt state
20. commercial state independent from workflow state
21. tenant isolation
22. identity resolved through the gateway
23. audit routed through audit gateway
24. no second Rule Engine
25. no cross-database FK

============================================================
25. REQUIRED CONFIGURATION TESTS
============================================================

Prove that the following can change without modifying TypeScript workflow
logic:

- step name
- step order
- mandatory flag
- optional flag
- actor
- commercial liaison
- threshold
- condition
- line routing
- visible field

Prove that:

published version A
does not change
when version B is authored/published.

Prove that:

running Purchase X
stays on version A

even after version B is published.

============================================================
26. REQUIRED LIFECYCLE SEPARATION EXAMPLES
============================================================

At least prove these legal combinations:

CASE A

Workflow = APPROVED
Commercial = APPROVED
Purchase = IN_PROGRESS
Payment = PARTIAL
Receiving = PARTIALLY_RECEIVED

CASE B

Workflow = APPROVED
Commercial = CLOSED
Purchase = IN_PROGRESS
Payment = PAID
Receiving = PARTIALLY_RECEIVED

CASE C

Workflow = APPROVED
Commercial = APPROVED
Purchase = NOT_RECEIVED
Payment = UNPAID
Receiving = NOT_RECEIVED

CASE D

Workflow = APPROVED
Commercial = APPROVED
Purchase = PARTIALLY_RECEIVED
Payment = PAID
Receiving = PARTIALLY_RECEIVED

The exact final enums may vary after preflight.

The invariant does NOT.

============================================================
27. REQUIRED COMMERCIAL PROCESS
============================================================

Commerce must be able to represent the real business process:

Requester
  ->
Manager / configured approval
  ->
Planning / configurable step
  ->
Commercial
  ->
Quotation / price evidence
  ->
Requester/group confirmation
  ->
Correction if needed
  ->
Commercial manager approval
  ->
Purchase/payment/receiving continuation

But the ordering MUST NOT be hard-coded.

The workflow configuration may define:

Requester
-> Planning
-> Commercial

or:

Requester
-> Commercial
-> Planning

without code changes.

============================================================
28. COMMERCIAL LINE ROUTING
============================================================

The system must support:

Purchase Request
  Line 1 -> Commercial A
  Line 2 -> Commercial A
  Line 3 -> Commercial B

And:

Manager
  -> Commercial A
  -> Commercial B

And parallel execution where required.

Do not create three Purchase Requests merely because lines follow
different routes.

The original Purchase Document remains the aggregate.

============================================================
29. PURCHASE COMPLETION
============================================================

Purchase completion is a distinct business event.

When completed:

- normal editing is locked
- completion actor recorded
- completion timestamp recorded
- completion state persisted/projected
- history preserved
- later payments continue on the same purchase

Final completion must be explicit.

UI must later use warning/confirmation.

Do not make completion a dangerous accidental one-click action.

Payment completion is NOT purchase completion.

Receiving completion is NOT purchase completion.

Workflow completion is NOT purchase completion.

============================================================
30. FINAL REPORT
============================================================

At the end of the phase provide:

1. Preflight report
2. Architecture decisions
3. All modified files
4. All created files
5. Database/schema summary
6. Migration summary
7. Runtime/datasource summary
8. Platform integration summary
9. Workflow architecture
10. Purchase lifecycle architecture
11. Commercial architecture
12. Payment architecture
13. Receiving architecture
14. Return architecture
15. Tenant isolation summary
16. Regression-test summary
17. G1-G18 result
18. Test commands and results
19. Build result
20. Known limitations
21. Anything intentionally not implemented
22. Any deviation from this prompt

For every deviation explain:

- why
- what repository precedent forced it
- which gate it affects
- whether an architectural decision is required

============================================================
31. FINAL HARD INVARIANTS
============================================================

These MUST NEVER break:

COMMERCE != CORE
COMMERCE != HR
COMMERCE != SECOND RULE ENGINE

Persistence:

core_db
    -> platform / identity / RBAC / entitlement

hr_db
    -> personnel / employment / organization

commerce_db
    -> procurement / purchase / commercial / workflow

There is NO shared Prisma.

There is NO cross-database FK.

There is NO cross-database join.

There is NO shared migration history.

There is NO Commerce business persistence in Core.

There is NO Commerce business persistence in HR.

There is NO second generic Rule Engine.

============================================================
32. FINAL EXECUTION RULE
============================================================

DO NOT START CODING IMMEDIATELY.

First:

1. perform complete preflight
2. inspect the named repository artifacts
3. run baseline tests
4. report the architecture
5. report PASS/FAIL for the preflight gates

Only when preflight passes:

implement Phase C1.

If anything is ambiguous:

DO NOT GUESS.

STOP.

Report the exact ambiguity, the evidence, the affected artifact, and the
smallest architectural decision required to continue.

No silent shortcuts.
No cross-database coupling.
No Core injection.
No HR coupling.
No second rule engine.
No hard-coded procurement workflow.
No mutable published workflow versions.
No erased history.
No client-controlled tenant identity.
