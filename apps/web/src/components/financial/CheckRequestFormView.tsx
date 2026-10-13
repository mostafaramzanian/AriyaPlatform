'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  createFinancialCheckRequest,
  fetchFinancialCheckRequest,
  submitFinancialCheckRequest,
  updateFinancialCheckRequest,
  type FinancialCheckRequest,
} from '@/lib/financial-api';
import { financialDateLabel, financialErrorMessage } from '@/lib/financial-labels';
import { FinancialCard, FinancialPageHeading } from './financial-ui';

/**
 * Phase F1 — FINANCIAL FOUNDATION: «درخواست صدور چک» — the state-0/1 form, used by BOTH
 * `/new` (create) and `/[id]/edit` (patch), exactly as Production's form view does.
 *
 * CONDITIONAL FIELDS MIRROR THE SOURCE'S VISIBILITY, NOT A RE-DESIGN
 * ------------------------------------------------------------------
 *  * نوع خرید — visible whenever the issue type is not حقوق, defaulted to «پروژه ای» the
 *    way the source's `DefaultValue` is, and NOT required for تنخواه (the source only
 *    demands it for خرید).
 *  * شناسه سفارش — visible ONLY for خرید (the source hides it for حقوق AND تنخواه), and
 *    required for خرید by the SERVER (V4); this screen shows the server's sentence.
 *  * پروژه / مدیر پروژه — visible only when نوع خرید = «پروژه ای» and the issue type is
 *    not حقوق; both are opaque references (no Project contract exists, Preflight §18), so
 *    they are plain text inputs rather than a fabricated picker.
 *
 * WHAT IS NOT AN INPUT, DELIBERATELY: `requesterUserId` (FORCED from the authenticated
 * actor — V6), `requestDate` (server-generated), `title` (server-built), `status` and
 * every decision field. درخواست‌کننده and تاریخ درخواست are read-only DISPLAYS, and no
 * control exists that could send one. Attachments live on the detail screen — the
 * source's own form saved the record first (btn_sabt) before offering its document grid.
 */
