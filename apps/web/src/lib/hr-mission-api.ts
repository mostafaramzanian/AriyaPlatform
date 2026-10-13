import { coreGet, corePatch, corePost } from './core-http';
import { HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE, type HrPage } from './hr-api';
import type { MissionRuleSetVersion } from './mission-rule-set-version';

/**
 * Phase 55: the WEB CLIENT for the Mission module — every route `MissionController` exposes, and
 * nothing else.
 *
 * WHY THIS IS ITS OWN FILE RATHER THAN MORE OF `hr-api.ts`
 * -------------------------------------------------------
 * `hr-api.ts` is the personnel REGISTER: employees, organization, positions, attendance and the
 * leave register. A Mission is a different object with a different lifecycle (DRAFT → SUBMITTED →
 * IN_APPROVAL → APPROVED / REJECTED / CORRECTION_REQUIRED / CANCELLED), its own configuration
 * surfaces and its own decision routes. Keeping it separate mirrors the server's own split — one
 * controller, one module directory — so this file reads as ONE contract.
 *
 * WHAT THIS CLIENT DELIBERATELY DOES NOT DO (§3, §5, §8)
 * -----------------------------------------------------
 * It COMPUTES NOTHING about authority or workflow. There is no approver resolution here, no
 * self-approval inference, no substitution lookup, no step-ordering or parallel-completion logic
 * and no re-derivation of any approval state. The server owns all of it: `GET :id/approval` returns
 * `instance.canDecide` plus a per-step `decidableByActor`, and the POST routes re-run the same
 * predicate before mutating. A client that "worked it out" would be a second authorization model
 * that can disagree with the one guarding the write.
 *
 * WHAT IT DELIBERATELY DOES NOT SEND (§2)
 * ---------------------------------------
 * No `tenantId`, no `actorId`, no `approverId`, no `projectId`. The actor is derived server-side by
 * `resolveHrActor` from the authenticated principal, and the API's global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so a request carrying one is REFUSED rather than silently scoped. There is
 * no code path in this file that can ask for another tenant's missions or name its own decider.
 *
 * THE CLASSIFICATION IS READ, NOT DERIVED. `durationMode`, `locationType` and `engagementType`
 * arrive on the response as the closed tokens the domain declares (`HOURLY`/`DAILY`,
 * `IN_CITY`/`OUT_OF_CITY`, `PROJECT`/`NON_PROJECT`). A saved request's classification is therefore
 * NEVER reconstructed from option-group codes on this side — the server already resolved it.
 *
 * `PROJECT` IS A CLASSIFICATION AND NOT A LINK (§7). This module has no project client, no project
 * type and no project field, because Phase 55 configures no project linkage: a `PROJECT` mission is
 * classified as project work and nothing more. Inventing a selector or an endpoint here would
 * advertise a capability the backend does not have.
 */

// ---------------------------------------------------------------------------
// Vocabulary — the CLOSED lists the domain declares
// ---------------------------------------------------------------------------

/**
 * Where a Mission request stands — seven members, mirroring `MissionRequestStatus`. There is
 * deliberately no `COMPLETED`: a mission ends at `APPROVED`, `REJECTED` or `CANCELLED`.
 */
export type HrMissionRequestStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_APPROVAL'
  | 'CORRECTION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

/** Whether the mission is measured in hours or in whole days — `MissionDurationMode`. */
export type HrMissionDurationMode = 'HOURLY' | 'DAILY';

/** Where the mission takes place — `MissionLocationType`. */
export type HrMissionLocationType = 'IN_CITY' | 'OUT_OF_CITY';

/**
 * Whether the mission is project or non-project work — `MissionEngagementType`.
 *
 * A two-word CLASSIFICATION, not a foreign key: nothing in Phase 55 links a mission to a project.
 */
export type HrMissionEngagementType = 'PROJECT' | 'NON_PROJECT';

/** The wire vocabulary, in schema order. */
export const HR_MISSION_REQUEST_STATUSES: readonly HrMissionRequestStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'IN_APPROVAL',
  'CORRECTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

/** A request's `revision` cursor: how many times it has been submitted, `null` before the first. */
export type HrMissionRoutingMode = 'SEQUENTIAL' | 'PARALLEL';

