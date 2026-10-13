import { CorrInboxView } from '@/components/correspondence/CorrInboxView';

export const metadata = {
  title: 'کارتابل مکاتبات',
  robots: { index: false, follow: false },
};

export default function AdminCorrespondencePage() {
  return <CorrInboxView />;
}
