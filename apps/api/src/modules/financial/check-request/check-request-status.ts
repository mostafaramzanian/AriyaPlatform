/**
 * Phase F1 — FINANCIAL FOUNDATION: the CheckRequest lifecycle, as PURE data and pure
 * functions — no NestJS, no Prisma, no repository, no clock, no HTTP.
 *
 * WHY A PURE MODULE AND NOT RULES INSIDE THE SERVICE
 * -------------------------------------------------
 * The vocabulary below is the same closed set `prisma/financial/schema.prisma` documents,
 * and four different callers need to agree on it: the DTO validates against it (a 400 for
 * an unknown issue type or opinion, never a database error), the service decides whether
 * a transition is legal, the controller returns the status back, and the tests pin the
 * whole graph. A rule re-typed in the service is how "state 1 is editable" and "state 1
 * may not be approved" both end up true.
 *
 * `bom-status.ts` in Production is the precedent, adopted rather than reinvented.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The STATUS ordinals and their names, the EDITABLE predicate, the TRANSITION guard, the
 * manager-decision vocabulary WITH the source's Persian labels, and the requester-opinion
 * vocabulary WITH its labels.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 * ---------------------------------
 *  * No approver-identity rule — "may this actor decide?" needs the row and the platform
 *    ports; see `check-request.service.ts`.
 *  * No validation of the source's conditional fields (V1–V7) — those need the ROW's
 *    values in the source's own order, and they live in the service where the refusal can
 *    carry the source's sentence.
 *  * No title format — see `buildCheckRequestTitle` in `check-request.ts`.
 */

/**
 * The stage ordinals, exactly as the source's `c_status` / `cr_status` count them.
 * Phase CHECK-ISSUATION completes the set the source proved: {0..8} plus 50.
 *
 *   DRAFT = 0             — the requester is composing; editable.
 *   SUBMITTED = 1         — submitted / returned-for-correction: the requester re-owns
 *                           the header and attachments (Preflight §7.1/§7.4) and it
 *                           re-enters review through `submit`.
 *   MANAGER_REVIEW = 2    — the manager's «آیا چک صادر شود؟» decision.
 *   APPROVED = 3          — allocation stage: «صدور فرم تخصیص» (the state the approve
 *                           lands on; the stage data lives in `CheckAllocation`).
 *   DOCUMENT_REVIEW = 4   — «بررسی اسناد» (BarasiAsnad: تایید / اصلاح).
 *   EXECUTIVE_APPROVAL = 5 — «تایید ریاست» (Riyast: تایید / رد — the third source value,
 *                           «نیازمند اصلاح», is DEFERRED / SOURCE-CONFLICT, §20 below).
 *   ISSUANCE = 6          — «صدور چک کارشناس مالی»: cheque image + TaedCheckSaderShode.
 *   DELIVERY = 7          — «دریافت رسید تحویل»: receipt + KhatemeSodoorCheck.
 *   COMPLETED = 8         — terminal (source: the task button is disabled at
 *                           `cr_status >= 8` — Preflight E11).
 *   TERMINATED = 50       — terminal: manager «خیر», executive «رد» (the requester's
 *                           cancellation remains U12 — NOT ESTABLISHED, no route).
 *
 * The ordinals are the CLOSED set: a transition outside this table is a typed 409, and
 * no repository call can write a status the table does not name.
 */
export const CHECK_REQUEST_STATUS = {
  DRAFT: 0,
  SUBMITTED: 1,
  MANAGER_REVIEW: 2,
  APPROVED: 3,
  DOCUMENT_REVIEW: 4,
  EXECUTIVE_APPROVAL: 5,
  ISSUANCE: 6,
  DELIVERY: 7,
  COMPLETED: 8,
  TERMINATED: 50,
} as const;

export type CheckRequestStatus = (typeof CHECK_REQUEST_STATUS)[keyof typeof CHECK_REQUEST_STATUS];

