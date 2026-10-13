'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_WORKFLOW_MAX_DEFINITION_CODE_LENGTH,
  COMMERCE_WORKFLOW_MAX_DEFINITION_NAME_LENGTH,
  createCommerceWorkflowDefinition,
  fetchCommerceWorkflowDefinitions,
  renameCommerceWorkflowDefinition,
  type CommerceWorkflowDefinition,
  type CommerceWorkflowDefinitionsPage,
} from '@/lib/commerce-api';
import { commerceActionErrorMessage, commerceInstantLabel } from '@/lib/commerce-labels';
import { toPersianDigits } from '@/lib/calendar-api';
import { CommerceFeedback, CommercePagination, CommerceSectionHeading } from '../commerce-ui';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCommerceSettingsGuard } from './CommerceSettingsGuard';
import { CommerceWorkflowVersionList } from './CommerceWorkflowVersionList';

/**
 * PHASE UI-4: «فرآیندهای خرید» — the workflow definitions, in the words an
 * administrator reads.
 *
 * THE MENTAL MODEL, TOP LEVEL: a «فرآیند خرید» is the container an administrator names
 * (a code and a title). Its VERSIONS are what actually govern purchases, and they are
 * managed one level down (`CommerceWorkflowVersionList` → `CommerceWorkflowEditor`)
 * because that is where draft/published/immutable becomes concrete. The backend's row
 * names never appear in the primary UI; a definition's `code` is shown as the small
 * technical handle it is.
 *
 * WHAT EXISTS HERE, EXACTLY: the definition routes — list, get, create
 * (`commerce.configure`), rename (`commerce.configure`). There is NO delete route in the
 * backend and therefore no delete affordance here: an absent capability is not drawn.
 *
 * NAVIGATION AND THE GUARD: choosing another definition (or another version) can
 * unmount a dirty editor, so every selection routes through `requestGuard` — the same
 * prompt the sub-navigation uses. No silent loss anywhere inside the domain.
 */

