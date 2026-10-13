'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import {
  HR_DEFAULT_PAGE_SIZE,
  HR_EMPLOYMENT_TYPES,
  HR_MAX_PAGE_SIZE,
  createHrEmployee,
  fetchHrEmployees,
  fetchHrPositions,
  fetchHrUnits,
  hrDateLabel,
  hrDisplayName,
  hrEmployeeStatusLabel,
  hrEmploymentTypeLabel,
  type HrEmployee,
  type HrEmployeeStatus,
  type HrEmploymentType,
  type HrOrganizationUnit,
  type HrPosition,
} from '@/lib/hr-api';
import { HrCard, HrEmployeeStatusBadge, HrNotice, HrPageHeading } from './hr-ui';

/**
 * Phase 51-HR-2: the personnel directory — `/admin/hr/employees`.
 *
 * FOUR PERMISSIONS DECIDE WHAT THIS SCREEN OFFERS, AND EACH ONE IS THE STRING THE BACKEND
 * ACTUALLY ENFORCES:
 *
 *   * `hr.employees.read`      — the directory itself (`GET /hr/employees`);
 *   * `hr.employees.manage`    — the create form (`POST /hr/employees`);
 *   * `hr.organization.read`   — the unit picker/filter (`GET /hr/organization/units`);
 *   * `hr.positions.read`      — the position picker/filter (`GET /hr/positions`).
 *
 * The last two are NOT decoration: an employee CANNOT be created without a unit and a
 * position (the backend requires both on the first interval), so an HR manager who holds
 * `manage` but cannot read the catalogues is told that plainly instead of being shown a
 * form whose dropdowns are empty. No request is issued for a permission the caller lacks —
 * it would be a guaranteed 403 and would surface as a broken picker.
 *
 * NOTHING IS SENT THAT THE API DOES NOT DECLARE. There is no `tenantId` in the filters, no
 * `tenantId`/`id`/actor field in the create payload, and `status` on create is one of the two
 * MANUAL statuses. `TERMINATED` is not reachable from this screen at all: employment ends
 * through the termination action on the personnel file, which closes the open interval on a
 * chosen date.
 */

const EMPLOYEES_READ = 'hr.employees.read';
const EMPLOYEES_MANAGE = 'hr.employees.manage';
const ORGANIZATION_READ = 'hr.organization.read';
const POSITIONS_READ = 'hr.positions.read';

const SEARCH_DEBOUNCE_MS = 350;

interface Filters {
  search: string;
  status: HrEmployeeStatus | '';
  organizationUnitId: string;
  positionId: string;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  status: '',
  organizationUnitId: '',
  positionId: '',
};

interface CreateForm {
  employeeCode: string;
  employmentType: HrEmploymentType;
  startDate: string;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string;
  userId: string;
}

const EMPTY_CREATE_FORM: CreateForm = {
  employeeCode: '',
  employmentType: 'FULL_TIME',
  startDate: '',
  organizationUnitId: '',
  positionId: '',
  managerEmployeeId: '',
  userId: '',
};

/** A blank select value means "no filter", which the query builder then omits entirely. */
function orUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/** `YYYY-MM-DD` in Latin digits — the only date shape this API accepts. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One directory row. The current assignment comes from the API's DERIVED projection, so
 * this screen never reads a unit or a position off the employee record itself.
 */
function EmployeeRow({ employee }: { employee: HrEmployee }) {
  const assignment = employee.currentAssignment;
  const name = hrDisplayName(employee.identity, employee.employeeCode);

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-3 align-top">
        <Link
          href={`/admin/hr/employees/${employee.id}`}
          className="font-medium text-foreground hover:text-primary"
          data-testid={`hr-employee-link-${employee.employeeCode}`}
        >
          {name}
        </Link>
        <div className="mt-0.5 text-xs text-muted-foreground">{employee.employeeCode}</div>
      </td>
      <td className="px-4 py-3 align-top">
        <HrEmployeeStatusBadge status={employee.status} />
      </td>
      <td className="px-4 py-3 align-top text-sm">{assignment?.organizationUnit?.name ?? '—'}</td>
      <td className="px-4 py-3 align-top text-sm">{assignment?.position?.title ?? '—'}</td>
      <td className="px-4 py-3 align-top text-sm">
        {assignment ? hrDateLabel(assignment.startDate) : '—'}
      </td>
      <td className="px-4 py-3 align-top text-sm">
        {/* The Core login link is OPTIONAL state, not an error — the wording says so. */}
        {employee.identity ? 'متصل' : 'بدون حساب کاربری'}
      </td>
    </tr>
  );
}

