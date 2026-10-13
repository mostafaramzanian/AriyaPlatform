import { coreGet, corePost } from './core-http';
import type { HrTone } from './hr-api';

/**
 * Phase 54-I (§12, §13, §14, §27): the WEB CLIENT for leave-policy simulation —
 * `GET /hr/leave-policies/*` and `POST /hr/leave-policies/:policyId/simulate`.
 *
 * WHY THIS IS A SECOND FILE RATHER THAN MORE OF `hr-api.ts`
 * --------------------------------------------------------
 * `hr-api.ts` is the HR-1..HR-3A surface: employees, positions, attendance, and the leave REGISTER —
 * the things an employee or a manager reads and an administrator records against. A policy is a
 * different object with a different audience and a different permission, and its own lifecycle
 * (DRAFT/VALIDATED/PUBLISHED/ARCHIVED, §10–§11) that nothing in `hr-api.ts` models. Keeping them
 * apart is the same division `leave-policy.dto.ts` keeps on the server, and it is what lets the
 * types in this file be read as ONE contract.
 *
 * THE EVIDENCE LEVEL IS NOT A FIELD HERE, AND THAT IS THE POINT (§27.2, §33.8)
 * --------------------------------------------------------------------------
 * The simulation body carries no `level`, no `evidenceLevel`, no `role`, no `permission` and no
 * `tenantId`. §27.2 requires a role-appropriate projection to be made SERVER-SIDE — "the payload a
 * lower layer receives does not *contain* the advanced detail at all" — so the client cannot name
 * its own disclosure, and the types below describe what ARRIVES rather than offering a menu. The
 * server decides; this file only describes.
 *
 * NOTHING IN THIS FILE RECOMPUTES ANYTHING. Every count, basis, window and verdict is read off the
 * response. §13.2 makes an explanation derived rather than re-derived, and a client that
 * recalculated a limit would be the second evaluator §14.2 forbids.
 */

// ---------------------------------------------------------------------------
// Vocabulary (§10.3, §11, §16) — the DECLARED members, never a widened string
// ---------------------------------------------------------------------------

/**
 * A policy version's lifecycle state, mirrored from `LeavePolicyVersionStatus`.
 *
 * FOUR MEMBERS, AND THE TYPE IS NOT WIDENED TO `string`: §10.3 makes these four the whole
 * vocabulary, so a renderer that had to handle an unknown state would need a label for a state the
 * server cannot produce. A value outside this union is a contract defect, not a fifth state.
 */
export type HrLeavePolicyVersionStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';

/**
 * §16.1's counting basis — MANDATORY wherever a maximum is displayed (D7).
 *
 * Declared here as well as on the result's limits because §32.3 requires a maximum to be shown WITH
 * its basis: a bare "3" is exactly the ambiguity D7 refuses to allow, so a screen that renders a
 * maximum without this has rendered an unreadable number.
 */
export type HrLeaveLimitCountingBasis = 'REQUEST_COUNT' | 'DAY_COUNT';

/** The resolved Jalali period a limit counts over. §16.2 freezes one member in this phase. */
export type HrLeaveLimitPeriodKind = 'YEAR';

// ---------------------------------------------------------------------------
// Policy reads (§12, §15)
// ---------------------------------------------------------------------------

/** A leave policy CONTAINER (§15.1). It carries no rules of its own — versions do. */
export interface HrLeavePolicy {
  id: string;
  tenantId: string;
  /** The tenant's own code for this instrument. */
  code: string;
  name: string;
}

/**
 * One policy version as it is STORED (§10.1, §10.6).
 *
 * `effectiveFrom`/`effectiveTo` are `YYYY-MM-DD` CALENDAR DAYS, not instants: §16.2 makes a window
 * two inclusive days, and the server emits exactly this shape. A renderer formats them with the
 * project's day helpers; it never parses one into a `Date` and re-derives a window of its own.
 *
 * `payload` IS DELIBERATELY NOT MODELLED beyond `unknown`. §15.6 stores the body the engine
 * validated, and the module states that interpreting it "is the engine's question" — so a typed
 * field here would invite a client to read rule content the server never projected.
 */
export interface HrLeavePolicyVersion {
  id: string;
  tenantId: string;
  policyId: string;
  /** The author's own label for this version — what an operator recognises it by. */
  versionLabel: string;
  status: HrLeavePolicyVersionStatus;
  jalaliYear: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: unknown;
  publishedAt: string | null;
  publishedByEmployeeId: string | null;
}

