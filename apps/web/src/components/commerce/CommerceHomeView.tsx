'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { fetchCommercePurchaseDocuments, type CommercePurchaseDocument } from '@/lib/commerce-api';
import { commerceDisplayName, commerceInstantLabel } from '@/lib/commerce-labels';
import {
  CommerceCard,
  CommerceDocumentStatusBadge,
  CommerceEmptyState,
  CommercePageHeading,
  CommerceSummaryMetric,
} from './commerce-ui';

/**
 * PHASE UI-1: the module home — `/admin/commerce`.
 *
 * WHAT THIS SCREEN MAY CLAIM. Every number on it is a SERVER `total` from
 * `GET /commerce/purchase-documents` read with a one-row window (the count and the page come
 * from one snapshot, and one row is the cheapest window that still answers with the real
 * total). No figure is arithmetic over a returned page, no KPI is invented, and nothing is
 * estimated: the UI-0 contract §7.2 fixes exactly these counters, and there is deliberately
 * no "spend" figure — Commerce exposes no aggregate endpoint (UI-0 GAP-4), and a home that
 * summed pages of rows would be the lying dashboard §7.3 forbids.
 *
 * THE CREATE CTA ARRIVED WITH UI-2. `POST /commerce/purchase-documents` and the
 * `/admin/commerce/purchases/new` route both exist now, so the primary action for a
 * `commerce.manage` holder opens the real create flow (and the register's rows open the
 * real detail route). The «نیازمند اقدام من» card still appears only for
 * `commerce.approve`: its screen's reads answer to the grants its own tabs consult, and a
 * shortcut to a refusal is not navigation.
 *
 * THE PERMISSION CHECK IS PRESENTATION ONLY. It decides whether a request is WORTH sending
 * and what is rendered; the backend remains the authority on every route.
 */

interface CommerceHomeData {
  /** The tenant's whole register, from the unfiltered read's total. */
  all: number;
  /** Documents the workflow is deciding — `status=SUBMITTED`. */
  submitted: number;
  /** The caller's own drafts; `null` when no user id is known — never rendered as 0. */
  myDrafts: number | null;
  /** The five most recent documents, newest first. */
  latest: CommercePurchaseDocument[];
}

