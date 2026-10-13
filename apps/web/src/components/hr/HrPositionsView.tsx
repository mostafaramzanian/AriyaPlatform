'use client';

import * as React from 'react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import {
  HR_DEFAULT_PAGE_SIZE,
  createHrPosition,
  fetchHrPositions,
  fetchHrUnits,
  hrRecordStatusLabel,
  setHrPositionStatus,
  updateHrPosition,
  type HrOrganizationUnit,
  type HrPosition,
  type HrRecordStatus,
} from '@/lib/hr-api';
import { HrCard, HrNotice, HrPageHeading, HrRecordStatusBadge } from './hr-ui';

/**
 * Phase 51-HR-2: the position catalogue — `/admin/hr/positions`.
 *
 * A POSITION IS A SLOT DEFINITION, NOT A PERSON AND NOT A HEADCOUNT. It belongs to exactly
 * one organization unit, two people may share it (nothing in the domain forbids job-sharing),
 * and a VACANCY is simply a position with no current holder — a state, not a row to delete.
 * This screen therefore offers no delete and no "assign" control: a person's position is an
 * employment interval, which is edited on the personnel file where history is preserved.
 *
 * PERMISSIONS, EXACTLY AS THE CONTROLLER DECLARES THEM: `hr.positions.read` gates the paged
 * list and the detail read; `hr.positions.manage` gates create, the title/unit move and the
 * (de)activation route. `hr.organization.read` is required as well for the unit picker — a
 * position cannot be created without a unit, so a manager who cannot read the chart is told
 * that plainly rather than being shown an empty dropdown. No request is issued for a
 * permission the caller lacks; each would be a guaranteed 403.
 *
 * THE EDIT FORM CAN MOVE A POSITION BETWEEN UNITS. That is deliberate and safe: employment
 * intervals reference the POSITION id, so re-parenting the slot re-labels it and every past
 * interval keeps pointing at the same id. An employee's unit is NOT editable this way — that
 * is an effective-dated transfer on the personnel file.
 */

const POSITIONS_READ = 'hr.positions.read';
const POSITIONS_MANAGE = 'hr.positions.manage';
const ORGANIZATION_READ = 'hr.organization.read';

const SEARCH_DEBOUNCE_MS = 350;

interface Filters {
  search: string;
  status: HrRecordStatus | '';
}

const EMPTY_FILTERS: Filters = { search: '', status: '' };

/** The create form's initial values — every field begins genuinely empty. */
const EMPTY_POSITION_FORM: PositionForm = { code: '', title: '', organizationUnitId: '' };

/**
 * The EDIT form's initial values.
 *
 * `code` is carried but rendered disabled: it is the position's identity and
 * `UpdatePositionDto` has no such field, so the form shows the real value rather than an
 * empty box that would suggest it can be changed.
 */
function toForm(position: HrPosition): PositionForm {
  return {
    code: position.code,
    title: position.title,
    organizationUnitId: position.organizationUnitId,
  };
}

interface PositionForm {
  code: string;
  title: string;
  organizationUnitId: string;
}

/**
 * The create/edit form.
 *
 * ONE COMPONENT FOR BOTH because the two differ by exactly one thing: `code` is immutable
 * after creation (`UpdatePositionDto` has no such field, and the global
 * `forbidNonWhitelisted` pipe would reject the whole request), so it is rendered read-only
 * while editing. Two components would be two places for the unit picker to drift.
 */