/** Every status the process defines, in ascending order — the closed set, as a list. */
export const CHECK_REQUEST_STATUSES: readonly CheckRequestStatus[] = [
  CHECK_REQUEST_STATUS.DRAFT,
  CHECK_REQUEST_STATUS.SUBMITTED,
  CHECK_REQUEST_STATUS.MANAGER_REVIEW,
  CHECK_REQUEST_STATUS.APPROVED,
  CHECK_REQUEST_STATUS.DOCUMENT_REVIEW,
  CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL,
  CHECK_REQUEST_STATUS.ISSUANCE,
  CHECK_REQUEST_STATUS.DELIVERY,
  CHECK_REQUEST_STATUS.COMPLETED,
  CHECK_REQUEST_STATUS.TERMINATED,
];

/**
 * The statuses NO action ever leaves — the brief §24/§25 terminal pair. A route hit
 * against one of these is a 409 before any domain code runs, and the process
 * configuration declares the same two so the wizard offers nothing at all there.
 */
export const CHECK_REQUEST_TERMINAL_STATUSES: readonly CheckRequestStatus[] = [
  CHECK_REQUEST_STATUS.COMPLETED,
  CHECK_REQUEST_STATUS.TERMINATED,
];

/** Whether `status` is terminal — no transition exists after it, ever. */
export function isCheckRequestTerminal(status: number): boolean {
  return CHECK_REQUEST_TERMINAL_STATUSES.includes(status as CheckRequestStatus);
}

/**
 * The stage names, for logs, tests and any internal branch that must read like the
 * source's stage table. THE WIRE CARRIES THE ORDINAL, not these strings: the brief names
 * every state by its ordinal, and introducing a second vocabulary on the wire would make
 * "state 1" mean two things.
 */
export const CHECK_REQUEST_STATUS_NAMES: Record<CheckRequestStatus, string> = {
  [CHECK_REQUEST_STATUS.DRAFT]: 'DRAFT',
  [CHECK_REQUEST_STATUS.SUBMITTED]: 'SUBMITTED',
  [CHECK_REQUEST_STATUS.MANAGER_REVIEW]: 'MANAGER_REVIEW',
  [CHECK_REQUEST_STATUS.APPROVED]: 'APPROVED',
  [CHECK_REQUEST_STATUS.DOCUMENT_REVIEW]: 'DOCUMENT_REVIEW',
  [CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL]: 'EXECUTIVE_APPROVAL',
  [CHECK_REQUEST_STATUS.ISSUANCE]: 'ISSUANCE',
  [CHECK_REQUEST_STATUS.DELIVERY]: 'DELIVERY',
  [CHECK_REQUEST_STATUS.COMPLETED]: 'COMPLETED',
  [CHECK_REQUEST_STATUS.TERMINATED]: 'TERMINATED',
};

export function checkRequestStatusName(status: number): string {
  return CHECK_REQUEST_STATUS_NAMES[status as CheckRequestStatus] ?? `UNKNOWN(${status})`;
}

/**
 * A row may be edited — header fields and attachments — while the REQUESTER owns it.
 *
 * WHY {0, 1} AND NOT JUST 0: the source's stage table gives state 1 the heading
 * "POST-SUBMIT / RETURNED-FOR-CORRECTION", its editable-fields column names "request
 * header + attachments + requester opinion", and §7.4 states the correction flow plainly:
 * "the requester re-owns the record (header + attachments + opinion editable) and it
 * re-enters at 1→2". Correction lands on 1 (this phase's `request-correction` writes it),
 * so a guard of {0} would strand every corrected request with nobody able to fix it.
 *
 * WHAT IT IS NOT: this predicate does not decide WHO may edit. That is the
 * `financial.check.manage` permission, the tenant scope and the row's own guards in the
 * service — a working state is a precondition, never an authorization.
 */
export function isCheckRequestEditable(status: number): boolean {
  return status === CHECK_REQUEST_STATUS.DRAFT || status === CHECK_REQUEST_STATUS.SUBMITTED;
}

