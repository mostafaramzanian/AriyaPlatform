import { CommercePurchaseDetailView } from '@/components/commerce/CommercePurchaseDetailView';

export const metadata = {
  title: 'سند درخواست خرید',
  robots: { index: false, follow: false },
};

/**
 * PHASE UI-2: the Purchase Detail route — `/admin/commerce/purchases/[id]`, the central
 * workspace for ONE document (UI-0 §10). A contextual leaf: reached from the register,
 * the module home or a task, and never listed in the sidebar.
 *
 * THE ID IS OPAQUE. It is passed straight to the real reads; nothing is decoded out of
 * it, no tenant is inferred, and no extra lookup exists merely to validate it — the
 * backend answers 404 for an id this tenant does not hold, which is the same answer an
 * absent id gets (C1 §3-E), and the page renders that honestly.
 */
export default async function AdminCommercePurchaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ decision?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const decisionId = typeof query.decision === 'string' && query.decision.length > 0 ? query.decision : null;

  return <CommercePurchaseDetailView documentId={id} decisionId={decisionId} />;
}