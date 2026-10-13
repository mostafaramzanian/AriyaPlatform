'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarDays } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { CoreJalaliDatePicker } from '@/components/core/CoreJalaliDatePicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownPanel } from '@/components/ui/dropdown-panel';
import { Select, type SelectOption } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getCalendarToday, parseDateKey, type CalendarDay } from '@/lib/calendar-api';
import {
  HR_ATTENDANCE_SOURCES,
  HR_DEFAULT_PAGE_SIZE,
  HR_MAX_PAGE_SIZE,
  fetchHrAttendance,
  fetchHrEmployees,
  hrAttendanceDayLabel,
  hrAttendanceSourceLabel,
  hrAttendanceSourceTone,
  hrDisplayName,
  hrInstantTimeLabel,
  hrWeekdayLabel,
  type HrAttendance,
  type HrAttendanceSource,
  type HrEmployee,
} from '@/lib/hr-api';
import { HrBadge, HrCard, HrNotice, HrPageHeading } from './hr-ui';

/**
 * Phase 51-HR-2E: the attendance register — `/admin/hr/attendance`.
 *
 * WHAT THIS SCREEN IS, AND WHY IT IS THE TENANT REGISTER RATHER THAN A PERSONAL PAGE
 * ---------------------------------------------------------------------------------
 * The visual reference for attendance is a PERSONAL screen: one person's month, with
 * statuses, late marks and leave. This screen is not that, and the difference is not a
 * shortcut — it is the backend's own boundary, restated here rather than worked around:
 *
 *   * THERE IS NO `GET /hr/attendance/me`. The controller states its absence as design:
 *     "my own attendance" needs an authoritative employee→login link, and HR stores
 *     `userId` as an OPTIONAL, non-unique identifier which this phase deliberately does
 *     not treat as a licence to expose a personal surface. A personal screen built
 *     without that link could only be built out of an assumption about who the reader is.
 *   * THERE IS NO STATUS FIELD. `Attendance` stores one row per employee per work day —
 *     the punch window, and nothing derived. "present | late | absent | leave" is
 *     COMPUTED from the punch, the shift and the calendar (§13), and this phase owns only
 *     the first of those three. So this screen renders NO status word, NO late minutes,
 *     NO overtime and NO attendance percentage: every one of those is a claim no server
 *     has made, and inventing it here would put a number on somebody's working record
 *     that can never be traced back to a fact.
 *
 * WHAT IT RENDERS INSTEAD — exactly the facts the API returns, and nothing more:
 *   `workDate` (the Gregorian day, as a date), `dateKey` (the SAME day in Jalali, which
 *   the SERVER derived), the weekday of that day, the employee's own code, `source` (a
 *   `DEVICE` punch or a `MANUAL` correction — with the correction's stated reason), and
 *   the two instants `clockIn`/`clockOut`. A `null` clock-out is rendered as the state it
 *   is — the day is still OPEN — rather than as a missing value or a zero.
 *
 * PERMISSIONS, EXACTLY AS THE CONTROLLER DECLARES THEM: `hr.attendance.read` gates the
 * register read, and nothing on this screen writes, so `hr.attendance.manage` appears
 * nowhere and no punch control is offered. `hr.employees.read` — a DIFFERENT read — is
 * required for the two conveniences that depend on the personnel directory: the optional
 * employee filter, and turning a row's employee code into a link to that person's file.
 * Without it the register still renders in full; the screen simply does not issue a
 * request it knows would be a 403.
 *
 * THE DATE FILTER SPEAKS THE CONTRACT'S LANGUAGE, NOT ITS OWN: `dateKey` for ONE Jalali
 * day (the server converts it), or `from`/`to` for a Gregorian range — never both, which
 * is why the shape of the range is an explicit choice on this screen instead of a state a
 * request could accidentally combine. Nothing here performs Jalali arithmetic: `jalali.util`
 * is the single implementation of that, and it lives on the server (§8).
 */

/** The register's read. */
const ATTENDANCE_READ = 'hr.attendance.read';
/** Needed only for the employee filter and for linking a row to a personnel file. */
const EMPLOYEES_READ = 'hr.employees.read';

const SEARCH_DEBOUNCE_MS = 350;

/** Which shape the date slot holds. The API refuses `dateKey` together with `from`/`to`. */
type DateMode = 'all' | 'day' | 'range';

