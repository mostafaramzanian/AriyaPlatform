import { HrLeavePolicyEntryView } from '@/components/hr/HrLeavePolicyEntryView';

export const metadata = {
  title: 'سیاست‌های مرخصی',
  robots: { index: false, follow: false },
};

/**
 * Phase 54-I: the entry surface.
 *
 * IT TAKES NO PARAMETERS AND LISTS NOTHING. It asks the governance question — which policy governs a
 * leave type on a day — and the answer carries the policy id that the per-policy route needs. There is
 * no policy directory because the API deliberately has none (§12), so this page resolves rather than
 * enumerates.
 *
 * READ-ONLY AS A PAGE: it renders a view, and the view performs the reads.
 */
export default function AdminHrLeavePoliciesPage() {
  return <HrLeavePolicyEntryView />;
}
