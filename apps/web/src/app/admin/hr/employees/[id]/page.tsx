import { HrEmployeeDetailView } from '@/components/hr/HrEmployeeDetailView';

export const metadata = {
  title: 'پرونده پرسنلی',
  robots: { index: false, follow: false },
};

/**
 * `params` is awaited, matching /admin/directory/[id], /admin/support/[id] and
 * /admin/correspondence/[id] — Next 15 passes it as a Promise.
 */
interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminHrEmployeePage({ params }: Props) {
  const { id } = await params;
  return <HrEmployeeDetailView employeeId={id} />;
}