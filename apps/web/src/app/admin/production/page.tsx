import { ProductionBomListView } from '@/components/production/ProductionBomListView';

export const metadata = {
  title: 'فهرست مواد و قطعات',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM: the BOM register route — `/admin/production`.
 *
 * A thin route wrapper: the view owns the fetch, the permission gate and the filters, so
 * this file carries only metadata. The same shape every other admin list route uses.
 */
export default function AdminProductionPage() {
  return <ProductionBomListView />;
}
