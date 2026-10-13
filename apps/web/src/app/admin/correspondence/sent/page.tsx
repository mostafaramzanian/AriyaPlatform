import { CorrSentView } from '@/components/correspondence/CorrSentView';

export const metadata = {
  title: 'نامه‌های ارسالی',
  robots: { index: false, follow: false },
};

export default function AdminCorrespondenceSentPage() {
  return <CorrSentView />;
}
