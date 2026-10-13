# Cross-Context Integration Policy

**Phase:** B3 — P0 Platform Hardening
**Status:** ENFORCED (executable architecture guards)

---

## 1. Bounded Context Ownership

Each bounded context owns exclusively:

| Context | Database | Prisma Schema | Module |
|---|---|---|---|
| Core | `core_db` | `prisma/core/schema.prisma` | `CoreAppModule` |
| CMS | `cms_db` | `prisma/cms/schema.prisma` | `CmsAppModule` |
| HR | `hr_db` | `prisma/hr/schema.prisma` | `HrModule` |
| Commerce | `commerce_db` | `prisma/commerce/schema.prisma` | `CommerceModule` |
| Production | `production_db` | `prisma/production/schema.prisma` | `ProductionModule` |
| Financial | `finance_db` | `prisma/financial/schema.prisma` | `FinancialModule` |
| Correspondence | `correspondence_db` | `prisma/correspondence/schema.prisma` | `CorrespondenceModule` |
| Observability | `observability_db` | `prisma/observability/schema.prisma` | Platform |

Each context owns its data model, repositories, business rules, and write operations.

---

## 2. Integration Rules

### 2.1 Direct Coupling: FORBIDDEN

A business module MUST NOT:

- Import another business module's Prisma service or generated client
- Import another business module's private repositories
- Import another business module's internal services
- Access another business module's database
- Declare cross-database foreign keys

**Enforced by:** `architecture-boundaries.spec.ts` — "no business module imports from
another business module's directory"

### 2.2 Synchronous Reads: Through Source-Owned Contracts

Cross-context reads MUST go through explicit, source-owned read contracts.

Approved patterns:

| Consumer | Source | Contract |
|---|---|---|
| Reporting | Commerce | `COMMERCE_PURCHASE_REPORTING_READER` |
| Reporting | Financial | `FINANCIAL_CHECK_REQUEST_REPORTING_READER` |
| Reporting | Production | `PRODUCTION_REPORTING_READER` |
| Reporting | Production | `PRODUCTION_BOM_CHANGE_REPORTING_READER` |
| Reporting | HR | `HR_PERSONNEL_TRAFFIC_REPORTING_READER` |
| KPI Runtime | Commerce | `COMMERCE_PURCHASE_REPORTING_READER` |
| KPI Runtime | Financial | `FINANCIAL_CHECK_REQUEST_REPORTING_READER` |
| KPI Runtime | Production | `PRODUCTION_REPORTING_READER` |

Each contract is:
- Owned by the source context
- Read-only
- Tenant-scoped
- Minimal projection (no private ORM details)

**Enforced by:** `architecture-boundaries.spec.ts` — "approved cross-context consumers
only import contracts, constants, and status vocabularies"

### 2.3 Platform Capabilities: Through Ports

Platform capabilities are accessed through explicit ports:

| Capability | Port Token | Provider |
|---|---|---|
| Audit | `AUDIT_PORT` | `PlatformAuditService` |
| Identity / User Directory | `USER_DIRECTORY` | `UserDirectoryService` |
| AI | `AI_GATEWAY` | `PlatformAIService` |
| Entitlement | `PlatformEntitlementModule` | Platform |
| Storage | `IStorageProvider` | MinIO adapter |
| Permissions | `PermissionSource` | Runtime-specific |

**Enforced by:** Module-specific isolation specs (`*-isolation.spec.ts`)

### 2.4 Asynchronous Side Effects: Through Durable Outbox

When a business mutation in one context must produce an effect in another
(e.g. audit trail in `core_db`), the producing context writes a durable outbox
record in its OWN database, within the SAME transaction as the business mutation.

A relay service then delivers the event through the approved port.

Current implementation: Financial `AuditOutbox` → `AuditOutboxRelayService` →
`AUDIT_PORT` → `core_db."AuditLog"`.

Rules:
- The outbox write MUST be atomic with the business mutation
- Consumers MUST be idempotent (duplicate delivery is possible)
- Event identity MUST be stable (producer-owned `auditId`)
- Failed deliveries MUST remain observable (retry with backoff)
- Events MUST NOT be silently discarded

### 2.5 Approved Consumer Imports

Reporting and KPI modules may import from business contexts, but ONLY:

- Reporting contracts and modules (`*/reporting/*`)
- Module constants (`*.constants`)
- Status vocabularies (`*-status`, `bom-status`, `purchase-status`, etc.)

They MUST NOT import:
- Private repositories
- Internal services
- Prisma services or generated clients
- Private domain logic

**Enforced by:** `architecture-boundaries.spec.ts` — "approved cross-context consumers
only import contracts, constants, and status vocabularies"

### 2.6 Datasource Ownership

The runtime-to-datasource ownership matrix is the canonical source of truth
(`src/runtime-datasources.ts`). It determines:

- Which databases each runtime may access
- Which health checks each runtime performs
- Which Prisma clients each runtime generates

No runtime may gain access to a database not declared in its policy.

**Enforced by:** `architecture-boundaries.spec.ts` — datasource ownership matrix,
`runtime-policy.spec.ts`, `docker-artifact-guard.spec.ts`

---

## 3. Saga / Process Manager

Multi-step distributed coordination SHOULD use an explicit process manager
only when a real workflow requires it.

Current state: no multi-step cross-context workflow exists in the repository.
Financial Check Issuance is a single-context lifecycle. Commerce Purchase is a
single-context lifecycle.

This policy does NOT pre-create a saga framework. When the first genuine
cross-context workflow arises, the process manager will be designed for that
specific flow.

---

## 4. Violations and Exceptions

### Pre-existing exceptions (documented, not violations)

None found. All cross-context imports follow the approved patterns.

### CMS Blog audit dependency

CMS uses Core's `PrismaService` (the legacy audit path). This is a documented
platform exception, not a business-to-business coupling — CMS is a platform
content module, not an independent business domain.

---

## 5. Enforcement Mechanism

All rules above are enforced by executable architecture guards in
`src/architecture-boundaries.spec.ts`:

1. **No business module imports from another business module's directory**
   — scans all non-spec `.ts` files in each business context directory
2. **Approved cross-context consumers only import through approved paths**
   — scans Reporting and KPI modules for non-approved imports
3. **No business module imports another context's Prisma service or client**
   — scans for cross-context database coupling

These guards run in CI as part of the contract suites.
