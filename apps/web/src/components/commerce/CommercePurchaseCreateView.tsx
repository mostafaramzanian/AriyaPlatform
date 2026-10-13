'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { Button } from '@/components/ui/button';
import {
  createCommercePurchaseDocument,
  fetchCommercePurchaseDocument,
  serializePurchaseLine,
  submitCommercePurchaseDocument,
  updateCommercePurchaseDocument,
  type CommerceCreatePurchaseInput,
  type CommercePurchaseDocument,
  type CommercePurchaseLineDraft,
  type CommercePurchaseLineInput,
  type CommerceUpdatePurchaseInput,
} from '@/lib/commerce-api';
import { commerceActionErrorMessage, commerceDisplayName } from '@/lib/commerce-labels';
import {
  CommerceCard,
  CommerceFeedback,
  CommercePageHeading,
  CommerceSectionHeading,
} from './commerce-ui';
import { CommerceConfirmDialog } from './CommerceConfirmDialog';
import { CommerceMemberPicker } from './settings/CommerceMemberPicker';
import {
  CommercePurchaseLinesEditor,
  emptyDraft,
  type CommerceLinesErrors,
} from './purchase/CommercePurchaseLinesEditor';
import { CommercePurchaseReview } from './purchase/CommercePurchaseReview';

/**
 * PHASE UI-2: Purchase Create / Edit — `/admin/commerce/purchases/new` (and the same
 * flow in edit mode for an existing DRAFT).
 *
 * THE PROGRESSIVE FORM (UI-0 §9, UI-2 §4). Three steps in ONE page — اطلاعات اصلی، اقلام،
 * بررسی — with the step as a NAMED STATE, not three routes: the contract asks the user
 * "من چه چیزی نیاز دارم؟" and a form split across URLs would lose the user's entered
 * data on every back-navigation. The weakest step sets the state: a step is reachable
 * forward only when the earlier steps pass their (presentation-level) checks.
 *
 * SAVE DRAFT vs SUBMIT ARE DIFFERENT FACTS, AND THE SCREEN SAYS SO.
 *  * «ذخیرهٔ پیش‌نویس» sends create (first time) or PATCH (afterwards) and answers with
 *    what happened — «پیش‌نویس ذخیره شد.» plus the SERVER-MINTED document number — and
 *    the view flips into edit mode against that same document id, so a second save can
 *    never mint a second document.
 *  * «ثبت و ارسال» performs the same save (create-then-submit, or update-then-submit),
 *    confirms through a consequence-first dialog, then goes to the real detail route.
 *
 * WHAT THE CLIENT NEVER DOES: no totals arithmetic (the server derives line totals and
 * document totals inside the write), no `status`, no `documentNumber`, no `tenantId`, no
 * optimistic results — every rendered fact after a mutation comes from the response body.
 * On any failure the entered values, the selected step and the line editor state are all
 * preserved; only the failure message changes.
 *
 * PHASE UI-5 (§20), RE-ALIGNED IN GAP-8: THE REQUESTER IS CHOSEN, NOT TYPED. UI-2 asked
 * for a raw UUID in a text field — a fact only a developer can produce. The requester is
 * now either picked from the Core directory through the SAME `CommerceMemberPicker` the
 * configuration surfaces use (when the session holds `admin.users.read`, the directory
 * route's own gate), or shown as a read-only statement of who it is — self by default, or
 * the DRAFT's resolved requester — with the missing grant named. The form still sends
 * exactly one `requesterId`, and it sends it EXACTLY as returned: a platform user id is
 * an opaque string (UUID v4 is only the mint default), so nothing here reshapes, validates
 * or regenerates it. Membership is checked server-side on write (`assertMember`).
 */

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** The DTO's own bounds, restated for immediate feedback — the server re-validates. */
const SUPPLIER_MAX = 128;
const DESCRIPTION_MAX = 2000;
/** `CreatePurchaseDocumentDto.requesterId` is `@MaxLength(64)` — the platform's bound. */
const REQUESTER_MAX = 64;

