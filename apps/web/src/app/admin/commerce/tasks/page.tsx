import { CommerceTasksView } from '@/components/commerce/CommerceTasksView';

export const metadata = {
  title: 'نیازمند اقدام من',
  robots: { index: false, follow: false },
};

export default function AdminCommerceTasksPage() {
  return <CommerceTasksView />;
}
