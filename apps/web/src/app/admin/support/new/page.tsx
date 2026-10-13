import { CoreTicketCreateView } from '@/components/core/CoreTicketCreateView';

export const metadata = {
  title: 'ثبت تیکت جدید',
  robots: { index: false, follow: false },
};

export default function AdminSupportNewPage() {
  return <CoreTicketCreateView />;
}