interface Filters {
  search: string;
  employeeId: string;
  source: HrAttendanceSource | '';
  /** One Jalali day, `YYYY/MM/DD` Latin digits — the server converts it. */
  dateKey: string;
  /** Inclusive Gregorian bounds on `workDate`, `YYYY-MM-DD`. */
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  employeeId: '',
  source: '',
  dateKey: '',
  from: '',
  to: '',
};

/**
 * The register's query: the filters, the SHAPE of the date slot, and the page.
 *
 * WHY THE MODE IS STORED AND NOT DERIVED FROM THE FILTER VALUES. Deriving it reads
 * tidier — no second source of truth — but it breaks the one case the control exists for:
 * choosing «یک روز (شمسی)» BEFORE a day is picked leaves `dateKey` empty, so a derived
 * mode reads back as `all` and the day control never appears. The operator picks a filter
 * and nothing happens. The mode is therefore part of the query, `handleDateMode` is what
 * keeps the two shapes mutually exclusive, and the request below still sends EXACTLY ONE
 * of them — which is the property the API's 400 actually protects.
 */
interface Query {
  filters: Filters;
  dateMode: DateMode;
  page: number;
}

const EMPTY_QUERY: Query = { filters: EMPTY_FILTERS, dateMode: 'all', page: 1 };

function orUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/**
 * One register row. Every cell is a value the API sent, or a FORMAT of one.
 *
 * THE RAW INSTANTS ARE IN THE DOM. Each punch cell carries the exact ISO string the API
 * returned in its `title`, while the text is the same moment rendered as `HH:mm` in the
 * platform's zone (`hrInstantTimeLabel` explains why that is a display decision and not a
 * conversion). So the screen is legible AND auditable: a reader who wants the instant the
 * device actually recorded does not have to trust the formatting.
 */
