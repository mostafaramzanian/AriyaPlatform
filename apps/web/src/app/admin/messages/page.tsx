import { CoreMessagesView } from '@/components/core/CoreMessagesView';

export const metadata = {
  title: 'پیام‌ها',
  robots: { index: false, follow: false },
};

export default function AdminMessagesPage() {
  return <CoreMessagesView />;
}
