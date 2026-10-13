import { CheckRequestDetailView } from '@/components/financial/CheckRequestDetailView';

export const metadata = {
  title: 'جزئیات درخواست صدور چک',
  robots: { index: false, follow: false },
};

/**
 * Phase F1 — FINANCIAL FOUNDATION: the detail route —
 * `/admin/financial/check-requests/[id]`.
 *
 * `params` is awaited because Next 15+ made dynamic route params asynchronous; the
 * neighbouring Production `[id]` route is the local precedent. The id is passed through
 * UNVALIDATED — it is an opaque identifier, and the view's real read is what answers 404
 * for an id this tenant does not hold.
 */
export default async function AdminFinancialCheckRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CheckRequestDetailView requestId={id} />;
}
