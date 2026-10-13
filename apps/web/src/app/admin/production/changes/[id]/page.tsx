import { ProductionBomChangeDetailView } from '@/components/production/ProductionBomChangeDetailView';

export const metadata = {
  title: 'درخواست تغییر BOM',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM-CHANGE: the change-request detail route —
 * `/admin/production/changes/[id]`.
 *
 * `params` is awaited because Next 15+ made dynamic route params asynchronous; the
 * neighbouring Commerce, HR and BOM `[id]` routes are the local precedent. The id is passed
 * through UNVALIDATED — it is an opaque change-request identifier, and the view's real read
 * is what answers 404 for an id this tenant does not hold.
 *
 * `new` IS ALSO A STATIC SIBLING (`/admin/production/changes/new`), and Next resolves the
 * static segment first, so the create route is never read as an id.
 */
export default async function AdminProductionChangePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductionBomChangeDetailView requestId={id} />;
}