function AttendanceRow({ row, canLinkEmployee }: { row: HrAttendance; canLinkEmployee: boolean }) {
  return (
    <tr className="border-t border-border" data-testid={`hr-attendance-row-${row.id}`}>
      <td className="px-4 py-3 text-sm text-foreground" data-testid={`hr-attendance-day-${row.id}`}>
        {/* The SERVER's Jalali day, in Persian digits. No conversion happens here. */}
        {hrAttendanceDayLabel(row.dateKey)}
      </td>
      <td
        className="px-4 py-3 text-sm text-muted-foreground"
        data-testid={`hr-attendance-weekday-${row.id}`}
      >
        {/* The weekday OF `workDate` — read off the date the API sent, never off today. */}
        {hrWeekdayLabel(row.workDate)}
      </td>
      <td
        className="px-4 py-3 font-mono text-xs text-muted-foreground"
        data-testid={`hr-attendance-workdate-${row.id}`}
      >
        {/* `YYYY-MM-DD` — a DATE. It is printed exactly as the API sent it, so the wire
            form stays visible instead of being re-rendered into a timestamp. */}
        {row.workDate}
      </td>
      <td className="px-4 py-3 text-sm">
        {canLinkEmployee ? (
          <Link
            href={`/admin/hr/employees/${row.employee.id}`}
            className="text-primary hover:underline"
            data-testid={`hr-attendance-employee-${row.employee.employeeCode}`}
          >
            {row.employee.employeeCode}
          </Link>
        ) : (
          <span data-testid={`hr-attendance-employee-${row.employee.employeeCode}`}>
            {row.employee.employeeCode}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <HrBadge
          tone={hrAttendanceSourceTone(row.source)}
          testId={`hr-attendance-source-${row.id}`}
        >
          {hrAttendanceSourceLabel(row.source)}
        </HrBadge>
        {/* A correction states WHY. It is the row's own field, so it is shown with the row
            rather than in a panel somewhere else. */}
        {row.reason && (
          <p
            className="mt-1 max-w-xs text-xs text-muted-foreground"
            data-testid={`hr-attendance-reason-${row.id}`}
          >
            {row.reason}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-foreground">
        <span title={row.clockIn} data-testid={`hr-attendance-in-${row.id}`}>
          {hrInstantTimeLabel(row.clockIn)}
        </span>
      </td>
      <td className="px-4 py-3 text-sm">
        {row.clockOut ? (
          // The testid sits on the VALUE, not on the cell, so the element that carries the
          // audit `title` is the element the spec reaches — exactly like the clock-in cell.
          // When the day is open there is no clock-out value to point at, which is why the
          // badge below is the only thing this cell offers.
          <span
            className="tabular-nums text-foreground"
            title={row.clockOut}
            data-testid={`hr-attendance-out-${row.id}`}
          >
            {hrInstantTimeLabel(row.clockOut)}
          </span>
        ) : (
          // `null` is a STATE — the day is still open — which is why it is a word rather
          // than an em dash that would read as "no data".
          <HrBadge tone="muted" testId={`hr-attendance-open-${row.id}`}>
            باز
          </HrBadge>
        )}
      </td>
    </tr>
  );
}

export function HrAttendanceView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(ATTENDANCE_READ);
  const canReadEmployees = permissions.includes(EMPLOYEES_READ);

  const [query, setQuery] = React.useState<Query>(EMPTY_QUERY);
  const [searchInput, setSearchInput] = React.useState('');

  const [items, setItems] = React.useState<HrAttendance[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in the retry handler (same commit as
  // the token bump) and re-arms on query changes in the render adjustment
  // below, so the register effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadList();
    setStatus(null);
    // The employee-directory read re-arms off the same token: clearing its
    // failure flag here is what the removed in-effect setter did on every
    // refetch.
    setEmployeeReadFailed(false);
  };

  // A query change is a NEW read: re-arm the register in the same commit the
  // change commits (the removed in-effect setters used to arm one render
  // later). The comparison is field-wise — the builders mint a fresh object
  // even for a no-op select, and arming without a following fetch would strand
  // the spinner. The fields mirror the register effect's dependency list, and
  // that effect early-returns on unsettled permissions without touching state,
  // so no arm is needed for the gate transition. The debounce path changes
  // `query` from a timer (`setQuery` inside `setTimeout`), so no event handler
  // could arm it there, and an effect-body setter is barred by
  // `react-hooks/set-state-in-effect`.
  const [prevQuery, setPrevQuery] = React.useState(query);
  const queryInputsChanged =
    prevQuery.page !== query.page ||
    prevQuery.dateMode !== query.dateMode ||
    prevQuery.filters.search !== query.filters.search ||
    prevQuery.filters.employeeId !== query.filters.employeeId ||
    prevQuery.filters.source !== query.filters.source ||
    prevQuery.filters.dateKey !== query.filters.dateKey ||
    prevQuery.filters.from !== query.filters.from ||
    prevQuery.filters.to !== query.filters.to;
  if (queryInputsChanged) {
    setPrevQuery(query);
    setLoading(true);
    setError(null);
    setStatus(null);
  }

  const [employees, setEmployees] = React.useState<HrEmployee[]>([]);
  const [isEmployeeReadFailed, setEmployeeReadFailed] = React.useState(false);
  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const [isDayPickerOpen, setDayPickerOpen] = React.useState(false);

  const applyFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    // Arm only when this call actually moves an effect input: a no-op select
    // (same value, fresh object identity) refires nothing and must not strand
    // the spinner. The unconditional `page: 1` below also counts — paging back
    // to the first page IS a new read. The render adjustment above mirrors this
    // check field-wise for the timer path (debounce), where no handler can arm.
    const willChange = value !== query.filters[key] || query.page !== 1;
    if (willChange) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }
    setQuery((prev) => ({ ...prev, filters: { ...prev.filters, [key]: value }, page: 1 }));
  };

  // Typing does not fire a request per keystroke.
  React.useEffect(() => {
    const handle = setTimeout(() => {
      setQuery((prev) =>
        prev.filters.search === searchInput
          ? prev
          : { ...prev, filters: { ...prev.filters, search: searchInput }, page: 1 }
      );
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [searchInput]);

  // The personnel directory, for the OPTIONAL filter and for the row links. NO request
  // without the read it needs: a picker that 403s is worse than one that is absent. A
  // failure here degrades to "no filter and no links" — the register is unaffected, which
  // is the whole point of keeping the two reads separate.
  React.useEffect(() => {
    if (isPermissionsLoading || !canReadEmployees) return;

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
  }, [isPermissionsLoading, canReadEmployees, reloadToken]);

  // The server's idea of today, for the Jalali day picker: its grid comes from
  // `GET /calendar/today` + `GET /calendar/month`, so the client performs NO Jalali
  // arithmetic and cannot disagree with the server about what day it is (`CoreDateChip`
  // follows the same rule). Until it answers there is no grid, so the picker is not
  // offered rather than offered empty.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    getCalendarToday()
      .then((day) => {
        if (active) setToday(day);
      })
      .catch(() => {
        if (active) setToday(null);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead]);

  // The register.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    // The SHAPE the operator chose, not one inferred from the filter values: picking
    // «یک روز (شمسی)» before a day exists is a real state, and deriving the mode from
    // `dateKey` would read that state back as `all`.
    const mode = query.dateMode;

    fetchHrAttendance({
      search: query.filters.search,
      employeeId: orUndefined(query.filters.employeeId),
      source: query.filters.source === '' ? undefined : query.filters.source,
      // EXACTLY ONE date shape. `dateKey` and `from`/`to` are mutually exclusive in the
      // contract (the API answers 400 for the combination), and the mode is what keeps
      // them so — the request can never carry two answers to "which days?".
      dateKey: mode === 'day' ? orUndefined(query.filters.dateKey) : undefined,
      from: mode === 'range' ? orUndefined(query.filters.from) : undefined,
      to: mode === 'range' ? orUndefined(query.filters.to) : undefined,
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
        setError(err instanceof Error ? err.message : 'دریافت دفتر حضور و غیاب با خطا مواجه شد.');
        setStatus(err instanceof CoreApiError ? err.status : null);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    isPermissionsLoading,
    canRead,
    query.filters.search,
    query.filters.employeeId,
    query.filters.source,
    query.filters.dateKey,
    query.filters.from,
    query.filters.to,
    query.dateMode,
    query.page,
    reloadToken,
  ]);

  const mode = query.dateMode;
  const hasFilters =
    query.filters.search.trim().length > 0 ||
    query.filters.employeeId.length > 0 ||
    query.filters.source.length > 0 ||
    query.filters.dateKey.length > 0 ||
    query.filters.from.length > 0 ||
    query.filters.to.length > 0;

  // The server's `total` divided by the page size THIS screen asked for — never a count of
  // the rows on screen, which would report "۲۰" for a tenant-wide register.
  const pageCount = Math.max(1, Math.ceil(total / HR_DEFAULT_PAGE_SIZE));

  const sourceOptions: SelectOption[] = [
    { value: '', label: 'همه منابع' },
    ...HR_ATTENDANCE_SOURCES.map((source) => ({
      value: source,
      label: hrAttendanceSourceLabel(source),
    })),
  ];

  const dateModeOptions: SelectOption[] = [
    { value: 'all', label: 'همه روزها' },
    { value: 'day', label: 'یک روز (شمسی)' },
    { value: 'range', label: 'بازه میلادی (از/تا)' },
  ];

  /**
   * The employee filter's options, from the REAL personnel read.
   *
   * A name is shown BESIDE the code because this list is a directory projection, not the
   * register: the register's own rows carry the CODE alone (its read never reaches Core
   * identity), and this screen deliberately does not join the two — a name known for the
   * first hundred employees and missing for the rest would be a label that is sometimes
   * right, which is worse than one that is always the employee's own code.
   */
  const employeeFilterOptions: SelectOption[] = [
    { value: '', label: 'همه کارکنان' },
    ...employees.map((employee) => ({
      value: employee.id,
      label: `${employee.employeeCode} — ${hrDisplayName(
        employee.identity,
        employee.employeeCode
      )}`,
    })),
  ];

  /**
   * Switching the SHAPE of the date slot clears the other shape, because the contract
   * refuses `dateKey` together with `from`/`to`. This is request-shape bookkeeping rather
   * than a business rule: the screen is choosing which of the API's two date filters it is
   * asking with, and it makes that choice visible instead of hiding it inside a builder.
   */
  const handleDateMode = (next: DateMode) => {
    const clearsDay = next !== 'day';
    const clearsRange = next !== 'range';

    // Arm only when the mode move (or its page/clearing side-effects) changes an
    // effect input: re-selecting the active mode at page 1 with already-cleared
    // fields refires nothing. Read against current `query` (this handler always
    // runs against the latest committed state).
    const willChange =
      next !== query.dateMode ||
      query.page !== 1 ||
      (clearsDay && query.filters.dateKey !== '') ||
      (clearsRange && (query.filters.from !== '' || query.filters.to !== ''));
    if (willChange) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }

    setQuery((prev) => ({
      dateMode: next,
      filters: {
        ...prev.filters,
        dateKey: clearsDay ? '' : prev.filters.dateKey,
        from: clearsRange ? '' : prev.filters.from,
        to: clearsRange ? '' : prev.filters.to,
      },
      page: 1,
    }));
  };

  /**
   * The month the Jalali picker opens on: the value already chosen, else the SERVER's
   * today. The fallback is the same shape `CorrLetterList` uses — a starting month for a
   * grid that is fetched anyway — and it is never a source of a Jalali date: the grid and
   * the day it returns both come from `GET /calendar/month`.
   */
  const pickerInitialMonth = React.useMemo(() => {
    if (query.filters.dateKey) {
      const parsed = parseDateKey(query.filters.dateKey);
      if (parsed) return { jy: parsed.jy, jm: parsed.jm };
    }
    if (today) return { jy: today.jy, jm: today.jm };
    return { jy: 1405, jm: 1 };
  }, [query.filters.dateKey, today]);

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهده دفتر حضور و غیاب به مجوز hr.attendance.read نیاز دارید." />
    );
  }

  return (
    <div data-testid="hr-attendance">
      <HrPageHeading
        title="حضور و غیاب"
        description="دفتر پانچ روزهای کاری کارکنان، بر پایه پانچ ثبت‌شده و اصلاح‌های دستی"
      />

      <p className="mb-4 text-xs text-muted-foreground" data-testid="hr-attendance-scope">
        این صفحه دفتر پانچ روزهای کاری است: برای هر کارمند و هر روز، پنجره ورود و خروج ثبت‌شده.
        وضعیت محاسبه‌شده حضور به تقویم شیفت نیاز دارد و در این مرحله نمایش داده نمی‌شود.
      </p>

      <HrCard title="فیلترها" testId="hr-attendance-filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            id="hr-attendance-search"
            name="search"
            label="کد کارمند"
            value={searchInput}
            placeholder="مثلاً E-1042"
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Select
            id="hr-attendance-source"
            name="source"
            label="منبع"
            value={query.filters.source}
            options={sourceOptions}
            onChange={(event) =>
              applyFilter('source', event.target.value as HrAttendanceSource | '')
            }
          />
          {/* Only offered with the read it needs: without `hr.employees.read` the register
              still renders in full, and no request that would 403 is ever issued. */}
          {canReadEmployees && (
            <Select
              id="hr-attendance-employee"
              name="employeeFilter"
              label="کارمند"
              value={query.filters.employeeId}
              options={employeeFilterOptions}
              onChange={(event) => applyFilter('employeeId', event.target.value)}
            />
          )}
          <Select
            id="hr-attendance-date-mode"
            name="dateMode"
            label="بازه زمانی"
            value={mode}
            options={dateModeOptions}
            onChange={(event) => handleDateMode(event.target.value as DateMode)}
          />
        </div>

        {/* ── The date slot ────────────────────────────────────────────────────────────
            ONE shape at a time, because the contract refuses `dateKey` together with
            `from`/`to`. The select above decides which control appears, so the request can
            never carry two answers to "which days?".

            NOTHING HERE FILTERS CLIENT-SIDE. Every control becomes a query parameter and
            the rows below are always what the server returned for it: a client-side
            filter over one page of a tenant-wide register would say "no punches" about a
            day that simply was not in the page. */}

        {mode === 'day' && (
          <div className="relative mt-4" data-testid="hr-attendance-day-filter">
            <div className="mb-2 text-sm font-medium text-foreground" id="hr-attendance-day-label">
              روز شمسی
            </div>
            <button
              type="button"
              data-testid="hr-attendance-day-open"
              aria-expanded={isDayPickerOpen}
              aria-labelledby="hr-attendance-day-label hr-attendance-day-value"
              onClick={() => setDayPickerOpen((open) => !open)}
              className={cn(
                'inline-flex h-11 w-full items-center gap-2 rounded-xl border bg-secondary/60 px-3 text-sm outline-none transition sm:w-72',
                isDayPickerOpen
                  ? 'border-primary ring-2 ring-primary/20'
                  : 'border-border hover:border-primary/40'
              )}
            >
              <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate text-right" id="hr-attendance-day-value">
                {query.filters.dateKey ? (
                  hrAttendanceDayLabel(query.filters.dateKey)
                ) : (
                  <span className="text-muted-foreground">انتخاب روز</span>
                )}
              </span>
            </button>
            {/* A day filter must be REMOVABLE without re-opening the grid and hunting for the
                same day: clearing it returns the register to "all days". */}
            {query.filters.dateKey.length > 0 && (
              <Button
                type="button"
                data-testid="hr-attendance-day-clear"
                onClick={() => {
                  applyFilter('dateKey', '');
                  setDayPickerOpen(false);
                }}
                className="mt-2 bg-muted text-foreground hover:bg-muted/80"
              >
                حذف فیلتر روز
              </Button>
            )}
            <DropdownPanel open={isDayPickerOpen} className="absolute z-50 mt-2 w-80 rounded-2xl border border-border bg-popover p-3 shadow-elevated">
                {/* The grid is the SERVER's (`/calendar/month`). Until it answers there is
                    no calendar on screen rather than one the client guessed — and no Jalali
                    arithmetic happens anywhere in this file. */}
                {today ? (
                  <CoreJalaliDatePicker
                    value={query.filters.dateKey || null}
                    onSelect={(date) => {
                      applyFilter('dateKey', date);
                      setDayPickerOpen(false);
                    }}
                    initialMonth={pickerInitialMonth}
                    todayKey={today.date}
                    className="w-full"
                  />
                ) : (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    تقویم در دسترس نیست.
                  </div>
                )}
            </DropdownPanel>
          </div>
        )}

        {mode === 'range' && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="hr-attendance-range-filter">
            {/* Gregorian `YYYY-MM-DD`, the SAME wire format `work_date` stores and indexes.
                No conversion: the value the control holds is the value the API receives. */}
            <Input
              id="hr-attendance-from"
              name="from"
              type="date"
              label="از تاریخ (میلادی)"
              value={query.filters.from}
              onChange={(event) => applyFilter('from', event.target.value)}
            />
            <Input
              id="hr-attendance-to"
              name="to"
              type="date"
              label="تا تاریخ (میلادی)"
              value={query.filters.to}
              onChange={(event) => applyFilter('to', event.target.value)}
            />
          </div>
        )}
      </HrCard>

      {/* The personnel directory is a CONVENIENCE here: the register's own read carries the
          employee code, so a failure to read names/filters degrades the screen instead of
          breaking it — and it is stated rather than silently ignored. */}
      {canReadEmployees && isEmployeeReadFailed && (
        <HrNotice
          tone="error"
          message="فهرست کارکنان خوانده نشد؛ فیلتر کارمند و پیوند پرونده در دسترس نیست."
        />
      )}

      <HrCard testId="hr-attendance-results">
        {error && status === 403 ? (
          // A 403 is a missing grant, so a retry button could never succeed.
          <CoreForbidden />
        ) : error ? (
          <CoreError message={error} onRetry={reload} />
        ) : isLoading ? (
          <CoreLoading lines={6} />
        ) : items.length === 0 ? (
          <CoreEmpty
            message={hasFilters ? 'پانچی با این فیلترها یافت نشد.' : 'هنوز پانچی ثبت نشده است.'}
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[52rem] text-right" data-testid="hr-attendance-table">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">روز (شمسی)</th>
                  <th className="px-4 py-3 font-medium">روز هفته</th>
                  <th className="px-4 py-3 font-medium">تاریخ (میلادی)</th>
                  <th className="px-4 py-3 font-medium">کارمند</th>
                  <th className="px-4 py-3 font-medium">منبع</th>
                  <th className="px-4 py-3 font-medium">ورود</th>
                  <th className="px-4 py-3 font-medium">خروج</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <AttendanceRow key={row.id} row={row} canLinkEmployee={canReadEmployees} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </HrCard>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" data-testid="hr-attendance-total">
          {/* The SERVER's total for the current query — never a count of the rows on
              screen, which would report «۲۰» for a tenant-wide register. */}
          {total.toLocaleString('fa-IR')} پانچ
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="hr-attendance-prev"
            disabled={query.page <= 1 || isLoading}
            onClick={() => {
              // Always moves `page` down (the button is disabled at page 1),
              // so the effect refires — arm in the same commit.
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
            data-testid="hr-attendance-next"
            disabled={query.page >= pageCount || isLoading}
            onClick={() => {
              // Same: always moves `page` up, so the effect refires.
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
    </div>
  );
}
