import { PurchaseReportView } from '@/components/reporting/PurchaseReportView';

/**
 * Phase REPORTING-PURCHASE-REPORT: the purchase report route —
 * `/admin/reporting/purchase-requests` — hosting «گزارش وضعیت و چرخه عمر
 * درخواست‌های خرید».
 *
 * The route renders inside the existing admin shell (`app/admin/layout.tsx`
 * → `AdminShell` → `CoreShell`), so authentication, the permission-aware
 * sidebar, the RTL document and the skip link are inherited — not
 * re-implemented here. The page itself stays a thin server component; the
 * report workspace below owns fetching, filters, summary, table and states.
 *
 * The `metadata.title` fills the browser tab; the shell's persistent header title
 * comes from the `PAGE_TITLE_ALIASES` entry in `core-nav.ts` (this route has no rail
 * row — a nav row is a platform-navigation decision, the Production/Financial
 * precedent), so neither surface ever falls back to «پنل مدیریت» on this page.
 */
export const metadata = {
  title: 'گزارش درخواست‌های خرید',
  robots: { index: false, follow: false },
};

export default function AdminReportingPurchaseRequestsPage() {
  return <PurchaseReportView />;
}
