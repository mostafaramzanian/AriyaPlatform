import { HrMissionApprovalView } from '@/components/hr/HrMissionApprovalView';

export const metadata = {
  title: 'تأیید ماموریت‌ها',
  robots: { index: false, follow: false },
};

export default function AdminHrMissionApprovalsPage() {
  return <HrMissionApprovalView />;
}
