import { ReceivingReportView } from '@/components/reporting/ReceivingReportView';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the receiving report route —
 * `/admin/reporting/commerce/receiving` — hosting «گزارش وضعیت دریافت‌های
 * بازرگانی».
 *
 * The route renders inside the existing admin shell, so authentication, the
 * permission-aware sidebar, the RTL document and the skip link are inherited. The
 * page itself stays a thin server component; the report workspace below owns
 * fetching, filters, summary, table and states.
 *
 * The `metadata.title` fills the browser tab; the shell's persistent header title
 * comes from the `PAGE_TITLE_ALIASES` entry in `core-nav.ts` (this route has no
 * rail row — a nav row is a platform-navigation decision, the sibling-report
 * precedent).
 */
export const metadata = {
  title: 'گزارش وضعیت دریافت‌های بازرگانی',
  robots: { index: false, follow: false },
};

export default function AdminReportingCommerceReceivingPage() {
  return <ReceivingReportView />;
}
