import { BlogCreateForm } from '@/components/admin/BlogCreateForm';

export const metadata = {
  title: 'مطلب جدید',
  robots: { index: false, follow: false },
};

export default function AdminBlogNewPage() {
  return <BlogCreateForm />;
}
