import { ProductionBomFormView } from '@/components/production/ProductionBomFormView';

export const metadata = {
  title: 'BOM جدید',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM: the BOM create route — `/admin/production/new`.
 *
 * `?edit=<id>` OPENS THE SAME FORM AGAINST AN EXISTING DRAFT (PATCH, not a second POST).
 * The id is an opaque BOM identifier: the view reads the document through the real route
 * (which answers 404 for anything this tenant does not hold) and never decodes anything out
 * of it — no tenant is inferred, no extra lookup validates it. `searchParams` is awaited
 * because Next 15+ made it asynchronous, matching the neighbouring `[id]` route.
 */
export default async function AdminProductionCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const query = await searchParams;
  const editBomId = typeof query.edit === 'string' && query.edit.length > 0 ? query.edit : null;

  return <ProductionBomFormView editBomId={editBomId} />;
}
