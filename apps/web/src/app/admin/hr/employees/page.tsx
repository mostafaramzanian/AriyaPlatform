import { HrEmployeesView } from '@/components/hr/HrEmployeesView';

export const metadata = {
  title: 'کارکنان',
  robots: { index: false, follow: false },
};

export default function AdminHrEmployeesPage() {
  return <HrEmployeesView />;
}