'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  decideProductionBom,
  deleteProductionBomItem,
  fetchProductionBom,
  fetchProductionBomItems,
  submitProductionBom,
  type ProductionBom,
  type ProductionBomItem,
  type ProductionBomItemPage,
} from '@/lib/production-api';
import {
  productionDateLabel,
  productionErrorCode,
  productionErrorMessage,
  productionManagerOpinionLabel,
  productionPartTypeLabel,
  productionServerMessage,
} from '@/lib/production-labels';
import {
  ProductionBomStatusBadge,
  ProductionCard,
  ProductionEmptyState,
  ProductionPageHeading,
  ProductionPagination,
} from './production-ui';
import { ProductionBomItemDialog } from './ProductionBomItemDialog';
import { ProductionBomTimeline } from './ProductionBomTimeline';

/**
 * Phase PRODUCTION-BOM: the BOM detail — `/admin/production/[id]`.
 *
 * ONE SCREEN, FOUR FACTS: the HEADER, the LIFECYCLE actions the state and the caller's
 * permissions jointly allow, the ITEMS grid, and the item dialog. The backend is the source
 * of truth: the status shown is the row's, every action is hidden or disabled from that row
 * plus the grants, and a refusal is rendered from its TYPED code, not an English sentence.
 *
 * THE ACTIONS ARE STATE- AND PERMISSION-GATED, and the gate is COSMETIC — the server refuses
 * regardless. `submit` appears only on a DRAFT to a `production.bom.manage` holder; the three
 * decisions only on a SUBMITTED BOM to a `production.bom.approve` holder; the item mutations
 * only while the BOM is a DRAFT.
 *
 * APPROVAL IS ON THE HEADER, NOT ON AN ITEM. There is no per-item approve button — the
 * source's approval task reviewed the grid while deciding the header.
 *
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE adds a FIFTH fact: the read-only event HISTORY at the
 * bottom of the page. It is rendered ONLY to a `production.bom.read` holder (the same grant
 * the two reads above use — no new permission was invented for it), it owns its own request
 * and pager, and it changes nothing about the header, the lifecycle or the items.
 */
