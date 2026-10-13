import { CorrNewLetterView } from '@/components/correspondence/CorrNewLetterView';

export const metadata = {
  title: 'ایجاد نامه جدید',
  robots: { index: false, follow: false },
};

export default function AdminCorrespondenceNewPage() {
  return <CorrNewLetterView />;
}
