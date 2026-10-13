/**
 * KPI Definition & Governance — the TYPED definition model for the first KPI cohort.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Phase KPI-DEFINITION-GOVERNANCE establishes WHAT a KPI is before anything is allowed to
 * calculate one. A KPI here is a governed, reviewable DEFINITION — business question, owner,
 * authoritative source, structural formula, time semantics, population, exclusions, unit,
 * tenant scope, authorization, data quality — and nothing else. This module owns the TYPES
 * and the QUALITY GATES that decide whether a definition may carry the status `APPROVED`;
 * `kpi-catalog.ts` owns the nine definitions themselves.
 *
 * WHAT THIS FILE DELIBERATELY IS NOT
 * ---------------------------------
 *  * NOT a calculation engine: there is no evaluator, no aggregation, no clock, no query.
 *    `KpiFormula` is a closed structural union a FUTURE runtime may translate — never an
 *    expression string, never `eval`, never SQL (governance rule: formulas are structural
 *    or documented mathematics only).
 *  * NOT a NestJS module: no decorator, no provider, no route, no import from any bounded
 *    context's persistence. `kpi-isolation.spec.ts` re-reads the file system to prove it.
 *  * NOT a target store: every target/threshold enters the catalog explicitly as
 *    `NOT_DEFINED` unless repository evidence establishes an SLA — and none does today.
 *
 * DEPENDENCY DIRECTION (architecture boundary, unchanged)
 * ------------------------------------------------------
 *   Domain → domain-owned reporting/source seam → Reporting → KPI governance (here).
 * The catalog reaches the seam CONTRACTS by TYPE only (`import type`), which erases at
 * compile time: the compiler proves every field a definition names (timestamps, dimensions,
 * status vocabularies) actually exists on the seam row the source owns — evidence-backed
 * definitions rather than plausible-looking strings.
 */

/** The governance lifecycle. Small and explicit; it documents readiness, it is not a workflow engine. */
export const KPI_LIFECYCLE_STATES = [
  'DRAFT',
  'EVIDENCE_REVIEW',
  'APPROVED',
  'BLOCKED',
  'DEPRECATED',
] as const;
export type KpiLifecycleState = (typeof KPI_LIFECYCLE_STATES)[number];

/**
 * Data-quality classification (§24). GREEN = every source field authoritative and present.
 * YELLOW = meaningful but a documented limitation exists. BLOCKED = required semantic or
 * source evidence does not exist. A `BLOCKED` classification can never be approved.
 */
export const KPI_DATA_QUALITY_CLASSES = ['GREEN', 'YELLOW', 'BLOCKED'] as const;
export type KpiDataQualityClass = (typeof KPI_DATA_QUALITY_CLASSES)[number];

/** Which cohort a KPI belongs to. The FIRST cohort is this phase's approval objective. */
export const KPI_COHORTS = ['FIRST', 'SECOND'] as const;
export type KpiCohort = (typeof KPI_COHORTS)[number];

/**
 * Tenant scope (§19). The ONLY member today: every first-cohort KPI is tenant-scoped.
 * Cross-tenant executive aggregation is a later architectural decision and would have to
 * add a member here deliberately — nothing computes across tenants while this is a singleton.
 */
export const KPI_SCOPES = ['CURRENT_AUTHENTICATED_TENANT'] as const;
export type KpiScope = (typeof KPI_SCOPES)[number];

/** The bounded-context categories a KPI can belong to (§16 ownership categories). */
export const KPI_OWNER_CONTEXTS = [
  'production',
  'commerce',
  'financial',
  'hr',
  'management',
] as const;
export type KpiOwnerContext = (typeof KPI_OWNER_CONTEXTS)[number];

/** A field name proven to exist on the seam row — the compile-time evidence link. */
export type KpiRowField<Row extends object> = Extract<keyof Row, string>;

/**
 * A structural count selector — closed, data-only, never an expression (§23). `oneOf` values
 * are checked against the domain's closed status/source vocabulary by
 * `satisfies readonly SomeVocabulary[]` at each catalog entry, so a typo like 'APPROVEDD'
 * or a foreign lifecycle's status is a compile error, not a plausible-looking string.
 */
