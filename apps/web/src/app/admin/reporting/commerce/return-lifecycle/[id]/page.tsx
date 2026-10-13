import { ReturnLifecycleReportDetailView } from '@/components/reporting/ReturnLifecycleReportDetailView';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the READ-ONLY return report detail —
 * `/admin/reporting/commerce/return-lifecycle/[id]` — one return of the register
 * with its lines and its audit-backed lifecycle timeline.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the lines table, the timeline and the error/forbidden states.
 * No mutation exists on this route by contract — the backend exposes five GETs and
 * nothing else.
 */
export const metadata = {
  title: 'جزئیات مرجوعی بازرگانی',
  robots: { index: false, follow: false },
};

export default async function AdminReportingCommerceReturnLifecycleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReturnLifecycleReportDetailView returnId={id} />;
}
