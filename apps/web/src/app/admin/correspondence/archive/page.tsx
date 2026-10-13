import { CorrArchiveView } from '@/components/correspondence/CorrArchiveView';

export const metadata = {
  title: 'بایگانی مکاتبات',
  robots: { index: false, follow: false },
};

export default function AdminCorrespondenceArchivePage() {
  return <CorrArchiveView />;
}
