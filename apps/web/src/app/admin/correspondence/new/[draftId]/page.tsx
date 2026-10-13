import { CorrNewLetterView } from '@/components/correspondence/CorrNewLetterView';

export const metadata = {
  title: 'ویرایش پیش‌نویس',
  robots: { index: false, follow: false },
};

interface Props {
  /** Awaited, matching the existing dynamic admin pages — Next 15 Promise. */
  params: Promise<{ draftId: string }>;
}

export default async function AdminCorrespondenceEditDraftPage({ params }: Props) {
  const { draftId } = await params;
  return <CorrNewLetterView draftId={draftId} />;
}
