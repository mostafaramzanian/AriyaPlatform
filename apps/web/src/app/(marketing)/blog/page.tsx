import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection } from '@/components/sections/PageSections';
import { listPublishedPosts } from '@/lib/blog-api';

export const metadata: Metadata = {
  title: 'وبلاگ',
  description: 'آخرین مقالات، به‌روزرسانی‌ها و دیدگاه‌های تیم آریا.',
};

function formatDate(iso: string | null) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
  } catch {
    return '';
  }
}

export default async function BlogListPage() {
  const result = await listPublishedPosts();

  return (
    <PublicLayout>
      <HeroSection
        title="وبلاگ آریا"
        description="آخرین مقالات، به‌روزرسانی‌های محصول و دیدگاه‌های تیم آریا."
      />

      <section className="section-shell">
        <div className="container-shell">
          {result === null && (
            <div className="card-panel p-8 text-center">
              <p className="text-muted-foreground">
                در حال حاضر امکان بارگذاری مقالات وجود ندارد. لطفاً بعداً دوباره تلاش کنید.
              </p>
            </div>
          )}

          {result !== null && result.items.length === 0 && (
            <div className="card-panel p-8 text-center">
              <p className="text-muted-foreground">هنوز مقاله‌ای منتشر نشده است.</p>
            </div>
          )}

          {result !== null && result.items.length > 0 && (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {result.items.map((post) => (
                <Link
                  key={post.id}
                  href={`/blog/${post.slug}`}
                  className="card-panel p-6 group transition hover:shadow-soft hover:-translate-y-1 flex flex-col"
                >
                  <h2 className="text-lg font-semibold text-foreground group-hover:text-accent">
                    {post.title}
                  </h2>
                  {post.excerpt && (
                    <p className="mt-3 text-sm text-muted-foreground flex-1">{post.excerpt}</p>
                  )}
                  <div className="mt-6 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{formatDate(post.publishedAt)}</span>
                    <span>{post.readingTimeMin} دقیقه مطالعه</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </PublicLayout>
  );
}