/**
 * The actions, one per row, and the ONLY statuses each is reachable from — the source's
 * transition rules (Preflight §7.2, re-verified against BOTH raw files in this phase):
 *
 *   SUBMIT  from {0, 1} → 2  (stages through SUBMITTED, lands in MANAGER_REVIEW)
 *   APPROVE from {2} → 3     (manager «بله»)
 *   REJECT  from {2} → 50    (manager «خیر»)
 *   REQUEST_CORRECTION from {2} → 1  (manager «نیازمند اصلاح است»)
 *   ALLOCATE from {3} → 4    (V9/V10/V11 validated, `Takhsis := "تایید"` — task 140-163)
 *   DOCUMENT_REVIEW_APPROVE from {4} → 5        («تایید» — task 165-181)
 *   DOCUMENT_REVIEW_CORRECTION from {4} → 1     («اصلاح» → `StateNext := 1`)
 *   EXECUTIVE_APPROVE from {5} → 6              («تایید» → default `st + 1`)
 *   EXECUTIVE_REJECT from {5} → 50              («رد» → `StateNext := 50`)
 *   ISSUE from {6} → 7       (cheque image + TaedCheckSaderShode — task 205-218)
 *   DELIVER from {7} → 8     (receipt + KhatemeSodoorCheck — task 220-236)
 *
 * NO EXECUTIVE REQUEST-CORRECTION — the brief §20's "No guess" ruling. The task form's
 * script writes `نیازمند اصلاح → StateNext = 6` (same target as approve) while BOTH
 * forms' display rules render `state == 3 && Riyast == نیازمند اصلاح` (allocation
 * active, presidency orange — i.e. target 3). Raw evidence re-extracted this phase and
 * the contradiction stands: the branch is DEFERRED / SOURCE-CONFLICT and this table
 * deliberately has no row for it.
 *
 * Every other pair is REFUSED: a second approve, an approve of a draft, an action on a
 * terminal row — each is a typed 409 naming the current status, never a silent no-op.
 */
export const CHECK_REQUEST_TRANSITIONS = {
  SUBMIT: [CHECK_REQUEST_STATUS.DRAFT, CHECK_REQUEST_STATUS.SUBMITTED],
  APPROVE: [CHECK_REQUEST_STATUS.MANAGER_REVIEW],
  REJECT: [CHECK_REQUEST_STATUS.MANAGER_REVIEW],
  REQUEST_CORRECTION: [CHECK_REQUEST_STATUS.MANAGER_REVIEW],
  ALLOCATE: [CHECK_REQUEST_STATUS.APPROVED],
  DOCUMENT_REVIEW_APPROVE: [CHECK_REQUEST_STATUS.DOCUMENT_REVIEW],
  DOCUMENT_REVIEW_CORRECTION: [CHECK_REQUEST_STATUS.DOCUMENT_REVIEW],
  EXECUTIVE_APPROVE: [CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL],
  EXECUTIVE_REJECT: [CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL],
  ISSUE: [CHECK_REQUEST_STATUS.ISSUANCE],
  DELIVER: [CHECK_REQUEST_STATUS.DELIVERY],
} as const satisfies Record<string, readonly CheckRequestStatus[]>;

export type CheckRequestTransition = keyof typeof CHECK_REQUEST_TRANSITIONS;

/** The status an action lands on when applied to a row in `from`, or `null` if illegal. */
export function checkRequestStatusAfter(
  from: number,
  action: CheckRequestTransition
): CheckRequestStatus | null {
  const allowed: readonly number[] = CHECK_REQUEST_TRANSITIONS[action];
  if (!allowed.includes(from)) return null;

  switch (action) {
    case 'SUBMIT':
      // The routing target — see the SUBMIT row of the transition table above.
      return CHECK_REQUEST_STATUS.MANAGER_REVIEW;
    case 'APPROVE':
      return CHECK_REQUEST_STATUS.APPROVED;
    case 'REJECT':
      return CHECK_REQUEST_STATUS.TERMINATED;
    case 'REQUEST_CORRECTION':
      return CHECK_REQUEST_STATUS.SUBMITTED;
    case 'ALLOCATE':
      return CHECK_REQUEST_STATUS.DOCUMENT_REVIEW;
    case 'DOCUMENT_REVIEW_APPROVE':
      return CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL;
    case 'DOCUMENT_REVIEW_CORRECTION':
      return CHECK_REQUEST_STATUS.SUBMITTED;
    case 'EXECUTIVE_APPROVE':
      return CHECK_REQUEST_STATUS.ISSUANCE;
    case 'EXECUTIVE_REJECT':
      return CHECK_REQUEST_STATUS.TERMINATED;
    case 'ISSUE':
      return CHECK_REQUEST_STATUS.DELIVERY;
    case 'DELIVER':
      return CHECK_REQUEST_STATUS.COMPLETED;
  }
}