export type KpiCountSelector =
  | { readonly dimension: 'status'; readonly oneOf: readonly string[] }
  | { readonly dimension: 'status'; readonly all: true }
  | { readonly dimension: 'source'; readonly oneOf: readonly string[] };

/**
 * Duration formula: the arithmetic mean of per-row elapsed seconds between two authoritative
 * timestamp fields. `statistic: 'MEAN'` is stated structurally because §7 forbids assuming a
 * statistic silently — mean is the simplest deterministic choice; median/percentile require
 * a product decision (recorded as a known limitation, not smuggled in).
 *
 * `validRowRule` / `orderingRule` are the exclusion semantics: rows missing either instant,
 * or with `to < from`, are EXCLUDED from the population and never zero-filled.
 */
export interface KpiMeanElapsedFormula<Row extends object> {
  readonly kind: 'MEAN_ELAPSED';
  readonly from: KpiRowField<Row>;
  readonly to: KpiRowField<Row> | 'EVALUATION_INSTANT';
  readonly statistic: 'MEAN';
  readonly validRowRule: 'BOTH_TIMESTAMP_FIELDS_NON_NULL';
  readonly orderingRule: 'TO_NOT_BEFORE_FROM';
}

/**
 * Ratio formula over structural counts. `zeroDenominator: 'NOT_AVAILABLE'` is a governance
 * rule, not a formatting choice: an empty denominator yields NOT_AVAILABLE — reporting 0%
 * for "no decisions existed" would be a fabricated measurement.
 */
export interface KpiRatioPercentFormula {
  readonly kind: 'RATIO_PERCENT';
  readonly numerator: KpiCountSelector;
  readonly denominator: KpiCountSelector;
  readonly zeroDenominator: 'NOT_AVAILABLE';
}

/** The closed set of formula shapes the first cohort may use. No strings, no SQL, no eval. */
export type KpiFormula<Row extends object> = KpiMeanElapsedFormula<Row> | KpiRatioPercentFormula;

/**
 * Time semantics (§18): which event places a record in a period, which instants delimit a
 * duration, and exactly how periods, zones and calendars behave. The window/timezone/calendar
 * strings are governance prose that must stay consistent across the catalog; the typed fields
 * are checked against the seam row.
 *
 * `cohortField: 'EVALUATION_INSTANT'` marks a snapshot metric (aging) with no period cohort
 * that is only meaningful as of an evaluation instant.
 */
export interface KpiTimeSemantics<Row extends object> {
  readonly cohortField: KpiRowField<Row> | 'EVALUATION_INSTANT';
  readonly startField: KpiRowField<Row> | 'NONE';
  readonly endField: KpiRowField<Row> | 'EVALUATION_INSTANT' | 'NONE';
  readonly window: string;
  readonly timezone: string;
  readonly calendar: string;
}

/**
 * Units (§7): `semantic` is the storage-independent governed value — SECONDS for durations
 * (exact difference of two UTC instants) and PERCENT for rates. `presentation` documents the
 * display conversion only; changing presentation never changes the governed value.
 */
export interface KpiUnit {
  readonly semantic: 'SECONDS' | 'PERCENT';
  readonly presentation: string;
}

/** A target ("what good means") — never invented (§17). NOT_DEFINED requires evidence of absence. */
export type KpiTarget =
  | { readonly state: 'NOT_DEFINED'; readonly evidence: string }
  | { readonly state: 'DEFINED'; readonly value: string; readonly evidence: string };

/** A threshold ("when management gets concerned") — same no-invention rule as `KpiTarget`. */
export type KpiThreshold = {
  readonly name: string;
  readonly comparator: '>' | '>=' | '<' | '<=' | '==';
  readonly value: string;
  readonly evidence: string;
};

export interface KpiThresholds {
  readonly state: 'NOT_DEFINED' | 'DEFINED';
  readonly evidence: string;
  /** Must be empty while `state` is NOT_DEFINED — enforced by `kpiApprovalIssues`. */
  readonly items: readonly KpiThreshold[];
}

