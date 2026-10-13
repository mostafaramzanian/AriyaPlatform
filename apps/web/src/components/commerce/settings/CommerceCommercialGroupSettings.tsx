'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  COMMERCE_COMMERCIAL_MAX_GROUP_CODE_LENGTH,
  COMMERCE_COMMERCIAL_MAX_GROUP_NAME_LENGTH,
  COMMERCE_DEFAULT_PAGE_SIZE,
  createCommerceCommercialGroup,
  fetchCommerceCommercialGroups,
  updateCommerceCommercialGroup,
  type CommerceCommercialGroup,
  type CommerceCommercialGroupsPage,
} from '@/lib/commerce-api';
import { commerceActionErrorMessage } from '@/lib/commerce-labels';
import { CommerceFeedback, CommercePagination, CommerceSectionHeading } from '../commerce-ui';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CommerceMemberPicker, useCommerceMemberNames } from './CommerceMemberPicker';

/**
 * PHASE UI-4 (§14/§15): گروه‌های بازرگانی — a business object, never a database row.
 *
 * WHAT THE BACKEND ACTUALLY ALLOWS (C1-P §9): list, get, create (code + name + optional
 * liaison) and PATCH (name and/or liaison). There is NO delete route — §3-L removed
 * deletion from the surface on purpose — so no delete affordance is drawn, and `code` is
 * shown but never editable (the DTO says it is the tenant's key on the row).
 *
 * THE LIAISON PICKER (§15) sends exactly `liaisonUserId` — a directory-returned id the
 * backend verifies as a tenant member — and nothing else: no tenantId, no actor fields.
 * Without `admin.users.read` the picker states the limitation instead of accepting a
 * pasted identifier it cannot verify.
 */
