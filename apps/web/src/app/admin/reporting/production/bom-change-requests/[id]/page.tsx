import { ProductionBomChangeReportDetailView } from '@/components/reporting/ProductionBomChangeReportDetailView';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the READ-ONLY change-request report
 * detail — `/admin/reporting/production/bom-change-requests/[id]` — one request of the
 * register.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the on-demand timeline and the error/forbidden states. No mutation
 * exists on this route by contract — the backend exposes five GETs and nothing else.
 */
export const metadata = {
  title: 'جزئیات درخواست تغییر فهرست مواد',
  robots: { index: false, follow: false },
};

export default async function AdminReportingProductionBomChangeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductionBomChangeReportDetailView changeId={id} />;
}
