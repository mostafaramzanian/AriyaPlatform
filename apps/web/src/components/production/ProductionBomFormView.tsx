'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import {
  createProductionBom,
  fetchProductionBom,
  updateProductionBom,
  type ProductionBom,
} from '@/lib/production-api';
import {
  productionErrorCode,
  productionErrorMessage,
  productionServerMessage,
} from '@/lib/production-labels';
import { ProductionCard, ProductionPageHeading } from './production-ui';

/**
 * Phase PRODUCTION-BOM: the BOM author form — `/admin/production/new` (create) and
 * `/admin/production/[id]/edit` (edit while DRAFT).
 *
 * ONE FORM, TWO MODES, AND THE MODE IS THE ROUTE. `editBomId` decides POST vs PATCH; there
 * is no hidden "is edit" flag a caller could set on a create request. In edit mode the row
 * is read through the real route first, so the form always shows what is STORED rather than
 * what a caller passed in a query string.
 *
 * `standardPartCode` IS NOT ON THIS FORM. The header has no such field, and the ITEM's
 * deferred code is not an input anywhere: offering one would be the fake generation button
 * the Product Tree decision explicitly forbids. The item form makes the same choice and
 * shows the field read-only, so its deferral is visible rather than hidden.
 *
 * THE APPROVER IS EDITABLE WHILE DRAFT. The legacy header form froze the field on edit
 * (`IsEnabledOnEdit="False"`) and M-5b takes the snapshot at SUBMIT, so while the row is a
 * DRAFT the approver may still be re-chosen; after submit this form is unreachable for
 * editing (the detail screen hides the action).
 */
