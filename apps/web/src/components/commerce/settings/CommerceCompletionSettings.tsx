'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import {
  archiveCommerceCompletionPolicy,
  createCommerceCompletionPolicy,
  fetchCommerceCompletionPolicies,
  publishCommerceCompletionPolicy,
  updateCommerceCompletionPolicy,
  validateCommerceCompletionPolicy,
  COMMERCE_COMPLETION_SOURCE_STATUSES,
  type CommerceCompletionPolicyRecord,
  type CommerceCompletionSourceStatus,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceDocumentStatusLabel,
  commerceInstantLabel,
  commerceWorkflowVersionStatusHint,
  commerceWorkflowVersionStatusLabel,
  commerceWorkflowVersionStatusTone,
} from '@/lib/commerce-labels';
import { CommerceBadge, CommerceFeedback, CommerceSectionHeading } from '../commerce-ui';
import { CommerceConfirmDialog } from '../CommerceConfirmDialog';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useCommerceDirtyFlag } from './CommerceSettingsGuard';

/**
 * PHASE C4-R (GAP-3): «تکمیل خرید» — the Purchase Completion Policy inside the EXISTING
 * Commerce settings domain (`?tab=commerce&view=completion`).
 *
 * WHAT THIS PANEL IS. The one place an administrator states WHEN a purchase request may be
 * completed: a versioned policy whose only member is the set of document statuses
 * completion is permitted FROM (`allowedFromStatuses`), published through the same
 * DRAFT → VALIDATED → PUBLISHED → ARCHIVED lifecycle the workflow and commercial
 * configuration already use, with exactly one published policy in force at a time.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW. No prerequisite, no condition editor, no role and no
 * permission control: the model has none (C1 §29 keeps payment, receiving, workflow and
 * return state out of completion, and no source makes any of them a precondition), so a
 * toggle for one would be a control promising a rule the backend cannot evaluate. The
 * panel says so in one honest sentence rather than leaving the administrator wondering.
 *
 * THE LANGUAGE IS THE ADMINISTRATOR'S. «وضعیت‌های مجاز برای تکمیل» and the status labels a
 * user already reads on the purchase register (`commerceDocumentStatusLabel`), never
 * `allowedFromStatuses` or `PurchaseDocumentStatus`. The technical identifiers appear only
 * where a support call needs them (the policy label, which the tenant writes itself).
 *
 * NO INVENTED DEFAULT. A new policy starts with NO status selected and cannot be saved
 * until one is: pre-ticking «تأییدشده» would be this screen deciding business semantics —
 * the exact decision C4 refused to make and C4-R hands to the product.
 *
 * THE PREVIEW IS THE POINT: «با این تنظیمات، سند درخواست خرید در کدام وضعیت‌ها قابل تکمیل
 * است؟» is answered as the administrator types, in the same vocabulary the register uses.
 */

/** The Persian summary of a set — one spelling, shared by the preview and the list. */
export function commerceCompletionSummary(allowed: readonly string[]): string {
  if (allowed.length === 0) return 'هیچ وضعیتی انتخاب نشده است';
  return allowed.map((status) => commerceDocumentStatusLabel(status)).join('، ');
}

/** `CommerceCompletionSourceStatus` → the register's own label. */
function statusLabel(status: CommerceCompletionSourceStatus): string {
  return commerceDocumentStatusLabel(status);
}

