import type { HrTone } from './hr-api';
import type {
  HrMissionApprovalInstanceStatus,
  HrMissionApprovalResolutionReason,
  HrMissionApprovalStepStatus,
  HrMissionDefinitionStatus,
  HrMissionDurationMode,
  HrMissionEngagementType,
  HrMissionLocationType,
  HrMissionPolicyVersionStatus,
  HrMissionRequestStatus,
  HrMissionRoutingMode,
} from './hr-mission-api';

/**
 * Phase 55 Step 8B: the PERSIAN VOCABULARY and badge tones for the Mission employee surface.
 *
 * WHY THIS IS A SEPARATE FILE FROM `hr-mission-api.ts`
 * ---------------------------------------------------
 * `hr-mission-api.ts` is the WIRE CONTRACT: routes, bodies and the shapes the server serialises.
 * Presentation — which Persian word names a status, which tone a badge takes — is a different
 * concern with a different reader, and the same split `hr-leave-approval-api.ts` kept when it put
 * its labels beside its routes but in their own section. Keeping them here means the client can be
 * imported by a test that cares only about URLs without dragging label tables in, and it gives the
 * vocabulary ONE home so a screen cannot invent a second word for the same state.
 *
 * EVERY MAP IS A TOTAL `Record<Union, string>`, NOT A LOOKUP WITH A FALLBACK. A missing member is a
 * compile error rather than a raw English token leaking onto a Persian screen — which is the failure
 * an index signature would have permitted silently.
 *
 * THE THREE `COMPLETED` WORDS IN THIS FILE ARE THE FLOW'S, NOT THE REQUEST'S
 * -------------------------------------------------------------------------
 * `HrMissionApprovalInstanceStatus` is the vocabulary of an approval FLOW, and a flow that has
 * finished is legitimately `'COMPLETED'` — the word is the domain's, one of the two members that
 * union declares. `HrMissionRequestStatus` is a different vocabulary: the seven the domain declares,
 * where a mission ends at `APPROVED`, `REJECTED` or `CANCELLED`. Nothing here — no request label, no
 * request tone, no filter — invents a completion state FOR A REQUEST, and the two vocabularies are
 * kept visibly separate below so the distinction cannot be blurred by a later edit.
 *
 * The distinction is load-bearing, not cosmetic: a flow that ended is not a request that succeeded.
 * A `CANCELLED` request can leave a `COMPLETED` flow behind it, and its own badge must still read
 * «لغوشده».
 */

const REQUEST_STATUS_LABELS: Record<HrMissionRequestStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارسال‌شده',
  IN_APPROVAL: 'در گردش تأیید',
  CORRECTION_REQUIRED: 'نیازمند اصلاح',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
};

/** The status in Persian. Total over the seven members — a new one must be named here. */
export function missionRequestStatusLabel(status: HrMissionRequestStatus): string {
  return REQUEST_STATUS_LABELS[status];
}

/**
 * The badge tone for a status.
 *
 * `CORRECTION_REQUIRED` is `danger` rather than `muted`: it is the one state that asks the EMPLOYEE
 * to act, and a returned request that looked inactive would be the most expensive misreading on this
 * screen. `APPROVED` is `ok`; the two ends of a refusal and a withdrawal are `danger`/`muted`.
 */
export function missionRequestStatusTone(status: HrMissionRequestStatus): HrTone {
  if (status === 'APPROVED') return 'ok';
  if (status === 'REJECTED' || status === 'CORRECTION_REQUIRED') return 'danger';
  return 'muted';
}

const DURATION_LABELS: Record<HrMissionDurationMode, string> = {
  HOURLY: 'ساعتی',
  DAILY: 'روزانه',
};

const LOCATION_LABELS: Record<HrMissionLocationType, string> = {
  IN_CITY: 'داخل شهر',
  OUT_OF_CITY: 'خارج شهر',
};

const ENGAGEMENT_LABELS: Record<HrMissionEngagementType, string> = {
  PROJECT: 'پروژه‌ای',
  NON_PROJECT: 'غیرپروژه‌ای',
};