export function CommerceWorkflowSettings({
  canConfigure,
  canWorkflowManage,
  canReadDirectory,
}: {
  canConfigure: boolean;
  canWorkflowManage: boolean;
  canReadDirectory: boolean;
}) {
  const { requestGuard } = useCommerceSettingsGuard();

  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<CommerceWorkflowDefinitionsPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  // Re-arms loading/cleared in every list-refresh handler below (same commit
  // as the token bump) — the search/page effect needs no in-effect setter
  // resets — and derives the mount skeleton from the cold `data: null`.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const busy = isLoading || (data === null && error === null);

  const [selected, setSelected] = React.useState<CommerceWorkflowDefinition | null>(null);

  // Create dialog (commerce.configure)
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createCode, setCreateCode] = React.useState('');
  const [createName, setCreateName] = React.useState('');
  const [createPending, setCreatePending] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // Rename dialog (commerce.configure)
  const [renameTarget, setRenameTarget] = React.useState<CommerceWorkflowDefinition | null>(null);
  const [renameName, setRenameName] = React.useState('');
  const [renamePending, setRenamePending] = React.useState(false);
  const [renameError, setRenameError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;

    fetchCommerceWorkflowDefinitions({
      page,
      pageSize: COMMERCE_DEFAULT_PAGE_SIZE,
      ...(appliedSearch ? { search: appliedSearch } : {}),
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت فهرست فرآیندها با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [page, appliedSearch, reloadToken]);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setAppliedSearch(searchInput.trim());
    setPage(1);
    // Same-commit re-arm (the removed in-effect setters used to arm one render
    // later).
    setLoading(true);
    setError(null);
    reload();
  };

  const selectDefinition = (definition: CommerceWorkflowDefinition) => {
    if (selected?.id === definition.id) return;
    requestGuard(() => setSelected(definition));
  };

  const submitCreate = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (createPending) return;

    const code = createCode.trim();
    const name = createName.trim();
    if (!code) {
      setCreateError('کد فرآیند را وارد کنید.');
      return;
    }
    if (code.length > COMMERCE_WORKFLOW_MAX_DEFINITION_CODE_LENGTH) {
      setCreateError(`کد فرآیند حداکثر ${COMMERCE_WORKFLOW_MAX_DEFINITION_CODE_LENGTH} نویسه است.`);
      return;
    }
    if (!name) {
      setCreateError('نام فرآیند را وارد کنید.');
      return;
    }
    if (name.length > COMMERCE_WORKFLOW_MAX_DEFINITION_NAME_LENGTH) {
      setCreateError(`نام فرآیند حداکثر ${COMMERCE_WORKFLOW_MAX_DEFINITION_NAME_LENGTH} نویسه است.`);
      return;
    }

    setCreatePending(true);
    setCreateError(null);
    createCommerceWorkflowDefinition({ code, name })
      .then((created) => {
        setCreatePending(false);
        setCreateOpen(false);
        setCreateCode('');
        setCreateName('');
        setFeedback(`فرآیند «${created.name}» ایجاد شد. اکنون می‌توانید نسخهٔ آن را بسازید.`);
        reload();
        setSelected(created);
      })
      .catch((err: unknown) => {
        setCreatePending(false);
        setCreateError(commerceActionErrorMessage(err, 'ایجاد فرآیند انجام نشد.'));
      });
  };

  const submitRename = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!renameTarget || renamePending) return;

    const name = renameName.trim();
    if (!name) {
      setRenameError('نام فرآیند را وارد کنید.');
      return;
    }
    if (name.length > COMMERCE_WORKFLOW_MAX_DEFINITION_NAME_LENGTH) {
      setRenameError(`نام فرآیند حداکثر ${COMMERCE_WORKFLOW_MAX_DEFINITION_NAME_LENGTH} نویسه است.`);
      return;
    }

    setRenamePending(true);
    setRenameError(null);
    renameCommerceWorkflowDefinition(renameTarget.id, { name })
      .then((renamed) => {
        setRenamePending(false);
        setRenameTarget(null);
        setFeedback(`نام فرآیند به «${renamed.name}» تغییر یافت.`);
        reload();
        setSelected((current) => (current?.id === renamed.id ? renamed : current));
      })
      .catch((err: unknown) => {
        setRenamePending(false);
        setRenameError(commerceActionErrorMessage(err, 'تغییر نام فرآیند انجام نشد.'));
      });
  };

  const definitions = data?.items ?? [];
  const hasActiveSearch = appliedSearch !== '';
  const showInitialLoading = isLoading && data === null;

  return (
    <div className="space-y-core-gap" data-testid="commerce-workflow-settings">
      <CommerceSectionHeading
        title="فرآیندهای خرید"
        description="هر فرآیند یک درخواست خرید را از ثبت تا پایان هدایت می‌کند. تغییرات روی نسخه‌های پیش‌نویس انجام می‌شود و نسخه‌های منتشرشده تغییرناپذیرند."
        actions={
          canConfigure ? (
            <Button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
              data-testid="commerce-workflow-create-open"
              className="text-xs"
            >
              فرآیند جدید
            </Button>
          ) : undefined
        }
      />

      <CommerceFeedback message={feedback} testId="commerce-workflow-feedback" />

      <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
        <form onSubmit={submitSearch} className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              id="commerce-workflow-search"
              name="search"
              type="search"
              label="جستجو بر اساس نام یا کد فرآیند"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="مثلاً فرآیند خرید استاندارد"
            />
          </div>
          <Button type="submit" className="text-xs">
            جستجو
          </Button>
        </form>

        {showInitialLoading || busy ? (
          <CoreLoading lines={4} />
        ) : error ? (
          <CoreError message={error} onRetry={reload} />
        ) : definitions.length === 0 ? (
          <div data-testid="commerce-workflow-empty">
            <p className="rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center text-sm text-muted-foreground">
              {hasActiveSearch
                ? 'فرآیندی با این جستجو یافت نشد.'
                : 'هنوز فرآیندی برای خرید تعریف نشده است.'}
            </p>
            {!hasActiveSearch && canConfigure && (
              <div className="mt-4 flex justify-center">
                <Button
                  type="button"
                  onClick={() => {
                    setCreateError(null);
                    setCreateOpen(true);
                  }}
                  className="text-xs"
                >
                  ایجاد فرآیند
                </Button>
              </div>
            )}
          </div>
        ) : (

          <>
            <ul className="divide-y divide-border" data-testid="commerce-workflow-definition-rows">
              {definitions.map((definition) => {
                const isSelected = selected?.id === definition.id;
                return (
                  <li key={definition.id} className="py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="text-sm font-medium text-foreground">{definition.name}</p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span dir="ltr" className="rounded-md bg-muted px-2 py-0.5">
                            {definition.code}
                          </span>
                          <span>{toPersianDigits(definition.versionCount)} نسخه</span>
                          <span title={definition.updatedAt}>
                            آخرین تغییر: {commerceInstantLabel(definition.updatedAt)}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => selectDefinition(definition)}
                          aria-expanded={isSelected}
                          data-testid={`commerce-workflow-versions-${definition.code}`}
                          className={
                            isSelected
                              ? 'text-xs'
                              : 'border border-border bg-background text-xs text-foreground hover:bg-secondary'
                          }
                        >
                          {isSelected ? 'بستن نسخه‌ها' : 'نسخه‌ها'}
                        </Button>
                        {canConfigure && (
                          <Button
                            type="button"
                            onClick={() => {
                              setRenameError(null);
                              setRenameName(definition.name);
                              setRenameTarget(definition);
                            }}
                            data-testid={`commerce-workflow-rename-${definition.code}`}
                            className="border border-border bg-background text-xs text-foreground hover:bg-secondary"
                          >
                            تغییر نام
                          </Button>
                        )}
                      </div>
                    </div>

                    {isSelected && (
                      <div className="mt-3 rounded-2xl border border-border bg-secondary/20 p-3 sm:p-4">
                        <CommerceWorkflowVersionList
                          definition={definition}
                          canWorkflowManage={canWorkflowManage}
                          canReadDirectory={canReadDirectory}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            <CommercePagination
              page={data?.page ?? page}
              pageSize={data?.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE}
              total={data?.total ?? 0}
              onPageChange={(next) => {
                requestGuard(() => {
                  // Same-commit re-arm (the removed in-effect setters used to
                  // arm one render later).
                  setLoading(true);
                  setError(null);
                  setPage(next);
                  setSelected(null);
                });
              }}
              disabled={isLoading}
            />
          </>
        )}
      </section>

      <CommerceSettingsDialog
        open={createOpen}
        title="فرآیند خرید جدید"
        description="فرآیند یک درخواست خرید را از ثبت تا پایان هدایت می‌کند."
        pending={createPending}
        onCancel={() => {
          if (!createPending) setCreateOpen(false);
        }}
        testId="commerce-workflow-create-dialog"
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
              data-testid="commerce-workflow-create-submit"
            >
              {createPending ? 'در حال ایجاد…' : 'ایجاد فرآیند'}
            </Button>
          </>
        }
      >
        <form id="commerce-workflow-create-form" onSubmit={submitCreate} className="space-y-4">
          <Input
            id="commerce-workflow-code"
            name="code"
            label="کد فرآیند"
            value={createCode}
            onChange={(event) => setCreateCode(event.target.value)}
            placeholder="standard-purchase"
            required
          />
          <p className="-mt-3 text-xs text-muted-foreground">
            کد، شناسهٔ فنی و یکتای این فرآیند برای ارجاع‌های داخلی است.
          </p>
          <Input
            id="commerce-workflow-name"
            name="name"
            label="نام فرآیند"
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder="فرآیند خرید استاندارد"
            required
          />
          {createError && (
            <p
              role="alert"
              data-testid="commerce-workflow-create-error"
              className="text-xs text-destructive"
            >
              {createError}
            </p>
          )}
        </form>
      </CommerceSettingsDialog>

      <CommerceSettingsDialog
        open={renameTarget !== null}
        title="تغییر نام فرآیند"
        description="نام نمایشی فرآیند تغییر می‌کند؛ نسخه‌ها و مراحل دست‌نخورده می‌مانند."
        pending={renamePending}
        onCancel={() => {
          if (!renamePending) setRenameTarget(null);
        }}
        testId="commerce-workflow-rename-dialog"
        footer={
          <>
            <Button
              type="button"
              disabled={renamePending}
              onClick={() => setRenameTarget(null)}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={() => submitRename()}
              disabled={renamePending}
              aria-busy={renamePending}
              data-testid="commerce-workflow-rename-submit"
            >
              {renamePending ? 'در حال ثبت…' : 'ثبت نام جدید'}
            </Button>
          </>
        }
      >
        <form id="commerce-workflow-rename-form" onSubmit={submitRename} className="space-y-4">
          <Input
            id="commerce-workflow-rename-name"
            name="name"
            label="نام فرآیند"
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            required
          />
          {renameError && (
            <p
              role="alert"
              data-testid="commerce-workflow-rename-error"
              className="text-xs text-destructive"
            >
              {renameError}
            </p>
          )}
        </form>
      </CommerceSettingsDialog>
    </div>
  );
}