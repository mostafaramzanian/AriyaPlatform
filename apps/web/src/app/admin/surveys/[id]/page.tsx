import { CoreSurveyDetailView } from '@/components/core/CoreSurveyDetailView';

export const metadata = {
  title: 'نظرسنجی',
  robots: { index: false, follow: false },
};

/**
 * `params` is awaited, matching the existing /admin/support/[id] page — Next 15
 * passes it as a Promise.
 */
interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminSurveyDetailPage({ params }: Props) {
  const { id } = await params;
  return <CoreSurveyDetailView surveyId={id} />;
}
