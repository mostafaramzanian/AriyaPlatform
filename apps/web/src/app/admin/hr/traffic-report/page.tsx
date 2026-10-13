import { HrTrafficReportView } from '@/components/hr/HrTrafficReportView';

export const metadata = {
  title: 'گزارش رفت‌وآمد پرسنل',
  robots: { index: false, follow: false },
};

export default function AdminHrTrafficReportPage() {
  return <HrTrafficReportView />;
}