/**
 * A UUID check that runs BEFORE the request, so a bad `userId` / `managerEmployeeId` is a
 * sentence in the form instead of a 400 from the global validation pipe.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The create form.
 *
 * `startDate` is entered as `YYYY-MM-DD` rather than through the Jalali picker on purpose:
 * the picker is driven by the SERVER's calendar (`GET /calendar/month`), and coupling a
 * request field to a second remote read would make the form unsubmittable whenever that
 * read is unavailable. The label states the required shape and the value is checked here
 * against the same pattern the backend uses, so the round trip is not spent discovering it.
 */
function CreateEmployeeForm({
  units,
  positions,
  isSaving,
  error,
  onCancel,
  onSubmit,
}: {
  units: HrOrganizationUnit[];
  positions: HrPosition[];
  isSaving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: CreateForm) => void;
}) {
  const [form, setForm] = React.useState<CreateForm>(EMPTY_CREATE_FORM);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const unitOptions: SelectOption[] = [
    { value: '', label: 'انتخاب واحد سازمانی' },
    ...units.map((unit) => ({ value: unit.id, label: `${unit.name} (${unit.code})` })),
  ];

  // A position belongs to exactly one unit, so the second dropdown offers only the slots
  // that live in the selected unit — a mismatch is refused by the backend anyway.
  const positionOptions: SelectOption[] = [
    { value: '', label: 'انتخاب سمت' },
    ...positions
      .filter(
        (position) =>
          !form.organizationUnitId || position.organizationUnitId === form.organizationUnitId,
      )
      .map((position) => ({ value: position.id, label: `${position.title} (${position.code})` })),
  ];

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    const employeeCode = form.employeeCode.trim();
    const startDate = form.startDate.trim();
    const userId = form.userId.trim();
    const managerEmployeeId = form.managerEmployeeId.trim();

    if (employeeCode.length === 0) {
      setLocalError('کد پرسنلی الزامی است.');
      return;
    }
    if (!ISO_DATE_PATTERN.test(startDate)) {
      setLocalError('تاریخ شروع باید به شکل YYYY-MM-DD باشد؛ نمونه: 2026-03-01');
      return;
    }
    if (form.organizationUnitId.length === 0 || form.positionId.length === 0) {
      setLocalError('واحد سازمانی و سمت برای نخستین بازه استخدامی الزامی هستند.');
      return;
    }
    if (userId.length > 0 && !UUID_PATTERN.test(userId)) {
      setLocalError('شناسه کاربری هسته باید یک UUID باشد.');
      return;
    }
    if (managerEmployeeId.length > 0 && !UUID_PATTERN.test(managerEmployeeId)) {
      setLocalError('شناسه کارمند مدیر باید یک UUID باشد.');
      return;
    }

    setLocalError(null);
    onSubmit({ employeeCode, startDate, userId, managerEmployeeId, employmentType: form.employmentType, organizationUnitId: form.organizationUnitId, positionId: form.positionId });
  };

  return (
    <div data-testid="hr-employee-create-form">
      <HrCard>
        <form onSubmit={submit} className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">افزودن کارمند</h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="hr-employee-code"
              name="employeeCode"
              label="کد پرسنلی"
              required
              value={form.employeeCode}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, employeeCode: event.target.value }))
              }
            />
            <Select
              id="hr-employee-type"
              name="employmentType"
              label="نوع استخدام"
              value={form.employmentType}
              options={HR_EMPLOYMENT_TYPES.map((type) => ({
                value: type,
                label: hrEmploymentTypeLabel(type),
              }))}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  employmentType: event.target.value as HrEmploymentType,
                }))
              }
            />
            <Input
              id="hr-employee-start-date"
              name="startDate"
              label="تاریخ شروع (YYYY-MM-DD)"
              required
              placeholder="2026-03-01"
              value={form.startDate}
              onChange={(event) => setForm((prev) => ({ ...prev, startDate: event.target.value }))}
            />
            <Input
              id="hr-employee-user-id"
              name="userId"
              label="شناسه کاربری هسته (اختیاری)"
              value={form.userId}
              onChange={(event) => setForm((prev) => ({ ...prev, userId: event.target.value }))}
            />
            <Select
              id="hr-employee-unit"
              name="organizationUnitId"
              label="واحد سازمانی"
              required
              value={form.organizationUnitId}
              options={unitOptions}
              // Changing the unit clears the position: the previously chosen slot may
              // belong to the unit that was just deselected.
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  organizationUnitId: event.target.value,
                  positionId: '',
                }))
              }
            />
            <Select
              id="hr-employee-position"
              name="positionId"
              label="سمت"
              required
              value={form.positionId}
              options={positionOptions}
              onChange={(event) => setForm((prev) => ({ ...prev, positionId: event.target.value }))}
            />
            <Input
              id="hr-employee-manager"
              name="managerEmployeeId"
              label="شناسه کارمند مدیر (اختیاری)"
              value={form.managerEmployeeId}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, managerEmployeeId: event.target.value }))
              }
            />
          </div>

          {(localError ?? error) && <HrNotice tone="error" message={localError ?? error ?? ''} />}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={isSaving} data-testid="hr-employee-create-submit">
              {isSaving ? 'در حال ذخیره...' : 'ذخیره'}
            </Button>
            <Button
              type="button"
              onClick={onCancel}
              disabled={isSaving}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </form>
      </HrCard>
    </div>
  );
}
/**
 * The personnel directory.
 *
 * FILTER CHANGES AND PAGE CHANGES ARE ONE PIECE OF STATE (`query`). Keeping the page
 * number in a separate `useState` is the classic way to fetch page 3 of the PREVIOUS
 * filter while the screen already shows the new one: here, every filter change replaces
 * the whole query and resets the page to 1 in the same update.
 */
