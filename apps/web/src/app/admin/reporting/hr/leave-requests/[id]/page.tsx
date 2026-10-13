import { HrLeaveReportDetailView } from '@/components/reporting/HrLeaveReportDetailView';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the READ-ONLY leave-request report detail —
 * `/admin/reporting/hr/leave-requests/[id]` — one register row.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the on-demand timeline and the error/forbidden states. No mutation
 * exists on this route by contract — the backend exposes five GETs and nothing else.
 */
export const metadata = {
  title: 'جزئیات درخواست مرخصی',
  robots: { index: false, follow: false },
};

export default async function AdminReportingHrLeaveRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HrLeaveReportDetailView rowId={id} />;
}
