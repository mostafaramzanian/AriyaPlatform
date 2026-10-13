import { CheckRequestListView } from '@/components/financial/CheckRequestListView';

export const metadata = {
  title: 'درخواست‌های صدور چک',
  robots: { index: false, follow: false },
};

/**
 * Phase F1 — FINANCIAL FOUNDATION: the check-request register route —
 * `/admin/financial/check-requests`.
 *
 * A thin route wrapper: the view owns the fetch, the permission gate and the filters, so
 * this file carries only metadata. The same shape every other admin list route uses.
 */
export default function AdminFinancialCheckRequestsPage() {
  return <CheckRequestListView />;
}
