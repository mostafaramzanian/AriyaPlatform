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
  createHrUnit,
  fetchHrOrganizationTree,
  fetchHrUnits,
  hrRecordStatusLabel,
  setHrUnitStatus,
  updateHrUnit,
  type HrOrganizationNode,
  type HrOrganizationTree,
  type HrOrganizationUnit,
  type HrRecordStatus,
} from '@/lib/hr-api';
import { HrCard, HrField, HrNotice, HrPageHeading, HrRecordStatusBadge } from './hr-ui';

/**
 * Phase 51-HR-2: the organization chart — `/admin/hr/organization`.
 *
 * ONE READ PERMISSION, ONE WRITE PERMISSION, EXACTLY AS THE CONTROLLER DECLARES THEM:
 * `hr.organization.read` gates the tree (`GET /hr/organization`), the summary and the paged
 * unit list (`GET /hr/organization/units`); `hr.organization.manage` gates create, re-parent,
 * rename and the (de)activation route. Hiding a control is presentation only — the backend
 * refuses every write without the manage grant regardless of what this screen renders.
 *
 * BOTH READS ARE USED BECAUSE THEY ANSWER DIFFERENT QUESTIONS. The TREE is what the chart
 * draws and it is bounded (the server refuses to assemble an unbounded hierarchy); the PAGED
 * LIST is what the search box and the status filter query. Filtering a tree client-side would
 * show a child whose parent was filtered out — a hierarchy with a hole in it — so the search
 * and the status filter drive the LIST, and the tree stays the unfiltered chart.
 *
 * A UNIT IS RETIRED, NEVER DELETED. There is no delete route in the API and none here: an
 * employment interval still points at the unit it was held in, so «غیرفعال» is the end of the
 * lifecycle and the row stays addressable.
 */

const ORGANIZATION_READ = 'hr.organization.read';
const ORGANIZATION_MANAGE = 'hr.organization.manage';

const SEARCH_DEBOUNCE_MS = 350;

/** The two unit fields this screen edits. `code` is deliberately not editable after create. */
interface UnitForm {
  code: string;
  name: string;
  parentId: string;
}

const EMPTY_UNIT_FORM: UnitForm = { code: '', name: '', parentId: '' };

/** The list filters. Both are omitted from the query when blank, never sent empty. */
interface Filters {
  search: string;
  status: HrRecordStatus | '';
}

const EMPTY_FILTERS: Filters = { search: '', status: '' };