export function ProductionBomFormView({ editBomId }: { editBomId: string | null }) {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canManage = !enforcePermissions || rbac.permissions.includes('production.bom.manage');

  const isEdit = editBomId !== null;

  const [title, setTitle] = React.useState('');
  const [projectRef, setProjectRef] = React.useState('');
  const [productTreeRef, setProductTreeRef] = React.useState('');
  const [requesterUserId, setRequesterUserId] = React.useState('');
  const [approverUserId, setApproverUserId] = React.useState('');
  const [comments, setComments] = React.useState('');

  const [existing, setExisting] = React.useState<ProductionBom | null>(null);
  const [isLoading, setLoading] = React.useState(isEdit);
  const [isSaving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The seed read used to arm in its effect body; the arm now rides a
  // render-time key adjustment mirroring the effect's exact dependency list.
  // prev starts as `null` so the first settled key (mount or grant arrival)
  // is detected. The create route is a no-op: its effect early-returned.
  const seedReadKey = `${isEdit ? 1 : 0}|${editBomId ?? ''}|${isAuthenticated ? 1 : 0}|${
    rbac.isLoading ? 1 : 0
  }|${canManage ? 1 : 0}`;
  const [prevSeedReadKey, setPrevSeedReadKey] = React.useState<string | null>(null);
  if (prevSeedReadKey !== seedReadKey) {
    setPrevSeedReadKey(seedReadKey);
    if (isEdit) {
      setLoading(true);
      setError(null);
    }
  }

  React.useEffect(() => {
    if (!isEdit || !isAuthenticated || rbac.isLoading || !canManage) return;

    let active = true;

    fetchProductionBom(editBomId as string)
      .then((bom) => {
        if (!active) return;
        setExisting(bom);
        setTitle(bom.title);
        setProjectRef(bom.projectRef);
        setProductTreeRef(bom.productTreeRef);
        setRequesterUserId(bom.requesterUserId);
        setApproverUserId(bom.approverUserId ?? '');
        setComments(bom.comments ?? '');
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isEdit, editBomId, isAuthenticated, rbac.isLoading, canManage]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (isEdit && existing) {
        const updated = await updateProductionBom(existing.id, {
          title: title.trim(),
          projectRef: projectRef.trim(),
          productTreeRef: productTreeRef.trim(),
          approverUserId: approverUserId.trim(),
          comments: comments.trim(),
        });
        router.push(`/admin/production/${updated.id}`);
        return;
      }

      const created = await createProductionBom({
        title: title.trim(),
        projectRef: projectRef.trim(),
        productTreeRef: productTreeRef.trim(),
        requesterUserId: requesterUserId.trim(),
        approverUserId: approverUserId.trim(),
        ...(comments.trim().length > 0 ? { comments: comments.trim() } : {}),
      });
      router.push(`/admin/production/${created.id}`);
    } catch (err: unknown) {
      const details = err instanceof CoreApiError ? err.details : undefined;
      setError(
        productionErrorMessage(
          productionErrorCode(details),
          productionServerMessage(details) ??
            (err instanceof Error ? err.message : undefined)
        )
      );
      setSaving(false);
    }
  };

  if (rbac.isLoading) return <CoreLoading lines={5} />;

  if (!canManage) {
    return (
      <CoreForbidden message="برای ثبت یا ویرایش BOM به مجوز production.bom.manage نیاز دارید." />
    );
  }

  if (isEdit && isLoading) return <CoreLoading lines={6} />;

  if (isEdit && existing && existing.status !== 'DRAFT') {
    return (
      <div data-testid="production-bom-form-locked">
        <CoreForbidden message="این BOM دیگر پیش‌نویس نیست و قابل ویرایش نمی‌باشد." />
        <div className="mt-4">
          <Link
            href={`/admin/production/${existing.id}`}
            className="text-sm text-foreground underline underline-offset-4"
          >
            بازگشت به BOM
          </Link>
        </div>
      </div>
    );
  }

  const inputClass =
    'h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring';

  return (
    <div data-testid="production-bom-form">
      <ProductionPageHeading
        title={isEdit ? 'ویرایش BOM' : 'BOM جدید'}
        description={
          isEdit
            ? 'ویرایش عنوان BOM تا زمانی که در وضعیت پیش‌نویس است'
            : 'ایجاد فهرست مواد و قطعات برای یک پروژه و درخت محصول'
        }
        testId="production-bom-form-heading"
      />

      {error && (
        <div className="mb-6" data-testid="production-bom-form-error">
          <CoreError message={error} />
        </div>
      )}

      <ProductionCard testId="production-bom-form-card">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="production-title" className="text-xs text-muted-foreground">
              عنوان *
            </label>
            <input
              id="production-title"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="production-project" className="text-xs text-muted-foreground">
                پروژه *
              </label>
              <input
                id="production-project"
                name="projectRef"
                value={projectRef}
                onChange={(event) => setProjectRef(event.target.value)}
                required
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="production-tree" className="text-xs text-muted-foreground">
                درخت محصول *
              </label>
              <input
                id="production-tree"
                name="productTreeRef"
                value={productTreeRef}
                onChange={(event) => setProductTreeRef(event.target.value)}
                required
                className={inputClass}
              />
            </div>

            {!isEdit && (
              <div className="flex flex-col gap-1">
                <label htmlFor="production-requester" className="text-xs text-muted-foreground">
                  درخواست‌کننده *
                </label>
                <input
                  id="production-requester"
                  name="requesterUserId"
                  value={requesterUserId}
                  onChange={(event) => setRequesterUserId(event.target.value)}
                  required
                  className={inputClass}
                />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label htmlFor="production-approver" className="text-xs text-muted-foreground">
                تایید‌کننده *
              </label>
              <input
                id="production-approver"
                name="approverUserId"
                value={approverUserId}
                onChange={(event) => setApproverUserId(event.target.value)}
                required
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-comments" className="text-xs text-muted-foreground">
              توضیحات
            </label>
            <textarea
              id="production-comments"
              name="comments"
              value={comments}
              onChange={(event) => setComments(event.target.value)}
              rows={3}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              data-testid="production-bom-form-submit"
              disabled={isSaving}
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isEdit ? 'ذخیرهٔ تغییرات' : 'ایجاد BOM'}
            </button>
            <Link
              href={isEdit && existing ? `/admin/production/${existing.id}` : '/admin/production'}
              data-testid="production-bom-form-cancel"
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
