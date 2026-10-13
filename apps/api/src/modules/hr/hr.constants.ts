/**
 * Phase 51-HR-1: the HR module's own constants.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The literal values below are shared by three or more files (DTO validation,
 * service queries, controller defaults) and by the tests. Declaring them once is
 * what stops "the list page says 100 but the service caps at 50" from becoming a
 * silent truncation, and it is what the unit specs import instead of re-typing.
 */

/**
 * Page size bounds for every HR list endpoint.
 *
 * `HR_MAX_PAGE_SIZE` is a hard ceiling, not a suggestion: `EmployeesService` clamps
 * with `Math.min`, so a request for `pageSize=100000` returns a bounded page rather
 * than attempting an unbounded scan of `hr_db`.
 */
export const HR_DEFAULT_PAGE_SIZE = 20;
export const HR_MAX_PAGE_SIZE = 100;

/** Bounds on the organisation tree read. */
export const HR_MAX_ORG_TREE_DEPTH = 20;

/**
 * The audit `resource` string for every HR row that is audited.
 *
 * Audit rows are delivered to `core_db."AuditLog"` through `AUDIT_PORT`. Phase B2.5
 * adds an HR-local `AuditOutbox` delivery buffer for the 10 durable-required event
 * families; the outbox is NOT a second audit trail — it is a transactional staging
 * area whose relay delivers events asynchronously. These constants are the `resource`
 * column values, so a query for HR actions is a query on `resource` rather than on a
 * string that has to be grepped for.
 */
export const HR_AUDIT_RESOURCE = {
  EMPLOYEE: 'hr.employee',
  EMPLOYMENT_RECORD: 'hr.employment_record',
  ORGANIZATION_UNIT: 'hr.organization_unit',
  POSITION: 'hr.position',
  /** Phase 51-HR-3: one row per audited act on the attendance register. */
  ATTENDANCE: 'hr.attendance',
  /** Phase 51-HR-3A: one row per audited act on a leave REQUEST (`LeaveRequest`). */
  LEAVE: 'hr.leave',
  /**
   * Phase 51-HR-3A: the tenant's own leave-TYPE catalogue (`LeaveType`).
   *
   * A SEPARATE RESOURCE FROM `LEAVE`, because the two are different objects with different
   * lifetimes and an operator reading the trail must be able to tell "somebody asked for
   * leave" from "somebody changed what kinds of leave this organization grants". Collapsing
   * them into one string would make that question require a join.
   */
  LEAVE_TYPE: 'hr.leave_type',
  /**
   * Phase 54-F (§15, §10.3-§10.5): the POLICY container (`LeavePolicy`).
   *
   * A THIRD RESOURCE, for the same reason `LEAVE_TYPE` is a second one. A policy is not a
   * version: creating the container is an administrative act with no rules in it, while
   * authoring, validating, publishing and archiving a version are the acts that decide what
   * the organization is governed by. An operator asking "who put this rule in force?" must
   * not have to filter out "somebody created an empty container on Tuesday".
   */
  LEAVE_POLICY: 'hr.leave_policy',
  /**
   * Phase 54-F (§10.3, §11): one version's own lifecycle (`LeavePolicyVersion`).
   *
   * KEPT SEPARATE FROM `LEAVE_POLICY` BECAUSE THE TWO HAVE DIFFERENT ROW IDENTITIES AND
   * DIFFERENT LIFETIMES. `resource_id` names one row, so sharing a resource string would make
   * the trail ambiguous about which row an act addressed — and the lifecycle acts (`validate`,
   * `publish`, `archive` and the authoring writes) are exactly the acts §23.5 requires to be
   * answerable after the fact.
   */
  LEAVE_POLICY_VERSION: 'hr.leave_policy_version',
  /** Phase 55: a Mission request (`MissionRequest`). */
  MISSION: 'hr.mission',
  /** Phase 55: the tenant's Mission option catalogue (`MissionOptionGroup` / `MissionOption`). */
  MISSION_OPTION: 'hr.mission_option',
  /** Phase 55: the Mission approval flow configuration (`MissionApprovalDefinition`). */
  MISSION_APPROVAL_DEFINITION: 'hr.mission_approval_definition',
  /** Phase 55: a Mission rule-set version (`MissionPolicyVersion`). */
  MISSION_POLICY_VERSION: 'hr.mission_policy_version',
} as const;