export function missionDurationLabel(mode: HrMissionDurationMode): string {
  return DURATION_LABELS[mode];
}

export function missionLocationLabel(location: HrMissionLocationType): string {
  return LOCATION_LABELS[location];
}

/**
 * The engagement classification in Persian.
 *
 * THIS IS A LABEL AND NOT A LINK. «پروژه‌ای» classifies the work; Phase 55 configures no project
 * linkage, so this word must never be dressed up as a selectable project or as a reference to one.
 */
export function missionEngagementLabel(engagement: HrMissionEngagementType): string {
  return ENGAGEMENT_LABELS[engagement];
}

/** `YYYY-MM-DD` as the reader's OWN calendar, or the stored day when it cannot be read. */
export function missionDayLabel(day: string): string {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return day;

  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'UTC' }).format(parsed);
}

/**
 * The stored days, printed VERBATIM beside the Persian rendering.
 *
 * The same discipline `HrLeaveView`'s day cell states: a reader must be able to see what was
 * recorded rather than trust a conversion, and the range is INCLUSIVE so a single-day mission
 * legitimately repeats its day.
 */
export function missionRangeLabel(startDate: string, endDate: string): string {
  return `${startDate} – ${endDate}`;
}

/** The hours of an HOURLY mission, or `null` on a DAILY one that has none to show. */
export function missionTimeRangeLabel(
  startTime: string | null,
  endTime: string | null
): string | null {
  if (!startTime || !endTime) return null;
  return `${startTime} – ${endTime}`;
}

// ---------------------------------------------------------------------------
// Step 8C — the APPROVAL flow vocabulary
// ---------------------------------------------------------------------------

/**
 * PHASE 55 STEP 8C: the words for the ROUTING and DECISION states.
 *
 * WHY THE APPROVAL VOCABULARY LIVES BESIDE THE REQUEST'S
 * -----------------------------------------------------
 * These are two different sentences about the same mission. The block above says where the REQUEST
 * stands («در گردش تأیید»); the block below says where its FLOW stands («در جریان»), which step is
 * being asked («در نوبت تصمیم») and why the approver is who they are («جانشین اصلی»). Merging them
 * would give one word two meanings — an `ACTIVE` step is not an `IN_APPROVAL` request — and the
 * decider's screen would inherit a vocabulary that answers a question it is not asking.
 *
 * EVERY MAP IS A TOTAL `Record<Union, string>`, NOT A LOOKUP WITH A FALLBACK. A missing member is a
 * compile error rather than a raw English token leaking onto a Persian screen.
 */

const APPROVAL_INSTANCE_STATUS_LABELS: Record<HrMissionApprovalInstanceStatus, string> = {
  ACTIVE: 'در جریان',
  COMPLETED: 'پایان‌یافته',
};

const APPROVAL_STEP_STATUS_LABELS: Record<HrMissionApprovalStepStatus, string> = {
  PENDING: 'در انتظار',
  ACTIVE: 'در نوبت تصمیم',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  SKIPPED: 'عبورکرده',
  CANCELLED: 'لغوشده',
};

const APPROVAL_RESOLUTION_REASON_LABELS: Record<HrMissionApprovalResolutionReason, string> = {
  PRIMARY: 'جانشین اصلی',
  SUBSTITUTE: 'جانشین موقت',
  NO_RESOLUTION: 'بدون جانشین',
};

const ROUTING_MODE_LABELS: Record<HrMissionRoutingMode, string> = {
  SEQUENTIAL: 'ترتیبی',
  PARALLEL: 'موازی',
};

/** The Persian label for a flow's own status. States the FLOW's position, not the request's. */
export function missionApprovalInstanceStatusLabel(
  status: HrMissionApprovalInstanceStatus
): string {
  return APPROVAL_INSTANCE_STATUS_LABELS[status];
}

/** The Persian label for a step's status — six members, no fallback branch. */
export function missionApprovalStepStatusLabel(status: HrMissionApprovalStepStatus): string {
  return APPROVAL_STEP_STATUS_LABELS[status];
}

