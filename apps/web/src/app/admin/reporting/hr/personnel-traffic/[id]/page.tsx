import { HrPersonnelTrafficReportDetailView } from '@/components/reporting/HrPersonnelTrafficReportDetailView';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the READ-ONLY personnel-traffic report detail —
 * `/admin/reporting/hr/personnel-traffic/[id]` — one register row.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the on-demand timeline and the error/forbidden states. No mutation
 * exists on this route by contract — the backend exposes three GETs and nothing else.
 */
export const metadata = {
  title: 'جزئیات رکورد تردد',
  robots: { index: false, follow: false },
};

export default async function AdminReportingHrPersonnelTrafficDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HrPersonnelTrafficReportDetailView rowId={id} />;
}