/**
 * Refresh semantics (§4). This phase computes nothing, so refresh is explicitly
 * NOT_APPLICABLE — stated rather than omitted, so a future runtime cannot assume a cadence
 * the governance layer never approved.
 */
export interface KpiRefreshSemantics {
  readonly mode: 'NOT_APPLICABLE_DEFINITION_ONLY';
  readonly note: string;
}

/**
 * Authorization (§19/§22): a KPI read answers to the SOURCE report's existing remit plus the
 * module entitlement. `newPermissionRequired: false` is a literal — KPI governance introduces
 * no new permission and no new surface.
 */
export interface KpiAuthorization {
  readonly readRemit: string;
  readonly moduleEntitlement: string;
  readonly newPermissionRequired: false;
  readonly note: string;
}

/**
 * The authoritative source contract (§4): which seam token serves the KPI, which row type it
 * projects, which fields the definition consumes, and — the evidence half — which domain
 * writers stamp the timestamps the formula relies on.
 */
export interface KpiSourceContract<Row extends object> {
  readonly seamToken: string;
  readonly seamFile: string;
  readonly rowType: string;
  readonly rowFields: readonly KpiRowField<Row>[];
  readonly domainWriters: readonly string[];
  readonly tenantScoped: true;
}

export interface KpiDataQuality {
  readonly classification: KpiDataQualityClass;
  readonly notes: readonly string[];
}

/** One governed KPI definition. Row-typed so seam drift breaks the build, not the meaning. */
export interface KpiDefinition<Row extends object = Record<string, unknown>> {
  readonly id: string;
  readonly technicalKey: string;
  readonly nameEn: string;
  readonly nameFa: string;
  readonly description: string;
  readonly businessQuestion: string;
  readonly ownerContext: KpiOwnerContext;
  readonly businessOwner: string;
  readonly status: KpiLifecycleState;
  /** Why the entry holds THIS status — evidence, not narrative (§21: every status has evidence). */
  readonly statusRationale: string;
  readonly cohort: KpiCohort;
  readonly definition: string;
  /** Structural formula; null only while a candidate documents open formula prose instead. */
  readonly formula: KpiFormula<Row> | null;
  /** Prose sketches of formulas deliberately NOT chosen — never executable. */
  readonly candidateFormulas: readonly string[];
  /** The domain truth the definition reads (the aggregate, not the report surface). */
  readonly authoritativeSource: string;
  readonly sourceContract: KpiSourceContract<Row> | null;
  readonly timeSemantics: KpiTimeSemantics<Row> | null;
  readonly scope: KpiScope;
  /** Who counts — explicit per §22 (no invented eligibility). */
  readonly population: string;
  /** Who does not count — per §22 (missing/stale pairs are excluded, never zero-filled). */
  readonly exclusions: string;
  readonly dimensions: readonly KpiRowField<Row>[];
  readonly unit: KpiUnit;
  readonly target: KpiTarget;
  readonly thresholds: KpiThresholds;
  readonly refreshSemantics: KpiRefreshSemantics;
  readonly authorization: KpiAuthorization;
  readonly dataQuality: KpiDataQuality;
  readonly knownLimitations: readonly string[];
  /** Required for every non-APPROVED entry: the semantic gaps that block approval. */
  readonly openQuestions: readonly string[];
  /** Required when status is BLOCKED: the exact missing evidence (§2). */
  readonly blockedReason: string | null;
  /** Repository evidence: existing file paths, each with what it proves. */
  readonly evidence: readonly string[];
}

/**
 * The shape validators and specs consume. Every validator takes `KpiDefinition<never>`:
 * because `Row` appears only in key-name positions (`Extract<keyof Row, string>`), the
 * `never` instantiation widens every literal field name to `string`, so each concrete
 * `KpiDefinition<SpecificRow>` is assignable without any cross-type coercion — the gates
 * read values, never the row type, and the row-typed evidence link in the catalog stands.
 */