/** One live flow's status — the instance is either open or finished. */
export type HrMissionApprovalInstanceStatus = 'ACTIVE' | 'COMPLETED';

/** One step's status, mirroring the server's own vocabulary. */
export type HrMissionApprovalStepStatus =
  'PENDING' | 'ACTIVE' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'CANCELLED';

/** One recorded decision, or `null` while the step awaits one. */
export type HrMissionStepDecision = 'APPROVED' | 'REJECTED' | null;

/**
 * WHY a step's resolved approver is the person it is — `MissionApprovalResolutionReason`.
 *
 * `SUBSTITUTE` means a leave substitution covered the mission period, and `NO_RESOLUTION` means the
 * step named nobody — which the backend REFUSES to route through, so a live flow cannot carry it.
 */
export type HrMissionApprovalResolutionReason = 'PRIMARY' | 'SUBSTITUTE' | 'NO_RESOLUTION';

/** A policy version's own lifecycle — `MissionPolicyVersionStatus`. */
export type HrMissionPolicyVersionStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';

/**
 * What the CALLER may do to one policy version, as the SERVER computes it.
 *
 * Read as received and rendered as received. The three lifecycle routes each accept exactly one stored
 * state (`DRAFT`→validate, `VALIDATED`→publish, `PUBLISHED`→archive), and the server reports which one
 * applies; re-deriving that from `status` on this side would be a second transition matrix that can
 * disagree with the guards protecting the writes. The flags are mutually exclusive and each state
 * offers at most one action, INCLUDING `ARCHIVED`, which offers none.
 */
export interface HrMissionPolicyVersionActions {
  canValidate: boolean;
  canPublish: boolean;
  canArchive: boolean;
}

/** The catalogue's own status, matching every other HR configuration row. */
export type HrMissionDefinitionStatus = 'ACTIVE' | 'INACTIVE' | 'DRAFT';

export const HR_MISSION_DEFAULT_PAGE_SIZE = HR_DEFAULT_PAGE_SIZE;
export const HR_MISSION_MAX_PAGE_SIZE = HR_MAX_PAGE_SIZE;

/**
 * `HR_MAX_PAGE_SIZE` is reused rather than re-declared: it is the SAME ceiling the API enforces
 * through `HR_MAX_PAGE_SIZE` in `hr.constants.ts`, and a second constant would be a second number to
 * keep in step. The server clamps regardless, so this is a courtesy that keeps a request honest.
 */
export type HrMissionPage<T> = HrPage<T>;

// ---------------------------------------------------------------------------
// Responses — the shapes the serializers actually emit
// ---------------------------------------------------------------------------

/** The employee a request is FOR, projected to the two fields HR owns. */
export interface HrMissionEmployeeRef {
  id: string;
  employeeCode: string;
}

/**
 * One option selection: WHICH option of WHICH group the requester chose.
 *
 * The ids, not the codes: this is the shape `serializeRequest` emits (`selections`), and the
 * derived `durationMode`/`locationType`/`engagementType` above it are the server's own reading of
 * exactly these rows.
 */
export interface HrMissionOptionSelection {
  optionGroupId: string;
  missionOptionId: string;
}

/** The flow summary a request's DETAIL read carries — `approval`, or `null` if never routed. */
export interface HrMissionApprovalSummary {
  id: string;
  status: HrMissionApprovalInstanceStatus;
  routingMode: HrMissionRoutingMode;
}

/**
 * ONE Mission request, exactly as `MissionService.serializeRequest` emits it.
 *
 * EVERY FIELD IS DECLARED, including the nullable ones, because the nullability is a statement the
 * screen must render rather than paper over: `startTime`/`endTime` are `null` on a DAILY mission,
 * `description`/`destination` are optional at creation, and the two decision reasons are `null`
 * until a decision of that kind is recorded.
 *
 * `startDate`/`endDate` are CALENDAR DAYS (`YYYY-MM-DD`): the server serialises a `@db.Date` column
 * through its own day-key helper, so a reader in another timezone cannot be handed a different day.
 * `createdAt`/`updatedAt` are INSTANTS and keep their offset, for the same reason in reverse.
 */
