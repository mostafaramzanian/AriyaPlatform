import { CoreDashboard } from '@/components/core/CoreDashboard';

export const metadata = {
  title: 'خانه',
  robots: { index: false, follow: false },
};

export default function AdminIndexPage() {
  return <CoreDashboard />;
}

