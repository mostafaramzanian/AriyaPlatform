import { CoreTicketDetailView } from '@/components/core/CoreTicketDetailView';

export const metadata = {
  title: 'جزئیات تیکت',
  robots: { index: false, follow: false },
};

/**
 * `params` is awaited, matching the existing /admin/directory/[id] page — Next 15
 * passes it as a Promise.
 */
interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminSupportTicketPage({ params }: Props) {
  const { id } = await params;
  return <CoreTicketDetailView ticketId={id} />;
}
