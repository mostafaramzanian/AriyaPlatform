import { ManagementDashboardView } from '@/components/management/ManagementDashboardView';

export const metadata = {
  title: 'نمای مدیریت',
  robots: { index: false, follow: false },
};

export default function AdminManagementPage() {
  return <ManagementDashboardView />;
}
