import { ProductionBomChangeReportView } from '@/components/reporting/ProductionBomChangeReportView';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the change-request report route —
 * `/admin/reporting/production/bom-change-requests` — hosting «گزارش وضعیت درخواست‌های
 * تغییر فهرست مواد (BOM)».
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
 *
 * STATIC SEGMENT BESIDE A DYNAMIC ONE. `bom-change-requests` sits beside `[id]`
 * under `reporting/production`, and Next resolves the static segment first — so a BOM
 * whose id happened to be `bom-change-requests` could not shadow this route, and this
 * route cannot shadow the BOM report's detail (the same reasoning
 * `/admin/production/changes` records).
 */
export const metadata = {
  title: 'گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)',
  robots: { index: false, follow: false },
};

export default function AdminReportingProductionBomChangePage() {
  return <ProductionBomChangeReportView />;
}
