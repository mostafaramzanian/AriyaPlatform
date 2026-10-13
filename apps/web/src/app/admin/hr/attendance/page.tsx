import { HrAttendanceView } from '@/components/hr/HrAttendanceView';

export const metadata = {
  title: 'حضور و غیاب',
  robots: { index: false, follow: false },
};

export default function AdminHrAttendancePage() {
  return <HrAttendanceView />;
}
