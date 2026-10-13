import { BlogEditForm } from '@/components/admin/BlogEditForm';

export const metadata = {
  title: 'ویرایش مطلب',
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminBlogEditPage({ params }: Props) {
  const { id } = await params;
  return <BlogEditForm id={id} />;
}
