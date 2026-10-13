'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  HR_DEFAULT_PAGE_SIZE,
  HR_LEAVE_REQUEST_STATUSES,
  HR_MAX_LEAVE_REASON_LENGTH,
  HR_MAX_LEAVE_TYPE_CODE_LENGTH,
  HR_MAX_LEAVE_TYPE_NAME_LENGTH,
  HR_MAX_PAGE_SIZE,
  cancelHrLeaveRequest,
  createHrLeaveRequest,
  createHrLeaveType,
  fetchHrEmployees,
  fetchHrLeaveRequests,
  fetchHrLeaveTypes,
  hrDisplayName,
  hrLeaveInstantLabel,
  hrLeavePeriodLabel,
  hrLeaveRequestStatusLabel,
  hrLeaveRequestStatusTone,
  setHrLeaveTypeStatus,
  type HrEmployee,
  type HrLeaveRequest,
  type HrLeaveRequestStatus,
  type HrLeaveType,
  type HrRecordStatus,
} from '@/lib/hr-api';
import { HrBadge, HrCard, HrNotice, HrPageHeading, HrRecordStatusBadge } from './hr-ui';
import { LeaveApprovalPanel } from './LeaveApprovalPanel';

/**
 * Phase 51-HR-3A-UI: the leave register — `/admin/hr/leave`.
 *
 * WHAT THIS SCREEN IS. The tenant's own record of the leave people have ASKED FOR: who, for
 * which kind of leave, over which whole-day range, why, and whether the request still stands.
 * Every one of those values comes from `GET /hr/leave-requests`, which is the register.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW, BECAUSE THE PLATFORM CANNOT SAY IT
 * --------------------------------------------------------------------
 *  * NO DECISION. There is no `APPROVED` / `REJECTED` member, no `approverId` and no
 *    approve/reject route, and the API says why: no authoritative approval rule exists here —
 *    deciding a request needs the answer to "who may decide THIS one?", and the
 *    reporting-subtree traversal that answers it does not exist. So this screen renders no
 *    decision word and offers no decision control. The ONE transition that needs no new
 *    policy is the one it does offer: withdrawing a pending request (`POST :id/cancel`),
 *    which is terminal, and which states its reason into the platform audit trail.
 *  * NO BALANCE, NO ENTITLEMENT AND NO DURATION. `startDate`/`endDate` are inclusive whole
 *    days and NOTHING IS COUNTED: which days of a range are WORKING days is a question for
 *    the calendar and the shift (§13), so a day count printed here would be a second answer
 *    that can disagree with them. The screen states that absence rather than leaving a column
 *    blank — a blank column reads as missing data, and the missing thing is a policy.
 *  * NO SELF-SERVICE VIEW. There is no `/hr/leave-requests/me`: "my own leave" needs an
 *    authoritative employee→login link, which HR stores as an OPTIONAL, non-unique identifier
 *    and deliberately does not treat as a licence to expose a personal surface.
 *
 * THE CATALOGUE IS PART OF THE SCREEN, NOT A ROUTE OF ITS OWN. Which leave kinds an
 * organization grants is that organization's own policy, and NOTHING IS SEEDED anywhere. So
 * `/hr/leave-types` is both the register's filter vocabulary AND the thing an administrator
 * must create before anything at all can be requested. It therefore lives on this page
 * (create, retire, restore) instead of behind its own nav row: with an empty catalogue the
 * honest rendering is "nothing can be requested yet", and that sentence belongs beside the
 * form it constrains.
 *
 * PERMISSIONS, EXACTLY AS THE CONTROLLERS DECLARE THEM: `hr.leave.read` gates every read on
 * this page. `hr.leave.manage` gates every write — submit a request, withdraw one, add a
 * catalogue entry, retire or restore one — and nothing writable appears without it.
 * `hr.employees.read` is a DIFFERENT read and is needed only for the personnel directory: the
 * optional employee filter and the row links, and the person picker of the request form.
 * Without it the register still renders IN FULL — its own read carries the employee code —
 * and no request that could only 403 is ever issued.
 *
 * EVERY DAY IS A DAY, NOT AN INSTANT: `startDate`/`endDate` are printed as the `YYYY-MM-DD`
 * strings the API sent, so the wire form stays visible, and `hrDateLabel` renders the same
 * day in the reader's calendar without moving it. The withdrawal instant keeps its raw ISO in
 * the cell's `title`, exactly as the attendance punches keep theirs. Nothing here converts,
 * counts or recomputes a date.
 */

/** The register's read. */
const LEAVE_READ = 'hr.leave.read';

/** The write grant: submitting, withdrawing, and naming the tenant's own leave kinds. */
const LEAVE_MANAGE = 'hr.leave.manage';

/** Needed only for the employee filter, the row links and the form's person picker. */
const EMPLOYEES_READ = 'hr.employees.read';

/**
 * Phase 54-J: the DECISION grant. Holding it reveals the approval panel's controls — nothing more.
 * The server decides whether THIS actor may decide THIS step (`decidableByActor`), so this constant
 * only decides whether the panel is offered at all.
 */
