/**
 * KPI Catalog — the nine governed definitions (five first-cohort, four documented
 * future candidates). Primary governance record companion: docs/architecture/KPI-CATALOG.md.
 *
 * WHAT THIS FILE IS: a frozen, reviewable data table. Every entry is evidence-backed:
 * field names are proven against the seam row by `satisfies`/`keyof` typing, status values
 * against the domain's closed vocabulary, and every claim cites the repository file that
 * proves it.
 *
 * WHAT THIS FILE IS NOT: a runtime. There is no evaluator, no query, no clock, no HTTP,
 * no scheduling — only frozen definitions plus the guards in the model. A future KPI
 * runtime must translate these definitions into implementation; it cannot read anything
 * executable from here, and that is deliberate (§26: no runtime in this phase).
 *
 * IMPORT DISCIPLINE (see kpi-governance.spec.ts): `import type` ONLY — from this folder's
 * model plus the four domain-owned reporting seam contracts and the pure domain vocabularies
 * they point at. Type-only imports are erased at compile time, so this file creates zero
 * runtime coupling across bounded contexts.
 */

import type { KpiDefinition, KpiRefreshSemantics } from './kpi-definition.model';
import type { ProductionReportRow } from '../modules/production/reporting/production-reporting.contract';
import type { BomStatus } from '../modules/production/bom/bom-status';
import type { CommercePurchaseReportRow } from '../modules/commerce/reporting/commerce-purchase-reporting.contract';
import type { PurchaseDocumentStatus } from '../modules/commerce/purchase/purchase-status';
import type { FinancialCheckRequestReportRow } from '../modules/financial/reporting/financial-check-request-reporting.contract';
import type { HrPersonnelTrafficReportRow } from '../modules/hr/reporting/hr-personnel-traffic-reporting.contract';

export type AnyKpiDefinition =
  | KpiDefinition<ProductionReportRow>
  | KpiDefinition<CommercePurchaseReportRow>
  | KpiDefinition<FinancialCheckRequestReportRow>
  | KpiDefinition<HrPersonnelTrafficReportRow>;

const GOVERNED_WALL_CLOCK =
  'Storage: UTC instants (timestamptz columns). ' +
  'Wall clock: Asia/Tehran (APP_TIME_ZONE, src/calendar/jalali.util.ts).';

const GOVERNED_CALENDAR =
  'Elapsed durations are calendar-independent instant differences. ' +
  'Period bucketing: Jalali calendar month in Asia/Tehran, matching the product Jalali ' +
  'presentation convention (reportDateLabel, jalaliYear document numbering, HR dateKey).';

const NOT_DEFINED_REFRESH: KpiRefreshSemantics = {
  mode: 'NOT_APPLICABLE_DEFINITION_ONLY',
  note: 'No computation, storage, refresh, scheduling, or alerting exists in this phase.',
};

const NO_SLA_EVIDENCE_NOTE =
  'No SLA, target, or threshold value exists anywhere in the repository for this measure ' +
  '(schemas carry no SLA column; reporting phases explicitly recorded SLA semantics deferred).';

/** KPI-001 — Production BOM Decision Cycle Time */
const KPI_001_PRODUCTION_BOM_DECISION_CYCLE_TIME: KpiDefinition<ProductionReportRow> = {
  id: 'KPI-001',
  technicalKey: 'production-bom-decision-cycle-time',
  nameEn: 'Production BOM Decision Cycle Time',
  nameFa: 'میانگین زمان تصمیم‌گیری فهرست مواد (BOM)',
  description: 'Mean elapsed time from a BOM submission for approval to the terminal decision.',
  businessQuestion: 'How long does an approver take, on average, to decide a submitted BOM?',
  ownerContext: 'production',
  businessOwner:
    'Production — the bounded context that owns the BOM lifecycle; decision authority is ' +
    'the snapshotted approver holding the production.bom.approve remit.',
  status: 'APPROVED',
  statusRationale:
    'All §22 quality gates pass: population closed by verified terminal statuses; both ' +
    'timestamps authoritative with proven single writers; cohort field decidedAt exists on ' +
    'every terminal row.',
  cohort: 'FIRST',
  definition:
    'Population: BOM headers of the current tenant with status APPROVED or REJECTED. ' +
    'One row contributes one value: elapsed(decidedAt − submittedAt) in seconds, valid only ' +
    'when both instants non-null and decidedAt >= submittedAt. Only the FINAL correction ' +
    'round is measured (resubmission overwrites submittedAt; re-decision overwrites decidedAt).',
  formula: {
    kind: 'MEAN_ELAPSED',
    from: 'submittedAt',
    to: 'decidedAt',
    statistic: 'MEAN',
    validRowRule: 'BOTH_TIMESTAMP_FIELDS_NON_NULL',
    orderingRule: 'TO_NOT_BEFORE_FROM',
  },
  candidateFormulas: [],
  authoritativeSource:
    'BomHeader (aggregate root, production_db) as projected by the approved read seam.',
  sourceContract: {
    seamToken: 'ProductionReportingReader',
    seamFile: 'apps/api/src/modules/production/reporting/production-reporting.contract.ts',
    rowType: 'ProductionReportRow',
    rowFields: ['status', 'managerOpinion', 'submittedAt', 'decidedAt', 'createdAt'],
    domainWriters: [
      'BomHeaderRepository.submit — stamps submittedAt atomically with DRAFT→SUBMITTED',
      'BomHeaderRepository.decide — stamps decidedAt atomically with the decision move',
    ],
    tenantScoped: true,
  },
  timeSemantics: {
    cohortField: 'decidedAt',
    startField: 'submittedAt',
    endField: 'decidedAt',
    window:
      'Jalali calendar month of decidedAt in Asia/Tehran: a BOM submitted in Bahman and ' +
      'decided in Esfand belongs to the Esfand cohort — the decision closes the measurement.',
    timezone: GOVERNED_WALL_CLOCK,
    calendar: GOVERNED_CALENDAR,
  },
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population: 'Tenant BOM headers with status APPROVED or REJECTED (verified terminal states).',
  exclusions:
    'DRAFT/NEEDS_CORRECTION (unresolved); SUBMITTED (undecided); null instants; ' +
    'decidedAt < submittedAt (stale); other tenants. Excluded rows never count as zero.',
  dimensions: ['status', 'projectRef', 'productTreeRef', 'decidedAt'],
  unit: {
    semantic: 'SECONDS',
    presentation: 'Hours (display conversion only; governed value is exact elapsed seconds).',
  },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'production.bom.read',
    moduleEntitlement: 'production',
    newPermissionRequired: false,
    note: 'Reads through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'YELLOW',
    notes: [
      'Only the FINAL correction round is measurable: submit/decide overwrite the same two ' +
        'columns, so earlier round pairs are not retained. The definition states this.',
      'MEAN is the simplest deterministic single-value statistic (§7); median/percentiles ' +
        'require a product decision and are deferred — the mean is outlier-sensitive.',
      'The reporting seam exposes status/search filters only (no date window): period-scoped ' +
        'computation requires a seam extension in the runtime phase.',
    ],
  },
  knownLimitations: [
    'Final-round decision latency only; cumulative multi-round effort is not stored.',
    'No target/threshold (NOT_DEFINED).',
  ],
  openQuestions: [],
  blockedReason: null,
  evidence: [
    'apps/api/src/modules/production/bom/bom-status.ts — APPROVED/REJECTED terminal.',
    'apps/api/src/modules/production/bom/bom.repository.ts — submit stamps submittedAt.',
    'apps/api/src/modules/production/reporting/production-reporting.contract.ts — row fields.',
  ],
};

