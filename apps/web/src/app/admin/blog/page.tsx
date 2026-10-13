import { BlogListView } from '@/components/admin/BlogListView';

export const metadata = {
  title: 'مدیریت وبلاگ',
  robots: { index: false, follow: false },
};

export default function AdminBlogPage() {
  return <BlogListView />;
}
