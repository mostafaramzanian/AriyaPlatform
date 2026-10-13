import { KpiListView } from '@/components/kpi/KpiListView';

/**
 * Phase KPI-RUNTIME: the KPI overview route — `/admin/kpis`.
 *
 * The route renders inside the existing admin shell (`app/admin/layout.tsx` → `AdminShell` →
 * `CoreShell`), so authentication, the permission-aware sidebar, the RTL document and the
 * skip link are inherited — not re-implemented here. The page itself stays a thin server
 * component; the workspace below owns the fetch, the Jalali month picker, the states and the
 * cards.
 *
 * The `metadata.title` fills the browser tab; the shell's persistent header title resolves
 * through the `CORE_NAV` row this phase adds (unlike the Reporting routes, which deliberately
 * have none — a KPI is a first-class management destination rather than a report of a
 * register, so it is discoverable from the rail).
 *
 * READ-ONLY BY CONTRACT: there is no write verb on this surface because the backend exposes
 * two GETs and nothing else.
 */
export const metadata = {
  title: 'شاخص‌های کلیدی عملکرد',
  robots: { index: false, follow: false },
};

export default function AdminKpisPage() {
  return <KpiListView />;
}