/** A blank select value is "no parent" — a ROOT unit, which is absence, not a null field. */
function orUndefined(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/** Indentation is bounded so a pathological hierarchy cannot push the label off-screen. */
function indentFor(depth: number): string {
  return `${Math.min(depth, 6) * 1.25}rem`;
}

/**
 * One node of the chart, rendered recursively.
 *
 * `data-depth` is exposed because the component spec asserts NESTING rather than order: a
 * flat list that happens to be alphabetically right is exactly the bug a chart screen makes.
 */
function TreeNode({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: HrOrganizationNode;
  depth: number;
  selectedId: string | null;
  onSelect: (unit: HrOrganizationUnit) => void;
}) {
  return (
    <li data-testid={`hr-org-node-${node.code}`} data-depth={depth}>
      <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 ${
          selectedId === node.id ? 'bg-primary/10' : 'hover:bg-muted/60'
        }`}
        style={{ marginInlineStart: indentFor(depth) }}
      >
        <button
          type="button"
          data-testid={`hr-org-select-${node.code}`}
          onClick={() => onSelect(node)}
          className="text-right text-sm font-medium text-foreground hover:text-primary"
        >
          {node.name}
          <span className="mx-2 text-xs text-muted-foreground">{node.code}</span>
        </button>
        <HrRecordStatusBadge status={node.status} />
      </div>

      {node.children.length > 0 && (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Flattens the tree so a parent picker offers every unit without a second request. */
function flattenTree(nodes: readonly HrOrganizationNode[]): HrOrganizationUnit[] {
  const out: HrOrganizationUnit[] = [];
  for (const node of nodes) {
    const { children, ...unit } = node;
    out.push(unit);
    out.push(...flattenTree(children));
  }
  return out;
}

/**
 * The create/edit form.
 *
 * `code` IS EDITABLE ONLY ON CREATE, and that is the API's rule, not a UI preference:
 * `UpdateOrganizationUnitDto` accepts `name` and `parentId` and nothing else, so an update
 * payload carrying `code` would be rejected by the global `forbidNonWhitelisted` pipe. A form
 * that offered the field would promise an edit the contract refuses, which is why the input
 * is rendered only for `create` and its value is never sent on save.
 */
function UnitFormPanel({
  mode,
  unit,
  parentOptions,
  isSaving,
  error,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  /** The unit being edited; absent while creating. */
  unit: HrOrganizationUnit | null;
  parentOptions: SelectOption[];
  isSaving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: UnitForm) => void;
}) {
  const [form, setForm] = React.useState<UnitForm>(() =>
    mode === 'edit' && unit
      ? { code: unit.code, name: unit.name, parentId: unit.parentId ?? '' }
      : EMPTY_UNIT_FORM,
  );
  const [localError, setLocalError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    if (form.name.trim().length === 0) {
      setLocalError('نام واحد را وارد کنید.');
      return;
    }

    if (mode === 'create' && form.code.trim().length === 0) {
      setLocalError('کد واحد را وارد کنید.');
      return;
    }

    onSubmit(form);
  };

  return (
    <div className="mb-6">
      <HrCard
        title={mode === 'create' ? 'واحد سازمانی جدید' : `ویرایش واحد ${unit?.code ?? ''}`}
        testId={mode === 'create' ? 'hr-unit-create-panel' : 'hr-unit-edit-panel'}
      >
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          {mode === 'create' && (
            <Input
              id="hr-unit-code"
              name="code"
              label="کد واحد"
              placeholder="بزرگ‌حروف، رقم، . _ / -"
              value={form.code}
              onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
              required
            />
          )}

          <Input
            id="hr-unit-name"
            name="name"
            label="نام واحد"
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            required
          />

          <Select
            id="hr-unit-parent"
            name="parentId"
            label="واحد بالادستی"
            value={form.parentId}
            options={parentOptions}
            onChange={(event) => setForm((prev) => ({ ...prev, parentId: event.target.value }))}
          />

          <p className="text-xs text-muted-foreground sm:col-span-2">
            {mode === 'create'
              ? 'خالی گذاشتن «واحد بالادستی» یعنی این واحد در ریشه چارت قرار می‌گیرد.'
              : 'جابه‌جایی زیر یک واحد جدید، وابستگی حلقه‌ای ایجاد نمی‌کند؛ سرور چنین درخواستی را رد می‌کند.'}
          </p>

          {(localError ?? error) && <HrNotice tone="error" message={localError ?? error ?? ''} />}

          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              type="submit"
              disabled={isSaving}
              data-testid={mode === 'create' ? 'hr-unit-create-submit' : 'hr-unit-edit-submit'}
            >
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
 * The organization chart.
 *
 * THE CHART AND THE TABLE ARE TWO READS ON PURPOSE. `GET /hr/organization` returns the whole
 * tenant hierarchy nested and bounded — that is what a chart needs — while
 * `GET /hr/organization/units` is the paged, filterable read a table needs. Filtering the
 * tree client-side would leave a node whose parent had been filtered out, i.e. a hierarchy
 * with a hole in it; so the search box and the status filter drive the LIST and the chart
 * stays the unfiltered whole.
 *
 * A WRITE REFRESHES BOTH. `reload()` bumps one token that both effects depend on, so a
 * renamed unit cannot stay stale in the chart while the table shows the new name.
 */
export function HrOrganizationView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(ORGANIZATION_READ);
  const canManage = permissions.includes(ORGANIZATION_MANAGE);

  const [tree, setTree] = React.useState<HrOrganizationTree | null>(null);
  /**
   * `tree === null` means "nothing to draw", which is true BOTH before the first answer and
   * after a failed one. Without this flag a failed chart read would spin forever, so the
   * card would claim to be loading while the screen below already reported the failure.
   */
  const [isTreeLoading, setTreeLoading] = React.useState(true);
  const [items, setItems] = React.useState<HrOrganizationUnit[]>([]);
  const [total, setTotal] = React.useState(0);
  const [selected, setSelected] = React.useState<HrOrganizationUnit | null>(null);

  const [query, setQuery] = React.useState<{ filters: Filters; page: number }>({
    filters: EMPTY_FILTERS,
    page: 1,
  });
  const [searchInput, setSearchInput] = React.useState('');

  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in the list retry and the mutation
  // handlers (same commit as the token bump), and arms the tree read too —
  // so neither effect needs an in-effect setter reset. First mount is covered
  // by both initial loading flags (`isLoading`, `isTreeLoading`).
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);

  const [panel, setPanel] = React.useState<'create' | 'edit' | null>(null);
  const [isSaving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    reloadList();
    setStatus(null);
    // The chart re-arms alongside the list: its effect has no other trigger.
    setTreeLoading(true);
  }, [reloadList]);

  // A query change is a NEW read: re-arm the list in the same commit the
  // change commits. The comparison is field-wise — `applyFilter` and the
  // debounce path mint fresh objects even for no-op changes, and arming
  // without a following fetch would strand the spinner. The fields mirror the
  // list effect's dependency list, and both effects early-return on unsettled
  // permissions without touching state, so no arm is needed for the gate
  // transition. The debounce path changes `query` from a timer, so no event
  // handler can arm it there.
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

  /** A filter change is a NEW query, never a new page of the old one. */
  const applyFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    // A no-op write would still mint a fresh `query` identity without changing
    // any field; only a real change arms — the render adjustment above covers
    // any incidental page reset it carries (page → 1) as well.
    if (query.filters[key] !== value) {
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

  // The chart. Deliberately NOT keyed on the filters — see the component doc.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchHrOrganizationTree()
      .then((result) => {
        if (!active) return;
        setTree(result);
        setTreeLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setTree(null);
        setTreeLoading(false);
        setError(err instanceof Error ? err.message : 'دریافت چارت سازمانی با خطا مواجه شد.');
        setStatus(err instanceof CoreApiError ? err.status : null);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead, reloadToken]);

  // The paged, filterable list.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchHrUnits({
      search: query.filters.search,
      status: orUndefined(query.filters.status) as HrRecordStatus | undefined,
      page: query.page,
      pageSize: HR_DEFAULT_PAGE_SIZE,
    })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setTotal(page.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setItems([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : 'دریافت فهرست واحدها با خطا مواجه شد.');
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
    query.page,
    reloadToken,
  ]);

  /**
   * The parent picker offers every unit EXCEPT the one being edited.
   *
   * A unit cannot be its own parent, and the server additionally refuses any re-parent that
   * would create a cycle (409) with a database trigger behind it. Excluding the edited unit
   * here is not the guarantee — it just removes the one obviously-wrong option.
   */
  const parentOptions: SelectOption[] = [
    { value: '', label: 'بدون واحد بالادستی (ریشه چارت)' },
    ...(tree ? flattenTree(tree.roots) : [])
      .filter((unit) => unit.id !== (panel === 'edit' && selected ? selected.id : ''))
      .map((unit) => ({ value: unit.id, label: `${unit.name} (${unit.code})` })),
  ];

  const handleCreate = (form: UnitForm) => {
    setSaving(true);
    setFormError(null);

    // An absent parent is ABSENCE: the field is omitted, never sent as `null` or `''`, so the
    // unit lands at the root exactly as `CreateOrganizationUnitDto` intends.
    createHrUnit({
      code: form.code.trim(),
      name: form.name.trim(),
      ...(form.parentId.length > 0 ? { parentId: form.parentId } : {}),
    })
      .then((created) => {
        setSaving(false);
        setPanel(null);
        setNotice(`واحد «${created.name}» ایجاد شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(err instanceof Error ? err.message : 'ایجاد واحد سازمانی با خطا مواجه شد.');
      });
  };

  const handleUpdate = (form: UnitForm) => {
    if (!selected) return;

    setSaving(true);
    setFormError(null);

    // `code` is deliberately NOT in this payload: `UpdateOrganizationUnitDto` has no such
    // field, and the global `forbidNonWhitelisted` pipe would reject the whole request.
    // `parentId: null` is how the API detaches a unit to the root — absence means "leave it".
    updateHrUnit(selected.id, {
      name: form.name.trim(),
      parentId: form.parentId.length > 0 ? form.parentId : null,
    })
      .then((updated) => {
        setSaving(false);
        setPanel(null);
        setSelected(updated);
        setNotice(`واحد «${updated.name}» به‌روزرسانی شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(
          err instanceof Error ? err.message : 'به‌روزرسانی واحد سازمانی با خطا مواجه شد.',
        );
      });
  };

  /** A unit is RETIRED, never deleted — there is no delete route in the API. */
  const handleToggleStatus = (unit: HrOrganizationUnit) => {
    const next: HrRecordStatus = unit.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    setBusyId(unit.id);
    setRowError(null);

    setHrUnitStatus(unit.id, next)
      .then((updated) => {
        setBusyId(null);
        setNotice(`وضعیت واحد «${updated.name}» به ${hrRecordStatusLabel(updated.status)} تغییر کرد.`);
        reload();
      })
      .catch((err: unknown) => {
        setBusyId(null);
        setRowError(err instanceof Error ? err.message : 'تغییر وضعیت واحد با خطا مواجه شد.');
      });
  };

  const pageCount = Math.max(1, Math.ceil(total / HR_DEFAULT_PAGE_SIZE));
  const hasFilters = query.filters.search.trim().length > 0 || query.filters.status.length > 0;
  const unitsInTree = tree ? flattenTree(tree.roots).length : 0;
  const parentName = selected?.parentId
    ? (flattenTree(tree?.roots ?? []).find((unit) => unit.id === selected.parentId)?.name ??
      selected.parentId)
    : null;

  const statusOptions: SelectOption[] = [
    { value: '', label: 'همه وضعیت‌ها' },
    { value: 'ACTIVE', label: hrRecordStatusLabel('ACTIVE') },
    { value: 'INACTIVE', label: hrRecordStatusLabel('INACTIVE') },
  ];

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهده چارت سازمانی به مجوز hr.organization.read نیاز دارید." />
    );
  }

  return (
    <div data-testid="hr-organization">
      <HrPageHeading
        title="چارت سازمانی"
        description="واحدهای سازمانی، ساختار سلسله‌مراتبی و وضعیت هر واحد"
        actions={
          canManage ? (
            <Button
              type="button"
              data-testid="hr-unit-create-open"
              onClick={() => {
                setFormError(null);
                setNotice(null);
                setSelected(null);
                setPanel((prev) => (prev === 'create' ? null : 'create'));
              }}
            >
              {panel === 'create' ? 'بستن فرم' : 'واحد سازمانی جدید'}
            </Button>
          ) : undefined
        }
      />

      {notice && <HrNotice tone="ok" message={notice} />}
      {rowError && <HrNotice tone="error" message={rowError} />}

      {panel === 'edit' && (
        <UnitFormPanel
          // A key per edited unit, so the panel's own state re-initialises from THAT unit
          // instead of keeping the previously selected one's fields.
          key={selected?.id ?? 'none'}
          mode="edit"
          unit={selected}
          parentOptions={parentOptions}
          isSaving={isSaving}
          error={formError}
          onCancel={() => setPanel(null)}
          onSubmit={handleUpdate}
        />
      )}

      {panel === 'create' && (
        <UnitFormPanel
          mode="create"
          unit={null}
          parentOptions={parentOptions}
          isSaving={isSaving}
          error={formError}
          onCancel={() => setPanel(null)}
          onSubmit={handleCreate}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <HrCard title="نمودار درختی" testId="hr-org-tree-card">
          {isTreeLoading ? (
            <CoreLoading lines={6} />
          ) : tree === null || tree.roots.length === 0 ? (
            <CoreEmpty message="هنوز واحد سازمانی ثبت نشده است." />
          ) : (
            <>
              <ul className="space-y-1" data-testid="hr-org-tree">
                {tree.roots.map((root) => (
                  <TreeNode
                    key={root.id}
                    node={root}
                    depth={0}
                    selectedId={selected?.id ?? null}
                    onSelect={setSelected}
                  />
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted-foreground" data-testid="hr-org-tree-total">
                {unitsInTree.toLocaleString('fa-IR')} واحد در چارت
              </p>
            </>
          )}
        </HrCard>

        <HrCard title="واحد انتخاب‌شده" testId="hr-org-selected-card">
          {selected === null ? (
            <CoreEmpty message="برای دیدن جزئیات و اقدامات، یک واحد را از چارت انتخاب کنید." />
          ) : (
            <div className="space-y-4">
              <dl className="grid gap-4 sm:grid-cols-2">
                <HrField label="نام واحد">{selected.name}</HrField>
                <HrField label="کد واحد">{selected.code}</HrField>
                <HrField label="وضعیت">
                  <HrRecordStatusBadge status={selected.status} />
                </HrField>
                <HrField label="واحد بالادستی">{parentName ?? 'ریشه چارت'}</HrField>
              </dl>

              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    data-testid="hr-unit-edit-open"
                    onClick={() => {
                      setFormError(null);
                      setNotice(null);
                      setPanel('edit');
                    }}
                  >
                    ویرایش واحد
                  </Button>
                  <Button
                    type="button"
                    data-testid="hr-unit-toggle-status"
                    disabled={busyId === selected.id}
                    onClick={() => handleToggleStatus(selected)}
                    className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
                  >
                    {busyId === selected.id
                      ? 'در حال اعمال...'
                      : selected.status === 'ACTIVE'
                        ? 'غیرفعال کردن'
                        : 'فعال کردن'}
                  </Button>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                واحد سازمانی حذف نمی‌شود؛ بازه‌های استخدامی به آن ارجاع می‌دهند، پس پایان چرخه
                زندگی «غیرفعال» است و رکورد باقی می‌ماند.
              </p>
            </div>
          )}
        </HrCard>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Input
          id="hr-unit-search"
          name="unitSearch"
          label="جستجو"
          placeholder="نام یا کد واحد"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Select
          id="hr-unit-status-filter"
          name="unitStatusFilter"
          label="وضعیت"
          value={query.filters.status}
          options={statusOptions}
          onChange={(event) => applyFilter('status', event.target.value as Filters['status'])}
        />
      </div>

      <div className="mt-4">
        {error && status === 403 ? (
          <CoreForbidden />
        ) : error ? (
          <CoreError message={error} onRetry={reload} />
        ) : isLoading ? (
          <CoreLoading lines={6} />
        ) : items.length === 0 ? (
          <CoreEmpty
            message={
              hasFilters ? 'هیچ واحدی با این فیلترها یافت نشد.' : 'هنوز واحد سازمانی ثبت نشده است.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[40rem] text-right" data-testid="hr-unit-table">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">نام واحد</th>
                  <th className="px-4 py-3 font-medium">کد</th>
                  <th className="px-4 py-3 font-medium">وضعیت</th>
                  <th className="px-4 py-3 font-medium">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {items.map((unit) => (
                  <tr
                    key={unit.id}
                    data-testid={`hr-unit-row-${unit.code}`}
                    className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-foreground">{unit.name}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{unit.code}</td>
                    <td className="px-4 py-3">
                      <HrRecordStatusBadge status={unit.status} />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        data-testid={`hr-unit-select-row-${unit.code}`}
                        onClick={() => {
                          setSelected(unit);
                          setNotice(null);
                        }}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        انتخاب
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>


      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" data-testid="hr-unit-total">
          {total.toLocaleString('fa-IR')} واحد
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="hr-unit-prev"
            disabled={query.page <= 1 || isLoading}
            onClick={() => {
              // Always moves `page` down (disabled at page 1), so the list
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
            data-testid="hr-unit-next"
            disabled={query.page >= pageCount || isLoading}
            onClick={() => {
              // Same: always moves `page` up, so the list effect refires.
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
