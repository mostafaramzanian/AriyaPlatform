import { Suspense } from 'react';
import { CoreCalendarView } from '@/components/core/CoreCalendarView';
import { CoreLoading } from '@/components/core/CoreStates';

export const metadata = {
  title: 'تقویم',
  robots: { index: false, follow: false },
};

/**
 * Phase 49I: the calendar surface.
 *
 * Wrapped in Suspense because CoreCalendarView reads `?date=` through
 * `useSearchParams`, which Next requires a suspense boundary for in the App Router.
 */
export default function AdminCalendarPage() {
  return (
    <Suspense fallback={<CoreLoading label="در حال بارگذاری تقویم..." lines={5} />}>
      <CoreCalendarView />
    </Suspense>
  );
}
