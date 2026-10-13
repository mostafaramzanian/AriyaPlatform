'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import { createProductionBomChange } from '@/lib/production-api';
import {
  productionErrorCode,
  productionErrorMessage,
  productionServerMessage,
} from '@/lib/production-labels';
import { ProductionCard, ProductionPageHeading } from './production-ui';

/**
 * Phase PRODUCTION-BOM-CHANGE: the «ثبت درخواست تغییر BOM» author form —
 * `/admin/production/changes/new`.
 *
 * EXACTLY THE FOUR INPUTS THE SOURCE'S SECTION 01 VALIDATES, AND NOTHING ELSE.
 * `BomEdit.txt`'s «ثبت و ادامه» refuses a save while «عنوان پروژه», «درخواست کننده»,
 * «تاریخ درخواست» or «مدیر تایید کننده» is empty; in Ariya:
 *
 *   * the TARGET BOM replaces «عنوان پروژه» — it is what the whole document is about, and
 *     the project reference is read FROM it server-side, so this screen cannot file a
 *     change against one BOM while claiming another project;
 *   * the REQUESTER is not an input: it is `actor.userId`, because the source resolved it
 *     from the CURRENT user and a body that could name somebody else would be a
 *     delegated-authorship feature nobody asked for;
 *   * the REQUEST DATE is not an input either — the column defaults to the moment of
 *     creation, which is what the source's `DatePicker` did (`new Date()`);
 *   * the TITLE is typed. The source CALCULATED it from the project NAME; Ariya has no
 *     project-name contract to read, so deriving a title from an opaque reference would be
 *     a fabricated name (the decision M-1 took for the BOM header itself).
 *
 * The global pipe's `whitelist` + `forbidNonWhitelisted` makes an extra field a refusal
 * rather than a silent drop, so this form never has to defend against one.
 */
export function ProductionBomChangeFormView() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canManage = !enforcePermissions || rbac.permissions.includes('production.bom.manage');

  const [bomId, setBomId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [approverUserId, setApproverUserId] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const [isSaving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!enforcePermissions && rbac.isLoading) return <CoreLoading lines={4} />;
  if (enforcePermissions && !canManage) {
    return <CoreForbidden message="برای ثبت درخواست تغییر BOM به مجوز production.bom.manage نیاز دارید." />;
  }

  const inputClass =
    'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await createProductionBomChange({
        bomId: bomId.trim(),
        title: title.trim(),
        approverUserId: approverUserId.trim(),
        ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
      });
      router.push(`/admin/production/changes/${created.id}`);
    } catch (err: unknown) {
      const details = err instanceof CoreApiError ? err.details : undefined;
      setError(
        productionErrorMessage(
          productionErrorCode(details),
          productionServerMessage(details) ?? 'ثبت درخواست تغییر با خطا مواجه شد.'
        )
      );
      setSaving(false);
    }
  };

  return (
    <div data-testid="production-change-form">
      <ProductionPageHeading
        title="ثبت درخواست تغییر BOM"
        description="درخواست تغییر اقلام یک BOM را برای تایید مافوق ارجاع دهید."
        testId="production-change-form-heading"
      />

      <ProductionCard>
        {error && (
          <div className="mb-4" data-testid="production-change-form-error">
            <CoreError message={error} onRetry={() => setError(null)} />
          </div>
        )}

        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-bomId" className="text-xs text-muted-foreground">
              شناسه BOM *
            </label>
            <input
              id="production-change-bomId"
              name="bomId"
              value={bomId}
              onChange={(event) => setBomId(event.target.value)}
              required
              dir="ltr"
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-title" className="text-xs text-muted-foreground">
              عنوان درخواست *
            </label>
            <input
              id="production-change-title"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-approver" className="text-xs text-muted-foreground">
              مدیر تاییدکننده *
            </label>
            <input
              id="production-change-approver"
              name="approverUserId"
              value={approverUserId}
              onChange={(event) => setApproverUserId(event.target.value)}
              required
              dir="ltr"
              className={inputClass}
            />
            <p className="text-xs text-muted-foreground">
              باید عضو همین سازمان باشد و نمی‌تواند درخواست‌کنندهٔ خودش باشد.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-notes" className="text-xs text-muted-foreground">
              توضیحات
            </label>
            <textarea
              id="production-change-notes"
              name="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              maxLength={2000}
              className={inputClass}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <button
              type="submit"
              data-testid="production-change-form-submit"
              disabled={isSaving}
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'در حال ثبت…' : 'ثبت درخواست'}
            </button>
            <Link
              href="/admin/production/changes"
              data-testid="production-change-form-cancel"
              className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
            >
              انصراف
            </Link>
          </div>
        </form>
      </ProductionCard>
    </div>
  );
}

