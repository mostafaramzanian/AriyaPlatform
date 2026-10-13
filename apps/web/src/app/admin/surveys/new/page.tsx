import { CoreSurveyEditorView } from '@/components/core/CoreSurveyEditorView';

export const metadata = {
  title: 'نظرسنجی جدید',
  robots: { index: false, follow: false },
};

export default function AdminSurveyNewPage() {
  return <CoreSurveyEditorView />;
}
