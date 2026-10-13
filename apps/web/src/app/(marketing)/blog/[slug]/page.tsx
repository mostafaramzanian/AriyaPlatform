import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { getPostBySlug } from '@/lib/blog-api';
import { SimpleMarkdown } from '@/lib/simple-markdown';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return { title: 'مقاله یافت نشد' };
  return {
    title: post.seoMetadata?.metaTitle || post.title,
    description: post.seoMetadata?.metaDescription || post.excerpt || undefined,
  };
}

function formatDate(iso: string | null) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
  } catch {
    return '';
  }
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);

  if (!post) {
    notFound();
  }

  return (
    <PublicLayout>
      <article className="section-shell">
        <div className="container-shell">
          <div className="mx-auto max-w-3xl">
            <Link href="/blog" className="text-sm text-accent hover:underline">
              ← بازگشت به وبلاگ
            </Link>

            <h1 className="mt-6 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {post.title}
            </h1>

            <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
              <span>{formatDate(post.publishedAt)}</span>
              <span>·</span>
              <span>{post.readingTimeMin} دقیقه مطالعه</span>
            </div>

            <div className="mt-10 card-panel p-8">
              <SimpleMarkdown content={post.content} />
            </div>
          </div>
        </div>
      </article>
    </PublicLayout>
  );
}