function PositionFormPanel({
  mode,
  units,
  initial,
  isSaving,
  error,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  units: HrOrganizationUnit[];
  /** Ignored while creating. */
  initial: PositionForm;
  isSaving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: PositionForm) => void;
}) {
  const [form, setForm] = React.useState<PositionForm>(initial);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const unitOptions: SelectOption[] = [
    { value: '', label: 'انتخاب واحد سازمانی' },
    ...units.map((unit) => ({ value: unit.id, label: `${unit.name} (${unit.code})` })),
  ];

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    // The code is a stable machine key: `A-Z 0-9 . _ / -`, matching `HR_CODE_PATTERN`.
    // Checking it here spends no round trip on a rule the form already states.
    if (mode === 'create' && !/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(form.code.trim())) {
      setLocalError('کد سمت باید با حرف یا رقم لاتین آغاز شود و فقط شامل A-Z، ۰-۹، «. _ / -» باشد.');
      return;
    }

    if (form.title.trim().length === 0) {
      setLocalError('عنوان سمت الزامی است.');
      return;
    }

    if (form.organizationUnitId.length === 0) {
      setLocalError('انتخاب واحد سازمانی الزامی است.');
      return;
    }

    setLocalError(null);
    onSubmit({ ...form, code: form.code.trim(), title: form.title.trim() });
  };

  return (
    <form onSubmit={submit} data-testid={`hr-position-form-${mode}`}>
      <HrCard title={mode === 'create' ? 'افزودن سمت' : 'ویرایش سمت'}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            id="hr-position-code"
            name="code"
            label="کد سمت"
            required={mode === 'create'}
            // The code is the position's identity: it is set once and never rewritten, so
            // editing shows it disabled rather than pretending it is a mutable field.
            disabled={mode === 'edit'}
            value={form.code}
            onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
          />
          <Input
            id="hr-position-title"
            name="title"
            label="عنوان سمت"
            required
            value={form.title}
            onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
          />
          <Select
            id="hr-position-unit"
            name="organizationUnitId"
            label="واحد سازمانی"
            required
            value={form.organizationUnitId}
            options={unitOptions}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, organizationUnitId: event.target.value }))
            }
          />
        </div>

        {(localError ?? error) && <HrNotice tone="error" message={localError ?? error ?? ''} />}

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={isSaving}
            data-testid={`hr-position-${mode}-submit`}
            className="mt-4"
          >
            {isSaving ? 'در حال ذخیره...' : 'ذخیره'}
          </Button>
          <Button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="mt-4 bg-muted text-foreground hover:bg-muted/80"
          >
            انصراف
          </Button>
        </div>
      </HrCard>
    </form>
  );
}


/**
 * The position catalogue.
 *
 * FILTER CHANGES AND PAGE CHANGES ARE ONE PIECE OF STATE (`query`): every filter change
 * replaces the whole query and resets the page to 1 in the same update, so the screen can
 * never fetch page 3 of the previous filter while showing the new one.
 */
