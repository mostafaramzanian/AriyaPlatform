'use client';

import * as React from 'react';

import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createMissionOption,
  createMissionOptionGroup,
  fetchMissionOptionGroups,
  updateMissionOption,
  updateMissionOptionGroup,
  type CreateMissionOptionGroupInput,
  type HrMissionOption,
  type HrMissionOptionGroup,
  type UpdateMissionOptionGroupInput,
  type UpdateMissionOptionInput,
} from '@/lib/hr-mission-api';
import { missionCatalogueActiveLabel, missionCatalogueActiveTone } from '@/lib/hr-mission-labels';
import { HrBadge, HrCard, HrNotice } from './hr-ui';

/**
 * Phase 55 Step 8D: DOMAIN 1 — the Mission OPTION CATALOGUE for `hr.mission.policy` holders.
 *
 * WHAT THE CATALOGUE IS, AND WHY THIS SCREEN ONLY EDITS WHAT EXISTS
 * ---------------------------------------------------------------
 * A group is a QUESTION («مدت ماموریت») and each option is an ANSWER («ساعتی»، «روزانه»). The
 * backend derives the three stored facts — `durationMode`, `locationType`, `engagementType` — by
 * looking each group's CODE up in `MISSION_FACT_GROUPS` and each option's CODE up in
 * `MISSION_FACT_OPTIONS` (`mission-options.ts`). A code outside those maps makes a selection
 * `unmapped-option`, which is a refusal on the request path.
 *
 * THAT IS WHY THIS SCREEN DOES NOT VALIDATE CODES. It renders the server's rows and posts exactly
 * the fields the DTO declares. It does NOT carry a list of "allowed codes", because the only
 * authoritative record of what is mappable lives in the domain module this client deliberately does
 * not own — a hardcoded copy here could drift from it, and it would refuse catalogue rows the
 * backend accepts. What it does instead is WARN about a code the frozen rule set does not serve
 * (`codeWarning`), because an unclassifiable row is a real trap for the operator who just created
 * it. The warning names what exists; it never redefines it.
 *
 * THERE IS NO DELETE, AND THE SCREEN SAYS SO. Every write route here is a create or an update; the
 * only way to retire a row is `active: false`, which preserves it for every request already recorded
 * against it. Rendering a delete control would offer an operation the contract does not have.
 *
 * WHAT IT NEVER SENDS: `tenantId`, `actorId`, `projectId`, a status, a revision or any server-derived
 * field. Every body is built field by field in the builders below, so the shape is inspectable
 * rather than spread from a form object that could carry more than the DTO allows.
 */

/** The three group codes the frozen Mission rule set serves — named in a warning, never enforced. */
const RULE_SERVED_GROUPS = 'DURATION، LOCATION، ENGAGEMENT';

/**
 * A sentence about a code the rule set does not serve, or `null` when there is nothing to warn about.
 *
 * WHY A WARNING RATHER THAN A REFUSAL. The backend accepts any code up to 64 characters; whether a
 * code is CLASSIFIABLE is a property of `mission-options.ts`, not of this DTO. So the panel reports
 * the one it does not recognise and lets the operator decide — the same latitude the DTO gives. This
 * is NOT an allow-list: it compares nothing to a set of OPTIONS, because an option's vocabulary is
 * the tenant's and this screen does not own it.
 */
function codeWarning(kind: 'group' | 'option', code: string): string | null {
  const trimmed = code.trim();
  if (trimmed === '') return null;

  if (kind === 'group') {
    return ['DURATION', 'LOCATION', 'ENGAGEMENT'].includes(trimmed)
      ? null
      : `کد گروه «${trimmed}» در فهرست گروه‌های قواعد ماموریت (${RULE_SERVED_GROUPS}) نیست؛ درخواست‌هایی که گزینه‌ای از آن را انتخاب کنند دسته‌بندی نخواهند شد.`;
  }

  return null;
}

/** The API's own message when it gave one, and this panel's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// The request bodies — each one the DTO's own fields, and nothing else
// ---------------------------------------------------------------------------

/**
 * `CreateMissionOptionGroupDto`: `code`, `label`, `required?`, `sortOrder?`.
 *
 * `sortOrder` is omitted rather than sent as `undefined` when the field is blank. The DTO's
 * `@IsOptional()` makes the two equivalent to the server, but a body carrying the key would put a
 * value in the wire log that the operator never typed.
 */