const LEAVE_APPROVE = 'hr.leave.approve';

/** `YYYY-MM-DD`: the shape both `type="date"` controls produce and the API accepts. */
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface Filters {
  employeeId: string;
  leaveTypeId: string;
  status: HrLeaveRequestStatus | '';
  /** Inclusive Gregorian lower bound on the request's LAST day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive Gregorian upper bound on the request's FIRST day, `YYYY-MM-DD`. */
  to: string;
}

const EMPTY_FILTERS: Filters = {
  employeeId: '',
  leaveTypeId: '',
  status: '',
  from: '',
  to: '',
};

interface Query {
  filters: Filters;
  page: number;
}

const EMPTY_QUERY: Query = { filters: EMPTY_FILTERS, page: 1 };

/** The submit form: what the API needs, and nothing it would refuse. */
interface RequestForm {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string;
}

const EMPTY_REQUEST_FORM: RequestForm = {
  employeeId: '',
  leaveTypeId: '',
  startDate: '',
  endDate: '',
  reason: '',
};

interface TypeForm {
  code: string;
  name: string;
}

const EMPTY_TYPE_FORM: TypeForm = { code: '', name: '' };

interface Notice {
  tone: 'ok' | 'error';
  message: string;
}

function orUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/**
 * True when a control's value is the `YYYY-MM-DD` day the API declares.
 *
 * This states the WIRE SHAPE, not a leave policy: it is what keeps a half-typed date from being
 * sent as if it were a day. `LeaveService` decides whether a request may exist at all.
 */
function isIsoDay(value: string): boolean {
  return ISO_DAY_PATTERN.test(value);
}

/** The API's own message when it gave one, and this screen's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/**
 * One register row. Every cell is a value the API sent, or a FORMAT of one.
 *
 * THE RAW DAYS ARE IN THE DOM. The period is labelled in the reader's calendar
 * (`hrLeavePeriodLabel`) while the two `YYYY-MM-DD` days the API stored are printed verbatim
 * in their own cell — so a reader can always see what was recorded and never has to trust a
 * rendering. The withdrawal instant keeps its exact ISO string in the cell's `title`.
 *
 * THE WITHDRAWAL IS THE ROW'S ONE ACT, and it is offered ONLY while the row is `PENDING`:
 * `CANCELLED` is terminal in the domain (`LEAVE_REQUEST_STATUS_TRANSITIONS`), so a second
 * attempt is a guaranteed 409 — inviting an operator into one would be a control that cannot
 * work. The reason is required by the API and is not a column: it travels to the audit trail,
 * which is where an act's stated reason belongs.
 */