/**
 * The Persian phrase naming WHY a step's approver is who they are.
 *
 * `NO_RESOLUTION` says «بدون جانشین» rather than inventing a person: the backend REFUSES to open a
 * flow through such a step, so seeing this word means the resolved id is absent — and the screen
 * must say so rather than render an empty cell that reads as a missing relation.
 */
export function missionApprovalResolutionReasonLabel(
  reason: HrMissionApprovalResolutionReason
): string {
  return APPROVAL_RESOLUTION_REASON_LABELS[reason];
}

/**
 * How the flow asks its steps — sequentially or all at once.
 *
 * It is RENDERED rather than inferred: which step is «در نوبت تصمیم» depends on this mode, so the
 * decider is told the mode instead of the screen guessing a route from step ordering.
 */
export function missionRoutingModeLabel(mode: HrMissionRoutingMode): string {
  return ROUTING_MODE_LABELS[mode];
}

/**
 * Tone for a flow status: a decision still to be made is the loud one, and a finished flow is muted.
 *
 * The same choice `leaveApprovalInstanceStatusTone` makes, and deliberately so: two approval screens
 * on one product should not disagree about which of these two states deserves attention.
 */
export function missionApprovalInstanceStatusTone(status: HrMissionApprovalInstanceStatus): HrTone {
  return status === 'ACTIVE' ? 'ok' : 'muted';
}

/**
 * Tone for a step status, chosen for the DECISION each row records: approved is green, rejected and
 * cancelled are red, and the three states that record no decision are muted — nothing has happened
 * yet, so nothing should shout.
 *
 * `SKIPPED` is muted rather than red: a skipped step was not refused, and colouring it like a
 * rejection would put a decision in a row that holds none.
 */
export function missionApprovalStepStatusTone(status: HrMissionApprovalStepStatus): HrTone {
  switch (status) {
    case 'APPROVED':
      return 'ok';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    case 'PENDING':
    case 'ACTIVE':
    case 'SKIPPED':
      return 'muted';
  }
}

// ---------------------------------------------------------------------------
// Step 8D — the ADMIN CONFIGURATION vocabulary
// ---------------------------------------------------------------------------

/**
 * PHASE 55 STEP 8D: the words an ADMINISTRATOR needs, which no other block provides.
 *
 * WHY THIS BLOCK IS SMALL AND WHY THAT IS THE POINT
 * ------------------------------------------------
 * The catalogue, the flow configuration and the rule-set version are the three things a
 * `hr.mission.policy` holder edits. Almost everything a screen shows about them already has a word
 * above: `SEQUENTIAL`/`PARALLEL` is `missionRoutingModeLabel`, and an option's own label is DATA the
 * tenant wrote — never translated here.
 *
 * THREE WORDS GENUINELY DID NOT EXIST YET, and inventing them inside a component would have given
 * one of them two meanings on two screens:
 *
 *   * `missionCatalogueActiveLabel` — the catalogue's own boolean. It is NOT a
 *     `HrMissionDefinitionStatus`: a group is `active` or not, while a flow carries a three-valued
 *     `status`. Mapping one onto the other would let a screen claim a group is «پیش‌نویس».
 *   * `missionDefinitionStatusLabel` — the flow's three-valued status, kept SEPARATE from the
 *     version's four-valued one below, because «بایگانی‌شده» is not a state a flow can be in and
 *     «غیرفعال» is not a state a version can be in. One shared map would have to be partial, and a
 *     partial map is how a raw English token leaks onto a Persian screen.
 *   * `missionPolicyVersionStatusLabel`/`…Meaning` — the version's own four, whose meanings are the
 *     lifecycle consequences an operator chooses between when they press publish.
 *
 * THE VERSION LABEL DELIBERATELY REUSES THE LEAVE-LIFECYCLE WORDING: both are the same four §10.3
 * states of the same Rule Engine, and two admin screens in one product disagreeing about what
 * «منتشرشده» is called would be a vocabulary split with no defensible reason. The sentences are
 * restated rather than imported because `hr-leave-policy-api` is the LEAVE domain's client, and a
 * Mission screen importing it would couple two domains through a label table.
 */

