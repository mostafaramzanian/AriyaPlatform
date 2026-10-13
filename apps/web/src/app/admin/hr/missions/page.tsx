import { HrMissionView } from '@/components/hr/HrMissionView';

export const metadata = {
  title: 'ماموریت‌ها',
  robots: { index: false, follow: false },
};

export default function AdminHrMissionsPage() {
  return <HrMissionView />;
}