function buildCreateGroupBody(
  code: string,
  label: string,
  required: boolean,
  sortOrder: string
): CreateMissionOptionGroupInput {
  const body: CreateMissionOptionGroupInput = {
    code: code.trim(),
    label: label.trim(),
    required,
  };
  const order = sortOrder.trim();
  if (order !== '') body.sortOrder = Number(order);
  return body;
}

/**
 * `UpdateMissionOptionGroupDto`: `label?`, `required?`, `sortOrder?`, `active?`.
 *
 * `code` IS DELIBERATELY ABSENT and the builder cannot express it: it is the stable machine key the
 * classification is derived from, so renaming it would silently reclassify every existing request.
 */
function buildUpdateGroupBody(
  label: string,
  required: boolean,
  sortOrder: string,
  active: boolean
): UpdateMissionOptionGroupInput {
  const body: UpdateMissionOptionGroupInput = {
    label: label.trim(),
    required,
    active,
  };
  const order = sortOrder.trim();
  if (order !== '') body.sortOrder = Number(order);
  return body;
}

/** `CreateMissionOptionDto`: `code`, `label`, `active?`, `sortOrder?`. */
function buildCreateOptionBody(code: string, label: string, sortOrder: string) {
  const body: { code: string; label: string; sortOrder?: number } = {
    code: code.trim(),
    label: label.trim(),
  };
  const order = sortOrder.trim();
  if (order !== '') body.sortOrder = Number(order);
  return body;
}

/**
 * `UpdateMissionOptionDto`: `label?`, `active?`, `sortOrder?`.
 *
 * `code` is absent for the same reason as on the group, and neither id is in the body: the group
 * scopes the row and the option identifies it, both in the PATH.
 */
function buildUpdateOptionBody(
  label: string,
  sortOrder: string,
  active: boolean
): UpdateMissionOptionInput {
  const body: UpdateMissionOptionInput = { label: label.trim(), active };
  const order = sortOrder.trim();
  if (order !== '') body.sortOrder = Number(order);
  return body;
}
// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * ONE option, with an in-place editor.
 *
 * The editor sends `label`, `active` and `sortOrder` — the three the option PATCH accepts — and
 * shows the CODE as read-only text rather than a disabled input, because an input that looks
 * editable and refuses every keystroke is a worse lie than a label. `code` is what makes the option
 * classifiable, so the draft's own code is what the warning is judged against.
 */