/** KPI-002 — Production BOM Approval Rate (نرخ تایید فهرست مواد (BOM)). */
const KPI_002_PRODUCTION_BOM_APPROVAL_RATE: KpiDefinition<ProductionReportRow> = {
  id: 'KPI-002',
  technicalKey: 'production-bom-approval-rate',
  nameEn: 'Production BOM Approval Rate',
  nameFa: 'نرخ تایید فهرست مواد (BOM)',
  description: 'Share of terminally decided BOMs that were approved rather than rejected.',
  businessQuestion: 'What share of decided BOMs are approved rather than rejected?',
  ownerContext: 'production',
  businessOwner:
    'Production — the bounded context that owns the BOM lifecycle; decision authority is ' +
    'the snapshotted approver holding the production.bom.approve remit.',
  status: 'APPROVED',
  statusRationale:
    'Denominator closed by the verified four-member lifecycle: APPROVED and REJECTED are the ' +
    'only terminal states, so no other decision population can leak in; DRAFT/SUBMITTED are ' +
    'unresolved by state-machine evidence, not by choice.',
  cohort: 'FIRST',
  definition:
    'Numerator: tenant BOM headers with status APPROVED and decidedAt inside the window. ' +
    'Denominator: tenant BOM headers with status APPROVED or REJECTED and decidedAt inside ' +
    'the window. A window with zero terminal decisions yields NOT_AVAILABLE — never 0%.',
  formula: {
    kind: 'RATIO_PERCENT',
    numerator: {
      dimension: 'status',
      oneOf: ['APPROVED'] as const satisfies readonly BomStatus[],
    },
    denominator: {
      dimension: 'status',
      oneOf: ['APPROVED', 'REJECTED'] as const satisfies readonly BomStatus[],
    },
    zeroDenominator: 'NOT_AVAILABLE',
  },
  candidateFormulas: [],
  authoritativeSource:
    'BomHeader (aggregate root, production_db) as projected by the Production-approved read seam.',
  sourceContract: {
    seamToken: 'ProductionReportingReader',
    seamFile: 'apps/api/src/modules/production/reporting/production-reporting.contract.ts',
    rowType: 'ProductionReportRow',
    rowFields: ['status', 'managerOpinion', 'decidedAt', 'projectRef', 'productTreeRef'],
    domainWriters: [
      'BomHeaderRepository.decide — terminal status and decidedAt written in the same ' +
        'conditional statement (from SUBMITTED only), so terminal rows always carry both.',
    ],
    tenantScoped: true,
  },
  timeSemantics: {
    cohortField: 'decidedAt',
    startField: 'NONE',
    endField: 'NONE',
    window:
      'Jalali calendar month of decidedAt in Asia/Tehran. Attribution by submission would ' +
      'count undecided rows and keep past periods open — rejected here as non-final.',
    timezone: GOVERNED_WALL_CLOCK,
    calendar: GOVERNED_CALENDAR,
  },
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population: 'Tenant BOM headers with status APPROVED or REJECTED and decidedAt in window.',
  exclusions:
    'DRAFT (editable; correction returns land here — unresolved), SUBMITTED (routed but ' +
    'undecided), other tenants. Empty denominators yield NOT_AVAILABLE, never 0%.',
  dimensions: ['projectRef', 'productTreeRef', 'decidedAt'],
  unit: { semantic: 'PERCENT', presentation: 'Percent 0–100; no presentation rounding governed.' },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'production.bom.read',
    moduleEntitlement: 'production',
    newPermissionRequired: false,
    note: 'Reads through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'GREEN',
    notes: [
      'Terminal counts are exact: the seam summary zero-fills every vocabulary member over ' +
        'the filtered population, and terminal rows carry decidedAt by construction.',
      'Correction returns are DRAFT and therefore excluded from both numerator and ' +
        'denominator (unresolved, not a decision). Each row contributes one terminal outcome.',
    ],
  },
  knownLimitations: ['No target/threshold (NOT_DEFINED).'],
  openQuestions: [],
  blockedReason: null,
  evidence: [
    'apps/api/src/modules/production/bom/bom-status.ts — APPROVED/REJECTED are the two ' +
      'terminal states; corrections return to DRAFT (not terminal).',
    'apps/api/src/modules/production/reporting/production-reporting.contract.ts — summary ' +
      'counts rows per status (zero-filled over BOM_STATUSES).',
  ],
};

