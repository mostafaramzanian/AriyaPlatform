import { KpiDetailView } from '@/components/kpi/KpiDetailView';

/**
 * Phase KPI-RUNTIME: the READ-ONLY KPI detail — `/admin/kpis/[technicalKey]` — one approved
 * definition, its value for the current Jalali month, and the provenance behind it.
 *
 * The technical key comes from the route params (a server component); the workspace below
 * owns the fetch, the value, the quality-vs-performance wording and the 404/403/error states.
 * No mutation exists on this route by contract — the backend exposes `GET /kpis/:key` and
 * nothing else.
 *
 * The detail key is deliberately NOT a navigation target: `isNavTarget` admits exact hrefs
 * only, so a KPI page can never be favourited or recorded as a recent visit — the same rule
 * every other `[id]` detail route in this repository follows.
 */
export const metadata = {
  title: 'جزئیات شاخص',
  robots: { index: false, follow: false },
};

export default async function AdminKpiDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <KpiDetailView technicalKey={decodeURIComponent(key)} />;
}
