import { ProductionReportDetailView } from '@/components/reporting/ProductionReportDetailView';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the READ-ONLY production report detail —
 * `/admin/reporting/production/[id]` — one BOM of the register.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the on-demand timeline and the error/forbidden states. No mutation
 * exists on this route by contract — the backend exposes three GETs and nothing else.
 */
export const metadata = {
  title: 'جزئیات فهرست مواد',
  robots: { index: false, follow: false },
};

export default async function AdminReportingProductionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductionReportDetailView bomId={id} />;
}