/** KPI-003 — Commerce Purchase Cycle Time (میانگین زمان چرخه عمر درخواست خرید). */
const KPI_003_COMMERCE_PURCHASE_CYCLE_TIME: KpiDefinition<CommercePurchaseReportRow> = {
  id: 'KPI-003',
  technicalKey: 'commerce-purchase-cycle-time',
  nameEn: 'Commerce Purchase Cycle Time',
  nameFa: 'میانگین زمان چرخه عمر درخواست خرید',
  description:
    'Mean elapsed time from purchase document creation to documented completion (CLOSED).',
  businessQuestion:
    'How long does a purchase request take, on average, from creation to completion?',
  ownerContext: 'commerce',
  businessOwner:
    'Commerce — the bounded context that owns the PurchaseDocument lifecycle; completion ' +
    'authority is gated by the tenant completion policy and the commerce.manage remit.',
  status: 'APPROVED',
  statusRationale:
    'Both timestamps authoritative with proven single writer (creation) and conditional ' +
    'single writer (completion act); population closed by the verified CLOSED state.',
  cohort: 'FIRST',
  definition:
    'Population: purchase documents of the current tenant with status CLOSED, createdAt ' +
    'non-null, completedAt non-null, and completedAt >= createdAt. One row contributes one ' +
    'value: elapsed(completedAt − createdAt) in seconds. PurchaseDocument stores NO ' +
    'submission instant (submit writes only status), so the pair starts at document creation ' +
    '— the register’s own request date — not at routing.',
  formula: {
    kind: 'MEAN_ELAPSED',
    from: 'createdAt',
    to: 'completedAt',
    statistic: 'MEAN',
    validRowRule: 'BOTH_TIMESTAMP_FIELDS_NON_NULL',
    orderingRule: 'TO_NOT_BEFORE_FROM',
  },
  candidateFormulas: [],
  authoritativeSource:
    'PurchaseDocument (aggregate root, commerce_db) as projected by the approved read seam.',
  sourceContract: {
    seamToken: 'CommercePurchaseReportingReader',
    seamFile: 'apps/api/src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts',
    rowType: 'CommercePurchaseReportRow',
    rowFields: ['status', 'kind', 'supplierId', 'createdAt', 'completedAt'],
    domainWriters: [
      'PurchaseRepository.createDocument — createdAt is the row creation instant (= the ' +
        'register’s request date); no other request-date column exists.',
      'PurchaseRepository.writeCompletedIn (via PurchaseCompletionService) — the ONLY writer ' +
        'of completedAt, conditional on completedAt null, always together with status CLOSED',
    ],
    tenantScoped: true,
  },
  timeSemantics: {
    cohortField: 'completedAt',
    startField: 'createdAt',
    endField: 'completedAt',
    window:
      'Jalali calendar month of completedAt in Asia/Tehran: a request created in Bahman and ' +
      'completed in Esfand belongs to the Esfand cohort — the completion closes the measurement.',
    timezone: GOVERNED_WALL_CLOCK,
    calendar: GOVERNED_CALENDAR,
  },
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population:
    'Tenant purchase documents with status CLOSED and an ordered createdAt→completedAt pair.',
  exclusions:
    'Non-CLOSED rows (uncompleted); null completedAt; completedAt < createdAt (anomaly); ' +
    'other tenants. Excluded rows never count as zero.',
  dimensions: ['status', 'kind', 'supplierId', 'completedAt'],
  unit: {
    semantic: 'SECONDS',
    presentation: 'Days (display conversion only; the governed value is exact elapsed seconds).',
  },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'commerce.read',
    moduleEntitlement: 'commerce',
    newPermissionRequired: false,
    note: 'Reads through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'YELLOW',
    notes: [
      'completedAt means the DOCUMENTED completion act (CLOSED), not goods receipt, payment, ' +
        'or workflow completion — C1 §29 keeps those lifecycles independent by design.',
      'Creation precedes routing: PurchaseDocument persists no submission instant, so the ' +
        'measured cycle starts at document creation (the register’s request date).',
      'Completion is policy-gated and fail-closed: a tenant with no published completion ' +
        'policy completes nothing, so 0 completions may mean configuration, not performance.',
    ],
  },
  knownLimitations: [
    'Only completed documents are measurable; open (in-flight) documents are excluded by ' +
      'definition — measure separately if needed (no such KPI exists in this phase).',
    'No target/threshold (NOT_DEFINED).',
  ],
  openQuestions: [],
  blockedReason: null,
  evidence: [
    'apps/api/src/modules/commerce/purchase/purchase-status.ts — six-status vocabulary; ' +
      'CLOSED is the completion destination; every non-CLOSED status is a legal source.',
    'apps/api/src/modules/commerce/completion/purchase-completion.service.ts AND ' +
      'purchase.repository.ts writeCompletedIn — sole conditional writer of completedAt.',
    'apps/api/src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts — row ' +
      'carries createdAt (IS the request date here), completedAt; no submittedAt column exists.',
  ],
};

