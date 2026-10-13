import { HrLeaveView } from '@/components/hr/HrLeaveView';

export const metadata = {
  title: 'مرخصی‌ها',
  robots: { index: false, follow: false },
};

export default function AdminHrLeavePage() {
  return <HrLeaveView />;
}