export function ProductionBomDetailView({ bomId }: { bomId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');
  const canManage = enforcePermissions && rbac.permissions.includes('production.bom.manage');
  const canApprove = enforcePermissions && rbac.permissions.includes('production.bom.approve');

  const [bom, setBom] = React.useState<ProductionBom | null>(null);
  const [bomError, setBomError] = React.useState<string | null>(null);
  const [isLoadingBom, setLoadingBom] = React.useState(true);

  const [items, setItems] = React.useState<ProductionBomItemPage | null>(null);
  const [itemsError, setItemsError] = React.useState<string | null>(null);
  const [isLoadingItems, setLoadingItems] = React.useState(false);
  const [itemPage, setItemPage] = React.useState(1);

  const [actionError, setActionError] = React.useState<string | null>(null);
  const [isActing, setActing] = React.useState(false);
  const [dialogItem, setDialogItem] = React.useState<ProductionBomItem | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  // The two reads used to arm themselves in their effect bodies; the arms now
  // ride render-time adjustments and this handler, all in the same commit as
  // the change that triggers the refetch. `reload` re-arms BOTH reads — one
  // token used to refire both effects, each arming itself.
  const reload = () => {
    setReloadToken((value) => value + 1);
    setLoadingBom(true);
    setBomError(null);
    setLoadingItems(true);
    setItemsError(null);
  };

  // A new BOM id is a new read of both the header and its items.
  const [prevBomId, setPrevBomId] = React.useState(bomId);
  if (prevBomId !== bomId) {
    setPrevBomId(bomId);
    setLoadingBom(true);
    setBomError(null);
    setLoadingItems(true);
    setItemsError(null);
  }

  // The items read starts once the header has landed (its guard used to skip
  // the arm while `bom` was still null).
  const [prevBom, setPrevBom] = React.useState(bom);
  if (prevBom !== bom) {
    setPrevBom(bom);
    if (bom !== null) {
      setLoadingItems(true);
      setItemsError(null);
    }
  }

  // A page change is a new items read (the pagination control writes state
  // from inside a child, so a render adjustment is the place to arm).
  const [prevItemPage, setPrevItemPage] = React.useState(itemPage);
  if (prevItemPage !== itemPage) {
    setPrevItemPage(itemPage);
    setLoadingItems(true);
    setItemsError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchProductionBom(bomId)
      .then((row) => {
        if (!active) return;
        setBom(row);
        setLoadingBom(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setBomError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setLoadingBom(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, bomId, reloadToken]);

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead || !bom) return;

    let active = true;

    fetchProductionBomItems(bomId, { page: itemPage, pageSize: PRODUCTION_DEFAULT_PAGE_SIZE })
      .then((page) => {
        if (!active) return;
        setItems(page);
        setLoadingItems(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setItemsError(err instanceof Error ? err.message : 'دریافت اقلام با خطا مواجه شد.');
        setLoadingItems(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, bom, bomId, itemPage, reloadToken]);

  const runAction = async (fn: () => Promise<unknown>) => {
    setActing(true);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err: unknown) {
      const details = err instanceof CoreApiError ? err.details : undefined;
      setActionError(
        productionErrorMessage(
          productionErrorCode(details),
          productionServerMessage(details) ??
            (err instanceof Error ? err.message : undefined)
        )
      );
    } finally {
      setActing(false);
    }
  };

  const removeItem = async (item: ProductionBomItem) => {
    if (!window.confirm(`قلم «${item.partName}» حذف شود؟`)) return;
    await runAction(() => deleteProductionBomItem(bomId, item.id));
  };

  if (rbac.isLoading) return <CoreLoading lines={6} />;

  if (!canRead) {
    return <CoreForbidden message="برای مشاهدهٔ این BOM به مجوز production.bom.read نیاز دارید." />;
  }

  if (isLoadingBom) return <CoreLoading lines={6} />;

  if (bomError || !bom) {
    return (
      <div data-testid="production-bom-detail-error">
        <CoreError message={bomError ?? 'BOM مورد نظر یافت نشد.'} onRetry={reload} />
        <div className="mt-4">
          <Link
            href="/admin/production"
            className="text-sm text-foreground underline underline-offset-4"
          >
            بازگشت به فهرست
          </Link>
        </div>
      </div>
    );
  }

  const isDraft = bom.status === 'DRAFT';
  const isSubmitted = bom.status === 'SUBMITTED';
  const itemRows = items?.items ?? [];
  const busy = isActing;

  return (
    <div data-testid="production-bom-detail">
      <ProductionPageHeading
        title={bom.title}
        testId="production-bom-detail-heading"
        actions={
          <>
            {canManage && isDraft && (
              <Link
                href={`/admin/production/${bom.id}/edit`}
                data-testid="production-bom-edit-action"
                className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
              >
                ویرایش
              </Link>
            )}
            {canManage && isDraft && (
              <button
                type="button"
                data-testid="production-bom-submit-action"
                disabled={busy}
                onClick={() => runAction(() => submitProductionBom(bom.id))}
                className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ارسال برای تایید
              </button>
            )}
          </>
        }
      />

      {actionError && (
        <div className="mb-6" data-testid="production-bom-action-error">
          <CoreError message={actionError} />
        </div>
      )}

      <ProductionCard className="mb-6" testId="production-bom-summary">
        <div className="flex flex-wrap items-center gap-3">
          <ProductionBomStatusBadge status={bom.status} />
          {bom.managerOpinion && (
            <span className="text-sm text-muted-foreground">
              نظر مدیر: {productionManagerOpinionLabel(bom.managerOpinion)}
            </span>
          )}
          <span className="text-sm text-muted-foreground">
            آخرین ویرایش: {productionDateLabel(bom.updatedAt)}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">پروژه</dt>
            <dd data-testid="production-bom-project" className="mt-1 text-sm text-foreground">
              {bom.projectRef}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">درخت محصول</dt>
            <dd data-testid="production-bom-tree" className="mt-1 text-sm text-foreground">
              {bom.productTreeRef}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">تایید‌کننده</dt>
            <dd data-testid="production-bom-approver" className="mt-1 text-sm text-foreground">
              {bom.approverUserId ?? '—'}
            </dd>
          </div>
        </dl>

        {bom.comments && (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="production-bom-comments">
            {bom.comments}
          </p>
        )}

        {canApprove && isSubmitted && (
          <div
            className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4"
            data-testid="production-bom-decision-actions"
          >
            <button
              type="button"
              data-testid="production-bom-approve-action"
              disabled={busy}
              onClick={() =>
                runAction(() => decideProductionBom(bom.id, 'approve', { opinion: 'APPROVED' }))
              }
              className="inline-flex h-9 items-center rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              تایید
            </button>
            <button
              type="button"
              data-testid="production-bom-reject-action"
              disabled={busy}
              onClick={() =>
                runAction(() => decideProductionBom(bom.id, 'reject', { opinion: 'REJECTED' }))
              }
              className="inline-flex h-9 items-center rounded-xl border border-destructive/40 px-3 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
            >
              رد
            </button>
            <button
              type="button"
              data-testid="production-bom-correction-action"
              disabled={busy}
              onClick={() =>
                runAction(() =>
                  decideProductionBom(bom.id, 'request-correction', { opinion: 'NEEDS_CORRECTION' })
                )
              }
              className="inline-flex h-9 items-center rounded-xl border border-border px-3 text-xs font-medium text-foreground transition hover:bg-secondary disabled:opacity-50"
            >
              نیاز به اصلاح
            </button>
          </div>
        )}
      </ProductionCard>

      <ProductionCard testId="production-bom-items">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">اقلام</h2>
          {canManage && isDraft && (
            <button
              type="button"
              data-testid="production-item-add-action"
              onClick={() => {
                setDialogItem(null);
                setDialogOpen(true);
              }}
              className="inline-flex h-9 items-center rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              افزودن قلم
            </button>
          )}
        </div>

        {itemsError && (
          <div className="mb-4" data-testid="production-bom-items-error">
            <CoreError message={itemsError} />
          </div>
        )}

        {isLoadingItems && items === null ? (
          <CoreLoading lines={4} />
        ) : itemRows.length === 0 ? (
          <ProductionEmptyState
            message="هنوز قلمی برای این BOM ثبت نشده است. یک BOM بدون قلم قابل ارسال نیست."
            testId="production-bom-items-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">نام قطعه</th>
                  <th className="px-3 py-2 font-medium">نوع</th>
                  <th className="px-3 py-2 font-medium">جنس</th>
                  <th className="px-3 py-2 font-medium">واحد</th>
                  <th className="px-3 py-2 font-medium">ضریب نقشه</th>
                  <th className="px-3 py-2 font-medium">ضریب یدکی</th>
                  <th className="px-3 py-2 font-medium">کد استاندارد</th>
                  <th className="px-3 py-2 font-medium">تأمین‌کننده پیشنهادی</th>
                  {canManage && isDraft && <th className="px-3 py-2 font-medium">عملیات</th>}
                </tr>
              </thead>
              <tbody aria-busy={isLoadingItems}>
                {itemRows.map((item) => (
                  <tr
                    key={item.id}
                    data-testid="production-bom-item-row"
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3 font-medium text-foreground">{item.partName}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {productionPartTypeLabel(item.partType)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{item.material}</td>
                    <td className="px-3 py-3 text-muted-foreground">{item.measurementUnit}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {toPersianDigits(String(item.drawingConsumptionCoefficient))}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {toPersianDigits(String(item.spareConsumptionCoefficient))}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {item.standardPartCode ?? (
                        <span data-testid={`production-item-code-deferred-${item.id}`}>—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {item.suggestedSupplier ?? '—'}
                    </td>
                    {canManage && isDraft && (
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-testid={`production-item-edit-${item.id}`}
                            onClick={() => {
                              setDialogItem(item);
                              setDialogOpen(true);
                            }}
                            className="text-xs font-medium text-foreground underline underline-offset-4"
                          >
                            ویرایش
                          </button>
                          <button
                            type="button"
                            data-testid={`production-item-delete-${item.id}`}
                            disabled={busy}
                            onClick={() => removeItem(item)}
                            className="text-xs font-medium text-destructive underline underline-offset-4 disabled:opacity-50"
                          >
                            حذف
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {itemRows.length > 0 && (
          <ProductionPagination
            page={items?.page ?? 1}
            pageSize={items?.pageSize ?? PRODUCTION_DEFAULT_PAGE_SIZE}
            total={items?.total ?? 0}
            onPageChange={setItemPage}
            disabled={isLoadingItems}
          />
        )}

        <p
          className="mt-4 text-xs text-muted-foreground"
          data-testid="production-bom-item-deferral-note"
        >
          کد استاندارد قطعه تا زمان تعیین قرارداد درخت محصول تولید نمی‌شود (به‌زودی).
        </p>
      </ProductionCard>

      {/*
        Phase PRODUCTION-BOM-AUDIT-TIMELINE: the read-only event history. Placed AFTER the
        items because it is a record of what happened to them, not an input to what they
        are — and it is gated on the SAME `production.bom.read` the two reads above use, so
        no new permission was introduced for it.
      */}
      {canRead && <ProductionBomTimeline bomId={bom.id} />}

      {dialogOpen && (
        <ProductionBomItemDialog
          bomId={bom.id}
          item={dialogItem}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}



