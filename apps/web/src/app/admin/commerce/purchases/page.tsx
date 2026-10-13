import { CommercePurchaseListView } from '@/components/commerce/CommercePurchaseListView';

export const metadata = {
  title: 'درخواست‌های خرید',
  robots: { index: false, follow: false },
};

export default function AdminCommercePurchasesPage() {
  return <CommercePurchaseListView />;
}