export function HrPositionsView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(POSITIONS_READ);
  const canManage = permissions.includes(POSITIONS_MANAGE);
  const canReadOrganization = permissions.includes(ORGANIZATION_READ);

  const [query, setQuery] = React.useState<{ filters: Filters; page: number }>({
    filters: EMPTY_FILTERS,
    page: 1,
  });
  const [searchInput, setSearchInput] = React.useState('');

  const [items, setItems] = React.useState<HrPosition[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in the retry handler (same commit as
  // the token bump) and re-arms on query changes in the render adjustment
  // below, so the list effect needs no in-effect setter resets. First mount is
  // covered by the initial `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadList();
    setStatus(null);
  };

  // A query change is a NEW read: re-arm the list in the same commit the
  // change commits (the removed in-effect setters used to arm one render
  // later). The comparison is field-wise — the builders mint a fresh object
  // even for a no-op select, and arming without a following fetch would strand
  // the spinner. The fields mirror the list effect's dependency list, and that
  // effect early-returns on unsettled permissions without touching state, so
  // no arm is needed for the gate transition. The debounce path changes
  // `query` from a timer (`setQuery` inside `setTimeout`), so no event handler
  // can arm it there, and an effect-body setter is barred by
  // `react-hooks/set-state-in-effect`.
  const [prevQuery, setPrevQuery] = React.useState(query);
  const queryInputsChanged =
    prevQuery.page !== query.page ||
    prevQuery.filters.search !== query.filters.search ||
    prevQuery.filters.status !== query.filters.status;
  if (queryInputsChanged) {
    setPrevQuery(query);
    setLoading(true);
    setError(null);
    setStatus(null);
  }

  const [units, setUnits] = React.useState<HrOrganizationUnit[]>([]);

  /** null while closed; `'create'`, or the id of the row being edited. */
  const [panel, setPanel] = React.useState<'create' | string | null>(null);
  const [isSaving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

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

  // The paged list is the read the search box and the status filter drive.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let cancelled = false;

    fetchHrPositions({
      search: query.filters.search,
      // A blank select value means "no filter" — omitted, never sent empty.
      status: query.filters.status === '' ? undefined : query.filters.status,
      page: query.page,
      pageSize: HR_DEFAULT_PAGE_SIZE,
    })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : 'دریافت فهرست سمت‌ها با خطا مواجه شد.');
        setStatus(err instanceof CoreApiError ? err.status : null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    isPermissionsLoading,
    canRead,
    query.filters.search,
    query.filters.status,
    query.page,
    reloadToken,
  ]);

  /**
   * The unit picker.
   *
   * A large page size rather than a second tree read: the form needs a flat list of every
   * unit, and `pageSize` is clamped by the client and re-clamped by the server to
   * `HR_MAX_PAGE_SIZE`, so one bounded request is enough.
   */
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead || !canManage || !canReadOrganization) return;

    let cancelled = false;

    fetchHrUnits({ pageSize: 100 })
      .then((page) => {
        if (cancelled) return;
        setUnits(page.items);
      })
      .catch(() => {
        // A failed catalogue read degrades to an unusable form, never a broken page: the
        // list itself is unaffected, and the backend re-validates the unit on submit.
        if (!cancelled) setUnits([]);
      });

    return () => {
      cancelled = true;
    };
  }, [isPermissionsLoading, canRead, canManage, canReadOrganization]);

  const handleCreate = (form: PositionForm) => {
    setSaving(true);
    setFormError(null);

    createHrPosition({
      code: form.code,
      title: form.title,
      organizationUnitId: form.organizationUnitId,
    })
      .then((created) => {
        setSaving(false);
        setPanel(null);
        setNotice(`سمت «${created.title}» ثبت شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(err instanceof Error ? err.message : 'ثبت سمت با خطا مواجه شد.');
      });
  };

  const handleUpdate = (id: string, form: PositionForm) => {
    setSaving(true);
    setFormError(null);

    // `code` is deliberately NOT in this payload: `UpdatePositionDto` has no such field,
    // and the global `forbidNonWhitelisted` pipe would reject the whole request.
    updateHrPosition(id, {
      title: form.title,
      organizationUnitId: form.organizationUnitId,
    })
      .then((updated) => {
        setSaving(false);
        setPanel(null);
        setNotice(`سمت «${updated.title}» به‌روزرسانی شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(err instanceof Error ? err.message : 'به‌روزرسانی سمت با خطا مواجه شد.');
      });
  };

  /** A position is RETIRED, never deleted — employment history still points at it. */
  const handleToggleStatus = (position: HrPosition) => {
    const next: HrRecordStatus = position.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    setBusyId(position.id);
    setRowError(null);

    setHrPositionStatus(position.id, next)
      .then(() => {
        setBusyId(null);
        setNotice(
          next === 'ACTIVE'
            ? `سمت «${position.title}» فعال شد.`
            : `سمت «${position.title}» غیرفعال شد.`,
        );
        reload();
      })
      .catch((err: unknown) => {
        setBusyId(null);
        setRowError(err instanceof Error ? err.message : 'تغییر وضعیت سمت با خطا مواجه شد.');
      });
  };

  const pageCount = Math.max(1, Math.ceil(total / HR_DEFAULT_PAGE_SIZE));
  const hasFilters = query.filters.search.trim().length > 0 || query.filters.status.length > 0;

  const statusOptions: SelectOption[] = [
    { value: '', label: 'همه وضعیت‌ها' },
    { value: 'ACTIVE', label: hrRecordStatusLabel('ACTIVE') },
    { value: 'INACTIVE', label: hrRecordStatusLabel('INACTIVE') },
  ];

  const editing =
    panel !== null && panel !== 'create' ? items.find((row) => row.id === panel) ?? null : null;

  /** The create/edit form needs the unit catalogue, and it says so instead of showing an empty list. */
  const canCreate = canManage && canReadOrganization;

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهده فهرست سمت‌ها به مجوز hr.positions.read نیاز دارید." />
    );
  }

  return (
    <div data-testid="hr-positions">
      <HrPageHeading
        title="سمت‌ها"
        description="فهرست سمت‌های سازمانی به تفکیک واحد؛ هر سمت یک جایگاه است، نه یک نفر"
        actions={
          canManage ? (
            <Button
              type="button"
              data-testid="hr-position-create-open"
              disabled={!canCreate}
              onClick={() => {
                setFormError(null);
                setNotice(null);
                setPanel((prev) => (prev === 'create' ? null : 'create'));
              }}
            >
              {panel === 'create' ? 'بستن فرم' : 'افزودن سمت'}
            </Button>
          ) : undefined
        }
      />

      {notice && <HrNotice tone="ok" message={notice} />}
      {rowError && <HrNotice tone="error" message={rowError} />}

      {/* The unit catalogue is a HARD requirement of the form, so its absence is stated
          rather than shown as an empty dropdown the operator cannot explain. */}
      {canManage && !canReadOrganization && (
        <HrNotice
          tone="error"
          message="برای افزودن یا ویرایش سمت، مجوز خواندن چارت سازمانی (hr.organization.read) نیز لازم است."
        />
      )}

      {canCreate && panel === 'create' && (
        <PositionFormPanel
          mode="create"
          units={units}
          initial={EMPTY_POSITION_FORM}
          isSaving={isSaving}
          error={formError}
          onCancel={() => setPanel(null)}
          onSubmit={handleCreate}
        />
      )}

      {editing && (
        <PositionFormPanel
          // A key per edited row, so the panel re-initialises from THAT position instead of
          // keeping whatever the previously opened row had filled in.
          key={editing.id}
          mode="edit"
          units={units}
          initial={toForm(editing)}
          isSaving={isSaving}
          error={formError}
          onCancel={() => setPanel(null)}
          onSubmit={(form) => handleUpdate(editing.id, form)}
        />
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Input
          id="hr-position-search"
          name="positionSearch"
          label="جستجو"
          placeholder="عنوان یا کد سمت"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Select
          id="hr-position-status-filter"
          name="positionStatusFilter"
          label="وضعیت"
          value={query.filters.status}
          options={statusOptions}
          onChange={(event) => applyFilter('status', event.target.value as Filters['status'])}
        />
      </div>

      {/* The unit catalogue, keyed by id: a row's unit is a reference, and the list endpoint
          already returns the unit with each position, so the map only fills gaps. */}
      <div className="mt-4">
        {/* A 403 is shown as a permission message, not as a generic error with a retry button:
            a retry can never succeed while the grant is missing. `status` carries the code the
            API reported, exactly as the organization screen uses it. */}
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
                ? 'هیچ سمتی با این فیلترها یافت نشد.'
                : 'هنوز سمتی ثبت نشده است.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[46rem] text-right" data-testid="hr-position-table">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">کد</th>
                  <th className="px-4 py-3 font-medium">عنوان</th>
                  <th className="px-4 py-3 font-medium">واحد سازمانی</th>
                  <th className="px-4 py-3 font-medium">وضعیت</th>
                  {canManage && <th className="px-4 py-3 font-medium">عملیات</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((position) => (
                  <tr
                    key={position.id}
                    data-testid={`hr-position-row-${position.id}`}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{position.code}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{position.title}</td>
                    <td className="px-4 py-3 text-sm">
                      {/* The list read includes the unit; a create/update echo does not, hence
                          the id fallback which is never shown on this screen. */}
                      {position.organizationUnit?.name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <HrRecordStatusBadge status={position.status} />
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            data-testid={`hr-position-edit-${position.id}`}
                            onClick={() => {
                              setFormError(null);
                              setNotice(null);
                              setPanel((prev) => (prev === position.id ? null : position.id));
                            }}
                            className="bg-muted text-foreground hover:bg-muted/80"
                          >
                            ویرایش
                          </Button>
                          <Button
                            type="button"
                            data-testid={`hr-position-toggle-${position.id}`}
                            disabled={busyId === position.id}
                            onClick={() => handleToggleStatus(position)}
                            className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
                          >
                            {/* A position is RETIRED, never deleted: no delete control exists. */}
                            {position.status === 'ACTIVE' ? 'غیرفعال‌سازی' : 'فعال‌سازی'}
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" data-testid="hr-position-total">
          {total.toLocaleString('fa-IR')} سمت
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="hr-position-prev"
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
            data-testid="hr-position-next"
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
