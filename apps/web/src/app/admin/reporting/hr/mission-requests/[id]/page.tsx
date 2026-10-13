import { HrMissionReportDetailView } from '@/components/reporting/HrMissionReportDetailView';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the READ-ONLY mission-request report detail —
 * `/admin/reporting/hr/mission-requests/[id]` — one register row.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the on-demand timeline and the error/forbidden states. No mutation
 * exists on this route by contract — the backend exposes five GETs and nothing else.
 */
export const metadata = {
  title: 'جزئیات درخواست مأموریت',
  robots: { index: false, follow: false },
};

export default async function AdminReportingHrMissionRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HrMissionReportDetailView rowId={id} />;
}
