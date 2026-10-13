import { ProductionBomDetailView } from '@/components/production/ProductionBomDetailView';

export const metadata = {
  title: 'جزئیات BOM',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM: the BOM detail route — `/admin/production/[id]`.
 *
 * `params` is awaited because Next 15+ made dynamic route params asynchronous; the
 * neighbouring Commerce `[id]` route is the local precedent. The id is passed through
 * UNVALIDATED — it is an opaque BOM identifier, and the view's real read is what answers
 * 404 for an id this tenant does not hold.
 */
export default async function AdminProductionBomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductionBomDetailView bomId={id} />;
}