/** KPI-004 — Commerce Purchase Completion Rate (نرخ تکمیل درخواست‌های خرید). */
const KPI_004_COMMERCE_PURCHASE_COMPLETION_RATE: KpiDefinition<CommercePurchaseReportRow> = {
  id: 'KPI-004',
  technicalKey: 'commerce-purchase-completion-rate',
  nameEn: 'Commerce Purchase Completion Rate',
  nameFa: 'نرخ تکمیل درخواست‌های خرید',
  description:
    'Share of purchase documents created in the cohort window that reached documented completion.',
  businessQuestion: 'What share of raised purchase requests are actually completed?',
  ownerContext: 'commerce',
  businessOwner:
    'Commerce — the bounded context that owns the PurchaseDocument lifecycle; completion ' +
    'authority is gated by the tenant completion policy and the commerce.manage remit.',
  status: 'APPROVED',
  statusRationale:
    'Deterministic over the register population: numerator = CLOSED rows (sole completion ' +
    'writer); denominator = all cohort rows, with no invented exclusions — every non-CLOSED ' +
    'status is a legal completion source by the domain’s own vocabulary.',
  cohort: 'FIRST',
  definition:
    'Numerator: tenant purchase documents created inside the window with status CLOSED. ' +
    'Denominator: all tenant purchase documents created inside the window (every status). ' +
    'A window with zero created documents yields NOT_AVAILABLE — never 0%.',
  formula: {
    kind: 'RATIO_PERCENT',
    numerator: {
      dimension: 'status',
      oneOf: ['CLOSED'] as const satisfies readonly PurchaseDocumentStatus[],
    },
    denominator: { dimension: 'status', all: true },
    zeroDenominator: 'NOT_AVAILABLE',
  },
  candidateFormulas: [],
  authoritativeSource:
    'PurchaseDocument (aggregate root, commerce_db) as projected by the approved read seam.',
  sourceContract: {
    seamToken: 'CommercePurchaseReportingReader',
    seamFile: 'apps/api/src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts',
    rowType: 'CommercePurchaseReportRow',
    rowFields: ['status', 'kind', 'supplierId', 'createdAt', 'completedAt'],
    domainWriters: [
      'PurchaseCompletionService.close via PurchaseRepository.writeCompletedIn — the ONLY ' +
        'transition that writes completedAt and CLOSED, gated by the published policy.',
    ],
    tenantScoped: true,
  },
  timeSemantics: {
    cohortField: 'createdAt',
    startField: 'createdAt',
    endField: 'NONE',
    window:
      'Jalali calendar month of createdAt in Asia/Tehran: a request created in Bahman and ' +
      'completed in Esfand still belongs to the Bahman creation cohort — the rate measures ' +
      'what became of documents raised in the window (right-censoring documented below).',
    timezone: GOVERNED_WALL_CLOCK,
    calendar: GOVERNED_CALENDAR,
  },
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population: 'All tenant purchase documents created inside the cohort window (all statuses).',
  exclusions:
    'None by status: no exclusion invented — DRAFT, SUBMITTED, APPROVED, REJECTED and ' +
    'CANCELLED are all legal completion sources. Empty cohorts yield NOT_AVAILABLE.',
  dimensions: ['kind', 'supplierId', 'createdAt'],
  unit: { semantic: 'PERCENT', presentation: 'Percent 0–100; no presentation rounding governed.' },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'commerce.read',
    moduleEntitlement: 'commerce',
    newPermissionRequired: false,
    note: 'Reads through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'YELLOW',
    notes: [
      'Right-censoring: recently created cohorts are incomplete — documents created near the ' +
        'window end may complete later, so immature cohorts read low by construction.',
      'Policy-dependence: completion is fail-closed — a tenant with no published completion ' +
        'policy cannot complete anything, so a low rate may indicate configuration.',
      'CANCELLED vocabulary exists (“withdrawn before completion”) on record, but no ' +
        'inbound transition edge reaches it at baseline — if a cancellation writer lands, ' +
        'cohort semantics stay unchanged (CANCELLED remains a non-completed cohort member).',
    ],
  },
  knownLimitations: [
    'Only the documented completion act (CLOSED) counts — not payment, receiving, or workflow.',
    'No target/threshold (NOT_DEFINED).',
  ],
  openQuestions: [],
  blockedReason: null,
  evidence: [
    'apps/api/src/modules/commerce/purchase/purchase-status.ts — six statuses; completion ' +
      'destination fixed at CLOSED; every non-CLOSED member is a legal completion source.',
    'apps/api/src/modules/commerce/completion/purchase-completion.service.ts — fail-closed: ' +
      'no published policy means completion is unavailable, never defaulted.',
  ],
};

