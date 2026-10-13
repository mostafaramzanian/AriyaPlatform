import { CoreAIProvidersView } from '@/components/core/CoreAIProvidersView';

export const metadata = {
  title: 'ارائه‌دهندگان هوش مصنوعی',
  robots: { index: false, follow: false },
};

export default function AdminAIProvidersPage() {
  return <CoreAIProvidersView />;
}
