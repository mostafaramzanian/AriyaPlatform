import { CoreDirectoryView } from '@/components/core/CoreDirectoryView';

export const metadata = {
  title: 'دفترچه سازمانی',
  robots: { index: false, follow: false },
};

export default function AdminDirectoryPage() {
  return <CoreDirectoryView />;
}
