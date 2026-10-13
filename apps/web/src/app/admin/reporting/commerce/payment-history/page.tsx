import { PaymentHistoryReportView } from '@/components/reporting/PaymentHistoryReportView';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the payment history report route —
 * `/admin/reporting/commerce/payment-history` — hosting «گزارش تاریخچه پرداخت‌های
 * بازرگانی».
 *
 * The route renders inside the existing admin shell, so authentication, the
 * permission-aware sidebar, the RTL document and the skip link are inherited. The page
 * itself stays a thin server component; the report workspace below owns fetching,
 * filters, summary, table and states.
 *
 * The `metadata.title` fills the browser tab; the shell's persistent header title
 * comes from the `PAGE_TITLE_ALIASES` entry in `core-nav.ts` (this route has no rail
 * row — a nav row is a platform-navigation decision, the sibling-report precedent).
 */
export const metadata = {
  title: 'گزارش تاریخچه پرداخت‌های بازرگانی',
  robots: { index: false, follow: false },
};

export default function AdminReportingCommercePaymentHistoryPage() {
  return <PaymentHistoryReportView />;
}