export function CheckRequestFormView({ editId }: { editId?: string | null }) {
  const { isAuthenticated, user } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);
  const router = useRouter();

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canManage = !enforcePermissions || rbac.permissions.includes('financial.check.manage');

  const [existing, setExisting] = React.useState<FinancialCheckRequest | null>(null);
  // Initial `Boolean(editId)` arms the first load; a record-change re-arm
  // lives in the id-change adjustment below — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles.
  const [loadingExisting, setLoadingExisting] = React.useState(Boolean(editId));
  const [prevEditId, setPrevEditId] = React.useState(editId);
  if (prevEditId !== editId) {
    setPrevEditId(editId);
    setLoadingExisting(Boolean(editId));
  }

  const [checkIssueType, setCheckIssueType] = React.useState<'PURCHASE' | 'PETTY_CASH' | 'SALARY'>(
    'PURCHASE'
  );
  const [purchaseType, setPurchaseType] = React.useState<'PROJECT' | 'NON_PROJECT' | ''>('PROJECT');
  const [orderReference, setOrderReference] = React.useState('');
  const [projectReference, setProjectReference] = React.useState('');
  const [projectManagerUserId, setProjectManagerUserId] = React.useState('');
  const [requesterOpinion, setRequesterOpinion] = React.useState<'CONTINUE' | 'CANCEL'>('CONTINUE');

  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!editId || !isAuthenticated || rbac.isLoading || !canManage) return;
    let active = true;

    fetchFinancialCheckRequest(editId)
      .then((row) => {
        if (!active) return;
        setExisting(row);
        setCheckIssueType(row.checkIssueType);
        setPurchaseType(row.purchaseType ?? '');
        setOrderReference(row.orderReference ?? '');
        setProjectReference(row.projectReference ?? '');
        setProjectManagerUserId(row.projectManagerUserId ?? '');
        setRequesterOpinion(row.requesterOpinion);
        setLoadingExisting(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const body = (err as { details?: { code?: string } }).details;
        setError(
          financialErrorMessage(
            body?.code,
            err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.'
          )
        );
        setLoadingExisting(false);
      });

    return () => {
      active = false;
    };
  }, [editId, isAuthenticated, rbac.isLoading, canManage]);

  const editable = !existing || existing.status === 0 || existing.status === 1;
  const isCreate = !editId;

  // The source's conditional visibility, as derived state.
  const showPurchaseType = checkIssueType !== 'SALARY';
  const showOrderReference = checkIssueType === 'PURCHASE';
  const showProjectFields = checkIssueType !== 'SALARY' && purchaseType === 'PROJECT';

  const reportFailure = (err: unknown) => {
    const body = (err as { details?: { code?: string } }).details;
    setError(
      financialErrorMessage(
        body?.code,
        err instanceof Error ? err.message : 'ثبت اطلاعات با خطا مواجه شد.'
      )
    );
  };

  const payload = () => ({
    checkIssueType,
    ...(showPurchaseType && purchaseType !== '' ? { purchaseType } : {}),
    ...(showOrderReference && orderReference.trim() !== ''
      ? { orderReference: orderReference.trim() }
      : {}),
    ...(showProjectFields && projectReference.trim() !== ''
      ? { projectReference: projectReference.trim() }
      : {}),
    ...(showProjectFields && projectManagerUserId.trim() !== ''
      ? { projectManagerUserId: projectManagerUserId.trim() }
      : {}),
    requesterOpinion,
  });

  async function save(): Promise<FinancialCheckRequest | null> {
    setError(null);
    setBusy(true);
    try {
      const saved = isCreate
        ? await createFinancialCheckRequest(payload())
        : await updateFinancialCheckRequest(editId!, payload());
      setExisting(saved);
      return saved;
    } catch (err) {
      reportFailure(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** «ثبت و ادامه» — save, then land on the detail (where the documents live). */
  async function handleSave() {
    const saved = await save();
    if (saved) router.push(`/admin/financial/check-requests/${saved.id}`);
  }

  /**
   * «ارجاع برای تصمیم مدیر» — the source's btn_True: validate + save, then the ROUTING
   * act. On the create screen the record must exist first (exactly why the source's own
   * script did `form.SaveRecord()` before routing), so this saves and routes in sequence —
   * two calls, because two acts are two calls; the SERVER owns each transition.
   */
  async function handleRoute() {
    let target = existing;
    if (!target) {
      target = await save();
      if (!target) return;
    } else {
      const saved = await save();
      if (!saved) return;
      target = saved;
    }

    setBusy(true);
    setError(null);
    try {
      await submitFinancialCheckRequest(target.id);
      router.push(`/admin/financial/check-requests/${target.id}`);
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  if (!isAuthenticated || rbac.isLoading) return <CoreLoading lines={4} />;
  if (!canManage) return <CoreForbidden />;
  if (loadingExisting) return <CoreLoading lines={6} />;

  const fieldClass =
    'h-10 w-full rounded-xl border border-border bg-background px-3 text-sm disabled:bg-secondary disabled:text-muted-foreground';
  const disabled = !editable || busy;

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <FinancialPageHeading
        testId="financial-check-form-heading"
        title={isCreate ? 'درخواست صدور چک جدید' : 'ویرایش درخواست صدور چک'}
        description={
          existing
            ? `عنوان (تولید سرور): ${existing.title}`
            : 'عنوان، تاریخ درخواست و درخواست‌کننده توسط سامانه تعیین می‌شوند.'
        }
      />

      {error && (
        <div className="mb-6" data-testid="financial-check-form-error">
          <CoreError message={error} onRetry={() => setError(null)} />
        </div>
      )}

      <FinancialCard testId="financial-check-form">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>
              نوع صدور چک <span className="text-destructive">*</span>
            </span>
            <select
              data-testid="financial-check-issue-type"
              value={checkIssueType}
              disabled={disabled}
              onChange={(event) => setCheckIssueType(event.target.value as typeof checkIssueType)}
              className={fieldClass}
            >
              <option value="PURCHASE">خرید</option>
              <option value="PETTY_CASH">تنخواه</option>
              <option value="SALARY">حقوق</option>
            </select>
          </label>

          {showPurchaseType && (
            <label className="flex flex-col gap-1 text-sm">
              <span>نوع خرید</span>
              <select
                data-testid="financial-check-purchase-type"
                value={purchaseType}
                disabled={disabled}
                onChange={(event) => setPurchaseType(event.target.value as typeof purchaseType)}
                className={fieldClass}
              >
                <option value="">—</option>
                <option value="PROJECT">پروژه ای</option>
                <option value="NON_PROJECT">غیر پروژه ای</option>
              </select>
            </label>
          )}

          {showOrderReference && (
            <label className="flex flex-col gap-1 text-sm">
              <span>
                شناسه شماره سفارش{' '}
                {checkIssueType === 'PURCHASE' && <span className="text-destructive">*</span>}
              </span>
              <input
                data-testid="financial-check-order-reference"
                value={orderReference}
                disabled={disabled}
                onChange={(event) => setOrderReference(event.target.value)}
                className={fieldClass}
                placeholder="شناسه سفارش خرید"
              />
            </label>
          )}

          {showProjectFields && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span>
                  پروژه <span className="text-destructive">*</span>
                </span>
                <input
                  data-testid="financial-check-project-reference"
                  value={projectReference}
                  disabled={disabled}
                  onChange={(event) => setProjectReference(event.target.value)}
                  className={fieldClass}
                  placeholder="شناسه پروژه"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>
                  مدیر پروژه <span className="text-destructive">*</span>
                </span>
                <input
                  data-testid="financial-check-project-manager"
                  value={projectManagerUserId}
                  disabled={disabled}
                  onChange={(event) => setProjectManagerUserId(event.target.value)}
                  className={fieldClass}
                  placeholder="شناسه کاربر مدیر پروژه"
                />
              </label>
            </>
          )}
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>درخواست‌کننده (از نشست شما — توسط سامانه تعیین می‌شود)</span>
            <input
              data-testid="financial-check-requester"
              readOnly
              value={existing?.requesterUserId ?? user?.email ?? user?.userId ?? ''}
              className={fieldClass}
            />
          </label>

          {existing && (
            <label className="flex flex-col gap-1 text-sm">
              <span>تاریخ درخواست (تولید سرور)</span>
              <input
                data-testid="financial-check-request-date"
                readOnly
                value={financialDateLabel(existing.requestDate)}
                className={fieldClass}
              />
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span>نظر درخواست‌کننده</span>
            <select
              data-testid="financial-check-requester-opinion"
              value={requesterOpinion}
              disabled={disabled}
              onChange={(event) =>
                setRequesterOpinion(event.target.value as typeof requesterOpinion)
              }
              className={fieldClass}
            >
              <option value="CONTINUE">تایید و ادامه</option>
              <option value="CANCEL">لغو کامل گردش درخواست</option>
            </select>
          </label>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            data-testid="financial-check-save"
            disabled={busy || !editable}
            onClick={handleSave}
            className="inline-flex h-10 items-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'در حال ثبت…' : isCreate ? 'ثبت و ادامه' : 'ذخیره تغییرات'}
          </button>

          {editable && (
            <button
              type="button"
              data-testid="financial-check-route"
              disabled={busy}
              onClick={handleRoute}
              className="inline-flex h-10 items-center rounded-xl border border-border px-5 text-sm font-medium text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              ارجاع برای تصمیم مدیر
            </button>
          )}

          <button
            type="button"
            data-testid="financial-check-cancel"
            disabled={busy}
            onClick={() => router.push('/admin/financial/check-requests')}
            className="inline-flex h-10 items-center rounded-xl px-4 text-sm text-muted-foreground transition hover:text-foreground"
          >
            انصراف
          </button>
        </div>

        {!editable && existing && (
          <p className="mt-4 text-xs text-muted-foreground" data-testid="financial-check-frozen">
            این درخواست در وضعیت «
            {existing.status === 2 ? 'در انتظار تصمیم مدیر' : 'غیرقابل ویرایش'}» است و فیلدها
            فقط‌خواندنی هستند.
          </p>
        )}
      </FinancialCard>
    </div>
  );
}