/** The `action` column values written with the resources above. */
export const HR_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  TERMINATE: 'terminate',
  REHIRE: 'rehire',
  TRANSFER: 'transfer',
  DEACTIVATE: 'deactivate',
  REACTIVATE: 'reactivate',
  /**
   * Phase 51-HR-3: an operator's correction of a day's punches.
   *
   * A distinct action rather than a second `update`, because the two are different
   * acts on different objects: a clock-out finishes the day the punch opened, while
   * an adjustment STATES what happened and lands on a DIFFERENT row (the `MANUAL`
   * one, §13). An operator reading the trail must be able to tell "the person left
   * at 17:00" from "an administrator decided the day ran 08:00–16:00".
   */
  ADJUST: 'adjust',
  /**
   * Phase 51-HR-3A: a withdrawal — `PENDING -> CANCELLED`.
   *
   * Its own action rather than a second `update`, for the reason `ADJUST` has one: what
   * changed is not the request's CONTENT but its STANDING, and the act is the one §13 carves
   * out of the general edit path. It also carries a `reason` the update path never has — the
   * withdrawal's statement travels with the act, because the row has no column for it.
   *
   * `TERMINATE`, `REHIRE`, `DEACTIVATE` and `REACTIVATE` above are NOT reused here. They
   * belong to an employee's employment and to a catalogue entry's lifecycle, and borrowing one
   * would put a leave withdrawal into a query that means "personnel status changed".
   */
  SUBMIT: 'submit',
  RESUBMIT: 'resubmit',
  CORRECTION: 'correction',
  CANCEL: 'cancel',
  /**
   * Phase 54-E (§18, §21, §49): a DECISION — `PENDING -> APPROVED` or `PENDING -> REJECTED`.
   *
   * TWO actions rather than one `decision`, for the reason `Attendance ADJUST` has its own: an
   * operator reading the trail must be able to ask "who refused leave, and why" without parsing a
   * payload. `approve` and `reject` are also different AUTHORITIES in the endpoint sense — they are
   * separate routes gated by the same permission today and separable tomorrow — and an action
   * column that collapsed them would have to be re-split the day they diverge.
   *
   * `CANCEL` above is NOT reused. A withdrawal is the REQUESTER's or an operator's act on the
   * REQUEST and it does not state a decision; a rejection is an APPROVER's act on a STEP. Sharing
   * an action string would put both in one query that means neither.
   */
  APPROVE: 'approve',
  /** Phase 54-E: the negative half of the pair above. Its audit entry always carries a `reason`. */
  REJECT: 'reject',
  /**
   * Phase 54-F (§10.3, §11, §12.3): the CHECK that accepts a well-formed policy version —
   * `DRAFT -> VALIDATED`.
   *
   * ITS OWN ACTION RATHER THAN A THIRD `update`, for the reason `ADJUST` and `CANCEL` have their
   * own: what changed is not the document's CONTENT but its STANDING. The body is byte-identical
   * before and after; what the act records is that somebody accepted it, and §11's whole point is
   * that this is a distinct gate a draft must pass rather than a field somebody edited.
   *
   * NO `reason` COLUMN AND NO `reason` FIELD HERE: a validation either passed or produced a
   * report, and the report is returned to the caller rather than stored (the body it judged is
   * already immutable in the version's own row, so the refusal is reproducible from the trail).
   */
  VALIDATE: 'validate',
  /**
   * Phase 54-F (§10.4, §11): the act that puts rules IN FORCE — `VALIDATED -> PUBLISHED`, which
   * also archives whichever version was published before it.
   *
   * ONE ACTION COVERING BOTH HALVES OF THE ACT, because §10.4 makes them one act: "publishing a
   * new version archives the previous one in the same act". Splitting them would invent a
   * withdrawal nobody performed. The archived predecessor's id travels in `newValue`, so the
   * supersession is readable from a single entry rather than reconstructed by joining two.
   */
  PUBLISH: 'publish',
  /**
   * Phase 54-F (§10.3, §11): withdrawal from selection WITHOUT a successor —
   * `PUBLISHED -> ARCHIVED`.
   *
   * DISTINCT FROM `PUBLISH` because the two leave different states behind: a publish always
   * leaves something in force, while an archive may leave the policy with none. An operator
   * asking "why is this policy granting nothing?" is asking for this action specifically, and a
   * shared string would make that query impossible.
   *
   * `CANCEL` AND `DEACTIVATE` ARE NOT REUSED. `CANCEL` belongs to a leave request's standing and
   * `DEACTIVATE` to a catalogue entry's; either would put a policy version's withdrawal into a
   * query that means something else entirely.
   */
  ARCHIVE: 'archive',
} as const;

