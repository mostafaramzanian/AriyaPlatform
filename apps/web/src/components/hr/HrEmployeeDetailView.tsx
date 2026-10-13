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
import {
  HR_EMPLOYMENT_TYPES,
  HR_MAX_PAGE_SIZE,
  fetchHrEmployee,
  fetchHrPositions,
  fetchHrUnits,
  hrDateLabel,
  hrDisplayName,
  hrEmploymentTypeLabel,
  hrIntervalStatusLabel,
  openHrEmploymentInterval,
  rehireHrEmployee,
  setHrEmployeeStatus,
  terminateHrEmployee,
  updateHrEmployee,
  type HrEmployeeDetail,
  type HrEmployeePatch,
  type HrEmploymentRecord,
  type HrEmploymentType,
  type HrIntervalInput,
  type HrManualEmployeeStatus,
  type HrOrganizationUnit,
  type HrPosition,
} from '@/lib/hr-api';
import { HrBadge, HrCard, HrEmployeeStatusBadge, HrField, HrNotice, HrPageHeading } from './hr-ui';

/**
 * Phase 51-HR-2: the personnel file — `/admin/hr/employees/:id`.
 *
 * THE FILE IS APPEND-ONLY BY DESIGN, AND THIS SCREEN MIRRORS THAT. Nothing here edits an
 * employment interval: a transfer or a promotion APPENDS a new interval and closes the
 * previous one, and ending employment CLOSES the open interval on a chosen date. There is
 * no delete control anywhere, because the API has no delete route — employment history is
 * a record, not a draft.
 *
 * EACH ACTION IS THE ENDPOINT THAT OWNS ITS RULE:
 *   * `PATCH /hr/employees/:id`                     — employee code and the Core identity link;
 *   * `PATCH /hr/employees/:id/status`              — the two MANUAL statuses (ACTIVE/INACTIVE);
 *   * `POST  /hr/employees/:id/employment-records`  — transfer / promotion / renewal;
 *   * `POST  /hr/employees/:id/terminate`           — closes the open interval;
 *   * `POST  /hr/employees/:id/rehire`              — appends after a termination.
 *
 * `TERMINATED` is deliberately absent from the status control: the API refuses it there,
 * because terminating is a DATED event that closes an interval rather than a label. The
 * service says so in as many words — "a terminated employee is rehired, not reactivated" —
 * so offering it would be a control whose only possible outcome is a 400.
 *
 * WHAT THIS SCREEN DOES NOT INVENT: the manager is stored as an EMPLOYEE id (§13 — never a
 * Core user id) and the API exposes no id→name lookup for employees, so it is rendered as
 * its identifier instead of being guessed at or quietly dropped. Unit and position names
 * come from the two catalogue reads, and when the caller cannot read a catalogue the raw
 * reference becomes a dash WITH an explanation — never a fabricated label.
 */

const EMPLOYEES_READ = 'hr.employees.read';
const EMPLOYEES_MANAGE = 'hr.employees.manage';
const ORGANIZATION_READ = 'hr.organization.read';
const POSITIONS_READ = 'hr.positions.read';

/** The same strict date the backend's `HR_ISO_DATE_PATTERN` accepts, checked before sending. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Checked before a request, so a malformed identity link is a sentence, not a 400. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Which write panel is open. One at a time: every one of them is a different endpoint. */
type ActionMode = 'interval' | 'terminate' | 'rehire' | 'settings';

/**
 * The ONE error sentence used by every write below.
 *
 * `CoreApiError` already carries the API's own message (mapped from the response body), and
 * the HTTP layer is the only writer of that text. Mapping it again here would replace a
 * precise backend sentence such as "The new interval must start after the current one began"
 * with a generic apology, so it is passed through unchanged.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'عملیات با خطا مواجه شد.';
}

/**
 * Pre-flight checks, so an obviously malformed body is a sentence rather than a 400.
 *
 * These are NOT a second copy of the server's rules: every one of them is the same shape the
 * API documents, and the API remains the authority. They exist only for the cases where the
 * browser already knows the answer — an empty date, a missing selection, a mistyped id.
 */
function validateInterval(form: IntervalForm): string | null {
  if (!ISO_DATE_PATTERN.test(form.startDate)) return 'تاریخ شروع باید به شکل YYYY-MM-DD باشد.';
  if (!UUID_PATTERN.test(form.organizationUnitId)) return 'واحد سازمانی را انتخاب کنید.';
  if (!UUID_PATTERN.test(form.positionId)) return 'سمت را انتخاب کنید.';
  const manager = form.managerEmployeeId.trim();
  if (manager.length > 0 && !UUID_PATTERN.test(manager)) {
    return 'شناسه مدیر باید یک UUID معتبر باشد.';
  }
  return null;
}

