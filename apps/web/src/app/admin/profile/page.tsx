import { Suspense } from 'react';
import { CoreProfileView } from '@/components/core/CoreProfileView';

export const metadata = {
  title: 'حساب من',
  robots: { index: false, follow: false },
};

/**
 * Phase 49C-1: the account page is now ONLY the account surface. The appearance and
 * accessibility controls that used to render beside `CoreProfileView` (as a sibling
 * card) moved to the settings destination `/admin/settings`, reached from the header
 * user menu — the account sections themselves became an accessible tablist.
 *
 * `CoreProfileView` reads the active tab from the URL (`?tab=`), so it is wrapped in a
 * Suspense boundary: `useSearchParams` requires one while the route is prerendered,
 * and the shell above this page is client code the build cannot see through.
 */
export default function AdminProfilePage() {
  return (
    <Suspense fallback={<div className="core-card p-core-card" />}>
      <CoreProfileView />
    </Suspense>
  );
}
