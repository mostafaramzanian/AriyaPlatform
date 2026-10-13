import { CoreNotificationsView } from '@/components/core/CoreNotificationsView';

export const metadata = {
  title: 'مرکز اعلان‌ها',
  robots: { index: false, follow: false },
};

export default function AdminNotificationsPage() {
  return <CoreNotificationsView />;
}