/** The same alphabet `HR_EMPLOYEE_CODE_PATTERN` declares in the API's hr.constants.ts. */
const EMPLOYEE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

/**
 * A unit or position NAME for an id, resolved through the catalogues.
 *
 * The employment-history rows carry ids only — the API returns resolved refs for the
 * CURRENT assignment alone — so a history row's names come from the two catalogue reads.
 * A dash is returned when the catalogue is unreadable or the row predates the catalogue
 * page: an unexplained identifier on screen is worse than an honest gap.
 */
function refName(map: Map<string, string>, id: string | null): string {
  if (!id) return '—';
  return map.get(id) ?? '—';
}

/**
 * The personnel file's history table — every interval this person has ever had.
 *
 * The API already ordered the rows newest-first, so nothing is re-sorted here: the order a
 * personnel file is read in is the server's contract, not a presentation choice.
 *
 * A row's unit and position are IDS on the history read (only the CURRENT assignment gets
 * resolved refs), so the names come from the two catalogue reads. When a catalogue cannot be
 * read the raw reference becomes a dash AND the table says why — a silently empty column
 * would look like missing history rather than a missing permission.
 */
function HistoryTable({
  history,
  unitNames,
  positionNames,
  catalogueReadable,
}: {
  history: HrEmploymentRecord[];
  unitNames: Map<string, string>;
  positionNames: Map<string, string>;
  catalogueReadable: boolean;
}) {
  if (history.length === 0) {
    return <CoreEmpty message="برای این کارمند بازه استخدامی ثبت نشده است." />;
  }

  return (
    <div className="space-y-3">
      {!catalogueReadable && (
        <p className="text-xs text-muted-foreground">
          بدون مجوز خواندن چارت سازمانی و سمت‌ها، نام واحد و سمت در تاریخچه نمایش داده نمی‌شود.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-right" data-testid="hr-history-table">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">از تاریخ</th>
              <th className="px-3 py-2 font-medium">تا تاریخ</th>
              <th className="px-3 py-2 font-medium">نوع همکاری</th>
              <th className="px-3 py-2 font-medium">وضعیت بازه</th>
              <th className="px-3 py-2 font-medium">واحد سازمانی</th>
              <th className="px-3 py-2 font-medium">سمت</th>
            </tr>
          </thead>
          <tbody>
            {history.map((record) => (
              <tr
                key={record.id}
                data-testid={`hr-history-${record.id}`}
                className="border-b border-border/60 last:border-0"
              >
                <td className="px-3 py-2 text-sm">{hrDateLabel(record.startDate)}</td>
                <td className="px-3 py-2 text-sm">
                  {/* An open interval has no end date — that is a state, not missing data. */}
                  {record.endDate === null ? 'در جریان' : hrDateLabel(record.endDate)}
                </td>
                <td className="px-3 py-2 text-sm">{hrEmploymentTypeLabel(record.employmentType)}</td>
                <td className="px-3 py-2">
                  <HrBadge tone={record.status === 'ACTIVE' ? 'ok' : 'muted'}>
                    {hrIntervalStatusLabel(record.status)}
                  </HrBadge>
                </td>
                <td className="px-3 py-2 text-sm">
                  {refName(unitNames, record.organizationUnitId)}
                </td>
                <td className="px-3 py-2 text-sm">
                  {refName(positionNames, record.positionId)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The interval form — TRANSFER, PROMOTION, RENEWAL and REHIRE all share this one shape.
 *
 * They are the same request body because they are the same act: an effective-dated interval
 * is appended. Only the endpoint differs, because only its precondition differs
 * (`POST …/employment-records` requires an ACTIVE employee with an open interval;
 * `POST …/rehire` requires a TERMINATED one with none).
 */
interface IntervalForm {
  employmentType: HrEmploymentType;
  startDate: string;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string;
}

const EMPTY_INTERVAL_FORM: IntervalForm = {
  employmentType: 'FULL_TIME',
  startDate: '',
  organizationUnitId: '',
  positionId: '',
  managerEmployeeId: '',
};

interface TerminateForm {
  endDate: string;
  reason: string;
}

const EMPTY_TERMINATE_FORM: TerminateForm = { endDate: '', reason: '' };

/** The mutable employee fields the API accepts: the code and the login link, nothing else. */
interface SettingsForm {
  employeeCode: string;
  userId: string;
}

export function HrEmployeeDetailView({ employeeId }: { employeeId: string }) {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(EMPLOYEES_READ);
  const canManage = permissions.includes(EMPLOYEES_MANAGE);
  const canReadOrganization = permissions.includes(ORGANIZATION_READ);
  const canReadPositions = permissions.includes(POSITIONS_READ);
  /** Unit and position names need BOTH catalogue reads; without them a name is a dash. */
  const canNameReferences = canReadOrganization && canReadPositions;

  const [employee, setEmployee] = React.useState<HrEmployeeDetail | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the mutation handlers and the error-state retry
  // (same commit as the token bump), so the detail effect needs no in-effect
  // setter resets. First mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload: reloadDetail } = useReloadToken(setIsLoading, setError);
  const reload = () => {
    reloadDetail();
  };

  // A new employee id is a NEW read: re-arm during render, guarded by the
  // previous prop (`react-hooks/set-state-in-effect` bars the setter in the
  // effect body; `react-hooks/set-state-in-render` bars an unguarded one).
  // Mount is a no-op (identity equal, skeleton already armed by `isLoading`).
  const [prevEmployeeId, setPrevEmployeeId] = React.useState(employeeId);
  if (prevEmployeeId !== employeeId) {
    setPrevEmployeeId(employeeId);
    setIsLoading(true);
    setError(null);
  }

  /** The catalogues, read only when the caller holds the matching read permission. */
  const [units, setUnits] = React.useState<HrOrganizationUnit[]>([]);
  const [positions, setPositions] = React.useState<HrPosition[]>([]);
  /**
   * The positions of the unit SELECTED IN THE FORM.
   *
   * `assertPositionIsUsable(actor, positionId, organizationUnitId)` makes the position's own
   * unit part of the backend's rule, so a picker offering the whole catalogue would invite a
   * 400. This is read per chosen unit rather than filtered from the page above, because the
   * catalogue may be larger than one page and a silently short dropdown is worse than a
   * second request.
   */
  const [formPositions, setFormPositions] = React.useState<HrPosition[]>([]);
  const [isCatalogueLoading, setIsCatalogueLoading] = React.useState(false);
  const [catalogueError, setCatalogueError] = React.useState<string | null>(null);

  /** One write panel at a time: each one is a different endpoint with its own precondition. */
  const [mode, setMode] = React.useState<ActionMode | null>(null);
  const [intervalForm, setIntervalForm] = React.useState<IntervalForm>(EMPTY_INTERVAL_FORM);
  const [terminateForm, setTerminateForm] = React.useState<TerminateForm>(EMPTY_TERMINATE_FORM);
  const [settingsForm, setSettingsForm] = React.useState<SettingsForm>({
    employeeCode: '',
    userId: '',
  });
  const [isSaving, setIsSaving] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  /** A completed write: a state change that is visible, never a silent success. */
  const [notice, setNotice] = React.useState<string | null>(null);

  const unitNames = React.useMemo(
    () => new Map(units.map((unit) => [unit.id, unit.name])),
    [units],
  );
  const positionNames = React.useMemo(
    () => new Map(positions.map((position) => [position.id, position.title])),
    [positions],
  );

  // No request without the read permission: it would be a guaranteed 403 rendered as a
  // broken screen, and the caller is told plainly instead (see the render below).
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let cancelled = false;

    fetchHrEmployee(employeeId)
      .then((detail) => {
        if (cancelled) return;
        setEmployee(detail);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError({
          message: err instanceof Error ? err.message : 'دریافت پرونده با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isPermissionsLoading, canRead, employeeId, reloadToken]);

  // The catalogue arm happens during render at the moment the gate OPENS —
  // the effect's first run used to set it one render later, and the effect has
  // no refire trigger of its own. prev starts closed so the mount-with-grant
  // case is detected as an opening; the closing direction needs no arm.
  const catalogueGateOpen = !isPermissionsLoading && canReadOrganization && canReadPositions;
  const [prevCatalogueGateOpen, setPrevCatalogueGateOpen] = React.useState(false);
  if (prevCatalogueGateOpen !== catalogueGateOpen) {
    setPrevCatalogueGateOpen(catalogueGateOpen);
    if (catalogueGateOpen) {
      setIsCatalogueLoading(true);
    }
  }

  // The catalogues, for the two pickers AND for naming the history rows. Skipped entirely for
  // a caller who cannot read them — the pickers then explain themselves rather than lying.
  React.useEffect(() => {
    if (isPermissionsLoading || !canReadOrganization || !canReadPositions) return;

    let cancelled = false;

    Promise.all([
      fetchHrUnits({ status: 'ACTIVE', pageSize: HR_MAX_PAGE_SIZE }),
      fetchHrPositions({ status: 'ACTIVE', pageSize: HR_MAX_PAGE_SIZE }),
    ])
      .then(([unitPage, positionPage]) => {
        if (cancelled) return;
        setUnits(unitPage.items);
        setPositions(positionPage.items);
        setCatalogueError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalogueError(
          err instanceof Error ? err.message : 'دریافت چارت سازمانی با خطا مواجه شد.',
        );
      })
      .finally(() => {
        if (!cancelled) setIsCatalogueLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isPermissionsLoading, canReadOrganization, canReadPositions]);

  /**
   * The form's position options: the chosen unit's OWN positions.
   *
   * A transfer may move someone to a unit whose slots are not on the catalogue page above, so
   * this is a fresh, unit-scoped read. It is skipped while no unit is chosen — there is
   * nothing to scope by — and it clears the list on every unit change so a position from the
   * previous unit can never be submitted with the new one.
   */
  const formUnitId = intervalForm.organizationUnitId;

  // The skip branch of the unit-scoped positions read clears the list, but a
  // setter in the effect body is barred — so the clear rides a render-time
  // adjustment keyed on the effect's own dependency tuple (a string, so the
  // comparison is a single one). Mount is a no-op: the list starts empty.
  const formPositionsSkipped =
    !canReadPositions || (mode !== 'interval' && mode !== 'rehire') || formUnitId.length === 0;
  const positionReadKey = `${canReadPositions}|${mode}|${formUnitId}`;
  const [prevPositionReadKey, setPrevPositionReadKey] = React.useState(positionReadKey);
  if (prevPositionReadKey !== positionReadKey) {
    setPrevPositionReadKey(positionReadKey);
    if (formPositionsSkipped) {
      setFormPositions([]);
    }
  }

  React.useEffect(() => {
    if (formPositionsSkipped) return;

    let cancelled = false;

    fetchHrPositions({ organizationUnitId: formUnitId, status: 'ACTIVE', pageSize: HR_MAX_PAGE_SIZE })
      .then((page) => {
        if (!cancelled) setFormPositions(page.items);
      })
      .catch(() => {
        if (!cancelled) setFormPositions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [canReadPositions, mode, formUnitId, formPositionsSkipped]);

  /** Moves between panels? Then the previous panel's error is stale, and so is its success. */
  const openPanel = (next: ActionMode) => {
    setMode((current) => (current === next ? null : next));
    setActionError(null);
    setNotice(null);
  };

  /**
   * TRANSFER / PROMOTION / RENEWAL — and REHIRE, which is the same body on a different route.
   *
   * The body is assembled field by field and `managerEmployeeId` is OMITTED when blank: an
   * empty string would fail `@IsUUID('4')`, and `null` would mean something else entirely.
   */
  const submitInterval = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employee) return;

    const invalid = validateInterval(intervalForm);
    if (invalid) {
      setActionError(invalid);
      return;
    }

    const managerEmployeeId = intervalForm.managerEmployeeId.trim();
    const payload: HrIntervalInput = {
      employmentType: intervalForm.employmentType,
      startDate: intervalForm.startDate,
      organizationUnitId: intervalForm.organizationUnitId,
      positionId: intervalForm.positionId,
      ...(managerEmployeeId.length > 0 ? { managerEmployeeId } : {}),
    };

    setIsSaving(true);
    setActionError(null);

    try {
      if (mode === 'rehire') {
        await rehireHrEmployee(employee.id, payload);
        setNotice('استخدام مجدد ثبت شد و بازه جدید به پرونده افزوده شد.');
      } else {
        await openHrEmploymentInterval(employee.id, payload);
        setNotice('بازه استخدامی جدید ثبت شد و بازه قبلی بسته شد.');
      }
      setIntervalForm(EMPTY_INTERVAL_FORM);
      setMode(null);
      reload();
    } catch (err: unknown) {
      setActionError(messageOf(err));
    } finally {
      setIsSaving(false);
    }
  };

  /** Ends employment on a date. The interval is CLOSED, never deleted. */
  const submitTerminate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employee) return;

    if (!ISO_DATE_PATTERN.test(terminateForm.endDate)) {
      setActionError('تاریخ پایان باید به شکل YYYY-MM-DD باشد.');
      return;
    }

    setIsSaving(true);
    setActionError(null);

    try {
      const reason = terminateForm.reason.trim();
      await terminateHrEmployee(employee.id, {
        endDate: terminateForm.endDate,
        ...(reason.length > 0 ? { reason } : {}),
      });
      setNotice('خاتمه همکاری ثبت شد و بازه جاری بسته شد.');
      setTerminateForm(EMPTY_TERMINATE_FORM);
      setMode(null);
      reload();
    } catch (err: unknown) {
      setActionError(messageOf(err));
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * The two mutable employee fields: the code and the Core login link.
   *
   * ONLY WHAT CHANGED IS SENT. `userId: null` is the API's deliberate way to UNLINK a login,
   * so an untouched field must be absent rather than `null` — otherwise opening this panel and
   * saving it would silently unlink an identity the operator never looked at.
   */
  const submitSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employee) return;

    const code = settingsForm.employeeCode.trim().toUpperCase();
    const userId = settingsForm.userId.trim();
    const patch: HrEmployeePatch = {};

    if (code !== employee.employeeCode) {
      if (!EMPLOYEE_CODE_PATTERN.test(code)) {
        setActionError(
          'کد کارمندی باید با حرف یا رقم شروع شود و فقط شامل A-Z، 0-9 و . _ / - باشد.',
        );
        return;
      }
      patch.employeeCode = code;
    }

    if (userId !== (employee.userId ?? '')) {
      if (userId.length > 0 && !UUID_PATTERN.test(userId)) {
        setActionError('شناسه حساب کاربری باید یک UUID معتبر باشد.');
        return;
      }
      // An empty field means "unlink", which is exactly what the API represents as null.
      patch.userId = userId.length > 0 ? userId : null;
    }

    if (Object.keys(patch).length === 0) {
      setActionError('تغییری برای ذخیره وجود ندارد.');
      return;
    }

    setIsSaving(true);
    setActionError(null);

    try {
      await updateHrEmployee(employee.id, patch);
      setNotice('اطلاعات کارمند ذخیره شد.');
      setMode(null);
      reload();
    } catch (err: unknown) {
      setActionError(messageOf(err));
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * The dedicated status route — ACTIVE and INACTIVE only.
   *
   * `TERMINATED` is not offered and not representable here: it is produced by a DATED
   * termination, and the API refuses the word on this route on purpose.
   */
  const applyStatus = async (status: HrManualEmployeeStatus) => {
    if (!employee) return;

    setIsSaving(true);
    setActionError(null);
    setNotice(null);

    try {
      await setHrEmployeeStatus(employee.id, status);
      setNotice(status === 'ACTIVE' ? 'وضعیت کارمند فعال شد.' : 'وضعیت کارمند غیرفعال شد.');
      reload();
    } catch (err: unknown) {
      setActionError(messageOf(err));
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * The settings panel is seeded from the LOADED RECORD, not from the list.
   *
   * Re-seeded whenever the record is re-read, so the panel starts from what the server
   * actually holds and `submitSettings` can compare against it. Without this the panel
   * would open empty and its first save would look like a request to change the code to ''.
   * Applied during render, guarded by the previous record — the effect-body
   * setter is barred by `react-hooks/set-state-in-effect`. Mount (null → null)
   * is a no-op: the panel opens from the form's own initial values and seeds
   * on the first record.
   */
  const [prevEmployee, setPrevEmployee] = React.useState(employee);
  if (prevEmployee !== employee) {
    setPrevEmployee(employee);
    if (employee) {
      setSettingsForm({ employeeCode: employee.employeeCode, userId: employee.userId ?? '' });
    }
  }

  // -- Gates ----------------------------------------------------------------
  //
  // The permission gate comes FIRST and issues no request: a 403 fetched on purpose would
  // be an error state standing in for an authorization answer.
  if (!isPermissionsLoading && !canRead) {
    return (
      <div data-testid="hr-employee-detail">
        <CoreForbidden message="شما به پروندههای پرسنلی دسترسی ندارید." />
        <Link
          href="/admin/hr/employees"
          data-testid="hr-detail-back"
          className="mt-4 inline-block text-sm text-primary hover:underline"
        >
          بازگشت به فهرست کارکنان
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="hr-employee-detail">
        <CoreLoading label="در حال بارگذاری پرونده پرسنلی..." lines={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="hr-employee-detail">
        <CoreError message={error.message} onRetry={reload} />
        <Link
          href="/admin/hr/employees"
          data-testid="hr-detail-back"
          className="mt-4 inline-block text-sm text-primary hover:underline"
        >
          بازگشت به فهرست کارکنان
        </Link>
      </div>
    );
  }

  // `isLoading` is false and nothing errored, so the record exists. The guard is here for the
  // type system and for the one frame before state settles — it renders the same skeleton.
  if (!employee) {
    return (
      <div data-testid="hr-employee-detail">
        <CoreLoading lines={6} />
      </div>
    );
  }

  const assignment = employee.currentAssignment;
  const canTerminate = canManage && employee.status !== 'TERMINATED' && assignment !== null;
  const canRehire = canManage && employee.status === 'TERMINATED' && assignment === null;

  const employmentTypeOptions: SelectOption[] = HR_EMPLOYMENT_TYPES.map((type) => ({
    value: type,
    label: hrEmploymentTypeLabel(type),
  }));

  const unitOptions: SelectOption[] = units.map((unit) => ({
    value: unit.id,
    label: `${unit.code} — ${unit.name}`,
  }));

  const formPositionOptions: SelectOption[] = formPositions.map((position) => ({
    value: position.id,
    label: `${position.code} — ${position.title}`,
  }));

  return (
    <div data-testid="hr-employee-detail">
      <Link
        href="/admin/hr/employees"
        data-testid="hr-detail-back"
        className="mb-4 inline-block text-sm text-primary hover:underline"
      >
        بازگشت به فهرست کارکنان
      </Link>

      <HrPageHeading
        title={hrDisplayName(employee.identity, employee.employeeCode)}
        description={`پرونده پرسنلی — کد کارمندی ${employee.employeeCode}`}
        actions={<HrEmployeeStatusBadge status={employee.status} />}
      />

      {actionError && <HrNotice tone="error" message={actionError} />}
      {notice && <HrNotice tone="ok" message={notice} />}

      {canManage && (
        <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="hr-detail-actions">
          {employee.status !== 'TERMINATED' && (
            <Button
              type="button"
              data-testid="hr-detail-interval-open"
              onClick={() => openPanel('interval')}
            >
              انتقال / ارتقا / تمدید
            </Button>
          )}

          {/*
            The status control offers the TWO MANUAL statuses only. TERMINATED is produced by the
            dated termination panel below, never by this toggle — the API refuses it here.
          */}
          {employee.status === 'ACTIVE' ? (
            <Button
              type="button"
              data-testid="hr-detail-deactivate"
              disabled={isSaving}
              onClick={() => applyStatus('INACTIVE')}
              className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
            >
              غیرفعال‌سازی
            </Button>
          ) : employee.status === 'INACTIVE' ? (
            <Button
              type="button"
              data-testid="hr-detail-activate"
              disabled={isSaving}
              onClick={() => applyStatus('ACTIVE')}
              className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
            >
              فعال‌سازی
            </Button>
          ) : null}

          {canTerminate && (
            <Button
              type="button"
              data-testid="hr-detail-terminate-open"
              disabled={isSaving}
              onClick={() => openPanel('terminate')}
              className="bg-destructive text-primary-foreground hover:bg-destructive/90 disabled:opacity-40"
            >
              خاتمه همکاری
            </Button>
          )}

          {canRehire && (
            <Button
              type="button"
              data-testid="hr-detail-rehire-open"
              onClick={() => openPanel('rehire')}
            >
              استخدام مجدد
            </Button>
          )}

          <Button
            type="button"
            data-testid="hr-detail-settings-open"
            onClick={() => openPanel('settings')}
            className="bg-muted text-foreground hover:bg-muted/80"
          >
            ویرایش اطلاعات
          </Button>
        </div>
      )}

      {/* TERMINATED with no open interval: the ONLY state from which rehire is the answer. */}
      {canManage && employee.status === 'TERMINATED' && (
        <p className="mb-6 text-xs text-muted-foreground">
          این کارمند خاتمه‌یافته است. برای ادامه همکاری از «استخدام مجدد» استفاده کنید؛ فعال‌سازی
          مستقیم مجاز نیست.
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The record itself, and the two catalogues it points at. */}
      {/* ---------------------------------------------------------------- */}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <HrCard title="اطلاعات پرسنلی" testId="hr-detail-summary">
          <dl className="grid gap-4 sm:grid-cols-2">
            <HrField label="کد کارمندی">{employee.employeeCode}</HrField>
            <HrField label="حساب کاربری متصل">
              {/*
                `userId` is an opaque identifier and the API exposes no id→profile lookup on
                this route beyond the identity projection, so the link is shown as what it is.
                `null` is a NORMAL state — a person is employable before they are given a login.
              */}
              {employee.userId ?? 'بدون حساب کاربری متصل'}
            </HrField>
            <HrField label="وضعیت">
              <HrEmployeeStatusBadge status={employee.status} />
            </HrField>
            <HrField label="آخرین به‌روزرسانی">{hrDateLabel(employee.updatedAt.slice(0, 10))}</HrField>
          </dl>
        </HrCard>

        <HrCard title="ابلاغ جاری" testId="hr-detail-assignment">
          {assignment === null ? (
            /*
              No open interval. That is a real state the schema permits and the screen must
              state plainly — an employee with no current assignment has no unit to show, and
              inventing one from history would be a claim the API never made.
            */
            <CoreEmpty message="برای این کارمند بازه استخدامی در جریان وجود ندارد." />
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2">
              <HrField label="واحد سازمانی">
                {/* The resolved ref the API already sent, then the catalogue, then a dash. */}
                {assignment.organizationUnit?.name ??
                  refName(unitNames, assignment.organizationUnitId)}
              </HrField>
              <HrField label="سمت">
                {assignment.position?.title ?? refName(positionNames, assignment.positionId)}
              </HrField>
              <HrField label="نوع همکاری">
                {hrEmploymentTypeLabel(assignment.employmentType)}
              </HrField>
              <HrField label="وضعیت بازه">
                <HrBadge tone={assignment.status === 'ACTIVE' ? 'ok' : 'muted'}>
                  {hrIntervalStatusLabel(assignment.status)}
                </HrBadge>
              </HrField>
              <HrField label="تاریخ شروع">{hrDateLabel(assignment.startDate)}</HrField>
              <HrField label="شناسه مدیر">
                {/*
                  A MANAGER IS AN EMPLOYEE ID (§13), never a Core user id, and the API exposes
                  no employee id→name lookup — so it is shown as its identifier rather than
                  guessed at or silently dropped.
                */}
                {assignment.managerEmployeeId ?? '—'}
              </HrField>
            </dl>
          )}
        </HrCard>
      </div>

      <HrCard title="تاریخچه بازه‌های استخدامی" testId="hr-detail-history" className="mb-6">
        <HistoryTable
          history={employee.employmentHistory}
          unitNames={unitNames}
          positionNames={positionNames}
          catalogueReadable={canNameReferences}
        />
      </HrCard>

      {/* ---------------------------------------------------------------- */}
      {/* Write panels. One endpoint each, opened deliberately, never auto-submitted. */}
      {/* ---------------------------------------------------------------- */}

      {(mode === 'interval' || mode === 'rehire') && (
        <HrCard
          title={mode === 'rehire' ? 'استخدام مجدد' : 'انتقال / ارتقا / تمدید'}
          testId="hr-detail-interval-panel"
          className="mb-6"
        >
          <p className="mb-4 text-xs text-muted-foreground">
            {mode === 'rehire'
              ? 'یک بازه استخدامی جدید پس از بازه خاتمه‌یافته ثبت می‌شود.'
              : 'بازه جاری بسته و بازه‌ای جدید از تاریخ انتخابی آغاز میشود. تاریخچه حذف نمی‌شود.'}
          </p>

          {/* A picker with no catalogue behind it would be a control that can only fail. */}
          {!canNameReferences && (
            <HrNotice
              tone="error"
              message="ثبت بازه استخدامی به مجوز خواندن چارت سازمانی و سمت‌های سازمانی نیاز دارد."
            />
          )}
          {catalogueError && <HrNotice tone="error" message={catalogueError} />}

          <form onSubmit={submitInterval} className="grid gap-4 sm:grid-cols-2">
            <Select
              label="نوع همکاری"
              name="employmentType"
              value={intervalForm.employmentType}
              onChange={(event) =>
                setIntervalForm((prev) => ({
                  ...prev,
                  employmentType: event.target.value as HrEmploymentType,
                }))
              }
              options={employmentTypeOptions}
            />
            <Input
              label="تاریخ شروع"
              name="startDate"
              placeholder="YYYY-MM-DD"
              value={intervalForm.startDate}
              onChange={(event) =>
                setIntervalForm((prev) => ({ ...prev, startDate: event.target.value }))
              }
              required
            />
            <Select
              label="واحد سازمانی"
              name="organizationUnitId"
              data-testid="hr-interval-unit"
              value={intervalForm.organizationUnitId}
              disabled={isCatalogueLoading}
              onChange={(event) =>
                // The unit change CLEARS the position. The two are related on the server
                // (`assertPositionIsUsable`), so carrying the previous unit's position across
                // would be a body the API is right to refuse.
                setIntervalForm((prev) => ({
                  ...prev,
                  organizationUnitId: event.target.value,
                  positionId: '',
                }))
              }
              options={[{ value: '', label: 'انتخاب واحد سازمانی' }, ...unitOptions]}
            />
            <Select
              label="سمت"
              name="positionId"
              data-testid="hr-interval-position"
              value={intervalForm.positionId}
              disabled={isCatalogueLoading || intervalForm.organizationUnitId.length === 0}
              onChange={(event) =>
                setIntervalForm((prev) => ({ ...prev, positionId: event.target.value }))
              }
              options={[
                {
                  value: '',
                  label:
                    intervalForm.organizationUnitId.length === 0
                      ? 'ابتدا واحد را انتخاب کنید'
                      : 'انتخاب سمت',
                },
                ...formPositionOptions,
              ]}
            />
            <Input
              label="شناسه مدیر (اختیاری)"
              name="managerEmployeeId"
              placeholder="UUID کارمند مدیر"
              value={intervalForm.managerEmployeeId}
              onChange={(event) =>
                setIntervalForm((prev) => ({ ...prev, managerEmployeeId: event.target.value }))
              }
            />
            <div className="flex items-end gap-2">
              <Button type="submit" data-testid="hr-interval-submit" disabled={isSaving}>
                {isSaving ? 'در حال ثبت...' : 'ثبت بازه'}
              </Button>
              <Button
                type="button"
                data-testid="hr-interval-cancel"
                onClick={() => setMode(null)}
                className="bg-muted text-foreground hover:bg-muted/80"
              >
                انصراف
              </Button>
            </div>
          </form>
        </HrCard>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* TERMINATION — a DATED event, not a status edit. */}
      {/* ---------------------------------------------------------------- */}

      {mode === 'terminate' && (
        <HrCard title="خاتمه همکاری" testId="hr-detail-terminate-panel" className="mb-6">
          <p className="mb-4 text-xs text-muted-foreground">
            بازه جاری در تاریخ انتخابی بسته می‌شود و وضعیت کارمند «خاتمه‌یافته» می‌شود. هیچ
            بازه‌ای حذف نمی‌شود و بازگشت به همکاری فقط از طریق «استخدام مجدد» ممکن است.
          </p>

          <form onSubmit={submitTerminate} className="grid gap-4 sm:grid-cols-2">
            <Input
              label="تاریخ پایان"
              name="endDate"
              placeholder="YYYY-MM-DD"
              data-testid="hr-terminate-end-date"
              value={terminateForm.endDate}
              onChange={(event) =>
                setTerminateForm((prev) => ({ ...prev, endDate: event.target.value }))
              }
              required
            />
            <Input
              label="دلیل (اختیاری)"
              name="reason"
              data-testid="hr-terminate-reason"
              value={terminateForm.reason}
              onChange={(event) =>
                setTerminateForm((prev) => ({ ...prev, reason: event.target.value }))
              }
              // The API caps the reason at 500 characters; the field is capped to match, so the
              // limit is visible instead of being a 400 after the operator has typed past it.
              maxLength={500}
            />
            <div className="flex items-end gap-2">
              <Button
                type="submit"
                data-testid="hr-terminate-submit"
                disabled={isSaving}
                className="bg-destructive text-primary-foreground hover:bg-destructive/90 disabled:opacity-40"
              >
                {isSaving ? 'در حال ثبت...' : 'ثبت خاتمه همکاری'}
              </Button>
              <Button
                type="button"
                data-testid="hr-terminate-cancel"
                onClick={() => setMode(null)}
                className="bg-muted text-foreground hover:bg-muted/80"
              >
                انصراف
              </Button>
            </div>
          </form>
        </HrCard>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The two mutable employee fields: the code and the login link. */}
      {/* ---------------------------------------------------------------- */}

      {mode === 'settings' && (
        <HrCard title="ویرایش اطلاعات کارمند" testId="hr-detail-settings-panel">
          <p className="mb-4 text-xs text-muted-foreground">
            فقط کد کارمندی و پیوند حساب کاربری قابل ویرایش است. واحد، سمت و نوع همکاری بخشی از
            تاریخچه‌اند و از طریق «انتقال / ارتقا» تغییر می‌کنند.
          </p>

          <form onSubmit={submitSettings} className="grid gap-4 sm:grid-cols-2">
            <Input
              label="کد کارمندی"
              name="employeeCode"
              data-testid="hr-settings-code"
              value={settingsForm.employeeCode}
              onChange={(event) =>
                setSettingsForm((prev) => ({ ...prev, employeeCode: event.target.value }))
              }
              required
            />
            <Input
              label="شناسه حساب کاربری"
              name="userId"
              placeholder="UUID حساب کاربری"
              data-testid="hr-settings-user"
              value={settingsForm.userId}
              onChange={(event) =>
                setSettingsForm((prev) => ({ ...prev, userId: event.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground sm:col-span-2">
              خالی گذاشتن این فیلد، پیوند حساب کاربری را حذف می‌کند. فیلدی که تغییر نکرده باشد
              ارسال نمی‌شود.
            </p>
            <div className="flex items-end gap-2">
              <Button type="submit" data-testid="hr-settings-submit" disabled={isSaving}>
                {isSaving ? 'در حال ذخیره...' : 'ذخیره'}
              </Button>
              <Button
                type="button"
                data-testid="hr-settings-cancel"
                onClick={() => setMode(null)}
                className="bg-muted text-foreground hover:bg-muted/80"
              >
                انصراف
              </Button>
            </div>
          </form>
        </HrCard>
      )}
    </div>
  );
}