/** The manager-decision vocabulary, the source's `c_B_NazarModir` values. */
export const MANAGER_DECISIONS = ['APPROVE', 'REJECT', 'REQUEST_CORRECTION'] as const;
export type ManagerDecision = (typeof MANAGER_DECISIONS)[number];

/**
 * The Persian labels for the manager's decision — the source's OWN words, preserved
 * verbatim for the UI (`بله;خیر;نیازمند اصلاح است`, Preflight §8.2). This is the same
 * shape `commerce-labels.ts` and `bom-status.ts` use: the API states the domain code,
 * the screen renders the legacy word, and no response ever carries a display string.
 */
export const MANAGER_DECISION_LABELS: Record<ManagerDecision, string> = {
  APPROVE: 'بله',
  REJECT: 'خیر',
  REQUEST_CORRECTION: 'نیازمند اصلاح است',
};

/**
 * The document reviewer's vocabulary — the source's `BarasiAsnad` list, verbatim
 * `تایید;اصلاح` (Preflight §8.2, task 165-181). There is NO reject: the only negative
 * branch the source offers here is a correction back to the requester (state 1).
 */
export const DOCUMENT_REVIEW_DECISIONS = ['APPROVE', 'CORRECTION'] as const;
export type DocumentReviewDecision = (typeof DOCUMENT_REVIEW_DECISIONS)[number];

export const DOCUMENT_REVIEW_DECISION_LABELS: Record<DocumentReviewDecision, string> = {
  APPROVE: 'تایید',
  CORRECTION: 'اصلاح',
};

/**
 * The presidency's vocabulary — the source's `Riyast` list MINUS its third value.
 *
 * The source offers `تایید;رد;نیازمند اصلاح`, but the «نیازمند اصلاح» branch is
 * DEFERRED / SOURCE-CONFLICT (the task script writes `StateNext = 6`, identical to the
 * approve target, while both forms' display rules render it at state 3 — brief §20,
 * re-confirmed against the raw files this phase). Declaring only the two resolved
 * values is how "no guess" becomes a property of the CODE: there is no enum member, no
 * transition row and no route for the contested branch to reach.
 */
export const EXECUTIVE_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type ExecutiveDecision = (typeof EXECUTIVE_DECISIONS)[number];

export const EXECUTIVE_DECISION_LABELS: Record<ExecutiveDecision, string> = {
  APPROVE: 'تایید',
  REJECT: 'رد',
};

/** The requester-opinion vocabulary, the source's `c_NazarDarkhastKonande` values. */
export const REQUESTER_OPINIONS = ['CONTINUE', 'CANCEL'] as const;
export type RequesterOpinion = (typeof REQUESTER_OPINIONS)[number];

/**
 * The Persian labels for the requester's opinion — the source's own list,
 * `تایید و ادامه;لغو کامل گردش درخواست`. The CANCEL value is RECORDABLE in F1 but its
 * ACTION (requester-initiated termination → 50) is `U12` — NOT ESTABLISHED — and
 * deliberately has no route.
 */
export const REQUESTER_OPINION_LABELS: Record<RequesterOpinion, string> = {
  CONTINUE: 'تایید و ادامه',
  CANCEL: 'لغو کامل گردش درخواست',
};

/** The issue-type vocabulary, the source's `c_NoeaSodoorCheck` values, with its labels. */
export const CHECK_ISSUE_TYPES = ['PURCHASE', 'PETTY_CASH', 'SALARY'] as const;
export type CheckIssueType = (typeof CHECK_ISSUE_TYPES)[number];

export const CHECK_ISSUE_TYPE_LABELS: Record<CheckIssueType, string> = {
  PURCHASE: 'خرید',
  PETTY_CASH: 'تنخواه',
  SALARY: 'حقوق',
};

/** The purchase-type vocabulary, the source's `c_NoaeKharid` values, with its labels. */
export const CHECK_PURCHASE_TYPES = ['PROJECT', 'NON_PROJECT'] as const;
export type CheckPurchaseType = (typeof CHECK_PURCHASE_TYPES)[number];

export const CHECK_PURCHASE_TYPE_LABELS: Record<CheckPurchaseType, string> = {
  PROJECT: 'پروژه ای',
  NON_PROJECT: 'غیر پروژه ای',
};