function MissionOptionRow({
  group,
  option,
  isBusy,
  onSaved,
  onError,
}: {
  group: HrMissionOptionGroup;
  option: HrMissionOption;
  isBusy: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [isOpen, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState(option.label);
  const [sortOrder, setSortOrder] = React.useState(String(option.sortOrder));
  const [active, setActive] = React.useState(option.active);
  const [isSaving, setSaving] = React.useState(false);

  const open = () => {
    setLabel(option.label);
    setSortOrder(String(option.sortOrder));
    setActive(option.active);
    setOpen(true);
  };

  const save = async () => {
    if (isSaving) return;
    setSaving(true);
    try {
      await updateMissionOption(
        group.id,
        option.id,
        buildUpdateOptionBody(label, sortOrder, active)
      );
      setOpen(false);
      onSaved();
    } catch (err: unknown) {
      onError(describe(err, 'ویرایش گزینه با خطا مواجه شد.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2"
      data-testid={`hr-mission-option-${option.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="font-mono text-xs text-muted-foreground"
          data-testid={`hr-mission-option-code-${option.id}`}
        >
          {option.code}
        </span>
        <span
          className="text-sm text-foreground"
          data-testid={`hr-mission-option-label-${option.id}`}
        >
          {option.label}
        </span>
        <HrBadge
          tone={missionCatalogueActiveTone(option.active)}
          testId={`hr-mission-option-active-${option.id}`}
        >
          {missionCatalogueActiveLabel(option.active)}
        </HrBadge>
        <Button
          type="button"
          data-testid={`hr-mission-option-edit-${option.id}`}
          onClick={open}
          className="bg-muted text-foreground hover:bg-muted/80"
        >
          ویرایش گزینه
        </Button>
      </div>

      {isOpen && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="عنوان گزینه"
              data-testid={`hr-mission-option-label-input-${option.id}`}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Input
              label="ترتیب نمایش"
              data-testid={`hr-mission-option-sort-input-${option.id}`}
              value={sortOrder}
              inputMode="numeric"
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              data-testid={`hr-mission-option-active-input-${option.id}`}
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            فعال باشد
          </label>

          {/* The code is NOT editable and is shown as text: it is the machine key the classification
              is derived from, so an editable-looking field would invite a rename that reclassifies
              every request already recorded against this option (§8D domain 1 rule 5). */}
          <p className="text-xs text-muted-foreground">
            کد گزینه قابل تغییر نیست و مرجع ماشینی دسته‌بندی است.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid={`hr-mission-option-save-${option.id}`}
              onClick={save}
              disabled={isSaving || isBusy || label.trim() === ''}
            >
              ذخیره
            </Button>
            <Button
              type="button"
              data-testid={`hr-mission-option-cancel-${option.id}`}
              onClick={() => setOpen(false)}
              disabled={isSaving}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Option groups
// ---------------------------------------------------------------------------

/**
 * ONE group: its own in-place editor, its options, and a form to add an option.
 *
 * `group.options` IS OPTIONAL in the type — the paginated read `include`s the options, a single-row
 * response need not — so the list distinguishes "no options" from "not carried" rather than
 * rendering an empty state that would mean both.
 */
function MissionOptionGroupCard({
  group,
  isBusy,
  onSaved,
  onError,
}: {
  group: HrMissionOptionGroup;
  isBusy: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [isEditing, setEditing] = React.useState(false);
  const [label, setLabel] = React.useState(group.label);
  const [sortOrder, setSortOrder] = React.useState(String(group.sortOrder));
  const [required, setRequired] = React.useState(group.required);
  const [active, setActive] = React.useState(group.active);
  const [isSaving, setSaving] = React.useState(false);

  const [isAdding, setAdding] = React.useState(false);
  const [newCode, setNewCode] = React.useState('');
  const [newLabel, setNewLabel] = React.useState('');
  const [newSortOrder, setNewSortOrder] = React.useState('');
  const [isCreating, setCreating] = React.useState(false);

  const openEditor = () => {
    setLabel(group.label);
    setSortOrder(String(group.sortOrder));
    setRequired(group.required);
    setActive(group.active);
    setEditing(true);
  };

  const saveGroup = async () => {
    if (isSaving) return;
    setSaving(true);
    try {
      await updateMissionOptionGroup(
        group.id,
        buildUpdateGroupBody(label, required, sortOrder, active)
      );
      setEditing(false);
      onSaved();
    } catch (err: unknown) {
      onError(describe(err, 'ویرایش گروه گزینه‌ها با خطا مواجه شد.'));
    } finally {
      setSaving(false);
    }
  };

  const addOption = async () => {
    if (isCreating) return;
    setCreating(true);
    try {
      await createMissionOption(group.id, buildCreateOptionBody(newCode, newLabel, newSortOrder));
      setNewCode('');
      setNewLabel('');
      setNewSortOrder('');
      setAdding(false);
      onSaved();
    } catch (err: unknown) {
      onError(describe(err, 'افزودن گزینه با خطا مواجه شد.'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <HrCard testId={`hr-mission-option-group-${group.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="font-mono text-xs text-muted-foreground"
          data-testid={`hr-mission-group-code-${group.code}`}
        >
          {group.code}
        </span>
        <h3
          className="text-base font-semibold text-foreground"
          data-testid={`hr-mission-group-label-${group.code}`}
        >
          {group.label}
        </h3>
        <HrBadge
          tone={missionCatalogueActiveTone(group.active)}
          testId={`hr-mission-group-active-${group.code}`}
        >
          {missionCatalogueActiveLabel(group.active)}
        </HrBadge>
        {/* `required` is the catalogue's OWN flag — it drives the employee form's completeness rule
            AND the server re-validates it, so it is stated rather than inferred from anything. */}
        <HrBadge tone="muted" testId={`hr-mission-group-required-${group.code}`}>
          {group.required ? 'انتخاب الزامی' : 'انتخاب اختیاری'}
        </HrBadge>
        <Button
          type="button"
          data-testid={`hr-mission-group-edit-${group.code}`}
          onClick={openEditor}
          className="bg-muted text-foreground hover:bg-muted/80"
        >
          ویرایش گروه
        </Button>
        <Button
          type="button"
          data-testid={`hr-mission-group-add-option-${group.code}`}
          onClick={() => setAdding((open) => !open)}
        >
          افزودن گزینه
        </Button>
      </div>

      {isEditing && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="عنوان گروه"
              data-testid={`hr-mission-group-label-input-${group.code}`}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Input
              label="ترتیب نمایش"
              data-testid={`hr-mission-group-sort-input-${group.code}`}
              value={sortOrder}
              inputMode="numeric"
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid={`hr-mission-group-required-input-${group.code}`}
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />
              انتخاب از این گروه الزامی باشد
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid={`hr-mission-group-active-input-${group.code}`}
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />
              فعال باشد
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            کد گروه قابل تغییر نیست و مرجع ماشینی دسته‌بندی است.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid={`hr-mission-group-save-${group.code}`}
              onClick={saveGroup}
              disabled={isSaving || isBusy || label.trim() === ''}
            >
              ذخیره
            </Button>
            <Button
              type="button"
              data-testid={`hr-mission-group-cancel-${group.code}`}
              onClick={() => setEditing(false)}
              disabled={isSaving}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </div>
      )}

      {/* The options the SERVER returned, in the order it returned them. No client sort: `sortOrder`
          is the tenant's statement about ordering and a second arrangement here would disagree with
          the employee form which reads the same list. */}
      <div className="mt-4">
        {group.options === undefined ? (
          <p className="text-sm text-muted-foreground">
            گزینه‌های این گروه همراه پاسخ سرور ارسال نشده است.
          </p>
        ) : group.options.length === 0 ? (
          <CoreEmpty message="این گروه هنوز گزینه‌ای ندارد." />
        ) : (
          <ul className="flex flex-col gap-2" data-testid={`hr-mission-options-${group.code}`}>
            {group.options.map((option) => (
              <MissionOptionRow
                key={option.id}
                group={group}
                option={option}
                isBusy={isBusy}
                onSaved={onSaved}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </div>

      {isAdding && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="کد گزینه"
              data-testid={`hr-mission-option-new-code-${group.code}`}
              value={newCode}
              onChange={(event) => setNewCode(event.target.value)}
            />
            <Input
              label="عنوان گزینه"
              data-testid={`hr-mission-option-new-label-${group.code}`}
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
            />
            <Input
              label="ترتیب نمایش"
              data-testid={`hr-mission-option-new-sort-${group.code}`}
              value={newSortOrder}
              inputMode="numeric"
              onChange={(event) => setNewSortOrder(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid={`hr-mission-option-new-save-${group.code}`}
              onClick={addOption}
              disabled={isCreating || isBusy || newCode.trim() === '' || newLabel.trim() === ''}
            >
              افزودن
            </Button>
            <Button
              type="button"
              data-testid={`hr-mission-option-new-cancel-${group.code}`}
              onClick={() => setAdding(false)}
              disabled={isCreating}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </div>
      )}
    </HrCard>
  );
}

// ---------------------------------------------------------------------------
// The catalogue panel
// ---------------------------------------------------------------------------

/**
 * DOMAIN 1 — the option catalogue.
 *
 * ONE READ, AND IT IS THE AUTHORITY. `fetchMissionOptionGroups` answers with each group's options
 * included, so the panel needs exactly one request to render the whole catalogue — and after EVERY
 * successful mutation it re-reads rather than patching its local copy. The server enforces its own
 * uniqueness and ordering, so a list assembled locally from responses could disagree with it.
 * Re-reading is also what makes the `active` flags on screen the SERVER's, which this step requires.
 *
 * NO OPTIMISTIC WRITE. A create or an update does not touch `groups`; it awaits the call and then
 * asks for the catalogue again. An operator who sees their change appear has seen the server accept
 * it — and one whose change was refused sees the refusal instead of a row that does not exist.
 */
export function MissionOptionCataloguePanel() {
  const [groups, setGroups] = React.useState<HrMissionOptionGroup[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** The notice's own tone, so a REFUSAL is never rendered as a success. */
  const [noticeTone, setNoticeTone] = React.useState<'ok' | 'error'>('ok');
  const [isMutating, setMutating] = React.useState(false);
  // Re-arms loading/cleared in `refresh` (same commit as the token bump), so
  // the list effect needs no in-effect setter resets. First mount is covered
  // by `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);

  const [isCreating, setCreating] = React.useState(false);
  const [newCode, setNewCode] = React.useState('');
  const [newLabel, setNewLabel] = React.useState('');
  const [newSortOrder, setNewSortOrder] = React.useState('');
  const [newRequired, setNewRequired] = React.useState(true);

  const refresh = React.useCallback(() => {
    setMutating(false);
    reloadList();
  }, [reloadList]);

  React.useEffect(() => {
    let active = true;

    fetchMissionOptionGroups()
      .then((result) => {
        if (!active) return;
        setGroups(result.items);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setGroups([]);
        setError(describe(err, 'دریافت فهرست گزینه‌های ماموریت با خطا مواجه شد.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadToken]);

  const createGroup = async () => {
    if (isMutating) return;
    setMutating(true);
    setNotice(null);
    try {
      await createMissionOptionGroup(
        buildCreateGroupBody(newCode, newLabel, newRequired, newSortOrder)
      );
      setNewCode('');
      setNewLabel('');
      setNewSortOrder('');
      setNewRequired(true);
      setCreating(false);
      setNoticeTone('ok');
      setNotice('گروه گزینه‌ها افزوده شد.');
      refresh();
    } catch (err: unknown) {
      setMutating(false);
      setNoticeTone('error');
      setNotice(describe(err, 'افزودن گروه گزینه‌ها با خطا مواجه شد.'));
    }
  };

  /** A failed in-place write: surfaced ONCE at panel level, and no blind re-read follows it. */
  const reportMutationError = (message: string) => {
    setMutating(false);
    setNoticeTone('error');
    setNotice(message);
  };

  if (isLoading) return <CoreLoading lines={5} />;

  if (error !== null) {
    return <CoreError message={error} onRetry={refresh} />;
  }

  const groupCodeWarning = codeWarning('group', newCode);

  return (
    <div className="flex flex-col gap-4">
      {notice !== null && <HrNotice tone={noticeTone} message={notice} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          data-testid="hr-mission-catalogue-create-group"
          onClick={() => setCreating((open) => !open)}
        >
          افزودن گروه گزینه‌ها
        </Button>
      </div>

      {isCreating && (
        <HrCard className="mt-3" testId="hr-mission-catalogue-create-group-form">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="کد گروه"
              data-testid="hr-mission-catalogue-new-group-code"
              value={newCode}
              onChange={(event) => setNewCode(event.target.value)}
            />
            <Input
              label="عنوان گروه"
              data-testid="hr-mission-catalogue-new-group-label"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
            />
            <Input
              label="ترتیب نمایش"
              data-testid="hr-mission-catalogue-new-group-sort"
              value={newSortOrder}
              inputMode="numeric"
              onChange={(event) => setNewSortOrder(event.target.value)}
            />
          </div>

          <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              data-testid="hr-mission-catalogue-new-group-required"
              checked={newRequired}
              onChange={(event) => setNewRequired(event.target.checked)}
            />
            انتخاب از این گروه الزامی باشد
          </label>

          {/* The rule set serves three groups with a fixed option vocabulary. A code outside them is
              accepted by the DTO and yields requests the engine cannot classify, so the operator is
              told BEFORE saving rather than after a request is refused downstream. */}
          {groupCodeWarning !== null && (
            <p
              data-testid="hr-mission-catalogue-group-code-warning"
              className="mt-3 rounded-xl border border-border bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
            >
              {groupCodeWarning}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid="hr-mission-catalogue-new-group-save"
              onClick={createGroup}
              disabled={isMutating || newCode.trim() === '' || newLabel.trim() === ''}
            >
              افزودن
            </Button>
            <Button
              type="button"
              data-testid="hr-mission-catalogue-new-group-cancel"
              onClick={() => setCreating(false)}
              disabled={isMutating}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </HrCard>
      )}

      {groups.length === 0 && !isCreating ? (
        <CoreEmpty message="فهرست گزینه‌های ماموریت خالی است؛ هنوز گروهی تعریف نشده است." />
      ) : (
        <div className="flex flex-col gap-4" data-testid="hr-mission-catalogue">
          {groups.map((group) => (
            <MissionOptionGroupCard
              key={group.id}
              group={group}
              isBusy={isMutating}
              onSaved={refresh}
              onError={reportMutationError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
