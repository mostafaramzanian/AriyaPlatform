import { ReturnLifecycleReportView } from '@/components/reporting/ReturnLifecycleReportView';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the return lifecycle report route —
 * `/admin/reporting/commerce/return-lifecycle` — hosting «گزارش چرخه حیات
 * مرجوعی‌های بازرگانی».
 *
 * The route renders inside the existing admin shell, so authentication, the
 * permission-aware sidebar, the RTL document and the skip link are inherited. The page
 * itself stays a thin server component; the report workspace below owns fetching,
 * filters, summary, chart, table and states.
 *
 * The `metadata.title` fills the browser tab; the shell's persistent header title
 * comes from the `PAGE_TITLE_ALIASES` entry in `core-nav.ts` (this route has no rail
 * row — a nav row is a platform-navigation decision, the sibling-report precedent).
 */
export const metadata = {
  title: 'گزارش چرخه حیات مرجوعی‌های بازرگانی',
  robots: { index: false, follow: false },
};

export default function AdminReportingCommerceReturnLifecyclePage() {
  return <ReturnLifecycleReportView />;
}
