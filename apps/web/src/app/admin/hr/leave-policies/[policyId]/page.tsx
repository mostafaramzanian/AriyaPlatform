import { HrLeavePolicyView } from '@/components/hr/HrLeavePolicyView';

export const metadata = {
  title: 'سیاست مرخصی',
  robots: { index: false, follow: false },
};

/**
 * Phase 54-I: the per-policy configuration and simulation surface.
 *
 * THE SEARCH PARAMETERS CARRY CONTEXT, NOT AUTHORITY. `leaveTypeId` pre-fills the simulation form and
 * `versionId` names the version the entry surface resolved, so the operator arrives with the question
 * they asked still in view. Neither is trusted for anything: the server derives the tenant, resolves
 * the version it is given against that tenant, and derives the evidence level itself (§27.2). A
 * hand-edited `versionId` therefore changes WHICH STORED VERSION IS DESCRIBED and nothing else — it
 * cannot widen disclosure, cross a tenant boundary, or affect runtime governance.
 *
 * `params` IS AWAITED because Next.js 15 made both `params` and `searchParams` asynchronous; the
 * neighbouring `employees/[id]` route is the local precedent.
 */
export default async function AdminHrLeavePolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ policyId: string }>;
  searchParams: Promise<{ leaveTypeId?: string; versionId?: string }>;
}) {
  const { policyId } = await params;
  const query = await searchParams;

  return (
    <HrLeavePolicyView
      policyId={policyId}
      leaveTypeId={query.leaveTypeId ?? ''}
      focusVersionId={query.versionId ?? null}
    />
  );
}
