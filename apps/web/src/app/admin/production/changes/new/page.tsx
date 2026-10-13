import { ProductionBomChangeFormView } from '@/components/production/ProductionBomChangeFormView';

export const metadata = {
  title: 'ثبت درخواست تغییر BOM',
  robots: { index: false, follow: false },
};

/**
 * Phase PRODUCTION-BOM-CHANGE: the create route — `/admin/production/changes/new`.
 *
 * CREATE ONLY. There is no `?edit=` mode here, unlike the BOM header's form: the change
 * request's own fields are editable through a PATCH the DETAIL screen owns, so a second
 * entry point would be a second place the same rule could be forgotten.
 *
 * A thin route wrapper: the view owns the permission gate and the form.
 */
export default function AdminProductionChangeCreatePage() {
  return <ProductionBomChangeFormView />;
}
