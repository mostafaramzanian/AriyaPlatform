import { toPersianDigits } from './calendar-api';
import { coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 51-HR-2: the Human Resources client for apps/web.
 *
 * MIRRORS THE BACKEND CONTRACT EXACTLY, and in the same way the other module clients
 * do. What is deliberately absent here is the point of the file:
 *
 *  * NO `tenantId` ANYWHERE. The HR actor is derived server-side by `resolveHrActor`
 *    from the authenticated principal, and the backend's global `ValidationPipe` runs
 *    with `forbidNonWhitelisted`, so a request carrying one is refused rather than
 *    silently scoped. There is no code path in this client that can ask for another
 *    tenant's personnel records.
 *  * NO `userId`/actor override on a create or update that would impersonate someone:
 *    `userId` exists ONCE, as the optional Core login LINK of an employee record, and
 *    the server verifies it is a member of the caller's tenant through the platform
 *    user-directory port before storing it.
 *  * NO `status: 'TERMINATED'` on an ordinary update. Employment ends through
 *    `terminateEmployee`, which closes the open interval on a chosen date; the backend
 *    rejects the word everywhere else on purpose.
 *
 * `core-http` is used exclusively, so there is exactly one session mechanism, one
 * error mapping and one response-envelope rule for the whole admin surface.
 */

/** Matches `HR_DEFAULT_PAGE_SIZE` / `HR_MAX_PAGE_SIZE` in the API's hr.constants.ts. */
export const HR_DEFAULT_PAGE_SIZE = 20;
export const HR_MAX_PAGE_SIZE = 100;

export type HrEmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
/** The statuses an administrator may SET directly — never TERMINATED (see the header). */
export type HrManualEmployeeStatus = 'ACTIVE' | 'INACTIVE';
export type HrRecordStatus = 'ACTIVE' | 'INACTIVE';
export type HrEmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'TEMPORARY' | 'INTERNSHIP';
export type HrIntervalStatus = 'ACTIVE' | 'ENDED';

export const HR_EMPLOYMENT_TYPES: readonly HrEmploymentType[] = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'TEMPORARY',
  'INTERNSHIP',
];

/** The allowlisted identity projection, identical to `DirectoryUserProfile`. */
export interface HrIdentity {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
}

export interface HrUnitRef {
  id: string;
  code: string;
  name: string;
}

export interface HrPositionRef {
  id: string;
  code: string;
  title: string;
}

export interface HrOrganizationUnit {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  parentId: string | null;
  status: HrRecordStatus;
  createdAt: string;
  updatedAt: string;
}

/** A tree node: the unit plus the children the server already resolved. */
export interface HrOrganizationNode extends HrOrganizationUnit {
  children: HrOrganizationNode[];
}

export interface HrOrganizationTree {
  roots: HrOrganizationNode[];
  total: number;
}

/**
 * The dashboard counters, all computed by the server inside the caller's tenant.
 *
 * ALL SIX ARE DECLARED, including the two the dashboard does not currently render:
 * this mirrors `OrganizationService.summary` field for field, so a screen that starts
 * showing «سمت‌های فعال» does not have to edit the contract first.
 */
export interface HrOrganizationSummary {
  units: number;
  activeUnits: number;
  positions: number;
  activePositions: number;
  employees: number;
  activeEmployees: number;
}

export interface HrPosition {
  id: string;
  tenantId: string;
  organizationUnitId: string;
  code: string;
  title: string;
  status: HrRecordStatus;
  createdAt: string;
  updatedAt: string;
  /** Present on the list and detail reads; absent on a create/update echo. */
  organizationUnit?: HrUnitRef;
}

