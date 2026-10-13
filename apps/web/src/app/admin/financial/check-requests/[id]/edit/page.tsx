import { CheckRequestFormView } from '@/components/financial/CheckRequestFormView';

export const metadata = {
  title: 'ویرایش درخواست صدور چک',
  robots: { index: false, follow: false },
};

/**
 * Phase F1 — FINANCIAL FOUNDATION: the edit route —
 * `/admin/financial/check-requests/[id]/edit`.
 *
 * A thin wrapper that hands the id to the SAME form the create route uses, which decides
 * POST vs PATCH from it. `params` is awaited (Next 15+).
 */
export default async function AdminFinancialCheckRequestEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CheckRequestFormView editId={id} />;
}