/**
 * A catalogue row's own `active` flag.
 *
 * `active: false` is a real, non-destructive state: the row stays in the catalogue and in every
 * request already recorded against it, it simply stops being OFFERED. That is why the wording is
 * «غیرفعال» and not anything resembling deletion — no route in this contract deletes a group or an
 * option, and a screen must never imply one exists.
 */
export function missionCatalogueActiveLabel(active: boolean): string {
  return active ? 'فعال' : 'غیرفعال';
}

/** Tone for the catalogue flag: an inactive row is muted, never red — it is not an error. */
export function missionCatalogueActiveTone(active: boolean): HrTone {
  return active ? 'ok' : 'muted';
}

const DEFINITION_STATUS_LABELS: Record<HrMissionDefinitionStatus, string> = {
  ACTIVE: 'فعال',
  INACTIVE: 'غیرفعال',
  DRAFT: 'پیش‌نویس',
};

/**
 * The Persian label for a FLOW configuration's status — three members, total, no fallback.
 *
 * `ACTIVE` here means the flow is in service, which is a different claim from a version being
 * `PUBLISHED`: a definition is selected by the rule set, not published by an operator.
 */
export function missionDefinitionStatusLabel(status: HrMissionDefinitionStatus): string {
  return DEFINITION_STATUS_LABELS[status];
}

/** Tone for a flow status: only `ACTIVE` is in service. */
export function missionDefinitionStatusTone(status: HrMissionDefinitionStatus): HrTone {
  return status === 'ACTIVE' ? 'ok' : 'muted';
}

const POLICY_VERSION_STATUS_LABELS: Record<HrMissionPolicyVersionStatus, string> = {
  DRAFT: 'پیش‌نویس',
  VALIDATED: 'اعتبارسنجی‌شده',
  PUBLISHED: 'منتشرشده',
  ARCHIVED: 'بایگانی‌شده',
};

/**
 * What each version state MEANS — the consequence sentence.
 *
 * KEPT BESIDE THE LABEL so the two cannot drift, and worded from the frozen lifecycle: a DRAFT is
 * configuration that is not in force, only PUBLISHED governs new decisions, and an ARCHIVED version
 * stays readable as history. An operator choosing between Validate, Publish and Archive is deciding
 * exactly this, which is why the list states it instead of leaving it to a badge colour.
 */
const POLICY_VERSION_STATUS_MEANINGS: Record<HrMissionPolicyVersionStatus, string> = {
  DRAFT: 'در حال تنظیم است و هنوز بر تصمیم‌های جدید اعمال نمی‌شود.',
  VALIDATED: 'اعتبارسنجی شده است، اما تا انتشار بر تصمیم‌های جدید اعمال نمی‌شود.',
  PUBLISHED: 'نسخه‌ای است که تصمیم‌های جدید ماموریت بر اساس آن گرفته می‌شود.',
  ARCHIVED:
    'نسخه تاریخی است؛ تصمیم‌های گذشته با آن توضیح داده می‌شوند، اما تصمیم جدیدی بر اساس آن گرفته نمی‌شود.',
};

/** The Persian label for a rule-set version's own status — four members, no fallback branch. */
export function missionPolicyVersionStatusLabel(status: HrMissionPolicyVersionStatus): string {
  return POLICY_VERSION_STATUS_LABELS[status];
}

/** The consequence sentence for a version state, so the badge never travels alone. */
export function missionPolicyVersionStatusMeaning(status: HrMissionPolicyVersionStatus): string {
  return POLICY_VERSION_STATUS_MEANINGS[status];
}

/**
 * Tone for a version status: only PUBLISHED is `ok`.
 *
 * A DRAFT is not a warning and an ARCHIVED row is not a failure — both are simply NOT in force, so
 * both are muted. The same choice `hrLeavePolicyVersionStatusTone` makes, for the same reason.
 */
export function missionPolicyVersionStatusTone(status: HrMissionPolicyVersionStatus): HrTone {
  return status === 'PUBLISHED' ? 'ok' : 'muted';
}