export interface HrEmploymentRecord {
  id: string;
  employeeId: string;
  tenantId: string;
  employmentType: HrEmploymentType;
  status: HrIntervalStatus;
  /** `YYYY-MM-DD`, always — the API is date-only by contract. */
  startDate: string;
  endDate: string | null;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The current assignment, DERIVED server-side from the one open interval. */
export interface HrCurrentAssignment {
  id: string;
  employmentType: HrEmploymentType;
  status: HrIntervalStatus;
  startDate: string;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string | null;
  organizationUnit: HrUnitRef | null;
  position: HrPositionRef | null;
}

export interface HrEmployee {
  id: string;
  tenantId: string;
  /** The optional Core login link. `null` is a normal state, not an error. */
  userId: string | null;
  employeeCode: string;
  status: HrEmployeeStatus;
  createdAt: string;
  updatedAt: string;
  identity: HrIdentity | null;
  currentAssignment: HrCurrentAssignment | null;
}

/** The DETAIL read: the same row plus its whole interval history, newest first. */
export interface HrEmployeeDetail extends HrEmployee {
  employmentHistory: HrEmploymentRecord[];
}

export interface HrPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------
//
// A builder exists rather than string concatenation at the call site for one reason:
// blank filters must be OMITTED, not sent empty. `?search=` and no `search` at all are
// different requests, and the backend validates the empty string against its own rules.
// Every value is encoded, so a Persian title is a legal search term.

export interface HrEmployeeQuery {
  search?: string;
  status?: HrEmployeeStatus;
  organizationUnitId?: string;
  positionId?: string;
  page?: number;
  pageSize?: number;
}

export interface HrPositionQuery {
  search?: string;
  organizationUnitId?: string;
  status?: HrRecordStatus;
  page?: number;
  pageSize?: number;
}

export interface HrUnitQuery {
  search?: string;
  parentId?: string;
  status?: HrRecordStatus;
  page?: number;
  pageSize?: number;
}

/** Trims a filter, and drops one that is blank rather than sending it empty. */
function text(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The one place `pageSize` is capped, using the constant the API declares. */
function cappedPageSize(pageSize: number | undefined): number | undefined {
  return pageSize === undefined ? undefined : Math.min(pageSize, HR_MAX_PAGE_SIZE);
}

function query(pairs: Array<[string, string | number | undefined | null]>): string {
  const params: string[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    params.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return params.length > 0 ? `?${params.join('&')}` : '';
}

/** `{ search: ' E-1 ' }` → `?search=E-1`. Persian filters are encoded, never raw. */
export function buildEmployeeQuery(input: HrEmployeeQuery = {}): string {
  return query([
    ['search', text(input.search)],
    ['status', input.status],
    ['organizationUnitId', input.organizationUnitId],
    ['positionId', input.positionId],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

export function buildPositionQuery(input: HrPositionQuery = {}): string {
  return query([
    ['search', text(input.search)],
    ['organizationUnitId', input.organizationUnitId],
    ['status', input.status],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

export function buildUnitQuery(input: HrUnitQuery = {}): string {
  return query([
    ['search', text(input.search)],
    ['parentId', input.parentId],
    ['status', input.status],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchHrOrganizationTree(): Promise<HrOrganizationTree> {
  return coreGet<HrOrganizationTree>('/hr/organization');
}

export function fetchHrOrganizationSummary(): Promise<HrOrganizationSummary> {
  return coreGet<HrOrganizationSummary>('/hr/organization/summary');
}

export function fetchHrUnits(input: HrUnitQuery = {}): Promise<HrPage<HrOrganizationUnit>> {
  return coreGet<HrPage<HrOrganizationUnit>>(`/hr/organization/units${buildUnitQuery(input)}`);
}

export function fetchHrPositions(input: HrPositionQuery = {}): Promise<HrPage<HrPosition>> {
  return coreGet<HrPage<HrPosition>>(`/hr/positions${buildPositionQuery(input)}`);
}

export function fetchHrPosition(id: string): Promise<HrPosition> {
  return coreGet<HrPosition>(`/hr/positions/${id}`);
}

export function fetchHrEmployees(input: HrEmployeeQuery = {}): Promise<HrPage<HrEmployee>> {
  return coreGet<HrPage<HrEmployee>>(`/hr/employees${buildEmployeeQuery(input)}`);
}

/** The detail read. `employmentHistory` is present on this route only, never on the list. */
export function fetchHrEmployee(id: string): Promise<HrEmployeeDetail> {
  return coreGet<HrEmployeeDetail>(`/hr/employees/${id}`);
}

/** Every interval this person has ever had, newest first. Nothing is filtered out. */
export function fetchHrEmploymentHistory(id: string): Promise<HrEmploymentRecord[]> {
  return coreGet<HrEmploymentRecord[]>(`/hr/employees/${id}/employment-records`);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
//
// Every input below is a subset of the corresponding backend DTO and NOTHING more. No
// `tenantId`, no `id` on a create, no actor field: the server derives all three.

export interface HrUnitInput {
  code: string;
  name: string;
  /** Omitted means "a root unit". An absent parent is absence, never a `null` field. */
  parentId?: string;
}

export interface HrUnitPatch {
  code?: string;
  name?: string;
  /**
   * `null` detaches the unit to the ROOT; omitting the field leaves it where it is.
   *
   * The two are different requests, which is why this is `string | null | undefined`
   * rather than a single optional value: `UpdateOrganizationUnitDto` declares
   * `parentId?: string | null`, and a client that could only send a string would have no
   * way to express "make this a root unit".
   */
  parentId?: string | null;
}

export interface HrPositionInput {
  code: string;
  title: string;
  organizationUnitId: string;
}

export interface HrPositionPatch {
  title?: string;
  organizationUnitId?: string;
  status?: HrRecordStatus;
}

/** The FIRST interval, required on create: an employee with no unit has no answer. */
export interface HrEmployeeInput {
  employeeCode: string;
  employmentType: HrEmploymentType;
  startDate: string;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId?: string;
  userId?: string;
  status?: HrManualEmployeeStatus;
}

/** A transfer, promotion or renewal. Always a NEW interval, never an edit. */
export interface HrIntervalInput {
  employmentType: HrEmploymentType;
  startDate: string;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId?: string;
}

export interface HrEmployeePatch {
  employeeCode?: string;
  /** `null` explicitly unlinks the login; omitting the field leaves it as it was. */
  userId?: string | null;
  status?: HrManualEmployeeStatus;
}

export interface HrTerminationInput {
  endDate: string;
  reason?: string;
}

export function createHrUnit(input: HrUnitInput): Promise<HrOrganizationUnit> {
  return corePost<HrOrganizationUnit>('/hr/organization/units', input);
}

export function updateHrUnit(id: string, input: HrUnitPatch): Promise<HrOrganizationUnit> {
  return corePatch<HrOrganizationUnit>(`/hr/organization/units/${id}`, input);
}

/** A unit is RETIRED, never deleted: employment history still points at it. */
export function setHrUnitStatus(id: string, status: HrRecordStatus): Promise<HrOrganizationUnit> {
  return corePatch<HrOrganizationUnit>(`/hr/organization/units/${id}/status`, { status });
}

export function createHrPosition(input: HrPositionInput): Promise<HrPosition> {
  return corePost<HrPosition>('/hr/positions', input);
}

export function updateHrPosition(id: string, input: HrPositionPatch): Promise<HrPosition> {
  return corePatch<HrPosition>(`/hr/positions/${id}`, input);
}

export function setHrPositionStatus(id: string, status: HrRecordStatus): Promise<HrPosition> {
  return corePatch<HrPosition>(`/hr/positions/${id}/status`, { status });
}

export function createHrEmployee(input: HrEmployeeInput): Promise<HrEmployeeDetail> {
  return corePost<HrEmployeeDetail>('/hr/employees', input);
}

export function updateHrEmployee(id: string, input: HrEmployeePatch): Promise<HrEmployee> {
  return corePatch<HrEmployee>(`/hr/employees/${id}`, input);
}

/** ACTIVE or INACTIVE only. TERMINATED is produced by `terminateHrEmployee`, never typed. */
export function setHrEmployeeStatus(id: string, status: HrManualEmployeeStatus): Promise<HrEmployee> {
  return corePatch<HrEmployee>(`/hr/employees/${id}/status`, { status });
}

/** TRANSFER / PROMOTION: opens a new interval and closes the current one. */
export function openHrEmploymentInterval(
  id: string,
  input: HrIntervalInput,
): Promise<HrEmploymentRecord> {
  return corePost<HrEmploymentRecord>(`/hr/employees/${id}/employment-records`, input);
}

/** Ends employment on a chosen date. Nothing is deleted; every interval is retained. */
export function terminateHrEmployee(
  id: string,
  input: HrTerminationInput,
): Promise<{ employee: HrEmployee; closedRecord: HrEmploymentRecord }> {
  return corePost<{ employee: HrEmployee; closedRecord: HrEmploymentRecord }>(
    `/hr/employees/${id}/terminate`,
    input,
  );
}

/** Re-engages a terminated employee by APPENDING an interval — never by reopening one. */
export function rehireHrEmployee(
  id: string,
  input: HrIntervalInput,
): Promise<{ employee: HrEmployee; record: HrEmploymentRecord }> {
  return corePost<{ employee: HrEmployee; record: HrEmploymentRecord }>(
    `/hr/employees/${id}/rehire`,
    input,
  );
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
//
// Persian labels live HERE, beside the contract, so a screen never renders a raw enum
// value. Every status is a WORD rather than a colour alone (§30): `…Tone` drives a
// badge's colour, while the label is always present in the DOM.

const EMPLOYEE_STATUS_LABELS: Record<HrEmployeeStatus, string> = {
  ACTIVE: 'فعال',
  INACTIVE: 'غیرفعال',
  TERMINATED: 'خاتمه‌یافته',
};

const RECORD_STATUS_LABELS: Record<HrRecordStatus, string> = {
  ACTIVE: 'فعال',
  INACTIVE: 'غیرفعال',
};

const INTERVAL_STATUS_LABELS: Record<HrIntervalStatus, string> = {
  ACTIVE: 'در جریان',
  ENDED: 'پایان‌یافته',
};

const EMPLOYMENT_TYPE_LABELS: Record<HrEmploymentType, string> = {
  FULL_TIME: 'تمام‌وقت',
  PART_TIME: 'پاره‌وقت',
  CONTRACT: 'پیمانی',
  TEMPORARY: 'موقت',
  INTERNSHIP: 'کارآموزی',
};

export type HrTone = 'ok' | 'muted' | 'danger';

export function hrEmployeeStatusLabel(status: HrEmployeeStatus): string {
  return EMPLOYEE_STATUS_LABELS[status] ?? status;
}

export function hrRecordStatusLabel(status: HrRecordStatus): string {
  return RECORD_STATUS_LABELS[status] ?? status;
}

export function hrIntervalStatusLabel(status: HrIntervalStatus): string {
  return INTERVAL_STATUS_LABELS[status] ?? status;
}

export function hrEmploymentTypeLabel(type: HrEmploymentType): string {
  return EMPLOYMENT_TYPE_LABELS[type] ?? type;
}

export function hrEmployeeStatusTone(status: HrEmployeeStatus): HrTone {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'TERMINATED') return 'danger';
  return 'muted';
}

export function hrRecordStatusTone(status: HrRecordStatus): HrTone {
  return status === 'ACTIVE' ? 'ok' : 'muted';
}

/** A person's display name, or their code — never an id, and never an empty string. */
export function hrDisplayName(identity: HrIdentity | null, fallback: string): string {
  if (!identity) return fallback;
  const name = [identity.firstName, identity.lastName].filter(Boolean).join(' ');
  return name.length > 0 ? name : fallback;
}

/** `2026-03-01` → the same calendar day in Persian digits. UTC, so no day can shift. */
export function hrDateLabel(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

// ---------------------------------------------------------------------------
// Attendance (Phase 51-HR-2E)
// ---------------------------------------------------------------------------
//
// THE REGISTER, MIRRORED FIELD FOR FIELD. `Attendance` is ONE ROW PER EMPLOYEE PER WORK
// DAY: the day's punch window and nothing derived. There is deliberately NO `status`,
// `lateMinutes`, `overtimeMinutes` or `workedMinutes` below, and the absence IS the
// contract: the service refuses to store a verdict, because "present | late | absent |
// leave" is COMPUTED from the punch, the shift and the calendar (§13) — a client that
// declared those fields would end up rendering a number no server ever computed.
//
// WHAT THE SERVER DOES DERIVE, AND THEREFORE WHAT THIS CLIENT MAY READ
// -------------------------------------------------------------------
//   * `workDate` — the Gregorian day, `YYYY-MM-DD`. A `@db.Date` column is a CALENDAR DAY,
//     so the wire form is a date and never `…T00:00:00.000Z`; emitting the instant would
//     hand a reader in Tehran a timestamp meaning "midnight UTC" (`AttendanceService
//     .serialize` explains the boundary decision).
//   * `dateKey` — the SAME day in Jalali, `YYYY/MM/DD` Latin digits, derived server-side in
//     `APP_TIME_ZONE`. A screen labels by THIS value rather than doing its own calendar
//     arithmetic, which is what stops two answers to "what day is this".
//   * `clockIn` / `clockOut` — INSTANTS, ISO-8601 with an offset. A moment stripped of its
//     offset is a different moment, so they stay instants end to end and are only
//     FORMATTED for display (`hrInstantTimeLabel`).
//   * `clockOut === null` — the day is still OPEN. A state, not an error, and not a
//     sentinel timestamp.
//   * `source` — `DEVICE` (a punch) or `MANUAL` (an operator's correction, which carries a
//     `reason`). A day may hold BOTH rows, so which one an entry is is information rather
//     than decoration.
//
// ABSENT ON PURPOSE, AND WHY IT STAYS ABSENT
// -----------------------------------------
//   * NO `tenantId` in any request: `resolveHrActor` derives the actor from the
//     authenticated principal, and the global pipe runs `forbidNonWhitelisted`.
//   * NO WRITE FUNCTION IN THIS FILE YET. The punch routes (`clock-in`, `:id/clock-out`,
//     `adjustments`) exist and are guarded by `hr.attendance.manage`; this client exposes
//     none of them because no Aria screen offers a punch yet, and an unused export that
//     "records attendance" is worse than a missing one. The register screen is READ-ONLY
//     against `hr.attendance.read`; the punch surface arrives with its own phase.
//   * NO `me` ROUTE. "My own attendance" needs an authoritative employee→login link, which
//     the backend stores but deliberately does not treat as a licence to expose a personal
//     surface this phase (see the controller's header). A helper for it would be a request
//     that 404s.

/** Where an attendance row came from. Mirrors `AttendanceSource` in `hr_db`. */
export type HrAttendanceSource = 'DEVICE' | 'MANUAL';

export const HR_ATTENDANCE_SOURCES: readonly HrAttendanceSource[] = ['DEVICE', 'MANUAL'];

/**
 * The employee label EVERY register read carries.
 *
 * It is the person's CODE and id — never a name: the register read joins the employee row
 * for its stable, human-facing key and deliberately does not reach Core identity, which is
 * a different database and a different owner. So a row is renderable without a second
 * query, and a screen that wants a name links to the personnel file rather than inventing
 * one.
 */
export interface HrAttendanceEmployeeRef {
  id: string;
  employeeCode: string;
}

export interface HrAttendance {
  id: string;
  tenantId: string;
  employeeId: string;
  /** `YYYY-MM-DD`, always — a calendar day, never an instant. */
  workDate: string;
  /** The same day in Jalali, `YYYY/MM/DD` Latin digits, derived server-side. */
  dateKey: string;
  /** An ISO-8601 instant WITH an offset: a moment, not a wall-clock reading. */
  clockIn: string;
  /** `null` means the day is still OPEN. A state, not an error. */
  clockOut: string | null;
  source: HrAttendanceSource;
  /** Written ONLY by a `MANUAL` correction; a `DEVICE` row has none. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  employee: HrAttendanceEmployeeRef;
}

/**
 * The register filter, matching `ListAttendanceQueryDto` field for field.
 *
 * `from` / `to` are INCLUSIVE GREGORIAN `YYYY-MM-DD` bounds on `work_date` — that is what
 * the column stores and indexes, so the contract speaks the column's language. `dateKey`
 * is ONE Jalali day (`YYYY/MM/DD`, Latin digits) and the SERVER converts it once into the
 * same `from = to` range, which is why the two spellings of "one day" cannot diverge.
 *
 * THE API REFUSES `dateKey` TOGETHER WITH `from`/`to` (two answers to "which days?" is the
 * ambiguity a register cannot afford), so this type is deliberately the union of the two
 * shapes rather than a builder that silently drops one: the CALLER picks a shape.
 * `HrAttendanceView` models that choice explicitly, so an incoherent request is never
 * constructed in the first place.
 */
export interface HrAttendanceQuery {
  /** Free text against the employee's CODE — the same question the personnel list answers. */
  search?: string;
  employeeId?: string;
  from?: string;
  to?: string;
  dateKey?: string;
  source?: HrAttendanceSource;
  page?: number;
  pageSize?: number;
}

/**
 * The register's query string.
 *
 * Same two rules as the rest of this module, through the same helper: blank filters are
 * OMITTED rather than sent empty, and `pageSize` is capped at the constant the API
 * declares — so the screen cannot ask for a page the service would have to refuse.
 */
export function buildAttendanceQuery(input: HrAttendanceQuery = {}): string {
  return query([
    ['search', text(input.search)],
    ['employeeId', input.employeeId],
    ['source', input.source],
    ['dateKey', input.dateKey],
    ['from', input.from],
    ['to', input.to],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

/** One page of the tenant's register, newest day first, as the server paged it. */
export function fetchHrAttendance(input: HrAttendanceQuery = {}): Promise<HrPage<HrAttendance>> {
  return coreGet<HrPage<HrAttendance>>(`/hr/attendance${buildAttendanceQuery(input)}`);
}

// ---------------------------------------------------------------------------
// Attendance presentation
// ---------------------------------------------------------------------------
//
// Persian labels live HERE, beside the contract, exactly as the employee statuses do: a
// screen never renders a raw enum value, and every state is a WORD with colour as a
// second, redundant channel (§30).

const ATTENDANCE_SOURCE_LABELS: Record<HrAttendanceSource, string> = {
  DEVICE: 'پانچ دستگاه',
  MANUAL: 'اصلاح دستی',
};

export function hrAttendanceSourceLabel(source: HrAttendanceSource): string {
  return ATTENDANCE_SOURCE_LABELS[source] ?? source;
}

/**
 * A `DEVICE` row is the evidence itself; a `MANUAL` row is a person's correction of it,
 * which is why the two never share a tone. Neither is "bad" — they are different KINDS of
 * record, and the label, not the colour, is what says which.
 */
export function hrAttendanceSourceTone(source: HrAttendanceSource): HrTone {
  return source === 'DEVICE' ? 'ok' : 'muted';
}

/**
 * `۱۴۰۵/۰۶/۲۷` — the SERVER's Jalali day in Persian digits.
 *
 * No conversion happens here. Persian numerals are a DISPLAY form produced at render time
 * (`toPersianDigits`), so the value on screen is the value the API derived, merely
 * renumbered — while the Latin key is what any request carries back.
 */
export function hrAttendanceDayLabel(dateKey: string): string {
  return toPersianDigits(dateKey);
}

/**
 * The Persian weekday of a `YYYY-MM-DD` day.
 *
 * THIS IS A READING, NOT A DERIVATION. The weekday of a calendar day is a property of that
 * day, not a second computation of it, and UTC is NAMED because a date-only value has no
 * zone: formatting it in the browser's local zone would name the neighbouring day's
 * weekday for a reader behind UTC. Nothing here can move the day the server stored.
 */
export function hrWeekdayLabel(workDate: string): string {
  const day = new Date(`${workDate}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return workDate;

  return new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: 'UTC' }).format(day);
}

/**
 * `Asia/Tehran` — the API's own `APP_TIME_ZONE`, restated for DISPLAY only.
 *
 * A FORMAT is a decision about where to READ an instant, never about what was stored: the
 * value the API sent is untouched, and the raw ISO string stays in the DOM (the cell's
 * `title`), so a reader can always see the instant that was actually recorded. Persian
 * digits again, produced at render time.
 */
const DISPLAY_TIME_ZONE = 'Asia/Tehran';

/** `۰۸:۰۰` for an instant, `—` when there is none, and the input back if unparseable. */
export function hrInstantTimeLabel(iso: string | null): string {
  if (!iso) return '—';

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;

  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(instant);

  return toPersianDigits(time);
}

// ---------------------------------------------------------------------------
//
// LEAVE: THE REQUEST REGISTER AND THE TENANT'S OWN CATALOGUE
// ---------------------------------------------------------------------------
//
// MIRRORED FIELD FOR FIELD FROM `LeaveService`, exactly as the register above is. What a
// screen may render is what the API returns, and the ABSENCES are part of the contract:
//
//   * THE LIFECYCLE IS THE FULL FOUR-MEMBER SET — `PENDING → APPROVED | REJECTED |
//     CANCELLED`, exactly as `domain/leave-status.ts` declares it since Phase 54-E (the
//     approval flow that can REACH a decision now exists). What stays ABSENT is the
//     decision's OWN bookkeeping on a row: no `approverId`, no `decidedAt` column — those
//     facts belong to the approval STEP that produced them (`hr-leave-approval-api.ts`
//     reads that flow), so a row never claims who decided it.
//   * NO BALANCE, NO ENTITLEMENT AND NO `durationDays`. `startDate`/`endDate` are INCLUSIVE
//     whole days and NOTHING IS COUNTED: which days of a range are working days is a
//     question for the calendar and the shift (§13), neither of which this client owns.
//   * NO `cancellationReason` ON A ROW. A withdrawal is an EVENT: it stamps `cancelledAt`,
//     and its stated reason travels in the request body to the platform audit trail. The
//     reason is therefore an INPUT (`HrLeaveCancellationInput`) and never a field of a row.
//   * NO `search` ON THE REGISTER. `GET /hr/leave-requests` accepts a page query that
//     carries one and the service deliberately ignores it — the register's own filter is
//     employee, type, state and window. A search control would change nothing, so no builder
//     here can send one. (The CATALOGUE read has no search either, for the reason its own
//     query interface states below.)
//
// DATES ARE DAYS, NOT INSTANTS. `startDate` / `endDate` arrive as `YYYY-MM-DD` (the service
// converts its stored `@db.Date` at the boundary), so a client that parsed them with
// `new Date(...)` would show a reader in Tehran the PREVIOUS day. They are rendered as the
// strings they are (`hrDateLabel`) and compared as strings when a form checks its own range —
// the same comparison `LeaveRequest_period_check` makes in the database.
//
// `cancelledAt`, `createdAt` and `updatedAt` ARE instants: ISO-8601 with an offset, kept
// whole and only FORMATTED for display (`hrLeaveInstantLabel`), exactly as punch instants are.
//
// WRITES: THE FOUR THE EXISTING SURFACE OFFERS, AND NO OTHERS — submit a request, withdraw a
// pending one, add a catalogue entry, retire or restore one. There is NO delete of either
// kind: a request that should not stand is WITHDRAWN (the trail of the withdrawal is the
// point), and a type that has ever been requested is RETIRED, because
// `LeaveRequest_tenant_leave_type_fkey` is `ON DELETE RESTRICT` (§10). `updateHrLeaveRequest`
// is deliberately absent as well: a correction is a NEW request, which is what keeps a
// withdrawal's trail intact — and an unused export that "edits leave" is worse than a
// missing one.

/**
 * Upper bounds matching the `varchar` widths in `hr_db`, so a 400 precedes a 22001. The API
 * spells the same three numbers in `dto/leave.dto.ts` as `MAX_LEAVE_*`, and this file mirrors
 * them for the same reason `HR_MAX_PAGE_SIZE` mirrors `hr.constants.ts`: the form states the
 * bound instead of letting the server refuse a value the operator has just typed.
 */
export const HR_MAX_LEAVE_REASON_LENGTH = 500;
export const HR_MAX_LEAVE_TYPE_CODE_LENGTH = 64;
export const HR_MAX_LEAVE_TYPE_NAME_LENGTH = 200;

/**
 * Where a request stands. Mirrors `LeaveRequestStatus` in `hr_db` — the four members
 * Phase 54-E added alongside the approval flow, in schema order.
 */
export type HrLeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** The members, in the order the schema declares them. The wire vocabulary, spelled once. */
export const HR_LEAVE_REQUEST_STATUSES: readonly HrLeaveRequestStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

/**
 * The employee label every register read carries: the person's CODE and id, never a name.
 *
 * `LeaveRepository.REQUEST_LABEL` joins the employee row for its stable, human-facing key and
 * deliberately does not reach Core identity, which is a different database and a different
 * owner. A row is therefore renderable without a second query, and a screen that wants a name
 * links to the personnel file rather than inventing one.
 */
export interface HrLeaveEmployeeRef {
  id: string;
  employeeCode: string;
}

/**
 * The leave kind a row was recorded under, INCLUDING ITS OWN STATE.
 *
 * `status` is what lets a register keep telling the truth about history: a type retired last
 * year still names the leave every old request was recorded under, and the row says so. The
 * write path refuses a request that names an `INACTIVE` type, so the flag here is a READING of
 * the row rather than a check this client performs.
 */
export interface HrLeaveTypeRef {
  id: string;
  code: string;
  name: string;
  status: HrRecordStatus;
}

export interface HrLeaveRequest {
  id: string;
  tenantId: string;
  employeeId: string;
  leaveTypeId: string;
  /** The FIRST day covered, `YYYY-MM-DD` and INCLUSIVE — a calendar day, never an instant. */
  startDate: string;
  /** The LAST day covered, `YYYY-MM-DD` and INCLUSIVE. Equal to `startDate` for one day. */
  endDate: string;
  /** Why the leave was asked for. Required by the API; trimmed, never blank. */
  reason: string;
  /** `PENDING` while it stands, `CANCELLED` once withdrawn — and terminal thereafter. */
  status: HrLeaveRequestStatus;
  /**
   * The withdrawal instant, ISO-8601 with an offset, or `null` while the request stands.
   *
   * `null` is a STATE — nothing was withdrawn — and not a missing value: the database ties
   * the two together with `LeaveRequest_cancelled_state_check`, so an instant can exist only
   * on a withdrawn row.
   */
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  employee: HrLeaveEmployeeRef;
  leaveType: HrLeaveTypeRef;
}

/** One entry of the tenant's OWN catalogue: the leave kinds it has named for itself. */
export interface HrLeaveType {
  id: string;
  tenantId: string;
  /** The normalised machine key, unique PER TENANT (`LeaveType_tenantId_code_key`). */
  code: string;
  /** Whatever the tenant calls this leave. This system never interprets it. */
  name: string;
  status: HrRecordStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * The register filter: exactly the five the API declares, and no search term.
 *
 * `from` / `to` are GREGORIAN `YYYY-MM-DD` days and mean INTERSECTION with a request's own
 * range — a request that starts before the window and runs through it IS returned, which is
 * the question "what leave touches these days" that a register asks.
 */
export interface HrLeaveRequestQuery {
  employeeId?: string;
  leaveTypeId?: string;
  status?: HrLeaveRequestStatus;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The catalogue filter.
 *
 * NO `search`, although `GET /hr/leave-types` accepts one: this read is the SOURCE OF THE
 * REQUEST FORM's own options as well as of the catalogue list, so a search term would
 * silently shrink the set of leave kinds a person may submit. The catalogue is the tenant's
 * own vocabulary — deliberately small — and the read is bounded by one page at the API's
 * maximum, the same bound the attendance screen's employee picker uses.
 */
export interface HrLeaveTypeQuery {
  status?: HrRecordStatus;
  page?: number;
  pageSize?: number;
}

/** `{ status: 'ACTIVE' }` → `?status=ACTIVE`. Blank values are omitted, never sent empty. */
export function buildLeaveRequestQuery(input: HrLeaveRequestQuery = {}): string {
  return query([
    ['employeeId', input.employeeId],
    ['leaveTypeId', input.leaveTypeId],
    ['status', input.status],
    ['from', input.from],
    ['to', input.to],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

export function buildLeaveTypeQuery(input: HrLeaveTypeQuery = {}): string {
  return query([
    ['status', input.status],
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

/** One page of the tenant's requests, latest period first, exactly as the server paged it. */
export function fetchHrLeaveRequests(
  input: HrLeaveRequestQuery = {}
): Promise<HrPage<HrLeaveRequest>> {
  return coreGet<HrPage<HrLeaveRequest>>(`/hr/leave-requests${buildLeaveRequestQuery(input)}`);
}

/** One page of the tenant's OWN catalogue, ordered by `code`. */
export function fetchHrLeaveTypes(input: HrLeaveTypeQuery = {}): Promise<HrPage<HrLeaveType>> {
  return coreGet<HrPage<HrLeaveType>>(`/hr/leave-types${buildLeaveTypeQuery(input)}`);
}

/**
 * Submits a request: `POST /hr/leave-requests`.
 *
 * NO `status` AND NO `cancelledAt` HERE, which is the point: the initial state is a DOMAIN
 * constant on the server (`LEAVE_REQUEST_INITIAL_STATUS`), so the only request this body can
 * produce is a PENDING one. Both dates are INCLUSIVE days, and a single-day request sends the
 * same day twice rather than a special shape.
 */
export interface HrLeaveRequestInput {
  /** The person the request is FOR; an employee of the actor's own tenant. */
  employeeId: string;
  /** An ACTIVE leave type of the actor's own tenant. */
  leaveTypeId: string;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive; equal to `startDate` for one day. */
  endDate: string;
  reason: string;
}

/**
 * Withdraws a pending request: `POST /hr/leave-requests/:id/cancel`.
 *
 * THE REASON IS REQUIRED AND IS NOT A COLUMN. `LeaveRequest` has no `cancellationReason`
 * field — a withdrawal is an EVENT that stamps `cancelledAt`, and its stated reason belongs
 * to the audit trail (`core_db."AuditLog"`), which is the ONE trail §49 requires. It is an
 * input here for exactly that reason, and it travels with the act.
 */
export interface HrLeaveCancellationInput {
  reason: string;
}

/** Adds an entry to the tenant's own catalogue: `POST /hr/leave-types`. */
export interface HrLeaveTypeInput {
  /** The stable machine key. Normalised and validated by the SERVER, like an employee code. */
  code: string;
  name: string;
}

/**
 * Submits a request and returns the row AS STORED — including the `status` and `cancelledAt`
 * the server derived, neither of which a caller may choose.
 */
export function createHrLeaveRequest(input: HrLeaveRequestInput): Promise<HrLeaveRequest> {
  return corePost<HrLeaveRequest>('/hr/leave-requests', input);
}

/**
 * Withdraws a pending request and returns the withdrawn row.
 *
 * `POST`, not `DELETE`: nothing is removed. A second attempt is a 409 — `CANCELLED` is
 * terminal, so a second withdrawal instant can never overwrite the first.
 */
export function cancelHrLeaveRequest(
  id: string,
  input: HrLeaveCancellationInput
): Promise<HrLeaveRequest> {
  return corePost<HrLeaveRequest>(`/hr/leave-requests/${id}/cancel`, input);
}

/** Adds a catalogue entry and returns the stored row, with the state it was born in. */
export function createHrLeaveType(input: HrLeaveTypeInput): Promise<HrLeaveType> {
  return corePost<HrLeaveType>('/hr/leave-types', input);
}

/**
 * Retires an entry, or returns it to use — `PATCH /hr/leave-types/:id` with the state alone.
 *
 * Retirement is a STATUS rather than a delete: a type that has ever been requested cannot be
 * removed from under its own history (`ON DELETE RESTRICT`), and `INACTIVE` is what makes it
 * unavailable for anything new while every old request keeps rendering its name. `code` is
 * NOT sent: a catalogue code is an identity node, exactly as it is on `OrganizationUnit`, so
 * renaming the key a tenant's own reports cite would be a new entry rather than an edit.
 */
export function setHrLeaveTypeStatus(id: string, status: HrRecordStatus): Promise<HrLeaveType> {
  return corePatch<HrLeaveType>(`/hr/leave-types/${id}`, { status });
}

// ---------------------------------------------------------------------------
// Leave presentation
// ---------------------------------------------------------------------------
//
// Persian labels live HERE, beside the contract, for the same reason the employee statuses and
// the attendance source do: a screen never renders a raw enum value, and every state is a WORD
// with colour as a second, redundant channel (§30).

const LEAVE_REQUEST_STATUS_LABELS: Record<HrLeaveRequestStatus, string> = {
  // NOT «در انتظار»: pending APPROVAL is a state, not a promise — the label states the
  // fact the API states: the request was RECORDED and nothing further has happened yet.
  PENDING: 'ثبت‌شده',
  // The approval flow's own outcome words — the same wording `hr-leave-approval-api.ts`
  // uses for a step's decision, and the words the reporting exports pin to this file.
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  // The API's own word for the act: `POST :id/cancel` stamps `cancelledAt`.
  CANCELLED: 'لغوشده',
};

export function hrLeaveRequestStatusLabel(status: HrLeaveRequestStatus): string {
  return LEAVE_REQUEST_STATUS_LABELS[status] ?? status;
}

/**
 * Badge tone per state — colour is the SECOND channel; the WORD is the message.
 *
 * `PENDING`/`APPROVED` are `ok`, `CANCELLED` is `muted` (a withdrawal is a legitimate
 * terminal state, not a broken record), and `REJECTED` is `danger` because it is the one
 * state that asks the reader to act — re-submitting is a NEW request, exactly as the
 * register's own restatement rule states.
 */
export function hrLeaveRequestStatusTone(status: HrLeaveRequestStatus): HrTone {
  if (status === 'PENDING' || status === 'APPROVED') return 'ok';
  if (status === 'REJECTED') return 'danger';
  return 'muted';
}

/**
 * `۱۴۰۴/۱۲/۱۰ – ۱۴۰۴/۱۲/۱۴` for a period, and ONE label when both ends are the same day.
 *
 * NO DURATION IS COMPUTED. Comparing the two strings the server sent for EQUALITY is a
 * READING of the row — `startDate = endDate` is the API's ordinary single-day case and must
 * not be printed twice — whereas subtracting them would be the `durationDays` this contract
 * deliberately does not have. Formatting is `hrDateLabel`, which renders a `YYYY-MM-DD` day as
 * the calendar day it is (in UTC), so no reader is shown the neighbouring day.
 */
export function hrLeavePeriodLabel(startDate: string, endDate: string): string {
  const start = hrDateLabel(startDate);
  if (startDate === endDate) return start;
  return `${start} – ${hrDateLabel(endDate)}`;
}

/**
 * `۱۴۰۵/۰۶/۲۷ ۰۹:۳۰` for an instant, `—` when there is none, and the input back if unparseable.
 *
 * The DAY is read in the API's own zone (`DISPLAY_TIME_ZONE`) rather than the browser's, so a
 * withdrawal recorded at 09:30 in Tehran is not shown as the previous evening to a reader
 * somewhere else — and the raw ISO string stays in the DOM (the cell's `title`), exactly as
 * the attendance punches keep theirs.
 */
export function hrLeaveInstantLabel(iso: string | null): string {
  if (!iso) return '—';

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;

  const day = new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(instant);

  return `${day} ${hrInstantTimeLabel(iso)}`;
}
