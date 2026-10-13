import { CommercePurchaseCreateView } from '@/components/commerce/CommercePurchaseCreateView';

export const metadata = {
  title: 'درخواست خرید جدید',
  robots: { index: false, follow: false },
};

/**
 * PHASE UI-2: the Purchase Create route — a CONTEXTUAL LEAF, deliberately not in the
 * Commerce sidebar (UI-0/UI-1 classification): it is reached from the register or the
 * module home, and after a save it hands over to the detail route.
 *
 * `?edit=<id>` OPENS THE SAME FORM AGAINST AN EXISTING DRAFT (PATCH, not a second POST).
 * The id is an opaque document identifier: the view reads the document through the real
 * route (which answers 404 for anything this tenant does not hold) and never decodes
 * anything out of it — no tenant is inferred, no extra lookup is made to validate it.
 * `params`/`searchParams` are awaited because Next 15+ made both asynchronous; the
 * neighbouring HR `[policyId]` route is the local precedent.
 */
export default async function AdminCommercePurchaseCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const query = await searchParams;
  const editDocumentId = typeof query.edit === 'string' && query.edit.length > 0 ? query.edit : null;

  return <CommercePurchaseCreateView editDocumentId={editDocumentId} />;
}