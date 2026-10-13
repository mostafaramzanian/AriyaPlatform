import { CoreDirectoryMemberView } from '@/components/core/CoreDirectoryMemberView';

export const metadata = {
  title: 'پروفایل همکار',
  robots: { index: false, follow: false },
};

/**
 * `params` is awaited, matching the existing /admin/blog/[id]/edit page — Next
 * 15 passes it as a Promise.
 */
interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminDirectoryMemberPage({ params }: Props) {
  const { id } = await params;
  return <CoreDirectoryMemberView memberId={id} />;
}