export interface HrMissionRequest {
  id: string;
  status: HrMissionRequestStatus;
  /** The revision last SUBMITTED, or `null` while the request has never been sent. */
  submittedRevision: number | null;
  /** The requester, or `null` if the employee projection was not loaded. */
  employee: HrMissionEmployeeRef | null;
  durationMode: HrMissionDurationMode;
  locationType: HrMissionLocationType;
  engagementType: HrMissionEngagementType;
  /** `YYYY-MM-DD`, INCLUSIVE. Equal to `endDate` for a single-day (or any HOURLY) mission. */
  startDate: string;
  /** `YYYY-MM-DD`, INCLUSIVE. */
  endDate: string;
  /** `HH:mm` or `HH:mm:ss`, present only on an HOURLY mission. */
  startTime: string | null;
  /** `HH:mm` or `HH:mm:ss`, present only on an HOURLY mission. */
  endTime: string | null;
  destination: string | null;
  description: string | null;
  /**
   * WHY A MANAGER SENT THE REQUEST BACK — the column the correction flow writes, or `null`.
   *
   * The employee who must ACT on `CORRECTION_REQUIRED` reads the reason from HERE rather than from
   * the approval steps, which sit behind the `hr.mission.approve` grant they do not hold.
   */
  correctionReason: string | null;
  /** WHY A MANAGER REFUSED IT — the column the reject flow writes, or `null`. */
  rejectionReason: string | null;
  selections: HrMissionOptionSelection[];
  /** Present on the DETAIL read; `undefined` on the paged list, which omits the flow. */
  approval?: HrMissionApprovalSummary | null;
  createdAt: string;
  updatedAt: string;
}

