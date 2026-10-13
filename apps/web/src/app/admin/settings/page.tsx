import { Suspense } from 'react';
import { CoreSettingsCenter } from '@/components/core/CoreSettingsCenter';

export const metadata = {
  title: 'تنظیمات',
  robots: { index: false, follow: false },
};

/**
 * Phase 49C-2: the unified Settings Center, reached from the header user menu
 * (تنظیمات) — the SINGLE settings destination for personal AND platform settings.
 *
 * 49C-1 mounted the personal appearance card here; 49C-2 promotes the surface to a
 * permission-aware tab shell (`CoreSettingsCenter`) whose panels are the EXISTING
 * platform views that used to live behind the «تنظیمات پلتفرم» sidebar group. That
 * sidebar group is now hidden from the rail, but its hrefs stay declared nav targets:
 * direct routes, titles, drift checks and visit recording keep their verified
 * semantics. No second settings architecture, no new routes, no backend changes.
 *
 * `CoreSettingsCenter` reads the active tab from the URL (`?tab=`), so it is wrapped
 * in a Suspense boundary: `useSearchParams` requires one while the route is
 * prerendered, and the shell above this page is client code the build cannot see
 * through.
 */
export default function AdminSettingsPage() {
  return (
    <Suspense fallback={<div className="core-card p-core-card" />}>
      <CoreSettingsCenter />
    </Suspense>
  );
}