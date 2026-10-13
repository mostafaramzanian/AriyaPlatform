import { HrOrganizationView } from '@/components/hr/HrOrganizationView';

export const metadata = {
  title: 'چارت سازمانی',
  robots: { index: false, follow: false },
};

export default function AdminHrOrganizationPage() {
  return <HrOrganizationView />;
}