import { PurchaseReportDetailView } from '@/components/reporting/PurchaseReportDetailView';

/**
 * Phase REPORTING-PURCHASE-REPORT: the READ-ONLY purchase report detail —
 * `/admin/reporting/purchase-requests/[id]` — one document of the register.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row, the on-demand timeline and the error/forbidden states. No mutation
 * exists on this route by contract — the backend exposes three GETs and nothing else.
 */
export const metadata = {
  title: 'جزئیات درخواست خرید',
  robots: { index: false, follow: false },
};

export default async function AdminReportingPurchaseRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PurchaseReportDetailView documentId={id} />;
}