export function CommerceHomeView() {
  const { user, isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  // Gated links follow the shell's rule: enforce only once RBAC has actually answered, so a
  // transient failure hides nothing (the backend still refuses what it should).
  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');
  const canApprove = rbac.permissions.includes('commerce.approve');
  const canManage = rbac.permissions.includes('commerce.manage');

  const userId = user?.userId ?? user?.sub ?? null;

  const [data, setData] = React.useState<CommerceHomeData | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token bump),
  // so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the register route
    // demands; retrying a 403 cannot succeed. (While RBAC is loading the shell renders the
    // loading branch below, so this effect simply waits.)
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    Promise.all([
      fetchCommercePurchaseDocuments({ page: 1, pageSize: 1 }),
      fetchCommercePurchaseDocuments({ page: 1, pageSize: 1, status: 'SUBMITTED' }),
      fetchCommercePurchaseDocuments({ page: 1, pageSize: 5 }),
      userId
        ? fetchCommercePurchaseDocuments({
            page: 1,
            pageSize: 1,
            status: 'DRAFT',
            requesterId: userId,
          })
        : Promise.resolve(null),
    ])
      .then(([all, submitted, latest, drafts]) => {
        if (!active) return;
        setData({
          all: all.total,
          submitted: submitted.total,
          myDrafts: drafts ? drafts.total : null,
          latest: latest.items,
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setData(null);
        setError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, userId, reloadToken]);

  // Whether a request cycle is meaningfully in flight. `isLoading` covers retries
  // (armed by the hook above, settled by the fetch effect); the derived term covers
  // the FIRST load, where no handler ever arms it: once the gate has settled and
  // neither data nor error has arrived, the four-fetch `Promise.all` is by
  // definition still pending. Replaces the previous in-effect `setLoading(true)`
  // reset (`react-hooks/set-state-in-effect`); the shell's `data === null` term
  // keeps non-first refetches (which keep `data`) off the skeleton, exactly as
  // before.
  const gateSettled = isAuthenticated && !rbac.isLoading && canRead;
  const busy = isLoading || (gateSettled && data === null && error === null);

  if (rbac.isLoading || (busy && data === null)) {
    return <CoreLoading lines={4} />;
  }

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهدهٔ ماژول تدارکات به مجوز commerce.read نیاز دارید." />
    );
  }

  if (error) {
    return <CoreError message={error} onRetry={reload} />;
  }

  const counters: Array<{ key: string; label: string; value: number | null; testId: string }> = [
    { key: 'all', label: 'همهٔ درخواست‌ها', value: data?.all ?? 0, testId: 'commerce-count-all' },
    {
      key: 'submitted',
      label: 'در حال بررسی',
      value: data?.submitted ?? 0,
      testId: 'commerce-count-submitted',
    },
    {
      key: 'drafts',
      label: 'پیش‌نویس‌های من',
      value: data?.myDrafts ?? null,
      testId: 'commerce-count-my-drafts',
    },
  ];

  return (
    <div data-testid="commerce-home">
      <CommercePageHeading
        title="خانهٔ تدارکات"
        description="نمای کلی درخواست‌های خرید سازمان"
        actions={
          <>
            <Link
              href="/admin/commerce/purchases"
              data-testid="commerce-home-cta-register"
              className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
            >
              مشاهدهٔ درخواست‌های خرید
            </Link>
            {canManage && (
              <Link
                href="/admin/commerce/purchases/new"
                data-testid="commerce-home-cta-create"
                className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
              >
                درخواست خرید جدید
              </Link>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {counters.map((counter) =>
          counter.value === null ? null : (
            <CommerceSummaryMetric
              key={counter.key}
              label={counter.label}
              value={counter.value.toLocaleString('fa-IR')}
              testId={counter.testId}
            />
          )
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Link
          href="/admin/commerce/purchases"
          data-testid="commerce-area-purchases"
          className="rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40"
        >
          <p className="text-sm font-medium text-foreground">درخواست‌های خرید</p>
          <p className="mt-1 text-xs text-muted-foreground">جستجو و مرور همهٔ درخواست‌های ثبت‌شده</p>
        </Link>
        {canApprove && (
          <Link
            href="/admin/commerce/tasks"
            data-testid="commerce-area-tasks"
            className="rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40"
          >
            <p className="text-sm font-medium text-foreground">نیازمند اقدام من</p>
            <p className="mt-1 text-xs text-muted-foreground">تصمیم‌های بازرگانی در انتظار شما</p>
          </Link>
        )}
      </div>

      <CommerceCard title="آخرین درخواست‌های خرید" testId="commerce-home-latest">
        {data && data.latest.length > 0 ? (
          <ul className="divide-y divide-border" data-testid="commerce-home-latest-list">
            {data.latest.map((document) => (
              <li
                key={document.id}
                data-testid={`commerce-home-latest-${document.documentNumber}`}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={`/admin/commerce/purchases/${document.id}`}
                    aria-label={`مشاهدهٔ سند ${document.documentNumber}`}
                    dir="ltr"
                    className="w-fit rounded-md bg-muted px-2 py-0.5 text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                  >
                    {document.documentNumber}
                  </Link>
                  <span className="truncate text-sm text-muted-foreground">
                    {commerceDisplayName(document.requester.profile, 'بدون پروفایل')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <CommerceDocumentStatusBadge status={document.status} />
                  <span className="text-xs text-muted-foreground" title={document.updatedAt}>
                    {commerceInstantLabel(document.updatedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <CommerceEmptyState message="هنوز درخواست خریدی ثبت نشده است." />
        )}
      </CommerceCard>
    </div>
  );
}