/** One stored LIMIT (§16), as the server reports it. */
export interface HrLeaveLimit {
  id: string;
  tenantId: string;
  policyId: string;
  policyVersionId: string;
  leaveTypeId: string;
  /** `null` means "applies to every employment type" (§16.6) — a real answer, not a missing one. */
  employmentType: string | null;
  maximum: number;
  countingBasis: HrLeaveLimitCountingBasis;
  period: HrLeaveLimitPeriodKind;
  jalaliYear: number;
  /** The authored window, as stored — `YYYY-MM-DD`, never re-derived by a client. */
  windowStart: string;
  windowEnd: string;
  /** §16.4: the states that consume the limit. ALWAYS present; empty only as a data defect. */
  consumesStates: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * §12's authoritative answer to "which policy governs this leave type on this day?".
 *
 * FOUR ANSWERS, AND `version: null` IS ONE OF THEM: §15.8 makes "no policy has been stated" a real
 * configuration state, so an ungoverned day is NOT an error and NOT an empty list — it is the
 * answer that the tenant has stated nothing, and a screen must render it as that rather than as a
 * failure.
 *
 * `undecidableLimits` IS CARRIED RATHER THAN DROPPED (§16.6): a limit whose employment scope cannot
 * be established is a REFUSAL on the request path, so a screen showing only `limits` would report a
 * clean configuration where one is genuinely indecidable.
 */
export interface HrEffectiveLeavePolicy {
  /** The day the question was answered for, `YYYY-MM-DD`. */
  asOf: string;
  policy: HrLeavePolicy | null;
  version: HrLeavePolicyVersion | null;
  limits: HrLeaveLimit[];
  undecidableLimits: HrLeaveLimit[];
  /** `true` only when the caller asked the historical question (`includeArchived`). */
  historical: boolean;
}

/** The query the effective resolution accepts — exactly what §15.4 authorises. */
export interface HrEffectiveLeavePolicyQuery {
  /** `YYYY-MM-DD`. Absent means the server's today, which is the only safe default for a day. */
  asOf?: string;
  /** Narrows the answer to one leave type's limits. */
  leaveTypeId?: string;
  /**
   * The employment scope to resolve for. ABSENT means "scope by leave type only", and the resolver
   * then returns every applicable scope rather than guessing one (§16.6) — so absence is a real
   * answer here, not a missing input.
   */
  employmentType?: string;
  /** Ask the HISTORICAL question. Off by default; see `HrEffectiveLeavePolicy.historical`. */
  includeArchived?: boolean;
}

// ---------------------------------------------------------------------------
// Simulation (§14) — request
// ---------------------------------------------------------------------------

/**
 * §14's typed `context`: the facts the simulated question is about.
 *
 * EVERY FIELD IS A §16 COORDINATE, mirroring `LEAVE_LIMIT_SIMULATION_SCALARS` on the server. There
 * is deliberately no `consumesStates`: the resolved 54-H decision leaves the authored
 * consumed-state set to the LIMIT's own stored definition, where it reaches the engine through each
 * projected rule's `where` clause — so a client that sent one would be simulating a policy whose
 * state set differs from the one in force.
 */
export interface HrLeavePolicySimulationContext {
  /** The leave type the question is about. Required. */
  leaveTypeId: string;
  /**
   * §16.6's employment scope.
   *
   * OMITTED RATHER THAN DEFAULTED when unknown, because the server treats absence as "cannot be
   * stated" — an insufficient-context case a scoped limit must REFUSE on (§16.6) — which is a
   * different sentence from `null`. A client that filled in a default would silently widen or narrow
   * an entitlement.
   */
  employmentType?: string;
  /** The requested range's inclusive bounds, `YYYY-MM-DD`. `requestedTo` defaults server-side. */
  requestedFrom?: string;
  requestedTo?: string;
}

/** §14's `subject`: whose records the collections are assembled from. */
export interface HrLeavePolicySimulationSubject {
  employeeId: string;
}

/**
 * §14's simulation body — THE COMPLETE SET OF FIELDS A CLIENT MAY SEND.
 *
 * WHAT IS ABSENT IS THE CONTRACT, so it is stated here rather than left to inference:
 *
 *   * `level` / `evidenceLevel` — the evidence level is the SURFACE's, derived server-side from
 *     `hr.leave.policy` (§13.3, §27.2, §27.6). A client-sent level would make the caller the
 *     authority on its own disclosure, which is the vulnerability 54-I closed.
 *   * `role` / `permission` — no client-supplied authority (§25.7).
 *   * `tenantId` — tenancy is resolved from the actor, fail-closed (§24.1), and the global
 *     `ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`, so sending one is a 400 rather
 *     than an ignored field.
 *   * `status` / `force` / `skipLimitCheck` — a version's state is the STORED row's, and §16 has no
 *     bypass.
 */
export interface HrLeavePolicySimulationRequest {
  /**
   * §14: which rule set to simulate.
   *
   * The server owns exactly one (`hr.leave.limit`) and refuses any other, so this is sent as the
   * constant below rather than as free text: a client cannot name a different set, and the constant
   * is the same string the service validates against.
   */
  ruleSetId: string;
  /**
   * The exact stored version to simulate.
   *
   * OMITTED MEANS "THE CURRENTLY EFFECTIVE PUBLISHED CONFIGURATION" (§14). Supplying it selects one
   * named configuration, including a DRAFT, VALIDATED or ARCHIVED one — which is the whole point of
   * a simulation surface, and why this is a lookup for a named version rather than a governance
   * question. The client sends it ONLY when the operator explicitly chose a version; it never
   * substitutes a default of its own.
   */
  versionId?: string;
  /** When to evaluate, ISO-8601. Optional; the server defaults it at the boundary (§14, D12). */
  evaluationInstant?: string;
  context: HrLeavePolicySimulationContext;
  subject?: HrLeavePolicySimulationSubject;
}

/**
 * The rule-set identity this client simulates — the same constant the server validates against.
 *
 * DECLARED HERE RATHER THAN INLINED AT THE CALL SITE, so the contract has one spelling: the server
 * refuses any other value with a 404, and a second literal is how a client ends up asking a
 * question the surface does not answer.
 */
export const HR_LEAVE_LIMIT_RULE_SET_ID = 'hr.leave.limit';

// ---------------------------------------------------------------------------
// Simulation (§14) — response
// ---------------------------------------------------------------------------

/**
 * The engine's typed decision, as it arrives. `LIMIT_REFUSAL` is the one action this surface
 * produces (§16.7), and `NONE` is §13's literal for "no rule produced a decision".
 *
 * DECLARED AS A UNION RATHER THAN `unknown`, because the renderer must NAME the decision — a screen
 * that printed an unlabelled object would be showing raw engine output, which §27.3 forbids.
 */
export interface HrSimulatedLimitRefusalAction {
  type: 'LIMIT_REFUSAL';
  /** The stored limit's id — "which limit said no", resolvable to a row an operator can open. */
  limitRef: string;
  countingBasis: HrLeaveLimitCountingBasis;
  maximum: number;
  windowStart: string;
  windowEnd: string;
}

/** One limit's grounds as the HR side reports them — flat, typed, and already counted. */
export interface HrSimulatedLimitGrounds {
  limitRef: string;
  leaveTypeId: string;
  employmentType: string | null;
  countingBasis: string;
  maximum: number;
  windowStart: string;
  windowEnd: string;
  /** The observed cardinality of the projection the basis counts over (§16.3, §16.7). */
  observed: number;
  /** `observed > maximum` — the refusal condition itself, stated rather than re-derived. */
  exceeded: boolean;
}

/** One rule's presence in the explanation, already narrowed to the level the server chose. */
export interface HrSimulationExplanationMatch {
  ruleId: string | null;
  ruleName: string | null;
  matched: boolean;
  conditionOutcome: 'TRUE' | 'FALSE' | 'UNKNOWN';
  decision: string | null;
  grounds: string[];
  failedLeaves: string[];
  missingFields: string[];
  error: string | null;
}

/**
 * §13's explanation, ALREADY PROJECTED to this surface's evidence level.
 *
 * EVERY FIELD IS OPTIONAL OR NULLABLE BECAUSE THAT IS THE PROJECTION: §27.2 makes the server withhold
 * advanced detail rather than have a renderer hide it, so `orderingBasis: null` is the ABSENCE of
 * priority/specificity from the payload — not a value a screen should treat as "unknown". A renderer
 * therefore shows what is present and says "not available at this level" for what is not, and never
 * reconstructs the missing half.
 *
 * `detailLevel` is reported so a screen can STATE which projection it received (§32.6: an
 * explanation teaches the model); it is never a control.
 */
export interface HrSimulationExplanation {
  ruleSetId: string;
  ruleSetVersion: string;
  evaluationInstant: string;
  detailLevel: string;
  status: string;
  decisionType: string | null;
  decisionActions: unknown[];
  winningRuleId: string | null;
  winningRuleVersion: string | null;
  /** `null` at levels that may not see priority/specificity (§13.3). */
  orderingBasis: unknown | null;
  matchHistory: HrSimulationExplanationMatch[];
  grounds: string[];
  failedLeaves: string[];
  missingFields: string[];
  observedCounts: { over: string; count: number }[];
  /** The codes this level renders from (§13.4). */
  reasonCodes: string[];
  conflicts: unknown[];
  /** Codes, ids, numbers and dates — never prose, and never JSON (§13.4). */
  explanationText: string;
}

/**
 * §14's simulation answer.
 *
 * `mode` AND `banner` ARE READ FROM THE RESPONSE, NEVER RECONSTRUCTED. §14.5 makes the banner part of
 * the API *and* of the UI so that "a screenshot of a simulation must be impossible to mistake for a
 * real decision" — and a client that built the banner itself would be asserting a guarantee the
 * server had not made in that response.
 */
export interface HrLeavePolicySimulationResult {
  ruleSetId: string;
  policyId: string;
  policyVersionId: string;
  versionLabel: string;
  /** The STORED lifecycle state that was simulated — never inferred from the label. */
  status: HrLeavePolicyVersionStatus;
  /** `true` only for an ARCHIVED version, so a screen cannot present history as governance. */
  historical: boolean;
  evaluationInstant: string;
  simulation: {
    ruleSetId: string;
    ruleSetVersion: string;
    evaluationInstant: string;
    status: string;
    decision: HrSimulatedLimitRefusalAction | 'NONE' | string;
    winningRule: unknown | null;
    decisionActions: unknown[];
    matchHistory: HrSimulationExplanationMatch[];
    orderingBasis: unknown | null;
    observedCounts: { over: string; count: number }[];
    missingFields: string[];
    explanationText: string;
    conflicts: unknown[];
    validation: { valid: boolean; issues: unknown[]; conflicts: unknown[] };
    /** §14.5's frozen literals, taken from the response. */
    mode: string;
    banner: string;
    wouldApply: unknown[];
  };
  limits: HrSimulatedLimitGrounds[];
  explanation: HrSimulationExplanation;
}

// ---------------------------------------------------------------------------
// Requests (§12, §14) — the only calls this surface makes
// ---------------------------------------------------------------------------

/** `{ asOf: '…' }` → `?asOf=…`. Blanks are omitted, never sent empty. */
function query(
  entries: readonly (readonly [string, string | number | boolean | undefined])[]
): string {
  const search = new URLSearchParams();

  for (const [key, value] of entries) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }

  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * §12/§15.4: WHICH POLICY GOVERNS THIS LEAVE TYPE ON THIS DAY?
 *
 * THIS IS THE SURFACE'S ENTRY POINT, and it is the question the API itself designates as
 * authoritative — not a directory. There is deliberately no `GET /hr/leave-policies` to list
 * policies with: §12 makes selection a RESOLUTION rather than a lookup, so an operator reaches a
 * policy by asking what governs, and the answer carries the policy's own id.
 *
 * GATED ON `hr.leave.read` BY THE SERVER, the same read the register and the leave-type catalogue
 * already require. The response is NOT reshaped here: the caller receives the server's own answers —
 * a policy, a version, the applicable limits and the indecidable ones — and renders each as what it
 * is.
 */
export function fetchEffectiveLeavePolicy(
  input: HrEffectiveLeavePolicyQuery = {}
): Promise<HrEffectiveLeavePolicy> {
  return coreGet<HrEffectiveLeavePolicy>(
    `/hr/leave-policies/effective${query([
      ['asOf', input.asOf],
      ['leaveTypeId', input.leaveTypeId],
      ['employmentType', input.employmentType],
      ['includeArchived', input.includeArchived],
    ])}`
  );
}

/** One policy container, by id. `GET /hr/leave-policies/:policyId`, gated on `hr.leave.read`. */
export function fetchLeavePolicy(policyId: string): Promise<HrLeavePolicy> {
  return coreGet<HrLeavePolicy>(`/hr/leave-policies/${policyId}`);
}

/**
 * ONE VERSION WITH ITS LIMITS — the historical-resolution read (§10.5).
 *
 * GATED ON `hr.leave.read` AND DELIBERATELY NOT REFUSING AN ARCHIVED VERSION: §10.5's guarantee is
 * that a past evaluation can explain itself, so withholding an archived row here would be the
 * opposite of "still resolvable". This route answers "tell me about THIS version", never "which
 * version governs?".
 */
export function fetchLeavePolicyVersion(
  policyId: string,
  versionId: string
): Promise<{ version: HrLeavePolicyVersion; limits: HrLeaveLimit[] }> {
  return coreGet<{ version: HrLeavePolicyVersion; limits: HrLeaveLimit[] }>(
    `/hr/leave-policies/${policyId}/versions/${versionId}`
  );
}

/**
 * THE VERSION IN FORCE FOR THIS POLICY, or a 404 when none is (§10.3).
 *
 * SEPARATE FROM `fetchEffectiveLeavePolicy` ON PURPOSE, and the two answer different questions: this
 * one takes a `policyId` and asks "which version of IT is published?", while the effective resolver
 * takes a leave type and a day and asks "what governs this request?". A policy whose effective
 * window has ended is still the published version here — the register's question — which is why this
 * does not filter by day.
 */
export function fetchPublishedLeavePolicyVersion(policyId: string): Promise<HrLeavePolicyVersion> {
  return coreGet<HrLeavePolicyVersion>(`/hr/leave-policies/${policyId}/published`);
}

/**
 * §14: SIMULATE. The real engine, over a supplied context, applying nothing.
 *
 * THE BODY IS BUILT HERE AND NOWHERE ELSE, so the forbidden fields cannot be reintroduced by a call
 * site: this function takes the authorised members and constructs the payload itself. A caller cannot
 * pass a `level`, because there is no parameter for one — the guarantee is the SIGNATURE rather than
 * a review of every call site (§27.2, §33.8).
 *
 * `versionId` IS OMITTED RATHER THAN SENT AS `undefined` when the operator named no version, because
 * the server branches on the field's PRESENCE to distinguish "the effective published configuration"
 * from "this exact version" (§14, Choice 1B). An explicit `undefined` key would make the two
 * indistinguishable once serialised.
 *
 * THE RESPONSE IS RETURNED UNTOUCHED. No field is added, removed, renamed or recomputed: the
 * explanation is already projected to this surface's evidence level by the server, and the banner is
 * the server's own literal (§13.2, §14.5).
 */
export function simulateLeavePolicyVersion(
  policyId: string,
  request: HrLeavePolicySimulationRequest
): Promise<HrLeavePolicySimulationResult> {
  return corePost<HrLeavePolicySimulationResult>(`/hr/leave-policies/${policyId}/simulate`, {
    ruleSetId: request.ruleSetId,
    ...(request.versionId === undefined ? {} : { versionId: request.versionId }),
    ...(request.evaluationInstant === undefined
      ? {}
      : { evaluationInstant: request.evaluationInstant }),
    context: {
      leaveTypeId: request.context.leaveTypeId,
      ...(request.context.employmentType === undefined
        ? {}
        : { employmentType: request.context.employmentType }),
      ...(request.context.requestedFrom === undefined
        ? {}
        : { requestedFrom: request.context.requestedFrom }),
      ...(request.context.requestedTo === undefined
        ? {}
        : { requestedTo: request.context.requestedTo }),
    },
    ...(request.subject === undefined ? {} : { subject: request.subject }),
  });
}

// ---------------------------------------------------------------------------
// Labels (§27.7, §32) — centralized so no screen re-words a state
// ---------------------------------------------------------------------------

/**
 * §27.7: STATE LABELS LIVE WITH THE API CLIENT, not per screen.
 *
 * EACH LABEL IS THE STATE'S NAME, and its MEANING travels beside it (`…StatusMeaning`) because §30.4
 * requires the four states to be "visible states with their consequences stated": an operator
 * choosing a version to simulate is deciding which configuration answered, and "منتشرشده" alone does
 * not tell them whether it governs today.
 */
const VERSION_STATUS_LABELS: Record<HrLeavePolicyVersionStatus, string> = {
  DRAFT: 'پیش‌نویس',
  VALIDATED: 'اعتبارسنجی‌شده',
  PUBLISHED: 'منتشرشده',
  ARCHIVED: 'بایگانی‌شده',
};

export function hrLeavePolicyVersionStatusLabel(status: HrLeavePolicyVersionStatus): string {
  return VERSION_STATUS_LABELS[status] ?? status;
}

/**
 * What each state MEANS for the reader — the consequence sentence (§30.4).
 *
 * KEPT BESIDE THE LABEL so the two cannot drift, and worded from the frozen lifecycle rather than
 * invented: a DRAFT is configuration that is not in force, an ARCHIVED version is history that stays
 * readable, and only PUBLISHED governs new decisions (§10.3, §10.5).
 */
const VERSION_STATUS_MEANINGS: Record<HrLeavePolicyVersionStatus, string> = {
  DRAFT: 'در حال تنظیم است و هنوز بر تصمیم‌های جدید اعمال نمی‌شود.',
  VALIDATED: 'اعتبارسنجی شده است، اما تا انتشار بر تصمیم‌های جدید اعمال نمی‌شود.',
  PUBLISHED: 'نسخه‌ای است که تصمیم‌های جدید بر اساس آن گرفته می‌شود.',
  ARCHIVED:
    'نسخه تاریخی است؛ تصمیم‌های گذشته با آن توضیح داده می‌شوند، اما تصمیم جدیدی بر اساس آن گرفته نمی‌شود.',
};

export function hrLeavePolicyVersionStatusMeaning(status: HrLeavePolicyVersionStatus): string {
  return VERSION_STATUS_MEANINGS[status] ?? '';
}

/** Tone per state: only PUBLISHED is "ok" — a draft and an archive are both NOT in force (§10.3). */
export function hrLeavePolicyVersionStatusTone(status: HrLeavePolicyVersionStatus): HrTone {
  return status === 'PUBLISHED' ? 'ok' : 'muted';
}

/**
 * §16.1/§32.3: A COUNTING BASIS IS ALWAYS DISPLAYED WITH ITS MAXIMUM (D7).
 *
 * The two bases are different semantics, so the label states the UNIT — requests, or calendar days —
 * and never the enum name. §32.2 makes a term mean one thing across the UI, and §32.3 requires the
 * basis to accompany any maximum, which is why this is a helper rather than a string each screen
 * spells for itself.
 */
const COUNTING_BASIS_LABELS: Record<HrLeaveLimitCountingBasis, string> = {
  REQUEST_COUNT: 'تعداد درخواست',
  DAY_COUNT: 'تعداد روز تقویمی',
};

export function hrLeaveLimitCountingBasisLabel(basis: string): string {
  return COUNTING_BASIS_LABELS[basis as HrLeaveLimitCountingBasis] ?? basis;
}

/**
 * The decision as a WORD, and only `LIMIT_REFUSAL` is a decision this surface produces (§16.7).
 *
 * `NONE` RENDERS AS "no limit refuses this", NOT as "approved": §13 makes `NONE` the statement that no
 * rule produced a decision, and a simulation that permitted a case has NOT approved a request — no
 * request exists. Conflating the two is exactly the "simulation mistaken for a decision" failure
 * §14.5 exists to prevent.
 */
export function hrSimulationDecisionLabel(decision: unknown): string {
  if (decision === 'NONE') return 'هیچ محدودیتی این مورد را رد نمی‌کند.';

  if (typeof decision === 'object' && decision !== null && 'type' in decision) {
    if ((decision as { type: unknown }).type === 'LIMIT_REFUSAL') {
      return 'این مورد از سقف مجاز عبور می‌کند.';
    }
  }

  return 'نتیجه تصمیم در دسترس نیست.';
}

/**
 * §16.6: the employment scope as a WORD. `null` means the limit is UNSCOPED — an answer rather than a
 * missing value — so it is labelled rather than left blank.
 */
export function hrLimitEmploymentScopeLabel(employmentType: string | null): string {
  return employmentType === null ? 'همه انواع استخدام' : employmentType;
}

/**
 * `YYYY-MM-DD` as a displayable day.
 *
 * A THIN PASSTHROUGH, DELIBERATELY: the server emits a calendar day and the project's existing HR
 * screens already render days it receives, so this exists to give the value ONE home rather than to
 * format it. Parsing it into a `Date` and re-deriving anything would be the calendar arithmetic §16.2
 * keeps on the server.
 */
export function hrLeavePolicyDayLabel(day: string | null): string {
  return day === null ? '—' : day;
}