export function HrEmployeesView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(EMPLOYEES_READ);
  const canManage = permissions.includes(EMPLOYEES_MANAGE);
  const canReadOrganization = permissions.includes(ORGANIZATION_READ);
  const canReadPositions = permissions.includes(POSITIONS_READ);

  const [query, setQuery] = React.useState<{ filters: Filters; page: number }>({
    filters: EMPTY_FILTERS,
    page: 1,
  });
  const [searchInput, setSearchInput] = React.useState('');

  const [items, setItems] = React.useState<HrEmployee[]>([]);
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
  };

  // A query change is a NEW read: re-arm the register in the same commit the
  // change commits (the removed in-effect setters used to arm one render
  // later). The comparison is field-wise — `applyFilter` and the unit cascade
  // below mint fresh objects even for no-op selects, and arming without a
  // following fetch would strand the spinner. The fields mirror the register
  // effect's dependency list, and that effect early-returns on unsettled
  // permissions without touching state, so no arm is needed for the gate
  // transition. The debounce path changes `query` from a timer (`setQuery`
  // inside `setTimeout`), so no event handler can arm it there, and an
  // effect-body setter is barred by `react-hooks/set-state-in-effect`.
  const [prevQuery, setPrevQuery] = React.useState(query);
  const queryInputsChanged =
    prevQuery.page !== query.page ||
    prevQuery.filters.search !== query.filters.search ||
    prevQuery.filters.status !== query.filters.status ||
    prevQuery.filters.organizationUnitId !== query.filters.organizationUnitId ||
    prevQuery.filters.positionId !== query.filters.positionId;
  if (queryInputsChanged) {
    setPrevQuery(query);
    setLoading(true);
    setError(null);
    setStatus(null);
  }

  const [units, setUnits] = React.useState<HrOrganizationUnit[]>([]);
  const [positions, setPositions] = React.useState<HrPosition[]>([]);

  const [isFormOpen, setFormOpen] = React.useState(false);
  const [isSaving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  /** A filter change is a NEW query, never a new page of the old one. */
  const applyFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    // Arm only when this call actually moves an effect input: a no-op select
    // (same value, fresh object identity) refires nothing and must not strand
    // the spinner. The unconditional `page: 1` below also counts — paging back
    // to the first page IS a new read.
    const willChange = value !== query.filters[key] || query.page !== 1;
    if (willChange) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }
    setQuery((prev) => ({ filters: { ...prev.filters, [key]: value }, page: 1 }));
  };

  // Typing does not fire a request per keystroke.
  React.useEffect(() => {
    const handle = setTimeout(() => {
      setQuery((prev) =>
        prev.filters.search === searchInput
          ? prev
          : { filters: { ...prev.filters, search: searchInput }, page: 1 },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // The catalogues. NO request without the matching read permission: a picker that
  // 403s is worse than a picker that says why it is empty.
  React.useEffect(() => {
    if (isPermissionsLoading) return;

    let active = true;
    const reads: Array<Promise<void>> = [];

    if (canReadOrganization) {
      reads.push(
        fetchHrUnits({ pageSize: HR_MAX_PAGE_SIZE, status: 'ACTIVE' })
          .then((page) => {
            if (active) setUnits(page.items);
          })
          .catch(() => {
            if (active) setUnits([]);
          }),
      );
    }

    if (canReadPositions) {
      reads.push(
        fetchHrPositions({ pageSize: HR_MAX_PAGE_SIZE, status: 'ACTIVE' })
          .then((page) => {
            if (active) setPositions(page.items);
          })
          .catch(() => {
            if (active) setPositions([]);
          }),
      );
    }

    void Promise.all(reads);

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canReadOrganization, canReadPositions, reloadToken]);

  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchHrEmployees({
      search: query.filters.search,
      status: orUndefined(query.filters.status) as HrEmployeeStatus | undefined,
      organizationUnitId: orUndefined(query.filters.organizationUnitId),
      positionId: orUndefined(query.filters.positionId),
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
        setError(err instanceof Error ? err.message : 'دریافت فهرست کارکنان با خطا مواجه شد.');
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
    query.filters.status,
    query.filters.organizationUnitId,
    query.filters.positionId,
    query.page,
    reloadToken,
  ]);

  const handleCreate = (form: CreateForm) => {
    setSaving(true);
    setFormError(null);

    // The payload is EXACTLY the fields the API declares, with `managerEmployeeId` /
    // `userId` OMITTED rather than sent empty — an absent optional field is absence.
    createHrEmployee({
      employeeCode: form.employeeCode,
      employmentType: form.employmentType,
      startDate: form.startDate,
      organizationUnitId: form.organizationUnitId,
      positionId: form.positionId,
      ...(form.managerEmployeeId.length > 0 ? { managerEmployeeId: form.managerEmployeeId } : {}),
      ...(form.userId.length > 0 ? { userId: form.userId } : {}),
    })
      .then((created) => {
        setSaving(false);
        setFormOpen(false);
        setNotice(`پرونده ${created.employeeCode} ثبت شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(err instanceof Error ? err.message : 'ثبت پرونده پرسنلی با خطا مواجه شد.');
      });
  };

  const pageCount = Math.max(1, Math.ceil(total / HR_DEFAULT_PAGE_SIZE));
  const hasFilters =
    query.filters.search.trim().length > 0 ||
    query.filters.status.length > 0 ||
    query.filters.organizationUnitId.length > 0 ||
    query.filters.positionId.length > 0;

  const statusOptions: SelectOption[] = [
    { value: '', label: 'همه وضعیت‌ها' },
    { value: 'ACTIVE', label: hrEmployeeStatusLabel('ACTIVE') },
    { value: 'INACTIVE', label: hrEmployeeStatusLabel('INACTIVE') },
    { value: 'TERMINATED', label: hrEmployeeStatusLabel('TERMINATED') },
  ];

  const unitFilterOptions: SelectOption[] = [
    { value: '', label: 'همه واحدها' },
    ...units.map((unit) => ({ value: unit.id, label: unit.name })),
  ];

  const positionFilterOptions: SelectOption[] = [
    { value: '', label: 'همه سمت‌ها' },
    ...positions
      .filter(
        (position) =>
          !query.filters.organizationUnitId ||
          position.organizationUnitId === query.filters.organizationUnitId,
      )
      .map((position) => ({ value: position.id, label: position.title })),
  ];

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهده پرونده‌های پرسنلی به مجوز hr.employees.read نیاز دارید." />
    );
  }

  /** The create form needs both catalogues, and it says so instead of showing empty lists. */
  const canCreate = canManage && canReadOrganization && canReadPositions;

  return (
    <div data-testid="hr-employees">
      <HrPageHeading
        title="کارکنان"
        description="پرونده پرسنلی، واحد سازمانی و سمت جاری هر کارمند"
        actions={
          canManage ? (
            <Button
              type="button"
              data-testid="hr-employee-create-open"
              disabled={!canCreate}
              onClick={() => {
                setFormError(null);
                setNotice(null);
                setFormOpen((open) => !open);
              }}
            >
              {isFormOpen ? 'بستن فرم' : 'افزودن کارمند'}
            </Button>
          ) : undefined
        }
      />

      {canManage && !canCreate && (
        <HrNotice
          tone="error"
          message="برای ثبت پرونده جدید، مجوز خواندن چارت سازمانی (hr.organization.read) و سمت‌ها (hr.positions.read) نیز لازم است."
        />
      )}

      {notice && <HrNotice tone="ok" message={notice} />}

      {isFormOpen && canCreate && (
        <div className="mb-6">
          <CreateEmployeeForm
            units={units}
            positions={positions}
            isSaving={isSaving}
            error={formError}
            onCancel={() => setFormOpen(false)}
            onSubmit={handleCreate}
          />
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-[2.4rem] h-4 w-4 text-muted-foreground"
          />
          <Input
            id="hr-employee-search"
            name="search"
            label="جستجو"
            placeholder="کد پرسنلی یا نام"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <Select
          id="hr-employee-status-filter"
          name="statusFilter"
          label="وضعیت"
          value={query.filters.status}
          options={statusOptions}
          onChange={(event) => applyFilter('status', event.target.value as Filters['status'])}
        />
        <Select
          id="hr-employee-unit-filter"
          name="unitFilter"
          label="واحد سازمانی"
          value={query.filters.organizationUnitId}
          options={unitFilterOptions}
          onChange={(event) => {
            const unitId = event.target.value;
            // The unit cascade may keep `positionId` (same object values after
            // the rebuild) or drop it; it always rebuilds `filters` and resets
            // the page to 1, so compare against CURRENT query: arm only when an
            // effect input actually moves (no-op selects must not strand the
            // spinner).
            const current = query.filters;
            const keepPosition =
              current.positionId.length === 0 ||
              positions.some(
                (position) =>
                  position.id === current.positionId &&
                  (unitId.length === 0 || position.organizationUnitId === unitId),
              );
            const nextPosition = keepPosition ? current.positionId : '';
            const willChange =
              current.organizationUnitId !== unitId ||
              current.positionId !== nextPosition ||
              query.page !== 1;
            if (willChange) {
              setLoading(true);
              setError(null);
              setStatus(null);
            }
            // A position from the previously selected unit is not a legal filter for
            // this one, so it is dropped together with the unit that owned it.
            setQuery((prev) => {
              const keepPrev =
                prev.filters.positionId.length === 0 ||
                positions.some(
                  (position) =>
                    position.id === prev.filters.positionId &&
                    (unitId.length === 0 || position.organizationUnitId === unitId),
                );
              return {
                filters: {
                  ...prev.filters,
                  organizationUnitId: unitId,
                  positionId: keepPrev ? prev.filters.positionId : '',
                },
                page: 1,
              };
            });
          }}
        />
        <Select
          id="hr-employee-position-filter"
          name="positionFilter"
          label="سمت"
          value={query.filters.positionId}
          options={positionFilterOptions}
          onChange={(event) => applyFilter('positionId', event.target.value)}
        />
      </div>
{error && status === 403 ? (
        <CoreForbidden />
      ) : error ? (
        <CoreError message={error} onRetry={reload} />
      ) : isLoading ? (
        <CoreLoading lines={6} />
      ) : items.length === 0 ? (
        <CoreEmpty
          message={
            hasFilters
              ? 'هیچ کارمندی با این فیلترها یافت نشد.'
              : 'هنوز پرونده پرسنلی ثبت نشده است.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[52rem] text-right" data-testid="hr-employee-table">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">کارمند</th>
                <th className="px-4 py-3 font-medium">وضعیت</th>
                <th className="px-4 py-3 font-medium">واحد سازمانی</th>
                <th className="px-4 py-3 font-medium">سمت</th>
                <th className="px-4 py-3 font-medium">شروع همکاری</th>
                <th className="px-4 py-3 font-medium">حساب کاربری</th>
              </tr>
            </thead>
            <tbody>
              {items.map((employee) => (
                <EmployeeRow key={employee.id} employee={employee} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" data-testid="hr-employee-total">
          {total.toLocaleString('fa-IR')} پرونده
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="hr-employee-prev"
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
            data-testid="hr-employee-next"
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
