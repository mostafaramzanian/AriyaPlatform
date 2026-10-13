import { HrLeaveReportView } from '@/components/reporting/HrLeaveReportView';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the leave-request report route —
 * `/admin/reporting/hr/leave-requests` — hosting «گزارش وضعیت درخواست‌های مرخصی».
 *
 * The route renders inside the existing admin shell (`app/admin/layout.tsx`
 * → `AdminShell` → `CoreShell`), so authentication, the permission-aware
 * sidebar, the RTL document and the skip link are inherited — not
 * re-implemented here. The page itself stays a thin server component; the
 * report workspace below owns fetching, filters, summary, table and states.
 *
 * The `metadata.title` fills the browser tab; the shell's persistent header title
 * comes from the `PAGE_TITLE_ALIASES` entry in `core-nav.ts` (this route has no rail
 * row — a nav row is a platform-navigation decision, the sibling-report
 * precedent), so neither surface ever falls back to «پنل مدیریت» on this page.
 */
export const metadata = {
  title: 'گزارش وضعیت درخواست‌های مرخصی',
  robots: { index: false, follow: false },
};

export default function AdminReportingHrLeaveRequestsPage() {
  return <HrLeaveReportView />;
}
