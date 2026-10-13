import { HrDashboardView } from '@/components/hr/HrDashboardView';

export const metadata = {
  title: 'منابع انسانی',
  robots: { index: false, follow: false },
};

export default function AdminHrPage() {
  return <HrDashboardView />;
}