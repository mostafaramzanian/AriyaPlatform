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
 * Phase 51-HR-2F: the Personnel Traffic Report — `/admin/hr/traffic-report`.
 *
 * WHY THIS IS A SECOND SCREEN RATHER THAN A SECOND REGISTER
 * --------------------------------------------------------
 * `/admin/hr/attendance` is the OPERATIONAL register: every date shape the contract offers,
 * including «همه روزها», read row by row. This screen answers the other question an
 * administrator asks — "what traffic did we record for this person / this source / this
 * window" — and it makes two choices the register deliberately does not, because a report is
 * read as an aggregate:
 *
 *   * THE WINDOW IS ALWAYS BOUNDED. There is no «همه روزها» mode here. The report runs on ONE
 *     Jalali day (converted once by the SERVER, exactly as the register's day view) or on a
 *     Gregorian از/تا pair — and in range mode it issues NO request until BOTH bounds are
 *     present. An unbounded scan is therefore not a slow query this screen sometimes
 *     performs; it is a request this screen cannot build.
 *   * THE PAGE SIZE IS THE CONSTANT (`HR_DEFAULT_PAGE_SIZE`), never operator-chosen: a report
 *     that could ask for 500 rows is a page of a different kind, and this phase adds none.
 *
 * NO NEW ENDPOINT, AND WHY THAT IS THE API DECISION RATHER THAN AN OMISSION
 * -----------------------------------------------------------------------
 * `GET /hr/attendance` already IS the report's read: inclusive `from`/`to` bounds on the
 * indexed `work_date` column, `employeeId`, `source`, `search` over the employee's code,
 * `page`/`pageSize`, and a SERVER-COMPUTED `total`. `AttendanceRepository.listPage` issues
 * both statements in ONE `$transaction`, so a page costs two queries and never one per row:
 * there is no N+1 here to avoid, and no per-row follow-up read.
 *
 * A dedicated `/hr/attendance/report` or `/hr/attendance/summary` route would exist only to
 * serve this screen's tiles — and the tiles are exactly where this schema cannot answer
 * honestly. `Attendance` stores the punch window and NOTHING derived, so there is no stored
 * `status`, `lateMinutes`, `overtimeMinutes` or leave for a summary endpoint to count. A
 * summary that produced them would be the fabricated metric the phase brief and §13 forbid.
 * The one aggregate a reader actually needs — how many records the filter matches — is
 * already the `total` this screen renders, and the database computed it over the WHOLE
 * filtered set rather than over the page in hand.
 *
 * WHAT THE TILES SHOW, AND WHAT THEY MAY NEVER SHOW
 * ------------------------------------------------
 *   * «رکورد مطابق فیلتر» — the server's `total` for the CURRENT query, never a count of the
 *     rows on screen.
 *   * «کارکنان در این صفحه» — the distinct employees among the rows THIS PAGE holds. It is a
 *     statement about the payload and is labelled as one: it is NOT a headcount, and no
 *     tenant-wide "how many people worked" figure is derivable here or displayed.
 *   * «صفحه» and «بازه پرس‌وجو» — pagination, and the bound actually sent to the server.
 *   * NOT SHOWN, because no server computed them: حاضر/غایب/تأخیر, مرخصی, اضافه‌کار, درصد
 *     حضور. The scope note under the heading STATES the omission, because a reader who
 *     expects those columns deserves to be told they are absent rather than shown a
 *     plausible number.
 *
 * AND THE RULE THAT MATTERS MOST: A MISSING ROW IS NOT AN ABSENCE. The register holds the
 * days that were RECORDED. An employee with no row in this window is not thereby absent —
 * they may be on leave, on a mission, or simply not covered by a device yet. Nothing here
 * turns the absence of a record into a claim about a person, and no count is expressed as a
 * rate over a headcount.
 *
 * PERMISSIONS, EXACTLY THE READ THE ROUTE ENFORCES: `hr.attendance.read` gates the report
 * itself — the same read `AttendanceController.list` enforces, seeded in core_db — and
 * `hr.employees.read` gates ONLY the two conveniences that need the personnel directory (the
 * employee filter and the link from a row to its personnel file). Without the second read the
 * report still renders in full and issues no request that would 403.
 */

const ATTENDANCE_READ = 'hr.attendance.read';
const EMPLOYEES_READ = 'hr.employees.read';

/** Typing does not fire one request per keystroke (the register's own debounce, restated). */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * The report's date slot. TWO shapes, never three: the API refuses `dateKey` together with
 * `from`/`to`, and this screen has no unbounded shape to fall back to.
 */
type DateMode = 'day' | 'range';

interface Filters {
  search: string;
  employeeId: string;
  source: '' | HrAttendanceSource;
  dateKey: string;
  from: string;
  to: string;
}

interface Query {
  filters: Filters;
  dateMode: DateMode;
  page: number;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  employeeId: '',
  source: '',
  dateKey: '',
  from: '',
  to: '',
};

/** The report opens on ONE day, and seeds that day from the SERVER's own today. */
const EMPTY_QUERY: Query = { filters: EMPTY_FILTERS, dateMode: 'day', page: 1 };

/** A blank filter is OMITTED rather than sent empty — the API validates a PRESENT value. */
function orUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/** `''` is «همه منابع»: the parameter is absent, not empty. */
function sourceParam(value: '' | HrAttendanceSource): HrAttendanceSource | undefined {
  return value === '' ? undefined : value;
}

/**
 * One summary tile.
 *
 * Every value handed to it is either a number the SERVER computed (`total`) or a fact about
 * the request this screen sent (the page, the window). Nothing here derives an attendance
 * metric, which is why `hint` is not decoration: it names WHAT the number counts, so a reader
 * cannot mistake «کارکنان در این صفحه» for a headcount.
 */
function SummaryTile({
  testId,
  label,
  value,
  hint,
}: {
  testId: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className="mt-1 text-lg font-medium tabular-nums text-foreground"
        data-testid={`${testId}-value`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * One report row. Every cell is a value the API sent, or a FORMAT of one.
 *
 * THE RAW INSTANTS ARE IN THE DOM: each punch cell carries the exact ISO string the API
 * returned in its `title`, while the text is that same moment rendered as `HH:mm`. The screen
 * is therefore legible AND auditable — a reader who wants the instant the device recorded does
 * not have to trust the formatting, exactly as on the register.
 */
function TrafficRow({ row, canLinkEmployee }: { row: HrAttendance; canLinkEmployee: boolean }) {
  return (
    <tr className="border-t border-border" data-testid={`hr-traffic-row-${row.id}`}>
      <td className="px-4 py-3 text-sm text-foreground" data-testid={`hr-traffic-day-${row.id}`}>
        {/* The SERVER's Jalali day, in Persian digits. No conversion happens here. */}
        {hrAttendanceDayLabel(row.dateKey)}
      </td>
      <td
        className="px-4 py-3 text-sm text-muted-foreground"
        data-testid={`hr-traffic-weekday-${row.id}`}
      >
        {/* The weekday OF `workDate` — read off the date the API sent, never off today. */}
        {hrWeekdayLabel(row.workDate)}
      </td>
      <td
        className="px-4 py-3 font-mono text-xs text-muted-foreground"
        data-testid={`hr-traffic-workdate-${row.id}`}
      >
        {/* `YYYY-MM-DD` — a DATE, printed exactly as the API sent it. */}
        {row.workDate}
      </td>
      <td className="px-4 py-3 text-sm">
        {canLinkEmployee ? (
          <Link
            href={`/admin/hr/employees/${row.employee.id}`}
            className="text-primary hover:underline"
            data-testid={`hr-traffic-employee-${row.employee.employeeCode}`}
          >
            {row.employee.employeeCode}
          </Link>
        ) : (
          <span data-testid={`hr-traffic-employee-${row.employee.employeeCode}`}>
            {row.employee.employeeCode}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <HrBadge tone={hrAttendanceSourceTone(row.source)} testId={`hr-traffic-source-${row.id}`}>
          {hrAttendanceSourceLabel(row.source)}
        </HrBadge>
        {/* A correction states WHY, and that reason is the row's own field. */}
        {row.reason && (
          <p
            className="mt-1 max-w-xs text-xs text-muted-foreground"
            data-testid={`hr-traffic-reason-${row.id}`}
          >
            {row.reason}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-foreground">
        <span title={row.clockIn} data-testid={`hr-traffic-in-${row.id}`}>
          {hrInstantTimeLabel(row.clockIn)}
        </span>
      </td>
      <td className="px-4 py-3 text-sm">
        {row.clockOut ? (
          <span
            className="tabular-nums text-foreground"
            title={row.clockOut}
            data-testid={`hr-traffic-out-${row.id}`}
          >
            {hrInstantTimeLabel(row.clockOut)}
          </span>
        ) : (
          // `null` is a STATE — the day is still open — so it is a word, not an em dash that
          // would read as "no data".
          <HrBadge tone="muted" testId={`hr-traffic-open-${row.id}`}>
            باز
          </HrBadge>
        )}
      </td>
    </tr>
  );
}

export function HrTrafficReportView() {
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
  // Re-arms loading/cleared/error-status in the retry and in the query-change
  // adjustments below (same commit as the bump), so the report effect needs
  // no in-effect setter reset. First mount is covered by `isLoading: true`.
  const { token: reloadToken, reload: reloadReport } = useReloadToken(setLoading, setError);

  const [employees, setEmployees] = React.useState<HrEmployee[]>([]);
  const [isEmployeeReadFailed, setEmployeeReadFailed] = React.useState(false);
  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const [isDayPickerOpen, setDayPickerOpen] = React.useState(false);

  const reload = React.useCallback(() => {
    reloadReport();
    setStatus(null);
  }, [reloadReport]);

  /** A filter change is a NEW query, never a new page of the old one. */
  const applyFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    // A no-op write would still mint a fresh `query` identity without changing
    // any field; only a real change arms — the render adjustment below covers
    // any incidental page reset it carries (page → 1) as well.
    if (query.filters[key] !== value) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }
    setQuery((prev) => ({ ...prev, filters: { ...prev.filters, [key]: value }, page: 1 }));
  };

  // A query change is a NEW read: re-arm in the same commit the change
  // commits. The comparison is field-wise — the debounce path and the day
  // seed mint fresh objects even for no-op changes, and arming without a
  // following fetch would strand the spinner. The fields mirror the report
  // effect's dependency list (the `hasQuery`/`mode` terms included), and that
  // effect early-returns without touching state, so no arm is needed for the
  // gate transition. The debounce and seed paths change `query` outside any
  // event handler, so no handler could arm them there.
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

  // The SERVER's today seeds the default window during render (guarded by the
  // previous value — `react-hooks/set-state-in-effect` bars the effect-body
  // setter the seed used to be). Mount (today null → null) is a no-op, and an
  // operator who CLEARS the day is still not re-filled: the guard checks the
  // empty-window condition exactly as the old effect did, once per arrival.
  const [prevToday, setPrevToday] = React.useState(today);
  if (prevToday !== today) {
    setPrevToday(today);
    if (today && query.dateMode === 'day' && query.filters.dateKey.length === 0) {
      setQuery((prev) => ({
        ...prev,
        filters: { ...prev.filters, dateKey: today.date },
      }));
    }
  }

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

  // The SERVER's today. It is the report's default window AND the month the Jalali grid opens
  // on, and NO client clock stands in for it: a report that guessed "today" would quietly
  // report on a day the server does not call today.
  React.useEffect(() => {
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
  }, []);

  /**
   * Seed the default window ONCE, and only while the operator has not chosen a day. An
   * operator who CLEARS the day keeps an empty day and gets the "choose a window" state
   * rather than this effect quietly re-filling it.
   */
  // (The day seed rides the render adjustment above: the operator who CLEARS
  // the day is not re-filled — its guard is the seed's own empty-window test.)

  // The personnel directory, for the OPTIONAL filter and the row links. NO request without the
  // read it needs: a picker that 403s is worse than one that is absent. A failure here degrades
  // to "no filter and no links" — the report itself is unaffected, which is the whole point of
  // keeping the two reads separate.
  React.useEffect(() => {
    if (isPermissionsLoading || !canReadEmployees) return;

    let active = true;

    fetchHrEmployees({ pageSize: HR_MAX_PAGE_SIZE })
      .then((result) => {
        if (active) setEmployees(result.items);
      })
      .catch(() => {
        if (active) setEmployeeReadFailed(true);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canReadEmployees]);

  const mode = query.dateMode;
  const isDayChosen = query.filters.dateKey.length > 0;
  const isRangeComplete = query.filters.from.length > 0 && query.filters.to.length > 0;
  const isRangeInverted = isRangeComplete && query.filters.from > query.filters.to;

  /**
   * THE BOUNDED-WINDOW RULE, AS A VALUE THE SCREEN CANNOT BYPASS: a day is a window, and a
   * range is a window only once BOTH bounds are present AND in order. While this is false no
   * request is issued at all — so «همه روزها» is not a slow query this report sometimes
   * performs; it is a request this report cannot build.
   */
  const hasQuery = mode === 'day' ? isDayChosen : isRangeComplete && !isRangeInverted;

  /**
   * TRUE ONLY WHEN THE SERVER HAS ANSWERED FOR THE QUERY CURRENTLY ON SCREEN.
   *
   * The tiles below are a reading OF AN ANSWER: the count is the server's `total` and the
   * page count is derived from it. While the read is in flight — or after it failed — there
   * is no such answer, so `total` is not a number this screen may show. Gating the tiles on
   * this flag is the same rule the window-required state applies to an unchosen window: a
   * «۰ رکورد» rendered before the server spoke is a number this screen invented.
   */
  const hasAnswer = !isLoading && !error;

  React.useEffect(() => {
    if (isPermissionsLoading || !canRead || !hasQuery) return;

    let active = true;

    fetchHrAttendance({
      search: orUndefined(query.filters.search.trim()),
      employeeId: orUndefined(query.filters.employeeId),
      source: sourceParam(query.filters.source),
      // EXACTLY ONE date shape, chosen by the mode. The two are mutually exclusive by
      // construction, so the API's 400 for sending both cannot be reached from this screen.
      ...(mode === 'day'
        ? { dateKey: query.filters.dateKey }
        : { from: query.filters.from, to: query.filters.to }),
      page: query.page,
      pageSize: HR_DEFAULT_PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setError(null);
        setStatus(null);
        setLoading(false);
      })
      .catch((failure) => {
        if (!active) return;
        setItems([]);
        setTotal(0);
        setStatus(failure instanceof CoreApiError ? failure.status : null);
        setError(
          failure instanceof CoreApiError ? failure.message : 'خواندن گزارش رفت‌وآمد ناموفق بود.'
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    isPermissionsLoading,
    canRead,
    hasQuery,
    mode,
    query.filters.search,
    query.filters.employeeId,
    query.filters.source,
    query.filters.dateKey,
    query.filters.from,
    query.filters.to,
    query.page,
    reloadToken,
  ]);

  // The server's `total` divided by the page size THIS screen asked for — never a count of the
  // rows on screen, which would report «۲۰» for a tenant-wide filter.
  const pageCount = Math.max(1, Math.ceil(total / HR_DEFAULT_PAGE_SIZE));

  /**
   * The distinct employees among the rows THIS PAGE holds. It is derived from the payload and
   * labelled as exactly that: it is NOT a headcount, and neither a tenant-wide figure nor a
   * rate over a headcount can be read from it.
   */
  const employeesOnPage = React.useMemo(
    () => new Set(items.map((row) => row.employeeId)).size,
    [items]
  );

  const hasExtraFilters =
    query.filters.search.trim().length > 0 ||
    query.filters.employeeId.length > 0 ||
    query.filters.source.length > 0;

  /** The bound THIS screen actually sent — a fact about the request, not a derived metric. */
  const windowLabel =
    mode === 'day'
      ? `${hrAttendanceDayLabel(query.filters.dateKey)} (شمسی)`
      : `${query.filters.from} تا ${query.filters.to} (میلادی)`;

  const sourceOptions: SelectOption[] = [
    { value: '', label: 'همه منابع' },
    ...HR_ATTENDANCE_SOURCES.map((source) => ({
      value: source,
      label: hrAttendanceSourceLabel(source),
    })),
  ];

  // TWO options, because there are two BOUNDED shapes. A third («همه روزها») would be exactly
  // the unbounded request this screen exists without.
  const dateModeOptions: SelectOption[] = [
    { value: 'day', label: 'یک روز (شمسی)' },
    { value: 'range', label: 'بازه میلادی (از/تا)' },
  ];

  /**
   * The employee filter's options, from the REAL personnel read.
   *
   * A name is shown BESIDE the code because this list is a directory projection, not the
   * report: the report's own rows carry the CODE alone (its read never reaches Core identity),
   * and this screen deliberately does not join the two — a name known for the first hundred
   * employees and missing for the rest would be a label that is sometimes right, which is worse
   * than one that is always the employee's own code.
   */
  const employeeFilterOptions: SelectOption[] = [
    { value: '', label: 'همه کارکنان' },
    ...employees.map((employee) => ({
      value: employee.id,
      label: `${employee.employeeCode} — ${hrDisplayName(employee.identity, employee.employeeCode)}`,
    })),
  ];

  /**
   * Switching the SHAPE of the date slot clears the other shape, because the contract refuses
   * `dateKey` together with `from`/`to`. Request-shape bookkeeping rather than a business rule:
   * the screen is choosing which of the API's two BOUNDED filters it is asking with, and it
   * makes that choice visible instead of hiding it inside a builder.
   */
  const handleDateMode = (next: DateMode) => {
    // Re-selecting the current shape is a no-op — no arm, no fetch.
    if (next !== query.dateMode) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }

    const clearsDay = next !== 'day';
    const clearsRange = next !== 'range';

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
   * The month the Jalali picker opens on: the value already chosen, else the SERVER's today.
   * The fallback is the same shape `CorrLetterList` uses — a starting month for a grid that is
   * fetched anyway — and it is never a source of a Jalali date: the grid and the day it returns
   * both come from `GET /calendar/month`.
   */
  const pickerInitialMonth = React.useMemo(() => {
    if (query.filters.dateKey) {
      const parsed = parseDateKey(query.filters.dateKey);
      if (parsed) return { jy: parsed.jy, jm: parsed.jm };
    }
    if (today) return { jy: today.jy, jm: today.jm };
    return { jy: 1405, jm: 1 };
  }, [query.filters.dateKey, today]);

  /**
   * Why NO request is running, said as a state rather than as an empty result: a report that
   * rendered «۰ رکورد» for a window nobody chose would be reporting a fact it does not have.
   */
  let windowPrompt = 'برای اجرای گزارش هر دو تاریخ «از» و «تا» را انتخاب کنید.';
  if (mode === 'day') {
    windowPrompt = 'برای اجرای گزارش یک روز شمسی انتخاب کنید.';
  } else if (isRangeInverted) {
    windowPrompt = 'بازه را اصلاح کنید: تاریخ «از» بعد از تاریخ «تا» است.';
  }

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهده گزارش رفت‌وآمد پرسنل به مجوز hr.attendance.read نیاز دارید." />
    );
  }

  return (
    <div data-testid="hr-traffic-report">
      <HrPageHeading
        title="گزارش رفت‌وآمد پرسنل"
        description="خواندنی و بدون اثر: گزارش رکوردهای ثبت‌شده حضور و غیاب در یک بازه محدود"
      />

      <p className="mb-4 text-xs text-muted-foreground" data-testid="hr-traffic-scope">
        این گزارش فقط رکوردهای ثبت‌شده دفتر حضور و غیاب را می‌خواند و همیشه در یک بازه محدود اجرا
        می‌شود. وضعیت محاسبه‌شده (حاضر، غایب، تأخیر)، مرخصی، اضافهکار و درصد حضور در این مرحله وجود
        ندارد و نمایش داده نمی‌شود؛ نبودِ رکورد برای یک روز هم به معنای غیبت نیست. خروجی‌گرفتن در
        این مرحله ارائه نمی‌شود.
      </p>

      <HrCard title="فیلترها" testId="hr-traffic-filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            id="hr-traffic-search"
            name="search"
            label="کد کارمند"
            value={searchInput}
            placeholder="مثلاً E-1042"
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Select
            id="hr-traffic-source"
            name="source"
            label="منبع"
            value={query.filters.source}
            options={sourceOptions}
            onChange={(event) =>
              applyFilter('source', event.target.value as HrAttendanceSource | '')
            }
          />
          {/* Only offered with the read it needs: without `hr.employees.read` the report still
              renders in full, and no request that would 403 is ever issued. */}
          {canReadEmployees && (
            <Select
              id="hr-traffic-employee"
              name="employeeFilter"
              label="کارمند"
              value={query.filters.employeeId}
              options={employeeFilterOptions}
              onChange={(event) => applyFilter('employeeId', event.target.value)}
            />
          )}
          <Select
            id="hr-traffic-date-mode"
            name="dateMode"
            label="بازه زمانی"
            value={mode}
            options={dateModeOptions}
            onChange={(event) => handleDateMode(event.target.value as DateMode)}
          />
        </div>

        {/* ── The date slot ────────────────────────────────────────────────────────────
            ONE BOUNDED SHAPE AT A TIME, because the contract refuses `dateKey` together with
            `from`/`to` — and because this screen has no unbounded shape to offer.

            NOTHING HERE FILTERS CLIENT-SIDE. Every control becomes a query parameter and the
            rows below are always what the server returned for it: a client-side filter over
            one page of a tenant-wide register would say «بدون رکورد» about a day that simply
            was not in the page. */}

        {mode === 'day' && (
          <div className="relative mt-4" data-testid="hr-traffic-day-filter">
            <div className="mb-2 text-sm font-medium text-foreground" id="hr-traffic-day-label">
              روز شمسی
            </div>
            <button
              type="button"
              data-testid="hr-traffic-day-open"
              aria-expanded={isDayPickerOpen}
              aria-labelledby="hr-traffic-day-label hr-traffic-day-value"
              onClick={() => setDayPickerOpen((open) => !open)}
              className={cn(
                'inline-flex h-11 w-full items-center gap-2 rounded-xl border bg-secondary/60 px-3 text-sm text-foreground',
                'hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate text-right" id="hr-traffic-day-value">
                {query.filters.dateKey ? (
                  hrAttendanceDayLabel(query.filters.dateKey)
                ) : (
                  <span className="text-muted-foreground">انتخاب روز</span>
                )}
              </span>
            </button>
            <DropdownPanel open={isDayPickerOpen} className="absolute z-50 mt-2 w-80 rounded-2xl border border-border bg-popover p-3 shadow-elevated">
                {/* The grid is the SERVER's (`/calendar/month`). Until it answers there is no
                    calendar on screen rather than one the client guessed — and no Jalali
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
          <div className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="hr-traffic-range-filter">
            {/* Gregorian `YYYY-MM-DD`, the SAME wire format `work_date` stores and indexes. No
                conversion: the value the control holds is the value the API receives. */}
            <Input
              id="hr-traffic-from"
              name="from"
              type="date"
              label="از تاریخ (میلادی)"
              value={query.filters.from}
              onChange={(event) => applyFilter('from', event.target.value)}
            />
            <Input
              id="hr-traffic-to"
              name="to"
              type="date"
              label="تا تاریخ (میلادی)"
              value={query.filters.to}
              onChange={(event) => applyFilter('to', event.target.value)}
            />
            <p className="text-xs text-muted-foreground sm:col-span-2">
              گزارش فقط با هر دو تاریخ اجرا می‌شود؛ بازه باز یا بدون مرز اجرا نمی‌شود.
            </p>
          </div>
        )}
      </HrCard>

      {/* The personnel directory is a CONVENIENCE here: the report's own read carries the
          employee code, so a failure to read names/filters degrades the screen instead of
          breaking it — and it is stated rather than silently ignored. */}
      {canReadEmployees && isEmployeeReadFailed && (
        <HrNotice
          tone="error"
          message="فهرست کارکنان خوانده نشد؛ فیلتر کارمند و پیوند پرونده در دسترس نیست."
        />
      )}

      {!hasQuery ? (
        <HrCard title="بازه گزارش" testId="hr-traffic-window-required">
          {/* NO TILE AND NO COUNT HERE. With no window chosen there is nothing the server could
              have counted, so «۰ رکورد» would be a number this screen invented — the state is
              stated in words instead. */}
          <CoreEmpty message={windowPrompt} />
        </HrCard>
      ) : (
        <>
          {/* THE TILES ARE PART OF THE ANSWER, NOT PART OF THE QUESTION. Until the server has
              answered there is no count and no page to report, so a tile reading «۰ رکورد»
              for a read that is still in flight would be a number this screen invented — the
              same failure the "no window chosen" state above refuses in words. The tiles
              therefore appear WITH the answer: while the read is running, the results card
              below owns the single loading state, and after a failure they are absent rather
              than left showing the previous window's numbers. */}
          {hasAnswer && (
            <div
              className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              data-testid="hr-traffic-summary"
            >
              <SummaryTile
                testId="hr-traffic-total"
                label="رکورد مطابق فیلتر"
                value={total.toLocaleString('fa-IR')}
                hint="شمارش سمت سرور برای همین فیلتر"
              />
              <SummaryTile
                testId="hr-traffic-employees"
                label="کارکنان در این صفحه"
                value={employeesOnPage.toLocaleString('fa-IR')}
                hint="فقط رکوردهای همین صفحه، نه فهرست کارکنان"
              />
              <SummaryTile
                testId="hr-traffic-page"
                label="صفحه"
                value={`${query.page.toLocaleString('fa-IR')} از ${pageCount.toLocaleString('fa-IR')}`}
                hint="بر پایه شمارش سرور"
              />
              <SummaryTile
                testId="hr-traffic-window"
                label="بازه پرس‌وجو"
                value={windowLabel}
                hint="همان مرزی که به سرور فرستاده شد"
              />
            </div>
          )}

          <HrCard testId="hr-traffic-results">
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
                  hasExtraFilters
                    ? 'در این بازه با این فیلترها رکوردی یافت نشد.'
                    : 'در این بازه رکوردی ثبت نشده است.'
                }
              />
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border bg-card">
                <table className="w-full min-w-[52rem] text-right" data-testid="hr-traffic-table">
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
                      <TrafficRow key={row.id} row={row} canLinkEmployee={canReadEmployees} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </HrCard>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted-foreground" data-testid="hr-traffic-total-line">
              {/* The SERVER's total for the current query — never a count of the rows on screen. */}
              {total.toLocaleString('fa-IR')} رکورد در این بازه
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                data-testid="hr-traffic-prev"
                disabled={query.page <= 1 || isLoading}
                onClick={() => {
                  // Always moves `page` down (disabled at page 1), so the
                  // report effect refires — arm in the same commit.
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
                data-testid="hr-traffic-next"
                disabled={query.page >= pageCount || isLoading}
                onClick={() => {
                  // Same: always moves `page` up, so the report effect refires.
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
        </>
      )}
    </div>
  );
}