const DETAIL_BASE = '/admin/commerce/purchases';

type Step = 'details' | 'lines' | 'review';

interface MainValues {
  requesterId: string;
  supplierId: string;
  currency: string;
}

interface MainErrors {
  requesterId?: string;
  supplierId?: string;
  currency?: string;
}

/** Presentation check for one decimal string: optional blank, positive/zero, ≤ 4 decimals. */
function decimalIssue(
  value: string,
  { positive, label }: { positive: boolean; label: string }
): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(trimmed)) {
    return `${label} باید عددی با حداکثر چهار رقم اعشار باشد.`;
  }
  if (positive && Number(trimmed) <= 0) return `${label} باید بزرگ‌تر از صفر باشد.`;
  return undefined;
}

function validateDetails(values: MainValues): MainErrors {
  const errors: MainErrors = {};
  const requester = values.requesterId.trim();
  if (requester.length === 0) {
    errors.requesterId = 'درخواست‌کننده انتخاب نشده است؛ پیش از ادامه آن را مشخص کنید.';
  } else if (requester.length > REQUESTER_MAX) {
    // The id is OPAQUE (GAP-8): the only shape assertion available is the platform's
    // own 64-character bound — the same one the DTO enforces.
    errors.requesterId = `شناسهٔ درخواست‌کننده حداکثر ${REQUESTER_MAX} کاراکتر است.`;
  }
  if (values.supplierId.trim().length > SUPPLIER_MAX) {
    errors.supplierId = `شناسهٔ تأمین‌کننده حداکثر ${SUPPLIER_MAX} کاراکتر است.`;
  }
  const currency = values.currency.trim();
  if (currency.length > 0 && !CURRENCY_PATTERN.test(currency)) {
    errors.currency = 'ارز باید یک کد سه‌حرفی باشد، مثل IRR.';
  }
  return errors;
}

function validateLines(lines: CommercePurchaseLineDraft[]): CommerceLinesErrors {
  const errors: CommerceLinesErrors = {};
  for (const line of lines) {
    const field: CommerceLinesErrors[string] = {};
    if (line.quantity.trim().length === 0) {
      field.quantity = 'مقدار الزامی است.';
    } else {
      const quantityIssue = decimalIssue(line.quantity, { positive: true, label: 'مقدار' });
      if (quantityIssue) field.quantity = quantityIssue;
    }
    const unitPriceIssue = decimalIssue(line.unitPrice, { positive: false, label: 'قیمت واحد' });
    if (unitPriceIssue) field.unitPrice = unitPriceIssue;
    const taxIssue = decimalIssue(line.tax, { positive: false, label: 'مبلغ مالیات' });
    if (taxIssue) field.tax = taxIssue;
    if (line.unit.trim().length > 32) field.unit = 'واحد حداکثر ۳۲ کاراکتر است.';
    if (line.externalRef.trim().length > 128) {
      field.externalRef = 'ارجاع خارجی حداکثر ۱۲۸ کاراکتر است.';
    }
    if (line.itemReference.trim().length > 200) {
      field.itemReference = 'شناسهٔ کالا/سرویس حداکثر ۲۰۰ کاراکتر است.';
    }
    if (line.technicalDescription.trim().length > DESCRIPTION_MAX) {
      field.technicalDescription = `شرح فنی حداکثر ${DESCRIPTION_MAX} کاراکتر است.`;
    }
    if (Object.keys(field).length > 0) errors[line.key] = field;
  }
  return errors;
}

/** Wire payload for the current form — shared by save-draft and submit. */
function buildLineInputs(lines: CommercePurchaseLineDraft[]): CommercePurchaseLineInput[] {
  return lines.map((line) => serializePurchaseLine(line));
}