export function CommerceCompletionSettings({ canConfigure }: { canConfigure: boolean }) {
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [policies, setPolicies] = React.useState<CommerceCompletionPolicyRecord[]>([]);
  // The mount effect below fetches once (empty deps); every post-mutation
  // re-read goes through `run`, which re-arms loading/cleared in its own
  // handler commit — so no in-effect setter resets are needed.
  const [feedback, setFeedback] = React.useState<{
    message: string;
    tone: 'ok' | 'danger';
  } | null>(null);
  const [pending, setPending] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState<
    { kind: 'publish' | 'archive'; policy: CommerceCompletionPolicyRecord } | null
  >(null);

  // The draft form: a label and a set, and NOTHING pre-selected.
  const [formLabel, setFormLabel] = React.useState('');
  const [formStatuses, setFormStatuses] = React.useState<CommerceCompletionSourceStatus[]>([]);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  // Unsaved edits are protected by the domain's shared guard, like every other editor here.
  useCommerceDirtyFlag(
    'completion-policy-draft',
    createOpen && (formLabel.trim().length > 0 || formStatuses.length > 0)
  );

  const load = React.useCallback(async () => {
    try {
      const page = await fetchCommerceCompletionPolicies({ page: 1, pageSize: 50 });
      setPolicies(page.items);
    } catch (error) {
      setLoadError(commerceActionErrorMessage(error, 'خواندن قواعد تکمیل خرید ناموفق بود.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchCommerceCompletionPolicies({ page: 1, pageSize: 50 })
      .then((page) => {
        setPolicies(page.items);
        setLoading(false);
      })
      .catch((error: unknown) => {
        setLoadError(commerceActionErrorMessage(error, 'خواندن قواعد تکمیل خرید ناموفق بود.'));
        setLoading(false);
      });
  }, []);

  const published = policies.find((policy) => policy.status === 'PUBLISHED') ?? null;

  const run = async (act: () => Promise<unknown>, success: string) => {
    setPending(true);
    setFeedback(null);
    try {
      await act();
      // Re-arm the list to a fresh load cycle in the same handler commit (the
      // removed in-effect setters used to arm one render later).
      setLoading(true);
      setLoadError(null);
      await load();
      setFeedback({ message: success, tone: 'ok' });
    } catch (error) {
      setFeedback({
        message: commerceActionErrorMessage(error, 'انجام عمل ناموفق بود.'),
        tone: 'danger',
      });
    } finally {
      setPending(false);
    }
  };

  const openCreate = () => {
    setFormLabel('');
    setFormStatuses([]);
    setEditingId(null);
    setFeedback(null);
    setCreateOpen(true);
  };

  const openEdit = (policy: CommerceCompletionPolicyRecord) => {
    setFormLabel(policy.versionLabel);
    setFormStatuses([...policy.allowedFromStatuses]);
    setEditingId(policy.id);
    setFeedback(null);
    setCreateOpen(true);
  };

  const toggleStatus = (status: CommerceCompletionSourceStatus) => {
    setFormStatuses((current) =>
      current.includes(status) ? current.filter((value) => value !== status) : [...current, status]
    );
  };

  const submitForm = async () => {
    const label = formLabel.trim();
    if (label.length === 0 || formStatuses.length === 0) return;

    await run(
      async () => {
        if (editingId) {
          await updateCommerceCompletionPolicy(editingId, { allowedFromStatuses: formStatuses });
        } else {
          await createCommerceCompletionPolicy({
            versionLabel: label,
            allowedFromStatuses: formStatuses,
          });
        }
      },
      'پیش‌نویس ذخیره شد. برای اعمال، آن را اعتبارسنجی و منتشر کنید.'
    );
    setCreateOpen(false);
  };

  if (loading) return <CoreLoading lines={4} />;
  if (loadError) {
    return (
      <div className="space-y-3" data-testid="commerce-completion-settings">
        <CoreError message={loadError} />
        <Button
          type="button"
          onClick={() => {
            // Retry re-arms in the same handler commit (the removed in-effect/`load`
            // setters used to clear one render later).
            setLoading(true);
            setLoadError(null);
            void load();
          }}
        >
          تلاش دوباره
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-core-gap" data-testid="commerce-completion-settings">
      <CommerceSectionHeading
        title="تکمیل خرید"
        description="مشخص کنید سند درخواست خرید در چه وضعیت‌هایی «تکمیل‌شده» محسوب می‌شود. تا زمانی که قاعده‌ای منتشر نشود، تکمیل خرید در این سازمان ممکن نیست."
        actions={
          canConfigure ? (
            <Button type="button" onClick={openCreate} data-testid="completion-new-policy">
              قاعدهٔ جدید
            </Button>
          ) : null
        }
      />

      {/* The state that matters most: what completion DOES today. */}
      <div
        className="rounded-2xl border border-border bg-card p-4"
        data-testid="completion-current-rule"
      >
        <p className="text-sm font-medium text-foreground">قاعدهٔ در جریان</p>
        {published ? (
          <>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="completion-current-summary"
            >
              {`با این تنظیمات، سند درخواست خرید تنها در وضعیت «${commerceCompletionSummary(
                published.allowedFromStatuses
              )}» قابل تکمیل است؛ در دیگر وضعیت‌ها درخواست تکمیل با خطا رد می‌شود.`}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              برچسب قاعده: {published.versionLabel} — آخرین به‌روزرسانی:{' '}
              {commerceInstantLabel(published.updatedAt)}
            </p>
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="completion-none-published">
            هنوز قاعده‌ای منتشر نشده است؛ بنابراین تکمیل خرید در حال حاضر برای هیچ سندی امکان‌پذیر
            نیست. یک قاعدهٔ جدید بسازید، اعتبارسنجی و منتشر کنید.
          </p>
        )}
      </div>

      {/* One honest sentence about what is NOT configurable, and why. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        این قاعده فقط «وضعیت مجاز برای تکمیل» را تعیین می‌کند. تکمیل خرید به پرداخت، تحویل، گردش
        کار یا مرجوعی‌ها گره نمی‌خورد؛ آن‌ها چرخه‌های مستقل خود را دارند و هیچ‌کدام شرط تکمیل
        نیستند.
      </p>

      <CommerceFeedback
        message={feedback?.message ?? null}
        tone={feedback?.tone ?? 'ok'}
        testId="completion-feedback"
      />

      <div className="space-y-3" data-testid="completion-policy-list">
        {policies.length === 0 ? (
          <p className="text-xs text-muted-foreground">هنوز هیچ قاعده‌ای ثبت نشده است.</p>
        ) : (
          policies.map((policy) => (
            <div
              key={policy.id}
              className="rounded-2xl border border-border bg-card p-4"
              data-testid="completion-policy-row"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{policy.versionLabel}</span>
                <CommerceBadge tone={commerceWorkflowVersionStatusTone(policy.status)}>
                  {commerceWorkflowVersionStatusLabel(policy.status)}
                </CommerceBadge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                وضعیت‌های مجاز برای تکمیل: {commerceCompletionSummary(policy.allowedFromStatuses)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {commerceWorkflowVersionStatusHint(policy.status)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                ثبت: {commerceInstantLabel(policy.createdAt)}
              </p>

              {canConfigure && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {policy.status === 'DRAFT' && (
                    <>
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() => openEdit(policy)}
                        data-testid={`completion-edit-${policy.id}`}
                      >
                        ویرایش پیش‌نویس
                      </Button>
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void run(
                            () => validateCommerceCompletionPolicy(policy.id),
                            'قاعده اعتبارسنجی شد و آمادهٔ انتشار است.'
                          )
                        }
                        data-testid={`completion-validate-${policy.id}`}
                      >
                        اعتبارسنجی
                      </Button>
                    </>
                  )}
                  {(policy.status === 'DRAFT' || policy.status === 'VALIDATED') && (
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirm({ kind: 'publish', policy })}
                      data-testid={`completion-publish-${policy.id}`}
                    >
                      انتشار
                    </Button>
                  )}
                  {policy.status !== 'ARCHIVED' && (
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirm({ kind: 'archive', policy })}
                      data-testid={`completion-archive-${policy.id}`}
                    >
                      آرشیو
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Create / edit a draft — the set is the whole form. */}
      <CommerceSettingsDialog
        open={createOpen}
        title={editingId ? 'ویرایش پیش‌نویس قاعدهٔ تکمیل' : 'قاعدهٔ تکمیل خرید'}
        description="وضعیت‌هایی را انتخاب کنید که در آن‌ها تکمیل سند درخواست خرید مجاز است."
        pending={pending}
        onCancel={() => setCreateOpen(false)}
        testId="completion-form"
        footer={
          <>
            <Button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={pending}
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={() => void submitForm()}
              disabled={pending || formLabel.trim().length === 0 || formStatuses.length === 0}
              data-testid="completion-save-draft"
            >
              ذخیره پیش‌نویس
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">برچسب قاعده</span>
            <input
              type="text"
              value={formLabel}
              disabled={editingId !== null}
              onChange={(event) => setFormLabel(event.target.value)}
              placeholder="مثلاً ۱۴۰۴-۰۱"
              data-testid="completion-label-input"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
            />
          </label>

          <fieldset className="space-y-2">
            <legend className="text-xs text-muted-foreground">وضعیت‌های مجاز برای تکمیل</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {COMMERCE_COMPLETION_SOURCE_STATUSES.map((status) => (
                <label
                  key={status}
                  className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={formStatuses.includes(status)}
                    onChange={() => toggleStatus(status)}
                    data-testid={`completion-status-${status}`}
                  />
                  <span>{statusLabel(status)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <p
            className="text-[11px] leading-relaxed text-muted-foreground"
            data-testid="completion-preview"
          >
            {`با این تنظیمات، سند درخواست خرید در وضعیت «${commerceCompletionSummary(
              formStatuses
            )}» قابل تکمیل است. پس از ذخیره، برای اعمال، قاعده را اعتبارسنجی و منتشر کنید.`}
          </p>
        </div>
      </CommerceSettingsDialog>

      {/* Publication and archiving are consequential: confirm explicitly. */}
      <CommerceConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'publish' ? 'انتشار قاعدهٔ تکمیل خرید' : 'آرشیو قاعدهٔ تکمیل خرید'}
        description={
          confirm?.kind === 'publish'
            ? `با انتشار «${confirm.policy.versionLabel}»، این قاعده برای درخواست‌های خرید در جریان قرار می‌گیرد و قاعدهٔ منتشرشدهٔ قبلی بایگانی می‌شود.`
            : `با آرشیو «${confirm?.policy.versionLabel}»، این قاعده از جریان خارج می‌شود${
                confirm?.policy.status === 'PUBLISHED'
                  ? ' و تا انتشار قاعدهٔ جدید، تکمیل خرید ممکن نخواهد بود.'
                  : '.'
              }`
        }
        confirmLabel={confirm?.kind === 'publish' ? 'انتشار' : 'آرشیو'}
        confirmTone="primary"
        pending={pending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (!target) return;
          if (target.kind === 'publish') {
            void run(
              () => publishCommerceCompletionPolicy(target.policy.id),
              'قاعده منتشر شد و از این پس در جریان است.'
            );
          } else {
            void run(() => archiveCommerceCompletionPolicy(target.policy.id), 'قاعده آرشیو شد.');
          }
        }}
        testId="completion-confirm"
      />
    </div>
  );
}