/** One submitted mission report, as `MissionReport` is stored. */
export interface HrMissionReport {
  id: string;
  missionRequestId: string;
  employeeId: string;
  content: string;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Request bodies — the DTOs' own fields, and nothing else
// ---------------------------------------------------------------------------

/**
 * Body of `POST /hr/missions` — `CreateMissionRequestDto`.
 *
 * `employeeId` is the employee the mission is FOR, and it is REQUIRED because a manager may record
 * a mission on somebody's behalf. It is an HR employee id, never an identity override: the actor
 * who is writing is derived server-side and is not expressible here.
 *
 * `startTime`/`endTime` belong to an HOURLY mission; the server validates that relationship against
 * the selected options, so omitting them on a DAILY mission is correct rather than incomplete.
 * `selections` carries the configured choices — the server derives `durationMode`, `locationType`
 * and `engagementType` FROM them, which is why this body has no such fields.
 */
export interface CreateMissionRequestInput {
  employeeId: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, INCLUSIVE. */
  endDate: string;
  /** `HH:mm` or `HH:mm:ss`; omit for a DAILY mission. */
  startTime?: string;
  /** `HH:mm` or `HH:mm:ss`; omit for a DAILY mission. */
  endTime?: string;
  destination?: string;
  description?: string;
  selections: HrMissionOptionSelection[];
}

/** Body of `PATCH /hr/missions/:id` — every field optional, and absence means "leave it alone". */
export interface UpdateMissionRequestInput {
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  destination?: string;
  description?: string;
  selections?: HrMissionOptionSelection[];
}

/**
 * Body of `POST /hr/missions/:id/cancel` — `CancelMissionRequestDto`.
 *
 * The reason is REQUIRED and is audited rather than stored on the request: the row has no
 * cancellation column, and §49's trail is where an act's stated reason belongs.
 */
export interface CancelMissionRequestInput {
  reason: string;
}

/**
 * Body of `POST /hr/missions/:id/reports` — `CreateMissionReportDto`.
 *
 * The server accepts a report ONLY for an `APPROVED` mission, so this client does not attempt to
 * predict that; a refusal arrives as a `409` and propagates.
 */
export interface SubmitMissionReportInput {
  content: string;
}

/**
 * Body of `POST /hr/missions/:id/approve`.
 *
 * `reason` is OPTIONAL — an approval need not say why — and an omitted field must stay ABSENT
 * rather than be sent as `undefined`.
 */
export interface ApproveMissionInput {
  reason?: string;
}

/** Body of `POST /hr/missions/:id/reject`. A refusal STATES WHY, so this is required. */
export interface RejectMissionInput {
  reason: string;
}

/** Body of `POST /hr/missions/:id/correction`. Same requirement, and a SEPARATE act. */
export interface CorrectMissionInput {
  reason: string;
}

/** Body of `POST /hr/missions/option-groups`. */
export interface CreateMissionOptionGroupInput {
  code: string;
  label: string;
  required?: boolean;
  sortOrder?: number;
}

/** Body of `PATCH /hr/missions/option-groups/:groupId`. `code` is deliberately absent. */
export interface UpdateMissionOptionGroupInput {
  label?: string;
  required?: boolean;
  sortOrder?: number;
  active?: boolean;
}

/** Body of `POST /hr/missions/option-groups/:groupId/options`. */
export interface CreateMissionOptionInput {
  code: string;
  label: string;
  active?: boolean;
  sortOrder?: number;
}

/** Body of `PATCH .../options/:optionId`. `code` is not editable, so it is not offered. */
export interface UpdateMissionOptionInput {
  label?: string;
  active?: boolean;
  sortOrder?: number;
}

/**
 * One step as the definition DTO accepts it.
 *
 * `approverEmployeeId` is the EXECUTABLE reference. `approverRole` is accepted by the DTO but the
 * server REFUSES a step that carries only a role when a flow is opened, so a caller setting it
 * without an employee id is configuring something that cannot run.
 */
export interface MissionApprovalStepDefinitionInput {
  order: number;
  name: string;
  approverEmployeeId?: string;
  approverRole?: string;
  required?: boolean;
}

/** Body of `POST /hr/missions/approval-definitions`. */
export interface CreateMissionApprovalDefinitionInput {
  name: string;
  routingMode: HrMissionRoutingMode;
  selfApprovalMode: 'NOT_ALLOWED' | 'ALLOWED';
  steps: MissionApprovalStepDefinitionInput[];
}

/**
 * Body of `PATCH /hr/missions/approval-definitions/:definitionId`.
 *
 * The STEPS are not here: they move through their own route, because replacing a definition's
 * ordered steps is a different act from renaming it.
 */
export interface UpdateMissionApprovalDefinitionInput {
  name?: string;
  routingMode?: HrMissionRoutingMode;
  selfApprovalMode?: 'NOT_ALLOWED' | 'ALLOWED';
  status?: HrMissionDefinitionStatus;
}

/**
 * Body of `POST /hr/missions/policy-versions`.
 *
 * `configuration` is the Rule Engine document — now TYPED as `MissionRuleSetVersion`, because the
 * server's shape is NOT undocumented: the engine declares it, the validator enforces it and the column
 * stores it verbatim. The server still stores it unchecked and judges it at `validate`, so a document
 * that fails validation comes back as a `400` naming the failing path; typing it here does not move
 * that authority.
 */
export interface CreateMissionPolicyVersionInput {
  version: number;
  label: string;
  ruleSetId?: string;
  configuration: MissionRuleSetVersion;
}

// ---------------------------------------------------------------------------
// Query inputs
// ---------------------------------------------------------------------------

/**
 * The request-register filter — exactly the five the API declares, and no search term.
 *
 * `from`/`to` are GREGORIAN days and mean INTERSECTION with a request's own range, so a mission
 * that starts before the window and runs through it IS returned.
 */
export interface HrMissionRequestQuery {
  employeeId?: string;
  status?: HrMissionRequestStatus;
  durationMode?: HrMissionDurationMode;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** The option-catalogue filter: by activation, plus paging. */
export interface HrMissionOptionGroupQuery {
  active?: boolean;
  page?: number;
  pageSize?: number;
}

/** The approval-definition filter: by status, plus paging. */
export interface HrMissionApprovalDefinitionQuery {
  status?: HrMissionDefinitionStatus;
  page?: number;
  pageSize?: number;
}

/** The policy-version filter: by lifecycle status, plus paging. */
export interface HrMissionPolicyVersionQuery {
  status?: HrMissionPolicyVersionStatus;
  page?: number;
  pageSize?: number;
}

function cappedPageSize(pageSize: number | undefined): number | undefined {
  return pageSize === undefined ? undefined : Math.min(pageSize, HR_MAX_PAGE_SIZE);
}

function query(pairs: Array<[string, string | number | boolean | undefined | null]>): string {
  const params: string[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    params.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return params.length > 0 ? `?${params.join('&')}` : '';
}

/**
 * `{ status: 'DRAFT' }` → `?status=DRAFT`. Paging appears only when the caller asked for it, so an
 * unpaged request stays unpaged and the server's own default applies rather than this client
 * inventing one.
 */
export function buildMissionRequestQuery(input: HrMissionRequestQuery = {}): string {
  return query([
    ['employeeId', input.employeeId],
    ['status', input.status],
    ['durationMode', input.durationMode],
    ['from', input.from],
    ['to', input.to],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

export function buildMissionOptionGroupQuery(input: HrMissionOptionGroupQuery = {}): string {
  return query([
    ['active', input.active],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

export function buildMissionApprovalDefinitionQuery(
  input: HrMissionApprovalDefinitionQuery = {}
): string {
  return query([
    ['status', input.status],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

export function buildMissionPolicyVersionQuery(input: HrMissionPolicyVersionQuery = {}): string {
  return query([
    ['status', input.status],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

/** IDs are ENCODED, never spliced raw — an id is data, and a path is a structure. */
const pathId = (value: string) => encodeURIComponent(value);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** One page of the mission register — `GET /hr/missions`. Gated on `hr.mission.read`. */
export function fetchMissions(
  input: HrMissionRequestQuery = {}
): Promise<HrMissionPage<HrMissionRequest>> {
  return coreGet<HrMissionPage<HrMissionRequest>>(`/hr/missions${buildMissionRequestQuery(input)}`);
}

/**
 * One request — `GET /hr/missions/:id`.
 *
 * Its `approval` field is the flow SUMMARY; the detailed flow is the separate approval read below,
 * which is gated on a different grant.
 */
export function fetchMission(id: string): Promise<HrMissionRequest> {
  return coreGet<HrMissionRequest>(`/hr/missions/${pathId(id)}`);
}

/**
 * Records a request — `POST /hr/missions`. The created row is a `DRAFT`.
 *
 * The body carries NO status: the initial state is a domain constant on the server, so the only
 * request this function can produce is a draft one.
 */
export function createMission(input: CreateMissionRequestInput): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>('/hr/missions', input);
}

/** Restates a draft or correction-required request — `PATCH /hr/missions/:id`. */
export function updateMission(
  id: string,
  input: UpdateMissionRequestInput
): Promise<HrMissionRequest> {
  return corePatch<HrMissionRequest>(`/hr/missions/${pathId(id)}`, input);
}

/**
 * Submits a request — `POST /hr/missions/:id/submit`. NO BODY.
 *
 * There is nothing for the caller to name: which request is the path, WHO is submitting is the
 * authenticated actor, and what happens next (auto-approval or routing) is the policy's decision,
 * returned as the request's new state. An empty body is the honest shape of that.
 */
export function submitMission(id: string): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>(`/hr/missions/${pathId(id)}/submit`);
}

/**
 * Resubmits a corrected request — `POST /hr/missions/:id/resubmit`.
 *
 * The body is the SAME shape as an update: a resubmission is the corrected content plus the act of
 * sending it, in one call, so the server can supersede the old flow in the same transaction.
 */
export function resubmitMission(
  id: string,
  input: UpdateMissionRequestInput
): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>(`/hr/missions/${pathId(id)}/resubmit`, input);
}

/** Withdraws a request — `POST /hr/missions/:id/cancel`. The reason is audited, not stored. */
export function cancelMission(
  id: string,
  input: CancelMissionRequestInput
): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>(`/hr/missions/${pathId(id)}/cancel`, input);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Files the mission report — `POST /hr/missions/:id/reports`.
 *
 * The server accepts this ONLY for an `APPROVED` mission and answers `409` otherwise; this client
 * does not pre-empt that, because the request's own status is the server's to state.
 */
export function submitMissionReport(
  id: string,
  input: SubmitMissionReportInput
): Promise<HrMissionReport> {
  return corePost<HrMissionReport>(`/hr/missions/${pathId(id)}/reports`, input);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * The steps waiting on the CALLING actor — `GET /hr/missions/approvals/pending`.
 *
 * No query and no parameter: the queue is resolved from the authenticated actor server-side, which
 * is what makes it a queue rather than a search. Gated on `hr.mission.approve`.
 */
export function fetchPendingMissionApprovals(): Promise<HrMissionRequest[]> {
  return coreGet<HrMissionRequest[]>('/hr/missions/approvals/pending');
}

/**
 * The request and its live flow — `GET /hr/missions/:id/approval`.
 *
 * The returned `instance` carries `canDecide` and a per-step `decidableByActor`, both computed by
 * the server. Render them as received: there is deliberately no helper here that recomputes them,
 * because a second answer is a second authority (§8).
 */
export function fetchMissionApproval(id: string): Promise<HrMissionApprovalDetail> {
  return coreGet<HrMissionApprovalDetail>(`/hr/missions/${pathId(id)}/approval`);
}

/** Approves the caller's step — `POST :id/approve`. The reason is OPTIONAL and stays absent. */
export function approveMission(
  id: string,
  input: ApproveMissionInput = {}
): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>(`/hr/missions/${pathId(id)}/approve`, input);
}

/** Refuses the request — `POST :id/reject`. A rejection STATES WHY, so the reason is required. */
export function rejectMission(id: string, input: RejectMissionInput): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>(`/hr/missions/${pathId(id)}/reject`, input);
}

/**
 * Sends the request back for correction — `POST :id/correction`.
 *
 * A SEPARATE route from rejection, and a separate reason: "fix this" and "no" are different
 * outcomes, and merging them would leave the employee unable to tell which one they received.
 */
export function correctMission(id: string, input: CorrectMissionInput): Promise<HrMissionRequest> {
  return corePost<HrMissionRequest>(`/hr/missions/${pathId(id)}/correction`, input);
}

// ---------------------------------------------------------------------------
// Option catalogue — the tenant's OWN choices, gated on `hr.mission.policy`
// ---------------------------------------------------------------------------

/**
 * One page of the option catalogue — `GET /hr/missions/option-groups`.
 *
 * Each row carries its `options` in their own order, so a form can render a whole group from this
 * one read instead of a request per group.
 */
export function fetchMissionOptionGroups(
  input: HrMissionOptionGroupQuery = {}
): Promise<HrMissionPage<HrMissionOptionGroup>> {
  return coreGet<HrMissionPage<HrMissionOptionGroup>>(
    `/hr/missions/option-groups${buildMissionOptionGroupQuery(input)}`
  );
}

/** Adds a group to the catalogue — `POST /hr/missions/option-groups`. */
export function createMissionOptionGroup(
  input: CreateMissionOptionGroupInput
): Promise<HrMissionOptionGroup> {
  return corePost<HrMissionOptionGroup>('/hr/missions/option-groups', input);
}

/**
 * Renames, reorders, re-requires or (de)activates a group — `PATCH .../option-groups/:groupId`.
 *
 * `code` is NOT settable: it is the stable machine key the classification is derived from, so
 * renaming it would silently reclassify every existing request recorded against it.
 */
export function updateMissionOptionGroup(
  groupId: string,
  input: UpdateMissionOptionGroupInput
): Promise<HrMissionOptionGroup> {
  return corePatch<HrMissionOptionGroup>(`/hr/missions/option-groups/${pathId(groupId)}`, input);
}

/** Adds a selectable option to a group — `POST .../option-groups/:groupId/options`. */
export function createMissionOption(
  groupId: string,
  input: CreateMissionOptionInput
): Promise<HrMissionOption> {
  return corePost<HrMissionOption>(`/hr/missions/option-groups/${pathId(groupId)}/options`, input);
}

/**
 * Renames, reorders or (de)activates one option — `PATCH .../options/:optionId`.
 *
 * Both ids are in the PATH, and neither is repeated in the body: the group scopes the row and the
 * option identifies it, so a body field carrying either would be a second, weaker statement of the
 * same address.
 */
export function updateMissionOption(
  groupId: string,
  optionId: string,
  input: UpdateMissionOptionInput
): Promise<HrMissionOption> {
  return corePatch<HrMissionOption>(
    `/hr/missions/option-groups/${pathId(groupId)}/options/${pathId(optionId)}`,
    input
  );
}

// ---------------------------------------------------------------------------
// Approval definitions
// ---------------------------------------------------------------------------

/** One page of flow configurations — `GET /hr/missions/approval-definitions`, with ordered steps. */
export function fetchMissionApprovalDefinitions(
  input: HrMissionApprovalDefinitionQuery = {}
): Promise<HrMissionPage<HrMissionApprovalDefinition>> {
  return coreGet<HrMissionPage<HrMissionApprovalDefinition>>(
    `/hr/missions/approval-definitions${buildMissionApprovalDefinitionQuery(input)}`
  );
}

/** Creates a flow — `POST /hr/missions/approval-definitions`, steps included. */
export function createMissionApprovalDefinition(
  input: CreateMissionApprovalDefinitionInput
): Promise<HrMissionApprovalDefinition> {
  return corePost<HrMissionApprovalDefinition>('/hr/missions/approval-definitions', input);
}

/** Renames, re-modes or (de)activates a flow — `PATCH .../approval-definitions/:definitionId`. */
export function updateMissionApprovalDefinition(
  definitionId: string,
  input: UpdateMissionApprovalDefinitionInput
): Promise<HrMissionApprovalDefinition> {
  return corePatch<HrMissionApprovalDefinition>(
    `/hr/missions/approval-definitions/${pathId(definitionId)}`,
    input
  );
}

/**
 * REPLACES a flow's ordered steps — `POST .../approval-definitions/:definitionId/steps`.
 *
 * The route takes the same DTO the create does and reads only its `steps`, so each element must be
 * the whole step it should BE rather than a change to apply: this is a replacement, and a step
 * omitted from the array is a step removed. Taking the create DTO is what states that at the call
 * site; the server ignores the definition-level fields here.
 */
export function replaceMissionApprovalDefinitionSteps(
  definitionId: string,
  input: CreateMissionApprovalDefinitionInput
): Promise<HrMissionApprovalDefinition> {
  return corePost<HrMissionApprovalDefinition>(
    `/hr/missions/approval-definitions/${pathId(definitionId)}/steps`,
    input
  );
}

// ---------------------------------------------------------------------------
// Policy versions — the Mission rule set's own lifecycle
// ---------------------------------------------------------------------------

/** One page of rule-set versions — `GET /hr/missions/policy-versions`, newest first. */
export function fetchMissionPolicyVersions(
  input: HrMissionPolicyVersionQuery = {}
): Promise<HrMissionPage<HrMissionPolicyVersion>> {
  return coreGet<HrMissionPage<HrMissionPolicyVersion>>(
    `/hr/missions/policy-versions${buildMissionPolicyVersionQuery(input)}`
  );
}

/** Authors a DRAFT version — `POST /hr/missions/policy-versions`. */
export function createMissionPolicyVersion(
  input: CreateMissionPolicyVersionInput
): Promise<HrMissionPolicyVersion> {
  return corePost<HrMissionPolicyVersion>('/hr/missions/policy-versions', input);
}

/**
 * Validates a DRAFT — `POST .../policy-versions/:versionId/validate`.
 *
 * NO BODY, and no rule set or version number: the path names the version and the server decides
 * what "valid" means against the published rule-set document. A client that sent its own idea of
 * validity would be grading its own homework.
 */
export function validateMissionPolicyVersion(versionId: string): Promise<HrMissionPolicyVersion> {
  return corePost<HrMissionPolicyVersion>(
    `/hr/missions/policy-versions/${pathId(versionId)}/validate`
  );
}

/** Publishes a VALIDATED version — `POST .../policy-versions/:versionId/publish`. No body. */
export function publishMissionPolicyVersion(versionId: string): Promise<HrMissionPolicyVersion> {
  return corePost<HrMissionPolicyVersion>(
    `/hr/missions/policy-versions/${pathId(versionId)}/publish`
  );
}

/** Archives a version — `POST .../policy-versions/:versionId/archive`. No body. */
export function archiveMissionPolicyVersion(versionId: string): Promise<HrMissionPolicyVersion> {
  return corePost<HrMissionPolicyVersion>(
    `/hr/missions/policy-versions/${pathId(versionId)}/archive`
  );
}

/** One approval step, as `getApprovalDetail` projects it. */
export interface HrMissionApprovalStep {
  order: number;
  status: HrMissionApprovalStepStatus;
  decision: HrMissionStepDecision;
  /** The decider's own note, or `null` — never the request's `description`. */
  decisionReason: string | null;
  /** WHO decided, by employee id, or `null` while undecided. */
  decidedByEmployeeId: string | null;
  /** WHO was resolved to decide, or `null` when the step named nobody. */
  resolvedApproverEmployeeId: string | null;
  resolutionReason: HrMissionApprovalResolutionReason;
  /**
   * The SERVER's answer to "may the CALLING actor decide this step?", computed from the same
   * predicate the write path re-runs. Rendered as received — never recomputed here.
   */
  decidableByActor: boolean;
}

/** The live flow of a request — `instance`, or `null` when nothing is being routed. */
export interface HrMissionApprovalInstance {
  id: string;
  status: HrMissionApprovalInstanceStatus;
  routingMode: HrMissionRoutingMode;
  sequenceNumber: number;
  submissionRevision: number | null;
  /** The actor-level answer: may this caller decide ANY currently active step? */
  canDecide: boolean;
  steps: HrMissionApprovalStep[];
}

/**
 * The approval DETAIL read: the request and its flow together.
 *
 * `instance: null` is a MEANINGFUL state — the server says so when no live flow exists — and not a
 * missing field. The screen states "nothing is being routed" rather than showing an empty table.
 */
export interface HrMissionApprovalDetail {
  request: HrMissionRequest;
  instance: HrMissionApprovalInstance | null;
}

/** One selectable option inside a group. */
export interface HrMissionOption {
  id: string;
  optionGroupId: string;
  code: string;
  label: string;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One option GROUP — the tenant's own catalogue of choices for one question.
 *
 * `required: true` means the form must collect exactly one option from this group before it can
 * submit; the server validates the same rule, so this flag drives the UI and never replaces it.
 */
export interface HrMissionOptionGroup {
  id: string;
  code: string;
  label: string;
  required: boolean;
  active: boolean;
  sortOrder: number;
  /** Present on the paginated read, which `include`s the options in their own order. */
  options?: HrMissionOption[];
  createdAt: string;
  updatedAt: string;
}

/** One step of an approval definition. */
export interface HrMissionApprovalStepDefinition {
  id: string;
  approvalDefinitionId: string;
  order: number;
  name: string;
  /**
   * THE ONLY EXECUTABLE APPROVER REFERENCE. The backend resolves a concrete employee id; a step
   * that names only a role is REFUSED when a flow is opened, so a UI must not present a role as
   * though it would work.
   */
  approverEmployeeId: string | null;
  /** Mirrored from the leave configuration and deliberately NOT resolvable for Mission. */
  approverRole: string | null;
  required: boolean;
}

/** One approval flow configuration. */
export interface HrMissionApprovalDefinition {
  id: string;
  name: string;
  status: HrMissionDefinitionStatus;
  routingMode: HrMissionRoutingMode;
  /** Frozen semantics: the only completion mode the backend honours. */
  parallelCompletionMode: 'ALL_REQUIRED';
  selfApprovalMode: 'NOT_ALLOWED' | 'ALLOWED';
  steps: HrMissionApprovalStepDefinition[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One Mission rule-set version.
 *
 * `configuration` IS TYPED — see `mission-rule-set-version.ts` for why that is a transcription of the
 * server's own `RuleSetVersion` rather than a guess, and for the one thing this type deliberately does
 * NOT do (validate; the server's engine owns that).
 *
 * `actions` is the SERVER's lifecycle answer and is never computed here. The three transitions each
 * accept exactly one stored state, and that matrix lives in one place on the server
 * (`mission-policy-version.projection.ts`) so this client cannot disagree with the guards that
 * actually protect the writes.
 */
export interface HrMissionPolicyVersion {
  id: string;
  version: number;
  status: HrMissionPolicyVersionStatus;
  ruleSetId: string;
  configuration: MissionRuleSetVersion;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  actions: HrMissionPolicyVersionActions;
}