/**
 * The employee-code normalisation pattern (documented in `prisma/hr/schema.prisma`).
 *
 * Uniqueness in `hr_db` is enforced by `Employee_tenantId_employeeCode_key` on the
 * NORMALISED value, so this is the single definition of "normalised": if the service
 * and the DTO ever disagreed, a code could pass validation and then collide at the
 * database, which is a 500 instead of a 400.
 */
export const HR_EMPLOYEE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

/** Shortest employment interval that is treated as plausible, in calendar years. */
export const HR_MIN_EMPLOYMENT_YEAR = 1900;

/**
 * The ONLY date shape this API accepts or emits: `YYYY-MM-DD`, no time, no offset.
 *
 * `EmploymentRecord.startDate` / `endDate` are `@db.Date` on purpose (see the schema's
 * DATE-ONLY SEMANTICS note): an employment interval is a calendar fact, and accepting
 * an instant would make the stored day depend on the caller's timezone. `@IsDateString()`
 * alone would accept `2026-03-01T00:00:00Z`, so the strict `Matches` is what keeps the
 * contract a date.
 */
export const HR_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Phase 51-HR-3: the ONLY instant shape an HR punch may be sent as — ISO-8601 with an
 * EXPLICIT offset (`Z`, `+03:30`, `-05:00`), never a bare wall-clock reading.
 *
 * WHY THE OFFSET IS REQUIRED RATHER THAN ASSUMED. A punch is a point on the timeline,
 * and the day it belongs to is DERIVED from it in `APP_TIME_ZONE`. If a client sent
 * `2026-09-18T08:00` the server would have to pick a zone for it, and `TZ` is
 * deliberately EMPTY in the api container — so the stored instant would depend on
 * whatever the process happened to default to, and the Jalali `dateKey` derived from
 * it could land on the wrong day. Requiring the offset moves that decision to the
 * caller that knows the zone, and keeps one interpretation of an instant.
 *
 * Seconds are optional; fractional seconds and both `Z` and numeric offsets are
 * accepted, because those are the shapes a browser or a device gateway produces.
 */
export const HR_ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Phase 51-HR-3: the Jalali `YYYY/MM/DD` wire format, Latin digits — the format
 * `formatJalaliDateKey` emits and `parseJalaliDateKey` reads (`src/calendar/jalali.util.ts`).
 *
 * The FORMAT is validated here and the DATE ITSELF is validated by
 * `parseJalaliDateKey` in the service, so `1405/13/45` is refused rather than turned
 * into a filter that silently matches nothing. Persian digits are deliberately NOT
 * accepted at the API boundary — the same rule the calendar module states: accepting
 * both would create two spellings of the same key.
 */
export const HR_JALALI_DATE_KEY_PATTERN = /^\d{4}\/\d{2}\/\d{2}$/;

/**
 * Phase 54-C (D14, §43.6): the module's CANONICAL ID — `hr` — as the platform's registry
 * knows it (`core_db."ModuleRegistration".moduleId`).
 *
 * WHY IT IS A CONSTANT AND NOT A LITERAL ON EACH CONTROLLER. The id appears in three places
 * that must never drift apart: the decorator HR's controllers carry, the `ModuleRegistration`
 * row the provisioning migration inserts, and the feature row that hangs off it
 * (`ModuleFeature.moduleId`). The failure mode of a literal is specific and expensive — a
 * renamed string on one side refuses a module that is working in production, with a `403`
 * that names a module id. §43.10 gate 4 reads the provisioning migration's SQL as TEXT and
 * compares it against this constant precisely because the two files cannot import each other
 * across the Core/HR boundary.
 *
 * HR *declares* this id; it does not decide entitlement with it (§43.6 — HR's application
 * layer never learns whether it is entitled).
 */
export const HR_MODULE_ID = 'hr';

/**
 * Phase 54-C (D14, §43.6): the FEATURE ids HR declares, as a frozen record.
 *
 * ONE member today. The feature level is the one that can be granted per tenant
 * (`ModuleFeatureGrant`, §43.3), so this record is the list of things an operator can sell,
 * switch off or withhold independently of the module as a whole. `LEAVE` is the first because
 * the leave surface is the one HR ships with a complete catalogue, request lifecycle and audit
 * trail — the smallest surface that is honestly a *feature* rather than a route.
 *
 * A feature id is a slug (the platform validates the same shape the SQL `CHECK` enforces), and
 * it is scoped by the module: `hr` + `leave`, never a bare `leave`.
 */
export const HR_FEATURE = {
  LEAVE: 'leave',
  /** Phase 55: the Mission feature, provisioned per tenant by a Core seed migration. */
  MISSION: 'mission',
} as const;
