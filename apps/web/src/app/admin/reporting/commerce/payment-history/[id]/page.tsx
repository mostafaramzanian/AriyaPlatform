import { PaymentHistoryReportDetailView } from '@/components/reporting/PaymentHistoryReportDetailView';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the READ-ONLY payment report detail —
 * `/admin/reporting/commerce/payment-history/[id]` — one payment event of the register.
 *
 * The id comes from the route params (a server component); the workspace below owns
 * the read-only row and the error/forbidden states. No mutation exists on this route
 * by contract — the backend exposes four GETs and nothing else, with no timeline.
 */
export const metadata = {
  title: 'جزئیات پرداخت بازرگانی',
  robots: { index: false, follow: false },
};

export default async function AdminReportingCommercePaymentHistoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PaymentHistoryReportDetailView paymentId={id} />;
}