/** A stored line back into an editable draft — the edit-mode entry point. */
function lineToDraft(
  line: CommercePurchaseDocument['lines'][number],
  index: number
): CommercePurchaseLineDraft {
  return {
    key: `existing-${index}-${line.id}`,
    lineType: line.lineType,
    quantity: line.quantity,
    unit: line.unit ?? '',
    unitPrice: line.unitPrice ?? '',
    tax: line.tax ?? '',
    externalRef: line.externalRef ?? '',
    itemReference: line.itemReference ?? '',
    technicalDescription: line.technicalDescription ?? '',
  };
}

export function CommercePurchaseCreateView({ editDocumentId = null }: { editDocumentId?: string | null }) {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canManage = !enforcePermissions || rbac.permissions.includes('commerce.manage');

  /**
   * PHASE UI-5 (§20): WHO the requester is may only be CHANGED through a search that really
   * exists. `GET /users/directory` is that search and it answers to `admin.users.read`; a
   * session without that grant cannot discover another member, so the form keeps the
   * documented fallback (UI-0 §26-GAP-8: self-default requester) instead of demanding a
   * pasted identifier that a normal business user cannot know. The grant gate is
   * presentation only — the backend still verifies membership on write (`assertMember`).
   */
  const canPickRequester = rbac.permissions.includes('admin.users.read');

  const sessionUserId = user?.userId ?? user?.sub ?? '';

  /**
   * THE SELF-DEFAULT IS ALWAYS USABLE (GAP-8, FORK A). A platform user id is an OPAQUE
   * string — `super-admin-user` is as valid a `requesterId` as any UUID — so the session's
   * own id starts the form as the requester, as long as it exists. The server still
   * verifies it as a member of the acting tenant on write (`assertMember`); nothing here
   * reshapes or re-formats it.
   */
  const sessionRequesterId = sessionUserId.trim();

  const [step, setStep] = React.useState<Step>('details');
  const [values, setValues] = React.useState<MainValues>({
    requesterId: sessionRequesterId,
    supplierId: '',
    currency: '',
  });
  /** The loaded DRAFT's requester NAME, so edit mode shows a person and not an id. */
  const [requesterName, setRequesterName] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<CommercePurchaseLineDraft[]>(() => [emptyDraft()]);
  const [mainErrors, setMainErrors] = React.useState<MainErrors>({});
  const [lineErrors, setLineErrors] = React.useState<CommerceLinesErrors>({});

  /** The document this form writes to: the route's id in edit mode, the response's id after a save. */
  const [documentId, setDocumentId] = React.useState<string | null>(editDocumentId);
  const [documentNumber, setDocumentNumber] = React.useState<string | null>(null);

  const [isLoading, setLoading] = React.useState<boolean>(Boolean(editDocumentId));
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump); a record-change re-arm lives in the id-change adjustment below, so
  // the load effect needs no in-effect setter resets. First mount is covered
  // by the initial `isLoading: Boolean(editDocumentId)`.
  const { token: loadToken, reload } = useReloadToken(setLoading, setLoadError);
  const [prevEditId, setPrevEditId] = React.useState(editDocumentId);
  if (prevEditId !== editDocumentId) {
    setPrevEditId(editDocumentId);
    setLoading(Boolean(editDocumentId));
    setLoadError(null);
  }
  const [notEditable, setNotEditable] = React.useState(false);

  const [pending, setPending] = React.useState<'save' | 'submit' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const [confirmSubmit, setConfirmSubmit] = React.useState(false);
  const [confirmLeave, setConfirmLeave] = React.useState(false);

  /** True once anything was changed after the last successful save; drives the leave guard. */
  const [dirty, setDirty] = React.useState(false);

  // Edit mode: load the DRAFT once. A document that is not editable is a fact, not an error —
  // it renders its own panel with a link to the detail rather than a retry that cannot succeed.
  React.useEffect(() => {
    if (!editDocumentId || !isAuthenticated || rbac.isLoading || !canManage) return;

    let active = true;

    fetchCommercePurchaseDocument(editDocumentId)
      .then((document) => {
        if (!active) return;
        if (!document.editable) {
          setNotEditable(true);
          setLoading(false);
          return;
        }
        setValues({
          requesterId: document.requester.id,
          supplierId: document.supplierId ?? '',
          currency: document.currency ?? '',
        });
        setRequesterName(
          document.requester.profile
            ? commerceDisplayName(document.requester.profile, '')
            : null
        );
        setLines(
          document.lines.length > 0
            ? document.lines.map((line, index) => lineToDraft(line, index))
            : [emptyDraft()]
        );
        setDocumentNumber(document.documentNumber);
        setDirty(false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoadError(commerceActionErrorMessage(err, 'بارگذاری سند با خطا مواجه شد.'));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [editDocumentId, isAuthenticated, rbac.isLoading, canManage, loadToken]);

  const patchValues = (patch: Partial<MainValues>) => {
    setValues((prev) => ({ ...prev, ...patch }));
    setDirty(true);
    setSuccess(null);
  };

  const patchLines = (next: CommercePurchaseLineDraft[]) => {
    setLines(next);
    setDirty(true);
    setSuccess(null);
  };

  const goToLines = () => {
    const errors = validateDetails(values);
    setMainErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setError(null);
    setStep('lines');
  };

  const goToReview = () => {
    const detailErrors = validateDetails(values);
    setMainErrors(detailErrors);
    const errors = validateLines(lines);
    setLineErrors(errors);
    if (Object.keys(detailErrors).length > 0) {
      setStep('details');
      return;
    }
    if (lines.length === 0 || Object.keys(errors).length > 0) return;
    setError(null);
    setStep('review');
  };

  /** Everything validateLines checks, checked again at save time — a user can step back. */
  const ensureValid = (): boolean => {
    const detailErrors = validateDetails(values);
    setMainErrors(detailErrors);
    const errors = validateLines(lines);
    setLineErrors(errors);

    if (Object.keys(detailErrors).length > 0) {
      setStep('details');
      return false;
    }
    if (lines.length === 0 || Object.keys(errors).length > 0) {
      setStep('lines');
      return false;
    }
    return true;
  };

  /**
   * Create-or-update. Failures propagate to the caller (which maps them and keeps every
   * entered value on screen); the resolved value is the saved document.
   */
  const save = React.useCallback(async (): Promise<CommercePurchaseDocument> => {
    const requesterId = values.requesterId.trim();
    const supplierId = values.supplierId.trim();
    const currency = values.currency.trim();
    const lineInputs = buildLineInputs(lines);

    if (documentId === null) {
      const payload: CommerceCreatePurchaseInput = {
        requesterId,
        lines: lineInputs,
        ...(supplierId ? { supplierId } : {}),
        ...(currency ? { currency } : {}),
      };
      return createCommercePurchaseDocument(payload);
    }

    // `null` clears a stored value; `undefined` would leave it untouched — the user's
    // empty field means "no supplier/currency stated", which is the CLEAR.
    const payload: CommerceUpdatePurchaseInput = {
      requesterId,
      supplierId: supplierId ? supplierId : null,
      currency: currency ? currency : null,
      lines: lineInputs,
    };
    return updateCommercePurchaseDocument(documentId, payload);
  }, [values, lines, documentId]);

  const handleSaveDraft = async () => {
    if (pending) return;
    if (!ensureValid()) return;

    setPending('save');
    setError(null);
    setSuccess(null);
    try {
      const document = await save();
      setDocumentId(document.id);
      setDocumentNumber(document.documentNumber);
      setDirty(false);
      setSuccess(`پیش‌نویس ذخیره شد. شمارهٔ سند: ${document.documentNumber}`);
    } catch (err: unknown) {
      setError(
        commerceActionErrorMessage(
          err,
          'ذخیرهٔ پیش‌نویس انجام نشد. اطلاعات واردشده حفظ شده است؛ دوباره تلاش کنید.'
        )
      );
    } finally {
      setPending(null);
    }
  };

  const handleSubmit = async () => {
    if (pending) return;
    setConfirmSubmit(false);
    if (!ensureValid()) return;

    setPending('submit');
    setError(null);
    setSuccess(null);
    try {
      const document = await save();
      const submitted = await submitCommercePurchaseDocument(document.id);
      setSuccess('درخواست خرید ارسال شد.');
      router.push(`${DETAIL_BASE}/${submitted.id}`);
    } catch (err: unknown) {
      setError(
        commerceActionErrorMessage(
          err,
          'ارسال درخواست انجام نشد. اطلاعات واردشده حفظ شده است؛ وضعیت را بررسی و دوباره تلاش کنید.'
        )
      );
    } finally {
      setPending(null);
    }
  };

  const handleLeave = () => {
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    router.push(DETAIL_BASE);
  };

  if (rbac.isLoading || isLoading) {
    return <CoreLoading lines={5} />;
  }

  if (!canManage) {
    return (
      <CoreForbidden message="برای ایجاد یا تغییر درخواست خرید به مجوز commerce.manage نیاز دارید." />
    );
  }

  if (loadError) {
    return (
      <CoreError message={loadError} onRetry={reload} />
    );
  }

  if (notEditable && documentId) {
    return (
      <div data-testid="commerce-purchase-create-not-editable">
        <CommercePageHeading title="ویرایش درخواست خرید" />
        <CommerceCard>
          <p className="text-sm text-foreground">
            این سند دیگر پیش‌نویس نیست و قابل ویرایش نمی‌باشد. فقط پیش‌نویس‌ها تغییر می‌پذیرند.
          </p>
          <div className="mt-4">
            <Link
              href={`${DETAIL_BASE}/${documentId}`}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              مشاهدهٔ سند
            </Link>
          </div>
        </CommerceCard>
      </div>
    );
  }

  const busy = pending !== null;
  const stepNumber = (value: Step) => (value === 'details' ? '۱' : value === 'lines' ? '۲' : '۳');

  /**
   * WHO this request is for, in the words a person reads. With the directory grant the picker
   * shows the member's own name; without it the panel names the session user («خود شما») or
   * the resolved name the document carried. It never renders a bare identifier as the
   * primary value.
   */
  const requesterLabel = !values.requesterId
    ? 'هنوز انتخاب نشده است'
    : sessionRequesterId && values.requesterId === sessionRequesterId
      ? 'خود شما'
      : requesterName && requesterName.length > 0
        ? requesterName
        : 'کاربر ثبت‌شدهٔ سند';

  return (
    <div data-testid="commerce-purchase-create">
      <CommercePageHeading
        title={editDocumentId ? 'ویرایش پیش‌نویس درخواست خرید' : 'درخواست خرید جدید'}
        description="مشخص کنید چه چیزی نیاز دارید؛ اقلام را اضافه کنید و سپس ثبت یا ارسال کنید."
        actions={
          <>
            <button
              type="button"
              onClick={handleLeave}
              disabled={busy}
              data-testid="commerce-create-back"
              className="inline-flex h-10 items-center gap-1 rounded-xl border border-border px-3 text-sm text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
              بازگشت به فهرست درخواست‌ها
            </button>
            {documentId && (
              <Link
                href={`${DETAIL_BASE}/${documentId}`}
                data-testid="commerce-create-open-detail"
                className="inline-flex h-10 items-center rounded-xl border border-border px-3 text-sm text-foreground transition hover:bg-secondary"
              >
                مشاهدهٔ سند
              </Link>
            )}
          </>
        }
      />

      {documentNumber && (
        <p className="mb-4 text-xs text-muted-foreground">
          شمارهٔ سند:{' '}
          <span dir="ltr" className="rounded-md bg-muted px-2 py-0.5 text-foreground">
            {documentNumber}
          </span>
        </p>
      )}

      <CommerceCard className="mb-6">
        <ol className="flex flex-wrap items-center gap-2" aria-label="مراحل ثبت درخواست">
          {(['details', 'lines', 'review'] as Step[]).map((value, index) => {
            const labels: Record<Step, string> = {
              details: 'اطلاعات اصلی',
              lines: 'اقلام',
              review: 'بررسی و ثبت',
            };
            const isCurrent = step === value;
            return (
              <li key={value} className="flex items-center gap-2">
                {index > 0 && <span className="text-muted-foreground">←</span>}
                <button
                  type="button"
                  onClick={() => {
                    if (value === 'details') setStep('details');
                    else if (value === 'lines') goToLines();
                    else goToReview();
                  }}
                  disabled={busy}
                  aria-current={isCurrent ? 'step' : undefined}
                  data-testid={`commerce-create-step-${value}`}
                  className={`rounded-xl border px-3 py-2 text-sm transition disabled:opacity-50 ${
                    isCurrent
                      ? 'border-primary/40 bg-primary/10 font-medium text-primary'
                      : 'border-border text-foreground hover:bg-secondary'
                  }`}
                >
                  {stepNumber(value)}. {labels[value]}
                </button>
              </li>
            );
          })}
        </ol>
      </CommerceCard>

      {success && <CommerceFeedback message={success} testId="commerce-create-success" />}
      {error && <CommerceFeedback message={error} tone="danger" testId="commerce-create-error" />}

      {step === 'details' && (
        <CommerceCard title="اطلاعات اصلی" testId="commerce-create-details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              {canPickRequester ? (
                <CommerceMemberPicker
                  id="commerce-requester-id"
                  label="درخواست‌کننده"
                  value={values.requesterId || null}
                  onChange={(memberId) => patchValues({ requesterId: memberId ?? '' })}
                  enabled
                  disabled={busy}
                  allowClear={false}
                  helper="به‌طور پیش‌فرض خود شما؛ برای ثبت به‌نمایندگی از دیگری، نام او را جستجو کنید."
                  limitationText=""
                  testId="commerce-create-requester"
                />
              ) : (
                <div data-testid="commerce-create-requester-readonly">
                  <p className="mb-1 text-xs text-muted-foreground">درخواست‌کننده</p>
                  <p className="rounded-xl border border-border bg-secondary/40 px-3 py-2 text-sm text-foreground">
                    {requesterLabel}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {values.requesterId
                      ? 'برای ثبت به‌نمایندگی از دیگری، مجوز مشاهدهٔ فهرست سازمانی (admin.users.read) لازم است.'
                      : 'برای این نشست درخواست‌کننده‌ای به‌صورت پیش‌فرض قابل ارسال نیست؛ انتخاب عضو به مجوز مشاهدهٔ فهرست سازمانی (admin.users.read) نیاز دارد و بدون آن ثبت درخواست ممکن نیست.'}
                  </p>
                </div>
              )}
              {mainErrors.requesterId && (
                <p
                  id="commerce-requester-id-error"
                  data-testid="commerce-create-requester-error"
                  className="mt-1 text-xs text-destructive"
                >
                  {mainErrors.requesterId}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="commerce-supplier-id"
                className="mb-1 block text-xs text-muted-foreground"
              >
                شناسهٔ تأمین‌کننده (اختیاری)
              </label>
              <input
                id="commerce-supplier-id"
                type="text"
                dir="ltr"
                maxLength={SUPPLIER_MAX}
                value={values.supplierId}
                disabled={busy}
                aria-invalid={mainErrors.supplierId ? true : undefined}
                aria-describedby={mainErrors.supplierId ? 'commerce-supplier-id-error' : undefined}
                onChange={(event) => patchValues({ supplierId: event.target.value })}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
              {mainErrors.supplierId && (
                <p id="commerce-supplier-id-error" className="mt-1 text-xs text-destructive">
                  {mainErrors.supplierId}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="commerce-currency" className="mb-1 block text-xs text-muted-foreground">
                ارز (اختیاری)
              </label>
              <input
                id="commerce-currency"
                type="text"
                dir="ltr"
                maxLength={3}
                value={values.currency}
                disabled={busy}
                aria-invalid={mainErrors.currency ? true : undefined}
                aria-describedby={
                  mainErrors.currency ? 'commerce-currency-error' : 'commerce-currency-hint'
                }
                onChange={(event) => patchValues({ currency: event.target.value.toUpperCase() })}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-start text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
              />
              <p id="commerce-currency-hint" className="mt-1 text-xs text-muted-foreground">
                کد سه‌حرفی، مثل IRR. خالی بگذارید تا توسط سرویس تعیین شود.
              </p>
              {mainErrors.currency && (
                <p id="commerce-currency-error" className="mt-1 text-xs text-destructive">
                  {mainErrors.currency}
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button
              type="button"
              onClick={goToLines}
              disabled={busy}
              data-testid="commerce-create-next"
            >
              مرحلهٔ بعد: اقلام
            </Button>
          </div>
        </CommerceCard>
      )}

      {step === 'lines' && (
        <CommerceCard testId="commerce-create-lines">
          <CommerceSectionHeading
            title="اقلام درخواست"
            description="برای هر قلم، نوع، مقدار و در صورت وجود قیمت را ثبت کنید."
          />
          <CommercePurchaseLinesEditor
            lines={lines}
            onChange={patchLines}
            errors={lineErrors}
            disabled={busy}
          />
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              onClick={() => setStep('details')}
              disabled={busy}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              مرحلهٔ قبل
            </Button>
            <Button
              type="button"
              onClick={goToReview}
              disabled={busy}
              data-testid="commerce-create-review"
            >
              مرحلهٔ بعد: بررسی
            </Button>
          </div>
        </CommerceCard>
      )}

      {step === 'review' && (
        <CommerceCard testId="commerce-create-review-step">
          <CommercePurchaseReview
            requesterId={values.requesterId}
            supplierId={values.supplierId}
            currency={values.currency}
            lines={lines}
          />
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              onClick={() => setStep('lines')}
              disabled={busy}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              مرحلهٔ قبل
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => void handleSaveDraft()}
                disabled={busy}
                aria-busy={pending === 'save'}
                data-testid="commerce-create-save"
                className="border border-border bg-background text-foreground hover:bg-secondary"
              >
                {pending === 'save' ? 'در حال ذخیره…' : 'ذخیرهٔ پیش‌نویس'}
              </Button>
              <Button
                type="button"
                onClick={() => setConfirmSubmit(true)}
                disabled={busy}
                data-testid="commerce-create-submit"
              >
                ثبت و ارسال
              </Button>
            </div>
          </div>
        </CommerceCard>
      )}

      <CommerceConfirmDialog
        open={confirmSubmit}
        testId="commerce-create-confirm-submit"
        title="ارسال درخواست خرید"
        description="پس از ارسال، سند از پیش‌نویس خارج و برای بررسی بعدی ثبت می‌شود."
        consequences="پس از ارسال، این سند دیگر از این فرم قابل ویرایش نیست."
        confirmLabel="ارسال درخواست"
        pending={pending === 'submit'}
        onConfirm={() => void handleSubmit()}
        onCancel={() => setConfirmSubmit(false)}
      />

      <CommerceConfirmDialog
        open={confirmLeave}
        testId="commerce-create-confirm-leave"
        title="تغییرات ذخیره‌نشده"
        description="اطلاعات واردشده در این فرم ذخیره نشده است."
        consequences="اگر اکنون خارج شوید، تمام مقادیر واردشده از بین می‌رود."
        confirmLabel="خروج بدون ذخیره"
        confirmTone="danger"
        onConfirm={() => {
          setConfirmLeave(false);
          router.push(DETAIL_BASE);
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </div>
  );
}

