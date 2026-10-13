import { CommerceHomeView } from '@/components/commerce/CommerceHomeView';

export const metadata = {
  title: 'خانهٔ تدارکات',
  robots: { index: false, follow: false },
};

export default function AdminCommercePage() {
  return <CommerceHomeView />;
}
