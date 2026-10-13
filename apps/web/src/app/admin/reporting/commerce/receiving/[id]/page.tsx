import { ReceivingReportDetailView } from '@/components/reporting/ReceivingReportDetailView';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the receiving report's DETAIL route —
 * `/admin/reporting/commerce/receiving/[id]` — hosting ONE per-line register row.
 *
 * Next 15: `params` is awaited, matching the sibling report detail pages. The row
 * id IS the purchase line id (scope gate A), so the page renders the line's own
 * projected facts and nothing of the document editor.
 */
export const metadata = {
  title: 'جزئیات وضعیت دریافت',
  robots: { index: false, follow: false },
};

export default async function AdminReportingCommerceReceivingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReceivingReportDetailView lineId={id} />;
}
