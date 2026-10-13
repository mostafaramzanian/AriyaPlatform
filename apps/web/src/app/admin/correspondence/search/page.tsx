import { CorrSearchView } from '@/components/correspondence/CorrSearchView';

export const metadata = {
  title: 'جستجوی مکاتبات',
  robots: { index: false, follow: false },
};

export default function AdminCorrespondenceSearchPage() {
  return <CorrSearchView />;
}