/** KPI-005 — Financial Check Request Decision Time (میانگین زمان تصمیم مدیر درخواست صدور چک). */
const KPI_005_FINANCIAL_CHECK_REQUEST_DECISION_TIME: KpiDefinition<FinancialCheckRequestReportRow> =
  {
    id: 'KPI-005',
    technicalKey: 'financial-check-request-decision-time',
    nameEn: 'Financial Check Request Decision Time',
    nameFa: 'میانگین زمان تصمیم مدیر درخواست صدور چک',
    description:
      'Mean elapsed time from a check request’s submission for review to the recorded decision.',
    businessQuestion:
      'How long does the manager take, on average, to decide a submitted check request?',
    ownerContext: 'financial',
    businessOwner:
      'Financial — the bounded context that owns the CheckRequest lifecycle; decision ' +
      'authority is the manager holding the financial.check.manage remit.',
    status: 'APPROVED',
    statusRationale:
      'Both timestamps authoritative with proven single writers (submit/decide); the decision ' +
      'pair is the same submittedAt→decidedAt shape as the approved Production KPI-001.',
    cohort: 'FIRST',
    definition:
      'Population: check requests of the current tenant with managerDecision non-null, ' +
      'submittedAt non-null, decidedAt non-null, and decidedAt >= submittedAt. One row ' +
      'contributes one value: elapsed(decidedAt − submittedAt) in seconds. Only the LATEST ' +
      'manager round is measured: REQUEST_CORRECTION returns the row to SUBMITTED and ' +
      'resubmission overwrites submittedAt while a new decision overwrites decidedAt.',
    formula: {
      kind: 'MEAN_ELAPSED',
      from: 'submittedAt',
      to: 'decidedAt',
      statistic: 'MEAN',
      validRowRule: 'BOTH_TIMESTAMP_FIELDS_NON_NULL',
      orderingRule: 'TO_NOT_BEFORE_FROM',
    },
    candidateFormulas: [],
    authoritativeSource:
      'CheckRequest (aggregate root, finance_db) as projected by the approved read seam.',
    sourceContract: {
      seamToken: 'FinancialCheckRequestReportingReader',
      seamFile:
        'apps/api/src/modules/financial/reporting/financial-check-request-reporting.contract.ts',
      rowType: 'FinancialCheckRequestReportRow',
      rowFields: [
        'status',
        'managerDecision',
        'submittedAt',
        'decidedAt',
        'requestDate',
        'checkIssueType',
        'purchaseType',
      ],
      domainWriters: [
        'CheckRequestRepository.submit — stamps submittedAt when the row enters MANAGER_REVIEW.',
        'CheckRequestRepository.decide — stamps decidedAt with managerDecision in the same ' +
          'conditional transition; later stages write stage rows, never decidedAt.',
      ],
      tenantScoped: true,
    },
    timeSemantics: {
      cohortField: 'decidedAt',
      startField: 'submittedAt',
      endField: 'decidedAt',
      window:
        'Jalali calendar month of decidedAt in Asia/Tehran; the decision closes the measurement.',
      timezone: GOVERNED_WALL_CLOCK,
      calendar: GOVERNED_CALENDAR,
    },
    scope: 'CURRENT_AUTHENTICATED_TENANT',
    population: 'Tenant check requests with a recorded manager decision and an ordered pair.',
    exclusions:
      'Rows without a manager decision; null instants; decidedAt < submittedAt (stale pair ' +
      'after resubmission — awaiting the next decision); other tenants. Never zero-filled.',
    dimensions: ['status', 'managerDecision', 'checkIssueType', 'purchaseType', 'decidedAt'],
    unit: {
      semantic: 'SECONDS',
      presentation: 'Hours (display conversion only; the governed value is exact elapsed seconds).',
    },
    target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
    thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
    refreshSemantics: NOT_DEFINED_REFRESH,
    authorization: {
      readRemit: 'financial.check.read',
      moduleEntitlement: 'financial',
      newPermissionRequired: false,
      note: 'Reads through the source-owned seam under the source report remit.',
    },
    dataQuality: {
      classification: 'YELLOW',
      notes: [
        'Neither submit nor decide clears the pair: a row in MANAGER_REVIEW may carry a stale ' +
          'pair from the previous round, so the ordering rule (not managerDecision alone) ' +
          'defines the population. The stale case is deterministic, not a silent guess.',
        'The seam deliberately exposes no date-window filter — period-scoped computation ' +
          'requires a seam extension in the runtime phase.',
      ],
    },
    knownLimitations: [
      'Measures manager decision latency only; allocation/document/executive/issue/delivery ' +
        'stages are out of scope and must never be inferred from audit events or updatedAt.',
      'MEAN is the simplest statistic (§7); median/percentiles deferred pending a product decision.',
      'No target/threshold (NOT_DEFINED).',
    ],
    openQuestions: [],
    blockedReason: null,
    evidence: [
      'apps/api/src/modules/financial/check-request/check-request-status.ts — ten ordinals ' +
        'including terminal 8 and 50; manager decision vocabulary recorded.',
      'apps/api/src/modules/financial/check-request/check-request.repository.ts — submit ' +
        'stamps submittedAt at MANAGER_REVIEW entry; decide stamps decidedAt+managerDecision.',
      'apps/api/src/modules/financial/reporting/financial-check-request-reporting.contract.ts.',
    ],
  };

