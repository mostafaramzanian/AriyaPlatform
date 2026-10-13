import { CheckRequestReportDetailView } from '@/components/reporting/CheckRequestReportDetailView';

export const metadata = {
  title: 'جزئیات درخواست صدور چک — گزارش',
  robots: { index: false, follow: false },
};

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the read-only detail route —
 * `/admin/reporting/check-requests/[id]`.
 *
 * The route renders INSIDE the report (same shell, same permission gate as
 * the register) and offers no mutation: the view fetches the contract
 * projection and the selected request's timeline, and the only action is the
 * link back to `/admin/reporting`.
 *
 * `params` is awaited because Next 15+ made dynamic route params
 * asynchronous; the Financial and Production `[id]` routes are the local
 * precedent. The id passes through UNVALIDATED — it is an opaque identifier,
 * and the read itself is what answers 404 for an id this tenant does not
 * hold (a foreign id is indistinguishable from a missing one).
 */
export default async function AdminReportingCheckRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CheckRequestReportDetailView requestId={id} />;
}