/**
 * The §22 quality gates, expressed as an issues list. An empty list means an entry MAY be
 * marked APPROVED; any entry that IS approved must produce an empty list (asserted by
 * `validateKpiRegistry`, which proves that stripping a required field makes an APPROVED
 * definition fail — the status-integrity guarantee of §29).
 */
export function kpiApprovalIssues(def: KpiDefinition<never>): readonly string[] {
  const issues: string[] = [];
  const present = (value: string | null | undefined): boolean =>
    typeof value === 'string' && value.trim().length > 0;
  const pushIf = (condition: boolean, message: string): void => {
    if (condition) issues.push(message);
  };

  pushIf(!present(def.id), 'id is required');
  pushIf(present(def.id) && !/^KPI-\d{3}$/.test(def.id), `id must match KPI-nnn (got "${def.id}")`);
  pushIf(!present(def.technicalKey), 'technicalKey is required');
  pushIf(
    present(def.technicalKey) && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(def.technicalKey),
    `technicalKey must be kebab-case (got "${def.technicalKey}")`
  );
  pushIf(!present(def.nameEn), 'nameEn is required');
  pushIf(!present(def.nameFa), 'nameFa (Persian name) is required');
  pushIf(!present(def.description), 'description is required');
  pushIf(!present(def.businessQuestion), 'businessQuestion is required');
  pushIf(!present(def.businessOwner), 'businessOwner is required (§16)');
  pushIf(!present(def.statusRationale), 'statusRationale is required (every status has evidence)');
  pushIf(!present(def.definition), 'definition is required');
  pushIf(def.formula === null, 'a structural formula is required for approval (§23)');
  pushIf(!present(def.authoritativeSource), 'authoritativeSource is required (§1)');
  pushIf(!present(def.population), 'population must be explicit (§22)');
  pushIf(!present(def.exclusions), 'exclusions must be explicit (§22)');
  pushIf(def.sourceContract === null, 'an authoritative source contract is required (§22)');
  if (def.sourceContract !== null) {
    const contract = def.sourceContract;
    pushIf(!present(contract.seamToken), 'sourceContract.seamToken is required');
    pushIf(!present(contract.seamFile), 'sourceContract.seamFile is required');
    pushIf(!present(contract.rowType), 'sourceContract.rowType is required');
    pushIf(contract.rowFields.length === 0, 'sourceContract.rowFields must be non-empty');
    pushIf(contract.domainWriters.length === 0, 'sourceContract.domainWriters must be non-empty');
    pushIf(contract.tenantScoped !== true, 'sourceContract must be tenant-scoped (§19)');
  }
  pushIf(def.timeSemantics === null, 'time semantics are required for approval (§18)');
  if (def.timeSemantics !== null) {
    pushIf(!present(def.timeSemantics.window), 'timeSemantics.window is required');
    pushIf(!present(def.timeSemantics.timezone), 'timeSemantics.timezone is required');
    pushIf(!present(def.timeSemantics.calendar), 'timeSemantics.calendar is required');
  }
  pushIf(
    def.scope !== 'CURRENT_AUTHENTICATED_TENANT',
    'scope must be CURRENT_AUTHENTICATED_TENANT (§19)'
  );
  pushIf(def.dimensions.length === 0, 'at least one source-supported dimension is required (§20)');
  pushIf(!present(def.unit.presentation), 'unit.presentation is required (§7)');
  pushIf(
    def.target.state === 'DEFINED' && !present((def.target as { value?: string }).value ?? null),
    'a DEFINED target must state its value (§17)'
  );
  pushIf(
    def.target.state === 'NOT_DEFINED' && !present(def.target.evidence),
    'a NOT_DEFINED target must state its evidence of absence (§17)'
  );
  pushIf(
    def.thresholds.state === 'DEFINED' && def.thresholds.items.length === 0,
    'a DEFINED threshold set must contain at least one threshold (§17)'
  );
  pushIf(
    def.thresholds.state === 'NOT_DEFINED' && def.thresholds.items.length > 0,
    'a NOT_DEFINED threshold set must not carry thresholds (§17)'
  );
  pushIf(
    def.thresholds.state === 'NOT_DEFINED' && !present(def.thresholds.evidence),
    'a NOT_DEFINED threshold set must state its evidence of absence (§17)'
  );
  pushIf(
    def.refreshSemantics.mode !== 'NOT_APPLICABLE_DEFINITION_ONLY',
    'refresh semantics must be explicitly NOT_APPLICABLE in this phase (§4)'
  );
  pushIf(!present(def.refreshSemantics.note), 'refreshSemantics.note is required');
  pushIf(!present(def.authorization.readRemit), 'authorization.readRemit is required (§22)');
  pushIf(
    !present(def.authorization.moduleEntitlement),
    'authorization.moduleEntitlement is required (§22)'
  );
  pushIf(
    def.authorization.newPermissionRequired !== false,
    'KPI governance must not introduce a new permission (§19)'
  );
  pushIf(!present(def.authorization.note), 'authorization.note is required');
  pushIf(
    def.dataQuality.classification === 'BLOCKED',
    'a BLOCKED data-quality classification cannot be approved (§24)'
  );
  pushIf(def.dataQuality.notes.length === 0, 'data-quality notes are required (§24)');
  pushIf(def.knownLimitations.length === 0, 'known limitations must be stated explicitly (§22)');
  pushIf(def.evidence.length === 0, 'at least one repository evidence reference is required');
  pushIf(def.openQuestions.length > 0, 'an APPROVED KPI must not carry open questions (§22)');
  pushIf(present(def.blockedReason), 'an APPROVED KPI must not carry a blockedReason (§2)');

  return issues;
}