/** KPI-006 — Financial Check Request Approval Rate (candidate, DRAFT). */
const KPI_006_FINANCIAL_CHECK_REQUEST_APPROVAL_RATE: KpiDefinition<FinancialCheckRequestReportRow> =
  {
    id: 'KPI-006',
    technicalKey: 'financial-check-request-approval-rate',
    nameEn: 'Financial Check Request Approval Rate',
    nameFa: 'نرخ تایید درخواست‌های صدور چک',
    description: 'Share of decided check requests approved — exact decision point undecided.',
    businessQuestion: 'What share of decided check requests are approved rather than rejected?',
    ownerContext: 'financial',
    businessOwner: 'Financial — the bounded context that owns the CheckRequest lifecycle.',
    status: 'DRAFT',
    statusRationale:
      'Documented as a future candidate per the phase scope: the semantic decision point is ' +
      'not established by repository evidence, so no formula may be approved.',
    cohort: 'SECOND',
    definition:
      'Candidate only: no authoritative definition exists. The Financial lifecycle has three ' +
      'distinct decision points — the manager gate («آیا چک صادر شود؟» → decidedAt), the ' +
      'executive gate (stage 5), and the terminal outcome (COMPLETED vs TERMINATED) — and no ' +
      'repository evidence designates any one of them as “the approval”.',
    formula: null,
    candidateFormulas: [
      'Manager-gate: 100 × count(managerDecision=APPROVE) / count(managerDecision ∈ ' +
        '{APPROVE, REJECT}) — excludes REQUEST_CORRECTION as unresolved at the gate.',
      'Terminal-outcome: 100 × count(status=COMPLETED) / count(status ∈ {COMPLETED, ' +
        'TERMINATED}) — terminal states verified {8, 50}, but COMPLETED means the whole ' +
        'issuance flow finished, not merely “approved”.',
    ],
    authoritativeSource:
      'CheckRequest (aggregate root, finance_db) as projected by the approved read seam.',
    sourceContract: {
      seamToken: 'FinancialCheckRequestReportingReader',
      seamFile:
        'apps/api/src/modules/financial/reporting/financial-check-request-reporting.contract.ts',
      rowType: 'FinancialCheckRequestReportRow',
      rowFields: ['status', 'managerDecision', 'decidedAt', 'submittedAt'],
      domainWriters: [],
      tenantScoped: true,
    },
    timeSemantics: null,
    scope: 'CURRENT_AUTHENTICATED_TENANT',
    population: 'UNDEFINED — depends on the undecided decision point (manager gate vs terminal).',
    exclusions: 'UNDEFINED — same dependency.',
    dimensions: ['status', 'managerDecision', 'decidedAt'],
    unit: {
      semantic: 'PERCENT',
      presentation: 'Percent 0–100; no presentation rounding governed.',
    },
    target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
    thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
    refreshSemantics: NOT_DEFINED_REFRESH,
    authorization: {
      readRemit: 'financial.check.read',
      moduleEntitlement: 'financial',
      newPermissionRequired: false,
      note: 'Future runtime would read through the source-owned seam under the source report remit.',
    },
    dataQuality: {
      classification: 'BLOCKED',
      notes: [
        'APPROVAL_DECISION_POINT_NOT_ESTABLISHED: manager-gate, executive-gate and terminal ' +
          'readings each have structure but answer different business questions.',
        'Choosing one just because it looks symmetrical with the BOM approval rate is ' +
          'explicitly forbidden by the governance brief — the choice needs product evidence.',
      ],
    },
    knownLimitations: ['Not approved; documentation only for future implementation.'],
    openQuestions: [
      'Which decision point does the business mean by “approval”: manager gate, executive ' +
        'gate, or terminal outcome?',
      'Should REQUEST_CORRECTION count as a decision outcome in the denominator, given it ' +
        'returns the request for revision rather than refusing it?',
    ],
    blockedReason: null,
    evidence: [
      'apps/api/src/modules/financial/check-request/check-request-status.ts — ten ordinals; ' +
        'terminal {8, 50}; three distinct decision gates (manager, document, executive).',
    ],
  };

/** KPI-007 — HR Manual Attendance Ratio (candidate, DRAFT): an attendance data-source KPI. */
const KPI_007_HR_MANUAL_ATTENDANCE_RATIO: KpiDefinition<HrPersonnelTrafficReportRow> = {
  id: 'KPI-007',
  technicalKey: 'hr-manual-attendance-ratio',
  nameEn: 'HR Manual Attendance Ratio',
  nameFa: 'نرخ ثبت‌های دستی در تردد پرسنل',
  description:
    'Share of attendance register rows recorded as MANUAL corrections rather than DEVICE punches.',
  businessQuestion:
    'How much of the attendance register is manual correction rather than device record?',
  ownerContext: 'hr',
  businessOwner:
    'HR — the bounded context that owns the Attendance register; MANUAL rows are written ' +
    'through the correction act guarded by the hr.attendance.manage remit.',
  status: 'DRAFT',
  statusRationale:
    'Documented as a future candidate per the phase scope: the register supports the measure, ' +
    'but the row-share vs day-share denominator semantics needs a product decision.',
  cohort: 'SECOND',
  definition:
    'Candidate only: ratio of register rows with source=MANUAL to register rows with any ' +
    'source in the window. Register rows, not days or employees: a corrected employee-day can ' +
    'carry BOTH a DEVICE row and a MANUAL row (source is part of the row key; the DEVICE row ' +
    'is never touched by a correction), so a day-level reading would need different logic.',
  formula: null,
  candidateFormulas: [
    'Row-share: 100 × count(source=MANUAL) / count(source ∈ {DEVICE, MANUAL}) — directly ' +
      'answered by the traffic summary bySource counts.',
    'Day-share: 100 × employee-days having ≥1 MANUAL row / employee-days — needs per-row ' +
      'reads, not available from the summary; semantics undecided.',
  ],
  authoritativeSource:
    'Attendance (register in hr_db) as projected by the HR-approved traffic reporting seam.',
  sourceContract: {
    seamToken: 'HrPersonnelTrafficReportingReader',
    seamFile: 'apps/api/src/modules/hr/reporting/hr-personnel-traffic-reporting.contract.ts',
    rowType: 'HrPersonnelTrafficReportRow',
    rowFields: ['workDate', 'dateKey', 'clockIn', 'clockOut', 'source'],
    domainWriters: [
      'AttendanceService clock-in writes source DEVICE (the evidence row).',
      'AttendanceService adjust writes the one MANUAL row for that employee-day (a correction ' +
        'row, never an edit of the DEVICE row).',
    ],
    tenantScoped: true,
  },
  timeSemantics: null,
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population: 'UNDEFINED as governed share — row-share vs day-share choice is open.',
  exclusions: 'UNDEFINED — same dependency.',
  dimensions: ['workDate', 'dateKey', 'source'],
  unit: { semantic: 'PERCENT', presentation: 'Percent 0–100; no presentation rounding governed.' },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'hr.attendance.read',
    moduleEntitlement: 'hr',
    newPermissionRequired: false,
    note: 'Future runtime would read through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'YELLOW',
    notes: [
      'This is an attendance DATA-SOURCE/process KPI (how the register is recorded). It must ' +
        'NOT be represented as employee attendance, reliability, performance, or compliance — ' +
        'the Attendance source explicitly lacks attendance-status, absence, duration and rate ' +
        'semantics.',
      'A MANUAL row always rides alongside a stored day; DEVICE and MANUAL rows for the same ' +
        'day coexist by key design, so any day-share reading differs from the row-share sketch.',
    ],
  },
  knownLimitations: ['Not approved; documentation only for future implementation.'],
  openQuestions: [
    'Row-share vs day-share denominator: does the business want the share of manual ROWS ' +
      '(seam-ready) or the share of manually-corrected DAYS (needs per-row logic)?',
    'Is a manual-correction mix even wanted as a governed KPI, or is it only diagnostic?',
  ],
  blockedReason: null,
  evidence: [
    'apps/api/src/modules/hr/attendance/hr-attendance-source.ts — closed two-member set ' +
      'DEVICE|MANUAL; register has no attendance status/absence/duration semantics.',
    'apps/api/src/modules/hr/attendance/attendance.service.ts — clock-in writes DEVICE rows; ' +
      'adjust writes the MANUAL row and never touches DEVICE.',
    'apps/api/src/modules/hr/reporting/hr-personnel-traffic-reporting.contract.ts — row ' +
      'carries source, workDate, dateKey; summary strip counts per source exactly.',
  ],
};

