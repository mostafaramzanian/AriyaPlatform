import { CorrLetterView } from '@/components/correspondence/CorrLetterView';

export const metadata = {
  title: 'مشاهده نامه',
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminCorrespondenceLetterPage({ params }: Props) {
  const { id } = await params;
  return <CorrLetterView letterId={id} />;
}
