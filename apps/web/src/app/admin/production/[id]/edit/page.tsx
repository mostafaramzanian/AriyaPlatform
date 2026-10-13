import { ProductionBomFormView } from '@/components/production/ProductionBomFormView';

export const metadata = {
  title: 'ویرایش BOM',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM: the BOM edit route — `/admin/production/[id]/edit`.
 *
 * A thin wrapper that hands the id to the SAME form the create route uses, which decides
 * POST vs PATCH from it. `params` is awaited (Next 15+).
 */
export default async function AdminProductionBomEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductionBomFormView editBomId={id} />;
}
