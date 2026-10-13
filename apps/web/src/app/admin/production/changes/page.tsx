import { ProductionBomChangeListView } from '@/components/production/ProductionBomChangeListView';

export const metadata = {
  title: 'درخواست‌های تغییر BOM',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM-CHANGE: the change-request register route —
 * `/admin/production/changes`.
 *
 * A thin route wrapper: the view owns the fetch, the permission gate and the filters, so this
 * file carries only metadata. The same shape every other admin list route uses.
 *
 * STATIC SEGMENT, NOT A DYNAMIC ONE. `changes` sits beside `[id]` under
 * `/admin/production`, and Next resolves the static segment first — so a BOM whose id
 * happened to be `changes` could not shadow this route, and this route cannot shadow the BOM
 * detail.
 */
export default function AdminProductionChangesPage() {
  return <ProductionBomChangeListView />;
}
