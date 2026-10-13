import { CheckRequestFormView } from '@/components/financial/CheckRequestFormView';

export const metadata = {
  title: 'درخواست صدور چک جدید',
  robots: { index: false, follow: false },
};

/**
 * Phase F1 — FINANCIAL FOUNDATION: the create route —
 * `/admin/financial/check-requests/new`.
 *
 * `?edit=<id>` opens the same form against an EXISTING request (PATCH, not a second
 * POST), keeping the create/edit symmetry Production's routes use. The id is opaque: the
 * view reads it through the real route, which answers 404 for anything this tenant does
 * not hold.
 */
export default async function AdminFinancialCheckRequestCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const query = await searchParams;
  const editId = typeof query.edit === 'string' && query.edit.length > 0 ? query.edit : null;

  return <CheckRequestFormView editId={editId} />;
}
