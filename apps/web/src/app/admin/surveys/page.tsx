import { CoreSurveysView } from '@/components/core/CoreSurveysView';

export const metadata = {
  title: 'نظرسنجی‌ها',
  robots: { index: false, follow: false },
};

export default function AdminSurveysPage() {
  return <CoreSurveysView />;
}
