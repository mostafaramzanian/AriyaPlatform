import { CoreSurveyEditorView } from '@/components/core/CoreSurveyEditorView';

export const metadata = {
  title: 'ویرایش نظرسنجی',
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Editing is DRAFT-only and manager-only, both enforced server-side. This page always
 * renders the editor; the editor itself loads the survey and reports the server's
 * refusal (403 or 409) rather than pre-judging it client-side.
 */
export default async function AdminSurveyEditPage({ params }: Props) {
  const { id } = await params;
  return <CoreSurveyEditorView surveyId={id} />;
}