function LeaveRequestRow({
  row,
  canWithdraw,
  canLinkEmployee,
  canApprove,
  onWithdraw,
  onDecided,
}: {
  row: HrLeaveRequest;
  canWithdraw: boolean;
  canLinkEmployee: boolean;
  /** Whether the actor holds `hr.leave.approve` — passed through to the panel, decided there. */
  canApprove: boolean;
  onWithdraw: (row: HrLeaveRequest, reason: string) => Promise<boolean>;
  /** Called by the panel after a successful decision, so this row's own status is refetched. */
  onDecided: () => void;
}) {
  const [isWithdrawing, setWithdrawing] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [isBusy, setBusy] = React.useState(false);

  /**
   * Phase 54-J: whether the approval flow is being shown for THIS row. The read behind it is a
   * second, more expensive one that nobody needs for the rows they never open (§10), so it is
   * mounted on demand and unmounted on close — its state is per-row and disappears with the row.
   */
  const [isApprovalOpen, setApprovalOpen] = React.useState(false);

  const submitWithdrawal = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const stated = reason.trim();
    if (stated.length === 0) return;

    setBusy(true);
    const withdrawn = await onWithdraw(row, stated);
    setBusy(false);

    // On success the form closes; on failure it stays OPEN holding the operator's own words,
    // so a rejected withdrawal never costs somebody the sentence they just wrote.
    if (withdrawn) {
      setWithdrawing(false);
      setReason('');
    }
  };

  return (
    <React.Fragment>
      <tr className="border-t border-border" data-testid={`hr-leave-row-${row.id}`}>
      <td className="px-4 py-3 text-sm">
        {canLinkEmployee ? (
          <Link
            href={`/admin/hr/employees/${row.employee.id}`}
            className="text-primary hover:underline"
            data-testid={`hr-leave-employee-${row.employee.employeeCode}`}
          >
            {row.employee.employeeCode}
          </Link>
        ) : (
          <span data-testid={`hr-leave-employee-${row.employee.employeeCode}`}>
            {row.employee.employeeCode}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm">
        <span className="text-foreground" data-testid={`hr-leave-type-${row.id}`}>
          {row.leaveType.name}
        </span>
        <div className="mt-0.5 font-mono text-xs text-muted-foreground">{row.leaveType.code}</div>
        {/* A RETIRED type still names the leave every old request was recorded under. Saying so
            is the difference between history and an entry that looks available today. */}
        {row.leaveType.status === 'INACTIVE' && (
          <span className="mt-1 inline-block" data-testid={`hr-leave-type-retired-${row.id}`}>
            <HrRecordStatusBadge status="INACTIVE" />
          </span>
        )}
      </td>
      <td
        className="px-4 py-3 text-sm text-foreground"
        title={`${row.startDate} → ${row.endDate}`}
        data-testid={`hr-leave-period-${row.id}`}
      >
        {/* The same days in the reader's calendar, produced at render time and never stored. */}
        {hrLeavePeriodLabel(row.startDate, row.endDate)}
      </td>
      <td
        className="px-4 py-3 font-mono text-xs text-muted-foreground"
        data-testid={`hr-leave-days-${row.id}`}
      >
        {/* BOTH ends, exactly as stored: the range is INCLUSIVE, so a single-day request
            legitimately repeats its day and hiding that would hide the contract. */}
        {row.startDate} – {row.endDate}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        <p className="max-w-sm" data-testid={`hr-leave-reason-${row.id}`}>
          {row.reason}
        </p>
      </td>
      <td className="px-4 py-3 text-sm">
        <HrBadge tone={hrLeaveRequestStatusTone(row.status)} testId={`hr-leave-status-${row.id}`}>
          {hrLeaveRequestStatusLabel(row.status)}
        </HrBadge>
        {row.cancelledAt && (
          <p
            className="mt-1 text-xs text-muted-foreground"
            title={row.cancelledAt}
            data-testid={`hr-leave-withdrawn-${row.id}`}
          >
            {hrLeaveInstantLabel(row.cancelledAt)}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-sm">
        {canWithdraw ? (
          isWithdrawing ? (
            <form className="flex w-56 flex-col gap-2" onSubmit={submitWithdrawal}>
              <Input
                id={`hr-leave-withdraw-reason-${row.id}`}
                name={`withdrawReason-${row.id}`}
                label="دلیل لغو"
                value={reason}
                maxLength={HR_MAX_LEAVE_REASON_LENGTH}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  data-testid={`hr-leave-withdraw-submit-${row.id}`}
                  disabled={isBusy || reason.trim().length === 0}
                >
                  ثبت لغو
                </Button>
                <Button
                  type="button"
                  data-testid={`hr-leave-withdraw-dismiss-${row.id}`}
                  onClick={() => {
                    setWithdrawing(false);
                    setReason('');
                  }}
                  className="bg-muted text-foreground hover:bg-muted/80"
                >
                  انصراف
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              data-testid={`hr-leave-withdraw-${row.id}`}
              onClick={() => setWithdrawing(true)}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              لغو درخواست
            </Button>
          )
        ) : (
          // An em dash, not a disabled button: nothing here is waiting on an action, and a
          // greyed-out control would imply a grant that might unlock it.
          <span className="text-muted-foreground">—</span>
        )}

        {/* PHASE 54-J: the approval flow, offered to ANY holder of `hr.leave.read` — the flow is a
            READ. Whether its controls appear is decided inside the panel from the server's own
            `decidableByActor`, so this toggle never guesses who may decide what. */}
        <Button
          type="button"
          data-testid={`hr-leave-approval-toggle-${row.id}`}
          aria-expanded={isApprovalOpen}
          onClick={() => setApprovalOpen((open) => !open)}
          className="mt-2 bg-muted text-foreground hover:bg-muted/80"
        >
          {isApprovalOpen ? 'بستن گردش تأیید' : 'گردش تأیید'}
        </Button>
      </td>
    </tr>

    {/* The flow, expanded IN PLACE and only when asked for. It spans the full width because it is a
        detail OF the row above rather than another column of the register (§10). */}
    {isApprovalOpen && (
      <tr className="border-t-0">
        <td colSpan={7} className="px-4 pb-4">
          <LeaveApprovalPanel
            leaveRequestId={row.id}
            reason={row.reason}
            canApprove={canApprove}
            onDecided={onDecided}
          />
        </td>
      </tr>
    )}
    </React.Fragment>
  );
}

export function HrLeaveView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(LEAVE_READ);
  const canManage = permissions.includes(LEAVE_MANAGE);
  const canReadEmployees = permissions.includes(EMPLOYEES_READ);
  // Phase 54-J: the DECISION grant, separate from `hr.leave.manage` on purpose — being allowed to
  // record a request is not being allowed to decide one, and the panel's controls hinge on this.
  const canApprove = permissions.includes(LEAVE_APPROVE);

  const [query, setQuery] = React.useState<Query>(EMPTY_QUERY);
  const [items, setItems] = React.useState<HrLeaveRequest[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in the register's retry/decision
  // handlers (same commit as the token bump), clears the shared personnel-
  // picker failure flag (the directory effect re-arms off the same token), and
  // re-arms on query changes in the render adjustment below — so none of the
  // three effects needs an in-effect setter reset. First mount is covered by
  // the initial `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadList();
    setStatus(null);
    setEmployeeReadFailed(false);
  };

  // A query change is a NEW read: re-arm the register in the same commit the
  // change commits (the removed in-effect setters used to arm one render
  // later). The comparison is field-wise — `applyFilter` and the clear button
  // mint fresh objects even for no-op changes, and arming without a following
  // fetch would strand the spinner. The fields mirror the register effect's
  // dependency list, and that effect early-returns on unsettled permissions
  // without touching state, so no arm is needed for the gate transition. The
  // debounce path changes `query` from a timer (`setQuery` inside
  // `setTimeout`), so no event handler can arm it there, and an effect-body
  // setter is barred by `react-hooks/set-state-in-effect`.
  const [prevQuery, setPrevQuery] = React.useState(query);
  const queryInputsChanged =
    prevQuery.page !== query.page ||
    prevQuery.filters.employeeId !== query.filters.employeeId ||
    prevQuery.filters.leaveTypeId !== query.filters.leaveTypeId ||
    prevQuery.filters.status !== query.filters.status ||
    prevQuery.filters.from !== query.filters.from ||
    prevQuery.filters.to !== query.filters.to;
  if (queryInputsChanged) {
    setPrevQuery(query);
    setLoading(true);
    setError(null);
    setStatus(null);
  }

  // The catalogue's own retry path: clearing the failure flag in the same
  // commit as the token bump — what the removed in-effect setter did on every
  // refetch (submit/toggle handlers below route through it too).
  const reloadCatalogue = () => {
    setTypeReadFailed(false);
    setCatalogueToken((value) => value + 1);
  };

  const [types, setTypes] = React.useState<HrLeaveType[]>([]);
  const [isTypeReadFailed, setTypeReadFailed] = React.useState(false);
  const [catalogueToken, setCatalogueToken] = React.useState(0);

  const [employees, setEmployees] = React.useState<HrEmployee[]>([]);
  const [isEmployeeReadFailed, setEmployeeReadFailed] = React.useState(false);

  const [form, setForm] = React.useState<RequestForm>(EMPTY_REQUEST_FORM);
  const [isSubmitting, setSubmitting] = React.useState(false);
  const [typeForm, setTypeForm] = React.useState<TypeForm>(EMPTY_TYPE_FORM);
  const [isTypeSubmitting, setTypeSubmitting] = React.useState(false);
  const [busyTypeId, setBusyTypeId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  /** A filter change is a NEW query, never a new page of the old one. */
  const applyFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    // A no-op write would still mint a fresh `query` identity without changing
    // any field, so the register's fetch could re-run with nothing to arm it.
    // Only a real field change arms — the render adjustment covers any
    // incidental page reset it carries (page → 1) as well.
    if (query.filters[key] !== value) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }
    setQuery((prev) => ({ ...prev, filters: { ...prev.filters, [key]: value }, page: 1 }));
  };

  // The tenant's own catalogue. It is read with the REGISTER's grant, because both endpoints
  // answer to `hr.leave.read` — and it is read even when the register is empty, since with no
  // types at all "nothing can be requested yet" is the fact the screen has to state.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchHrLeaveTypes({ pageSize: HR_MAX_PAGE_SIZE })
      .then((page) => {
        if (active) setTypes(page.items);
      })
      .catch(() => {
        if (!active) return;
        setTypes([]);
        setTypeReadFailed(true);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead, catalogueToken]);

  // The personnel directory, for the OPTIONAL filter, the row links and the form's person
  // picker. NO request without the read it needs: a picker that 403s is worse than one that
  // is absent. A failure degrades to "no filter, no links, no submit form" — the register is
  // unaffected, which is the whole point of keeping the two reads separate.
  //
  // AND NO REQUEST ON A REFUSED PAGE. This read is gated on `canRead` as well, because the
  // directory exists only to serve the controls INSIDE the register branch: without
  // `hr.leave.read` the screen renders a refusal and every one of those controls is absent, so
  // fetching a hundred personnel records would be a tenant-wide read performed to render
  // nothing. `hr.employees.read` alone is a grant to open the EMPLOYEE screens, not to make
  // this page's refusal cheaper to compute.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead || !canReadEmployees) return;

    let active = true;

    fetchHrEmployees({ pageSize: HR_MAX_PAGE_SIZE })
      .then((page) => {
        if (active) setEmployees(page.items);
      })
      .catch(() => {
        if (!active) return;
        setEmployees([]);
        setEmployeeReadFailed(true);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead, canReadEmployees, reloadToken]);

  // The register itself.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchHrLeaveRequests({
      employeeId: orUndefined(query.filters.employeeId),
      leaveTypeId: orUndefined(query.filters.leaveTypeId),
      status: query.filters.status === '' ? undefined : query.filters.status,
      // The two window bounds travel as the `YYYY-MM-DD` days they are, and as nothing else:
      // no search term exists on this register, so none can be sent.
      from: orUndefined(query.filters.from),
      to: orUndefined(query.filters.to),
      page: query.page,
      pageSize: HR_DEFAULT_PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setItems([]);
        setTotal(0);
        setError(describe(err, 'دریافت درخواست‌های مرخصی با خطا مواجه شد.'));
        setStatus(err instanceof CoreApiError ? err.status : null);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    isPermissionsLoading,
    canRead,
    query.filters.employeeId,
    query.filters.leaveTypeId,
    query.filters.status,
    query.filters.from,
    query.filters.to,
    query.page,
    reloadToken,
  ]);

  const hasFilters =
    query.filters.employeeId.length > 0 ||
    query.filters.leaveTypeId.length > 0 ||
    query.filters.status.length > 0 ||
    query.filters.from.length > 0 ||
    query.filters.to.length > 0;

  // The server's `total` divided by the page size THIS screen asked for — never a count of the
  // rows on screen, which would report «۲۰» for a tenant-wide register.
  const pageCount = Math.max(1, Math.ceil(total / HR_DEFAULT_PAGE_SIZE));

  /** The kinds a NEW request may name. A retired type is history, not an option. */
  const activeTypes = types.filter((type) => type.status === 'ACTIVE');

  const statusOptions: SelectOption[] = [
    { value: '', label: 'همه وضعیت‌ها' },
    ...HR_LEAVE_REQUEST_STATUSES.map((value) => ({
      value,
      label: hrLeaveRequestStatusLabel(value),
    })),
  ];

  /**
   * The filter's type options come from the REAL catalogue read — including retired entries,
   * because "what did we record against this kind of leave" is a question about history too.
   */
  const typeFilterOptions: SelectOption[] = [
    { value: '', label: 'همه انواع مرخصی' },
    ...types.map((type) => ({ value: type.id, label: `${type.name} (${type.code})` })),
  ];

  const typeFormOptions: SelectOption[] = [
    { value: '', label: 'انتخاب نوع مرخصی' },
    ...activeTypes.map((type) => ({ value: type.id, label: `${type.name} (${type.code})` })),
  ];

  /**
   * The employee options, from the REAL personnel read.
   *
   * A name is shown BESIDE the code because this is a directory projection, not the register:
   * the register's own rows carry the CODE alone (its read never reaches Core identity), and
   * this screen deliberately does not join the two — a name known for the first hundred
   * employees and missing for the rest would be a label that is sometimes right, which is
   * worse than one that is always the employee's own code.
   */
  const directoryOptions = (placeholder: string): SelectOption[] => [
    { value: '', label: placeholder },
    ...employees.map((employee) => ({
      value: employee.id,
      label: `${employee.employeeCode} — ${hrDisplayName(
        employee.identity,
        employee.employeeCode
      )}`,
    })),
  ];

  /**
   * The submit control's own precondition — the WIRE SHAPE of the five values, and nothing about
   * the leave they describe.
   *
   * This is deliberately NOT a policy check. Whether a range is acceptable, whether the person is
   * entitled to the days and whether the type may be requested at all are the SERVER's answers
   * (`LeaveRequest_period_check` and `LeaveService` state them), and this screen repeats none of
   * them: it only refuses to SEND a value that is not one — an empty picker, or a half-typed date
   * the browser has not finished producing. A refused range comes back as the API's own message
   * and is shown verbatim, which is the point: the operator reads the rule that actually applies.
   */
  const canSubmitRequest =
    form.employeeId.length > 0 &&
    form.leaveTypeId.length > 0 &&
    isIsoDay(form.startDate) &&
    isIsoDay(form.endDate) &&
    form.reason.trim().length > 0;

  const canSubmitType = typeForm.code.trim().length > 0 && typeForm.name.trim().length > 0;

  /** Submits a request — `POST /hr/leave-requests`. `status` is not sent: it is a domain constant. */
  const submitRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitRequest || isSubmitting) return;

    setSubmitting(true);
    setNotice(null);

    try {
      const created = await createHrLeaveRequest({
        employeeId: form.employeeId,
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason.trim(),
      });

      // The form clears ONLY now, on the server's own confirmation — the way the withdrawal form
      // stays open on a rejection.
      setForm(EMPTY_REQUEST_FORM);
      setNotice({
        tone: 'ok',
        message: `درخواست مرخصی برای ${created.employee.employeeCode} ثبت شد.`,
      });
      reload();
    } catch (err: unknown) {
      setNotice({ tone: 'error', message: describe(err, 'ثبت درخواست مرخصی با خطا مواجه شد.') });
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Withdraws a pending request. The row's `onWithdraw` is awaited by the row's own form, so a
   * `false` here is what keeps the operator's stated reason on screen.
   *
   * THE REGISTER IS RE-READ rather than patched in place: it is the SERVER's list, and a client
   * that edited one row locally would briefly show a state the server had not confirmed.
   */
  const withdraw = async (row: HrLeaveRequest, reason: string): Promise<boolean> => {
    setNotice(null);

    try {
      const withdrawn = await cancelHrLeaveRequest(row.id, { reason });
      setNotice({
        tone: 'ok',
        message: `درخواست ${withdrawn.employee.employeeCode} لغو شد.`,
      });
      reload();
      return true;
    } catch (err: unknown) {
      setNotice({ tone: 'error', message: describe(err, 'لغو درخواست با خطا مواجه شد.') });
      return false;
    }
  };

  /** Adds a kind of leave to the tenant's own catalogue — `POST /hr/leave-types`. */
  const submitType = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitType || isTypeSubmitting) return;

    setTypeSubmitting(true);
    setNotice(null);

    try {
      const created = await createHrLeaveType({
        code: typeForm.code.trim(),
        name: typeForm.name.trim(),
      });

      setTypeForm(EMPTY_TYPE_FORM);
      setNotice({ tone: 'ok', message: `نوع مرخصی «${created.name}» ثبت شد.` });
      // The catalogue is re-read, and so is the register: a row recorded under a type the screen
      // has not seen yet still renders its own copy of the name, and the filter vocabulary grows.
      reloadCatalogue();
    } catch (err: unknown) {
      setNotice({ tone: 'error', message: describe(err, 'ثبت نوع مرخصی با خطا مواجه شد.') });
    } finally {
      setTypeSubmitting(false);
    }
  };

  /**
   * Retires a catalogue entry or returns it to use — the ONLY lifecycle act, because a type that
   * has ever been requested cannot be deleted from under its own history (`ON DELETE RESTRICT`).
   */
  const toggleType = async (type: HrLeaveType) => {
    // The next state is chosen from the state the SERVER sent, so the button can never ask for a
    // transition that means nothing.
    const next: HrRecordStatus = type.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    setBusyTypeId(type.id);
    setNotice(null);

    try {
      const updated = await setHrLeaveTypeStatus(type.id, next);
      setNotice({
        tone: 'ok',
        message:
          updated.status === 'ACTIVE'
            ? `نوع مرخصی «${updated.name}» دوباره در دسترس است.`
            : `نوع مرخصی «${updated.name}» بازنشسته شد.`,
      });
      reloadCatalogue();
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'تغییر وضعیت نوع مرخصی با خطا مواجه شد.'),
      });
    } finally {
      setBusyTypeId(null);
    }
  };

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return <CoreForbidden message="برای مشاهده مرخصی‌ها به مجوز hr.leave.read نیاز دارید." />;
  }

  return (
    <div data-testid="hr-leave">
      <HrPageHeading
        title="مرخصی‌ها"
        description="دفتر درخواست‌های مرخصی، و نام‌گذاری انواع مرخصی این سازمان"
      />

      {/* The screen states its own boundary before it states any row. Every absence here is the
          backend's own: no decision state exists (there is no approval rule to decide WITH), and
          no duration is counted (which days of a range are working days needs the calendar and the
          shift, §13). Saying so is what stops a reader from reading the register as a balance. */}
      <p className="mb-4 text-xs text-muted-foreground" data-testid="hr-leave-scope">
        این صفحه دفتر درخواست‌های مرخصی است: هر درخواست یک بازه روز کامل است و هر دو سر بازه شامل
        می‌شود. روزهای کاری، مانده مرخصی و تصمیم تأیید یا رد در این مرحله محاسبه نمی‌شود.
      </p>

      {notice && <HrNotice tone={notice.tone} message={notice.message} />}

      {/* ── The register ─────────────────────────────────────────────────────────────────────
          The RECORD comes first, because that is what the page is FOR; the two cards that write
          follow it. NOTHING HERE FILTERS CLIENT-SIDE: every control becomes a query parameter and
          the rows below are always what the server returned for it — a client-side filter over one
          page of a tenant-wide register would say "no leave" about a request that was simply not
          in the page. */}

      <HrCard title="فیلترها" testId="hr-leave-filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Only offered with the read it needs: without `hr.employees.read` the register still
              renders in full, and no request that would 403 is ever issued. */}
          {canReadEmployees && (
            <Select
              id="hr-leave-employee"
              name="employeeFilter"
              label="کارمند"
              value={query.filters.employeeId}
              options={directoryOptions('همه کارکنان')}
              onChange={(event) => applyFilter('employeeId', event.target.value)}
            />
          )}
          <Select
            id="hr-leave-type"
            name="leaveTypeFilter"
            label="نوع مرخصی"
            value={query.filters.leaveTypeId}
            options={typeFilterOptions}
            onChange={(event) => applyFilter('leaveTypeId', event.target.value)}
          />
          <Select
            id="hr-leave-status"
            name="status"
            label="وضعیت"
            value={query.filters.status}
            options={statusOptions}
            onChange={(event) =>
              applyFilter('status', event.target.value as HrLeaveRequestStatus | '')
            }
          />
        </div>

        {/* The window is GREGORIAN `YYYY-MM-DD`, the SAME wire format the API declares and indexes:
            no conversion, and the value the control holds is the value the API receives. */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="hr-leave-window-filter">
          <Input
            id="hr-leave-from"
            name="from"
            type="date"
            label="از تاریخ (میلادی)"
            value={query.filters.from}
            onChange={(event) => applyFilter('from', event.target.value)}
          />
          <Input
            id="hr-leave-to"
            name="to"
            type="date"
            label="تا تاریخ (میلادی)"
            value={query.filters.to}
            onChange={(event) => applyFilter('to', event.target.value)}
          />
        </div>

        {hasFilters && (
          <Button
            type="button"
            data-testid="hr-leave-filters-clear"
            onClick={() => {
              // Visible only when a filter is active, so this always reaches a
              // different query — arm in the same commit as the reset.
              setLoading(true);
              setError(null);
              setStatus(null);
              setQuery(EMPTY_QUERY);
            }}
            className="mt-4 bg-muted text-foreground hover:bg-muted/80"
          >
            حذف فیلترها
          </Button>
        )}
      </HrCard>

      {/* The personnel directory is a CONVENIENCE here: the register's own read carries the
          employee code, so a failure to read names/filters degrades the screen instead of breaking
          it — and it is stated rather than silently ignored. */}
      {canReadEmployees && isEmployeeReadFailed && (
        <HrNotice
          tone="error"
          message="فهرست کارکنان خوانده نشد؛ فیلتر کارمند، پیوند پرونده و فرم ثبت درخواست در دسترس نیست."
        />
      )}

      <HrCard testId="hr-leave-results">
        {error && status === 403 ? (
          // A 403 is a missing grant, so a retry button could never succeed.
          <CoreForbidden />
        ) : error ? (
          <CoreError message={error} onRetry={reload} />
        ) : isLoading ? (
          <CoreLoading lines={6} />
        ) : items.length === 0 ? (
          <CoreEmpty
            message={
              hasFilters
                ? 'درخواست مرخصی‌ای با این فیلترها یافت نشد.'
                : 'هنوز درخواست مرخصی‌ای ثبت نشده است.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[64rem] text-right" data-testid="hr-leave-table">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">کارمند</th>
                  <th className="px-4 py-3 font-medium">نوع مرخصی</th>
                  <th className="px-4 py-3 font-medium">بازه (شمسی)</th>
                  <th className="px-4 py-3 font-medium">روزها (میلادی)</th>
                  <th className="px-4 py-3 font-medium">دلیل</th>
                  <th className="px-4 py-3 font-medium">وضعیت</th>
                  <th className="px-4 py-3 font-medium">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <LeaveRequestRow
                    key={row.id}
                    row={row}
                    // The withdrawal is offered ONLY while the row stands AND the write grant is
                    // held: `CANCELLED` is terminal, so a second attempt is a guaranteed 409.
                    canWithdraw={canManage && row.status === 'PENDING'}
                    canLinkEmployee={canReadEmployees}
                    canApprove={canApprove}
                    onWithdraw={withdraw}
                    onDecided={reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </HrCard>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" data-testid="hr-leave-total">
          {/* The SERVER's total for the current query — never a count of the rows on screen,
              which would report «۲۰» for a tenant-wide register. */}
          {total.toLocaleString('fa-IR')} درخواست
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="hr-leave-prev"
            disabled={query.page <= 1 || isLoading}
            onClick={() => {
              // Always moves `page` down (disabled at page 1), so the register
              // effect refires — arm in the same commit.
              setLoading(true);
              setError(null);
              setStatus(null);
              setQuery((prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }));
            }}
            className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
          >
            قبلی
          </Button>
          <span className="text-muted-foreground">
            صفحه {query.page.toLocaleString('fa-IR')} از {pageCount.toLocaleString('fa-IR')}
          </span>
          <Button
            type="button"
            data-testid="hr-leave-next"
            disabled={query.page >= pageCount || isLoading}
            onClick={() => {
              // Same: always moves `page` up, so the register effect refires.
              setLoading(true);
              setError(null);
              setStatus(null);
              setQuery((prev) => ({ ...prev, page: prev.page + 1 }));
            }}
            className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
          >
            بعدی
          </Button>
        </div>
      </div>

      {/* THE TWO CARDS THAT WRITE come after the record, because the record is what the page is
          FOR. Both are gated on `hr.leave.manage` — a holder of the read alone gets the register,
          the filters and the catalogue's names, and no control that would 403. */}
      {canManage && (
        <HrCard title="ثبت درخواست مرخصی" testId="hr-leave-request">
          {/* The catalogue is a PRECONDITION, not a convenience: nothing can be requested before
              this tenant has named at least one kind of leave, and an empty select would read as a
              broken control rather than as the policy that has not been stated yet. */}
          {activeTypes.length === 0 ? (
            <CoreEmpty message="هنوز نوع مرخصی فعالی ثبت نشده است؛ تا زمانی که یک نوع مرخصی ثبت نشود، درخواستی قابل ثبت نیست." />
          ) : !canReadEmployees ? (
            // The person picker comes from the personnel directory. Without that read there is no
            // honest way to choose WHO a request is for, so no request is attempted at all.
            <p className="text-sm text-muted-foreground" data-testid="hr-leave-request-blocked">
              برای ثبت درخواست، مجوز hr.employees.read نیز لازم است: کارمند از فهرست کارکنان انتخاب
              می‌شود.
            </p>
          ) : (
            <form className="grid gap-4" onSubmit={submitRequest}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  id="hr-leave-form-employee"
                  name="employeeId"
                  label="کارمند"
                  required
                  value={form.employeeId}
                  options={directoryOptions('انتخاب کارمند')}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, employeeId: event.target.value }))
                  }
                />
                <Select
                  id="hr-leave-form-type"
                  name="leaveTypeId"
                  label="نوع مرخصی"
                  required
                  value={form.leaveTypeId}
                  options={typeFormOptions}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, leaveTypeId: event.target.value }))
                  }
                />
                {/* BOTH ends are INCLUSIVE whole days, in the API's own wire format. `min` is the
                    browser's own affordance on top of the server's rule; it decides nothing. */}
                <Input
                  id="hr-leave-form-start"
                  name="startDate"
                  type="date"
                  label="از تاریخ (میلادی)"
                  required
                  value={form.startDate}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, startDate: event.target.value }))
                  }
                />
                <Input
                  id="hr-leave-form-end"
                  name="endDate"
                  type="date"
                  label="تا تاریخ (میلادی)"
                  required
                  min={form.startDate || undefined}
                  value={form.endDate}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, endDate: event.target.value }))
                  }
                />
              </div>
              <Textarea
                id="hr-leave-form-reason"
                name="reason"
                label="دلیل"
                required
                maxLength={HR_MAX_LEAVE_REASON_LENGTH}
                value={form.reason}
                onChange={(event) => setForm((prev) => ({ ...prev, reason: event.target.value }))}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  data-testid="hr-leave-request-submit"
                  disabled={!canSubmitRequest || isSubmitting}
                >
                  ثبت درخواست
                </Button>
                {/* The reason is required by the API and is not a column: a withdrawal travels to
                    the audit trail WITH its stated reason, which is where an act's reason belongs. */}
                <span className="text-xs text-muted-foreground">
                  وضعیت درخواست را سرور تعیین می‌کند؛ دلیل لغو، در صورت لغو، در ردّ حسابرسی ثبت
                  می‌شود.
                </span>
              </div>
            </form>
          )}
        </HrCard>
      )}
      {/* ── The tenant's OWN catalogue ───────────────────────────────────────────────────────
          Not a route of its own, on purpose. Nothing is seeded anywhere: which leave kinds an
          organization grants is that organization's own policy, so this card is BOTH the
          register's filter vocabulary AND the thing an administrator must create before anything
          can be requested at all. With an empty catalogue the honest rendering is "nothing can be
          requested yet" — stated in the form above, and here as an empty list rather than as a
          default taxonomy worn by every tenant that never replaced it. */}

      <HrCard title="انواع مرخصی" testId="hr-leave-catalogue">
        <p className="mb-4 text-xs text-muted-foreground">
          هر سازمان انواع مرخصی خود را خودش نام‌گذاری می‌کند؛ هیچ نوعی از پیش ثبت نشده است.
        </p>

        {isTypeReadFailed ? (
          <CoreError
            message="دریافت انواع مرخصی با خطا مواجه شد."
            onRetry={reloadCatalogue}
          />
        ) : types.length === 0 ? (
          <CoreEmpty message="هنوز نوع مرخصی ثبت نشده است." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[40rem] text-right" data-testid="hr-leave-type-table">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">کد</th>
                  <th className="px-4 py-3 font-medium">نام</th>
                  <th className="px-4 py-3 font-medium">وضعیت</th>
                  <th className="px-4 py-3 font-medium">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {types.map((type) => (
                  <tr
                    key={type.id}
                    className="border-t border-border"
                    data-testid={`hr-leave-type-row-${type.id}`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {type.code}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{type.name}</td>
                    <td className="px-4 py-3">
                      <HrRecordStatusBadge status={type.status} />
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {canManage ? (
                        <Button
                          type="button"
                          data-testid={`hr-leave-type-toggle-${type.id}`}
                          disabled={busyTypeId === type.id}
                          onClick={() => toggleType(type)}
                          className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
                        >
                          {type.status === 'ACTIVE' ? 'بازنشستگی' : 'بازگرداندن به استفاده'}
                        </Button>
                      ) : (
                        // An em dash, not a disabled button: no grant is waiting to unlock it.
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage && (
          <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submitType}>
            <Input
              id="hr-leave-type-code"
              name="code"
              label="کد نوع مرخصی"
              required
              maxLength={HR_MAX_LEAVE_TYPE_CODE_LENGTH}
              value={typeForm.code}
              onChange={(event) => setTypeForm((prev) => ({ ...prev, code: event.target.value }))}
            />
            <Input
              id="hr-leave-type-name"
              name="name"
              label="نام نوع مرخصی"
              required
              maxLength={HR_MAX_LEAVE_TYPE_NAME_LENGTH}
              value={typeForm.name}
              onChange={(event) => setTypeForm((prev) => ({ ...prev, name: event.target.value }))}
            />
            <div className="sm:col-span-2">
              <Button
                type="submit"
                data-testid="hr-leave-type-submit"
                disabled={!canSubmitType || isTypeSubmitting}
              >
                افزودن نوع مرخصی
              </Button>
            </div>
          </form>
        )}
      </HrCard>
    </div>
  );
}
