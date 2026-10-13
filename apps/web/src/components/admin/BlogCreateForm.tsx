'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { CmsApiError, createPost, omitEmpty } from '@/lib/cms-api';
import { FeaturedImagePicker } from './FeaturedImagePicker';

/**
 * Fields map 1:1 onto CreateBlogDto. Only what the DTO accepts is sent:
 * required title (5..200) + content (min 20), plus optional slug, excerpt and
 * SEO metaTitle/metaDescription/canonicalUrl. Categories/tags/featuredImageId
 * expect existing UUIDs and have no picker in this slice, so they are omitted.
 * Status is not sent — the backend always creates DRAFT.
 */
export function BlogCreateForm() {
  const router = useRouter();
  const [values, setValues] = React.useState({
    title: '',
    slug: '',
    content: '',
    excerpt: '',
    metaTitle: '',
    metaDescription: '',
    canonicalUrl: '',
  });
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<CmsApiError | null>(null);
  const [featuredImageId, setFeaturedImageId] = React.useState<string | null>(null);

  function handleChange(
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) {
    const { name, value } = event.target;
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const created = await createPost(
        omitEmpty({
          title: values.title,
          content: values.content,
          slug: values.slug || undefined,
          excerpt: values.excerpt || undefined,
          metaTitle: values.metaTitle || undefined,
          metaDescription: values.metaDescription || undefined,
          canonicalUrl: values.canonicalUrl || undefined,
          featuredImageId: featuredImageId ?? undefined,
        }) as { title: string; content: string; featuredImageId?: string | null },
      );
      // Editing continues on the newly created draft, mirroring the flow the
      // list page links to.
      router.push(`/admin/blog/${created.id}/edit`);
    } catch (err) {
      setError(
        err instanceof CmsApiError
          ? err
          : new CmsApiError(0, 'UNKNOWN', 'ایجاد مطلب ناموفق بود.'),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/blog" className="text-sm text-primary hover:underline">
          ← بازگشت به فهرست
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">مطلب جدید</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مطلب جدید به‌صورت پیش‌نویس ذخیره می‌شود.
        </p>
      </div>

      {error && <Alert type={error.status === 403 ? 'warning' : 'error'} message={error.message} />}

      {error?.details && error.details.length > 0 && (
        <ul className="card-panel space-y-1 p-4 text-sm text-destructive">
          {error.details.map((detail, index) => (
            <li key={`${detail.property ?? 'field'}-${index}`}>
              {detail.property}: {Object.values(detail.constraints ?? {}).join('، ')}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="card-panel space-y-5 p-6 md:p-8">
        <Input
          label="عنوان"
          name="title"
          id="title"
          value={values.title}
          onChange={handleChange}
          required
          minLength={5}
          maxLength={200}
          disabled={isSubmitting}
        />

        <Input
          label="نامک (اختیاری)"
          name="slug"
          id="slug"
          value={values.slug}
          onChange={handleChange}
          maxLength={120}
          placeholder="my-post-slug"
          disabled={isSubmitting}
        />

        <Textarea
          label="محتوا (Markdown)"
          name="content"
          id="content"
          value={values.content}
          onChange={handleChange}
          required
          minLength={20}
          rows={14}
          disabled={isSubmitting}
        />

        <Textarea
          label="خلاصه (اختیاری)"
          name="excerpt"
          id="excerpt"
          value={values.excerpt}
          onChange={handleChange}
          maxLength={500}
          rows={3}
          disabled={isSubmitting}
        />

        <Input
          label="عنوان سئو (اختیاری)"
          name="metaTitle"
          id="metaTitle"
          value={values.metaTitle}
          onChange={handleChange}
          maxLength={60}
          disabled={isSubmitting}
        />

        <Textarea
          label="توضیح سئو (اختیاری)"
          name="metaDescription"
          id="metaDescription"
          value={values.metaDescription}
          onChange={handleChange}
          maxLength={160}
          rows={2}
          disabled={isSubmitting}
        />

        <Input
          label="نشانی کانونیکال (اختیاری)"
          name="canonicalUrl"
          id="canonicalUrl"
          type="url"
          value={values.canonicalUrl}
          onChange={handleChange}
          placeholder="https://example.com/blog/my-post"
          disabled={isSubmitting}
        />

        <FeaturedImagePicker value={featuredImageId} onChange={setFeaturedImageId} />

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'در حال ذخیره...' : 'ذخیره پیش‌نویس'}
          </Button>
          <Link href="/admin/blog" className="btn-secondary">
            انصراف
          </Link>
        </div>
      </form>
    </div>
  );
}