export function CommerceCommercialGroupSettings({
  canConfigure,
  canReadDirectory,
}: {
  canConfigure: boolean;
  canReadDirectory: boolean;
}) {
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<CommerceCommercialGroupsPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  // Re-arms loading/cleared in every list-refresh handler below (same commit
  // as the token bump) — the page effect needs no in-effect setter resets —
  // and derives the mount skeleton from the cold `data: null`.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const busy = isLoading || (data === null && error === null);

  // Create dialog (commerce.configure)
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createCode, setCreateCode] = React.useState('');
  const [createName, setCreateName] = React.useState('');
  const [createLiaison, setCreateLiaison] = React.useState<string | null>(null);
  const [createPending, setCreatePending] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // Edit dialog (commerce.configure) — code is NOT part of this edit.
  const [editTarget, setEditTarget] = React.useState<CommerceCommercialGroup | null>(null);
  const [editName, setEditName] = React.useState('');
  const [editLiaison, setEditLiaison] = React.useState<string | null>(null);
  const [editPending, setEditPending] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;

    fetchCommerceCommercialGroups({ page, pageSize: COMMERCE_DEFAULT_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت فهرست گروه‌ها با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [page, reloadToken]);

  // Resolve liaison names for the visible page (bounded by the page size).
  const liaisonIds = React.useMemo(
    () => (data?.items ?? []).map((group) => group.liaisonUserId),
    [data]
  );
  const liaisonNames = useCommerceMemberNames(liaisonIds, canReadDirectory);

  const submitCreate = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (createPending) return;

    const code = createCode.trim();
    const name = createName.trim();
    if (!code) {
      setCreateError('کد گروه را وارد کنید.');
      return;
    }
    if (code.length > COMMERCE_COMMERCIAL_MAX_GROUP_CODE_LENGTH) {
      setCreateError(`کد گروه حداکثر ${COMMERCE_COMMERCIAL_MAX_GROUP_CODE_LENGTH} نویسه است.`);
      return;
    }
    if (!name) {
      setCreateError('نام گروه را وارد کنید.');
      return;
    }
    if (name.length > COMMERCE_COMMERCIAL_MAX_GROUP_NAME_LENGTH) {
      setCreateError(`نام گروه حداکثر ${COMMERCE_COMMERCIAL_MAX_GROUP_NAME_LENGTH} نویسه است.`);
      return;
    }

    setCreatePending(true);
    setCreateError(null);
    createCommerceCommercialGroup({
      code,
      name,
      ...(createLiaison ? { liaisonUserId: createLiaison } : {}),
    })
      .then((created) => {
        setCreatePending(false);
        setCreateOpen(false);
        setCreateCode('');
        setCreateName('');
        setCreateLiaison(null);
        setFeedback(`گروه «${created.name}» ایجاد شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setCreatePending(false);
        setCreateError(commerceActionErrorMessage(err, 'ایجاد گروه انجام نشد.'));
      });
  };

  const submitEdit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!editTarget || editPending) return;

    const name = editName.trim();
    if (!name) {
      setEditError('نام گروه را وارد کنید.');
      return;
    }
    if (name.length > COMMERCE_COMMERCIAL_MAX_GROUP_NAME_LENGTH) {
      setEditError(`نام گروه حداکثر ${COMMERCE_COMMERCIAL_MAX_GROUP_NAME_LENGTH} نویسه است.`);
      return;
    }

    setEditPending(true);
    setEditError(null);
    updateCommerceCommercialGroup(editTarget.id, {
      ...(name !== editTarget.name ? { name } : {}),
      // `null` CLEARS the liaison on purpose (a modelled state); omitted = untouched.
      ...(editLiaison !== editTarget.liaisonUserId ? { liaisonUserId: editLiaison } : {}),
    })
      .then((updated) => {
        setEditPending(false);
        setEditTarget(null);
        setFeedback(`گروه «${updated.name}» به‌روزرسانی شد.`);
        reload();
      })
      .catch((err: unknown) => {
        setEditPending(false);
        setEditError(commerceActionErrorMessage(err, 'ذخیرهٔ گروه انجام نشد.'));
      });
  };

  const groups = data?.items ?? [];
  const showInitialLoading = isLoading && data === null;

  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
      <CommerceSectionHeading
        title="گروه‌های بازرگانی"
        description="هر گروه مسئول رسیدگی به دسته‌ای از ردیف‌های خرید است؛ رابط بازرگانی مسئول پاسخگویی به آن گروه است."
        actions={
          canConfigure ? (
            <Button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
              data-testid="commerce-commercial-group-create-open"
              className="text-xs"
            >
              گروه جدید
            </Button>
          ) : undefined
        }
      />

      <CommerceFeedback message={feedback} testId="commerce-commercial-group-feedback" />

      {showInitialLoading || busy ? (
        <CoreLoading lines={4} />
      ) : error ? (
        <CoreError message={error} onRetry={reload} />
      ) : groups.length === 0 ? (
        <div data-testid="commerce-commercial-group-empty">
          <p className="rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center text-sm text-muted-foreground">
            هنوز گروه بازرگانی تعریف نشده است.
          </p>
          {canConfigure && (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                onClick={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
                className="text-xs"
              >
                ایجاد گروه
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border" data-testid="commerce-commercial-group-rows">
            {groups.map((group) => (
              <li
                key={group.id}
                data-testid={`commerce-commercial-group-${group.code}`}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-medium text-foreground">{group.name}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span dir="ltr" className="rounded-md bg-muted px-2 py-0.5">
                      {group.code}
                    </span>
                    <span>
                      رابط بازرگانی:{' '}
                      {group.liaisonUserId
                        ? liaisonNames.get(group.liaisonUserId) ??
                          (canReadDirectory ? 'نامشخص' : 'تعیین شده')
                        : 'تعیین نشده'}
                    </span>
                  </div>
                </div>
                {canConfigure && (
                  <Button
                    type="button"
                    onClick={() => {
                      setEditError(null);
                      setEditName(group.name);
                      setEditLiaison(group.liaisonUserId);
                      setEditTarget(group);
                    }}
                    data-testid={`commerce-commercial-group-edit-${group.code}`}
                    className="border border-border bg-background text-xs text-foreground hover:bg-secondary"
                  >
                    ویرایش
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <CommercePagination
            page={data?.page ?? page}
            pageSize={data?.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE}
            total={data?.total ?? 0}
            onPageChange={(next) => {
              // Page changes re-arm in the same handler commit (the removed
              // in-effect setters used to arm one render later).
              setLoading(true);
              setError(null);
              setPage(next);
            }}
            disabled={isLoading}
          />
        </>
      )}

      <CommerceSettingsDialog
        open={createOpen}
        title="گروه بازرگانی جدید"
        description="گروه، واحد رسیدگی به ردیف‌های خرید است. رابط بازرگانی اختیاری است."
        pending={createPending}
        onCancel={() => {
          if (!createPending) setCreateOpen(false);
        }}
        testId="commerce-commercial-group-create-dialog"
        footer={
          <>
            <Button
              type="button"
              disabled={createPending}
              onClick={() => setCreateOpen(false)}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={() => submitCreate()}
              disabled={createPending}
              aria-busy={createPending}
              data-testid="commerce-commercial-group-create-submit"
            >
              {createPending ? 'در حال ایجاد…' : 'ایجاد گروه'}
            </Button>
          </>
        }
      >
        <form
          id="commerce-commercial-group-create-form"
          onSubmit={submitCreate}
          className="space-y-4"
        >
          <Input
            data-testid="commerce-commercial-group-code"
            id="commerce-commercial-group-code"
            name="code"
            label="کد گروه"
            dir="ltr"
            value={createCode}
            onChange={(event) => setCreateCode(event.target.value)}
            placeholder="standard-goods"
            required
          />
          <p className="-mt-3 text-xs text-muted-foreground">
            کد، شناسهٔ یکتای گروه است و پس از ایجاد قابل تغییر نیست.
          </p>
          <Input
            data-testid="commerce-commercial-group-name"
            id="commerce-commercial-group-name"
            name="name"
            label="نام گروه"
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder="کالای استاندارد"
            required
          />
          <CommerceMemberPicker
            id="commerce-commercial-group-create-liaison"
            label="رابط بازرگانی (اختیاری)"
            value={createLiaison}
            onChange={setCreateLiaison}
            enabled={canReadDirectory}
            disabled={createPending}
            limitationText="برای انتخاب رابط، مجوز مشاهدهٔ فهرست سازمانی (admin.users.read) لازم است؛ گروه همچنان بدون رابط قابل ایجاد است."
            testId="commerce-commercial-group-create-liaison"
          />
          {createError && (
            <p
              role="alert"
              data-testid="commerce-commercial-group-create-error"
              className="text-xs text-destructive"
            >
              {createError}
            </p>
          )}
        </form>
      </CommerceSettingsDialog>

      <CommerceSettingsDialog
        open={editTarget !== null}
        title="ویرایش گروه بازرگانی"
        description={
          editTarget ? (
            <>
              کد گروه (<span dir="ltr">{editTarget.code}</span>) تغییرناپذیر است.
            </>
          ) : undefined
        }
        pending={editPending}
        onCancel={() => {
          if (!editPending) setEditTarget(null);
        }}
        testId="commerce-commercial-group-edit-dialog"
        footer={
          <>
            <Button
              type="button"
              disabled={editPending}
              onClick={() => setEditTarget(null)}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={() => submitEdit()}
              disabled={editPending}
              aria-busy={editPending}
              data-testid="commerce-commercial-group-edit-submit"
            >
              {editPending ? 'در حال ثبت…' : 'ذخیرهٔ تغییرات'}
            </Button>
          </>
        }
      >
        <form
          id="commerce-commercial-group-edit-form"
          onSubmit={submitEdit}
          className="space-y-4"
        >
          <Input
            data-testid="commerce-commercial-group-edit-name"
            id="commerce-commercial-group-edit-name"
            name="name"
            label="نام گروه"
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
            required
          />
          <CommerceMemberPicker
            id="commerce-commercial-group-edit-liaison"
            label="رابط بازرگانی"
            value={editLiaison}
            onChange={setEditLiaison}
            enabled={canReadDirectory}
            disabled={editPending}
            limitationText="برای تغییر رابط، مجوز مشاهدهٔ فهرست سازمانی (admin.users.read) لازم است."
            testId="commerce-commercial-group-edit-liaison"
          />
          {editError && (
            <p
              role="alert"
              data-testid="commerce-commercial-group-edit-error"
              className="text-xs text-destructive"
            >
              {editError}
            </p>
          )}
        </form>
      </CommerceSettingsDialog>
    </section>
  );
}