/** KPI-008 — Production Pending Approval Aging (candidate, EVIDENCE_REVIEW). */
const KPI_008_PRODUCTION_PENDING_AGING: KpiDefinition<ProductionReportRow> = {
  id: 'KPI-008',
  technicalKey: 'production-pending-approval-aging',
  nameEn: 'Production Pending Approval Aging',
  nameFa: 'سن ماندگاری فهرست مواد در انتظار تایید',
  description:
    'Age of BOMs currently awaiting an approver decision, from routing to the evaluation instant.',
  businessQuestion: 'How long have the currently undecided BOMs been waiting for a decision?',
  ownerContext: 'production',
  businessOwner:
    'Production — the bounded context that owns the BOM lifecycle; decision authority is ' +
    'the snapshotted approver holding the production.bom.approve remit.',
  status: 'EVIDENCE_REVIEW',
  statusRationale:
    'Start event (submittedAt — “the instant routing began”) and population (SUBMITTED — ' +
    'the only status awaiting the approver) are evidence-established per §15; approve/defer ' +
    'decision waits on the aggregation statistic and as-of semantics, owned by the runtime.',
  cohort: 'SECOND',
  definition:
    'Population: BOM headers of the current tenant with status SUBMITTED and submittedAt ' +
    'non-null. Per row: elapsed(EVALUATION_INSTANT − submittedAt) in seconds. NOT measured ' +
    'from createdAt: a SUBMITTED row’s routing began exactly when submit stamped submittedAt.',
  formula: null,
  candidateFormulas: [
    'Snapshot mean age: mean over pending rows of elapsed(asOf − submittedAt).',
    'Oldest-wait-first: max over pending rows of elapsed(asOf − submittedAt) — which single ' +
      'number (or banded distribution) the business wants is undecided.',
  ],
  authoritativeSource:
    'BomHeader (aggregate root, production_db) as projected by the Production-approved read seam.',
  sourceContract: {
    seamToken: 'ProductionReportingReader',
    seamFile: 'apps/api/src/modules/production/reporting/production-reporting.contract.ts',
    rowType: 'ProductionReportRow',
    rowFields: ['status', 'submittedAt', 'projectRef', 'productTreeRef'],
    domainWriters: [
      'BomHeaderRepository.submit — stamps submittedAt atomically with the DRAFT→SUBMITTED move.',
    ],
    tenantScoped: true,
  },
  timeSemantics: {
    cohortField: 'EVALUATION_INSTANT',
    startField: 'submittedAt',
    endField: 'EVALUATION_INSTANT',
    window:
      'No period window: aging is meaningful only as-of an evaluation instant (UTC), to be ' +
      'fixed by the future runtime contract. Wall clock at evaluation: Asia/Tehran.',
    timezone: GOVERNED_WALL_CLOCK,
    calendar: GOVERNED_CALENDAR,
  },
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population: 'Tenant BOM headers with status SUBMITTED (awaiting the approver decision).',
  exclusions:
    'DRAFT including NEEDS_CORRECTION returns (awaiting the requester, not the approver); ' +
    'terminal rows (decided); null submittedAt; other tenants.',
  dimensions: ['projectRef', 'productTreeRef', 'submittedAt'],
  unit: {
    semantic: 'SECONDS',
    presentation: 'Days (display conversion only; the governed value is exact elapsed seconds).',
  },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'production.bom.read',
    moduleEntitlement: 'production',
    newPermissionRequired: false,
    note: 'Future runtime would read through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'GREEN',
    notes: [
      'submittedAt is stamped atomically with the SUBMITTED move, so every pending row ' +
        'carries the pending-start instant by construction.',
    ],
  },
  knownLimitations: ['Not approved; documentation only. Aggregation statistic undecided (§15).'],
  openQuestions: [
    'Which single number (or distribution) defines “aging”: mean age, oldest age, or age bands?',
    'How is the as-of evaluation instant fixed and rendered (the future runtime contract)?',
  ],
  blockedReason: null,
  evidence: [
    'apps/api/src/modules/production/bom/bom.repository.ts — “submittedAt is stamped here ' +
      'because this is the instant the routing fact began”.',
    'apps/api/src/modules/production/bom/bom-status.ts — SUBMITTED is the only routed-but-' +
      'undecided state; correction returns to DRAFT (requester-owned, not approval-pending).',
  ],
};

