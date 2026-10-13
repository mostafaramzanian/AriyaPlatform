import { HrMissionConfigurationView } from '@/components/hr/HrMissionConfigurationView';

export const metadata = {
  title: 'پیکربندی ماموریت‌ها',
  robots: { index: false, follow: false },
};

export default function AdminHrMissionConfigurationPage() {
  return <HrMissionConfigurationView />;
}
