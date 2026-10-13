import { CorrDraftsView } from '@/components/correspondence/CorrDraftsView';

export const metadata = {
  title: 'پیش‌نویس‌ها',
  robots: { index: false, follow: false },
};

export default function AdminCorrespondenceDraftsPage() {
  return <CorrDraftsView />;
}
