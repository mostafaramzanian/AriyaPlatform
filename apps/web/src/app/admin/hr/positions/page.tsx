import { HrPositionsView } from '@/components/hr/HrPositionsView';

export const metadata = {
  title: 'سمت‌ها',
  robots: { index: false, follow: false },
};

export default function AdminHrPositionsPage() {
  return <HrPositionsView />;
}