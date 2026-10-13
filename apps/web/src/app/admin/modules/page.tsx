import { CoreModulesView } from '@/components/core/CoreModulesView';

export const metadata = {
  title: 'ماژول‌ها و سرویس‌های متصل',
  robots: { index: false, follow: false },
};

export default function AdminModulesPage() {
  return <CoreModulesView />;
}