/** KPI-009 — Commerce Pending Purchase Aging (BLOCKED: no authoritative start instant). */
const KPI_009_COMMERCE_PENDING_PURCHASE_AGING: KpiDefinition<CommercePurchaseReportRow> = {
  id: 'KPI-009',
  technicalKey: 'commerce-pending-purchase-aging',
  nameEn: 'Commerce Pending Purchase Aging',
  nameFa: 'سن ماندگاری درخواست خرید در انتظار تکمیل',
  description: 'Age of open purchase documents — BLOCKED: the pending-start instant is missing.',
  businessQuestion: 'How long have the currently open purchase requests been waiting?',
  ownerContext: 'commerce',
  businessOwner:
    'Commerce — the bounded context that owns the PurchaseDocument lifecycle; completion ' +
    'authority is gated by the tenant completion policy and the commerce.manage remit.',
  status: 'BLOCKED',
  statusRationale:
    'Blocked per the no-guessing rule: the pending-clock start event and the pending ' +
    'population cannot be established from the PurchaseDocument aggregate.',
  cohort: 'SECOND',
  definition:
    'No authoritative definition exists. PurchaseDocument persists no submission/entry ' +
    'instant for its open states: markDocumentSubmitted writes only status (no timestamp), ' +
    'so “when did this purchase become pending” has no document-level column.',
  formula: null,
  candidateFormulas: [
    'age = asOf − <authoritative open-state entry instant> for the pending population — ' +
      'both the instant and the population are undefined today (see blockedReason).',
  ],
  authoritativeSource:
    'PurchaseDocument (aggregate root, commerce_db) as projected by the approved read seam.',
  sourceContract: {
    seamToken: 'CommercePurchaseReportingReader',
    seamFile: 'apps/api/src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts',
    rowType: 'CommercePurchaseReportRow',
    rowFields: ['status', 'kind', 'supplierId', 'createdAt', 'completedAt'],
    domainWriters: [],
    tenantScoped: true,
  },
  timeSemantics: null,
  scope: 'CURRENT_AUTHENTICATED_TENANT',
  population: 'UNDEFINED — no authoritative open-state entry instant exists on the aggregate.',
  exclusions: 'UNDEFINED — same dependency.',
  dimensions: [],
  unit: {
    semantic: 'SECONDS',
    presentation: 'Days (display conversion only; not computable until unblocked).',
  },
  target: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE },
  thresholds: { state: 'NOT_DEFINED', evidence: NO_SLA_EVIDENCE_NOTE, items: [] },
  refreshSemantics: NOT_DEFINED_REFRESH,
  authorization: {
    readRemit: 'commerce.read',
    moduleEntitlement: 'commerce',
    newPermissionRequired: false,
    note: 'Future runtime would read through the source-owned seam under the source report remit.',
  },
  dataQuality: {
    classification: 'BLOCKED',
    notes: [
      'START_EVENT_NOT_AUTHORITATIVE: createdAt is document creation (pre-routing), updatedAt ' +
        'is rewritten by every touch — neither is an open-state entry instant (§15 forbids ' +
        'defaulting to now−createdAt).',
      'WorkflowInstance.createdAt exists only for documents that entered a workflow and is a ' +
        'different aggregate not exposed on the Commerce reporting seam — cross-aggregate ' +
        'derivation would bypass the seam contract.',
    ],
  },
  knownLimitations: ['Blocked; documentation only. No formula may be approved.'],
  openQuestions: [
    'Which statuses constitute “pending purchase” (SUBMITTED? APPROVED-awaiting-CLOSED? DRAFT?)?',
    'Which event starts the pending clock — and on which aggregate does it live?',
  ],
  blockedReason:
    'START_EVENT_AND_POPULATION_NOT_ESTABLISHED: PurchaseDocument stores no submission or ' +
    'state-entry timestamp (markDocumentSubmitted/writeCompletedIn are the only status writers; ' +
    'only the completion act stamps an instant), and the pending population is undefined ' +
    '(decision-pending vs completion-pending are different clocks). Deriving the start from ' +
    'updatedAt or from the WorkflowInstance aggregate is forbidden by the governance rules.',
  evidence: [
    'apps/api/src/modules/commerce/purchase/purchase.repository.ts — writeSubmitted persists ' +
      'only status (no instant); completedAt is the only stamped lifecycle instant.',
    'apps/api/prisma/commerce/schema.prisma — PurchaseDocument date columns: createdAt, ' +
      'updatedAt, completedAt. No submittedAt / no state-entry instant exists.',
    'apps/api/src/modules/commerce/reporting/commerce-purchase-reporting.contract.ts — row ' +
      'projects only the document columns above; workflow internals are out of contract.',
  ],
};

/**
 * The governed catalog: nine entries, frozen. Five first-cohort KPIs form the approval
 * objective; four second-cohort candidates stay documented-but-unapproved (§34: evidence
 * determines final status — the statuses above ARE the evidence-determined outcome).
 */
export const KPI_CATALOG: readonly AnyKpiDefinition[] = Object.freeze([
  KPI_001_PRODUCTION_BOM_DECISION_CYCLE_TIME,
  KPI_002_PRODUCTION_BOM_APPROVAL_RATE,
  KPI_003_COMMERCE_PURCHASE_CYCLE_TIME,
  KPI_004_COMMERCE_PURCHASE_COMPLETION_RATE,
  KPI_005_FINANCIAL_CHECK_REQUEST_DECISION_TIME,
  KPI_006_FINANCIAL_CHECK_REQUEST_APPROVAL_RATE,
  KPI_007_HR_MANUAL_ATTENDANCE_RATIO,
  KPI_008_PRODUCTION_PENDING_AGING,
  KPI_009_COMMERCE_PENDING_PURCHASE_AGING,
]);

/** Lookup by KPI ID (`KPI-001` … `KPI-009`); undefined when unknown — never a guess. */
export function getKpiById(id: string): AnyKpiDefinition | undefined {
  return KPI_CATALOG.find((entry) => entry.id === id);
}

/** Lookup by technical key; undefined when unknown — never a guess. */
export function getKpiByTechnicalKey(technicalKey: string): AnyKpiDefinition | undefined {
  return KPI_CATALOG.find((entry) => entry.technicalKey === technicalKey);
}