/**
 * Registry-wide integrity (§30): uniqueness, formats, tenant scope, and status-specific
 * completeness. Empty list = every entry coherent AND every APPROVED entry passes §22.
 */
export function validateKpiRegistry(defs: readonly KpiDefinition<never>[]): readonly string[] {
  const issues: string[] = [];

  if (defs.length === 0) {
    issues.push('registry must not be empty');
    return issues;
  }

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const def of defs) {
    if (seenIds.has(def.id)) issues.push(`duplicate KPI id "${def.id}"`);
    if (seenKeys.has(def.technicalKey))
      issues.push(`duplicate technical key "${def.technicalKey}"`);
    seenIds.add(def.id);
    seenKeys.add(def.technicalKey);

    if (def.statusRationale.trim().length === 0) {
      issues.push(`${def.id}: statusRationale must document why this status holds (§21)`);
    }
    if (def.target.state === 'NOT_DEFINED' && def.target.evidence.trim().length === 0) {
      issues.push(`${def.id}: NOT_DEFINED target must state its evidence of absence (§17)`);
    }
    if (def.thresholds.state === 'NOT_DEFINED' && def.thresholds.evidence.trim().length === 0) {
      issues.push(`${def.id}: NOT_DEFINED thresholds must state their evidence of absence (§17)`);
    }
    if (def.scope !== 'CURRENT_AUTHENTICATED_TENANT') {
      issues.push(`${def.id}: scope must be CURRENT_AUTHENTICATED_TENANT (§19)`);
    }
    if (def.authorization.newPermissionRequired !== false) {
      issues.push(`${def.id}: authorization must not require a new permission (§19)`);
    }

    switch (def.status) {
      case 'APPROVED':
        for (const issue of kpiApprovalIssues(def)) issues.push(`${def.id}: ${issue}`);
        break;
      case 'BLOCKED':
        if (def.blockedReason === null || def.blockedReason.trim().length === 0) {
          issues.push(
            `${def.id}: BLOCKED status requires a blockedReason naming missing evidence (§2)`
          );
        }
        break;
      case 'DRAFT':
      case 'EVIDENCE_REVIEW':
        if (def.openQuestions.length === 0) {
          issues.push(`${def.id}: ${def.status} status requires documented openQuestions (§2)`);
        }
        break;
      case 'DEPRECATED':
        break;
    }
  }

  return issues;
}
