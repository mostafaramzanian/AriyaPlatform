import { API_ENDPOINT } from './constants';

/**
 * Phase 34: minimal client for the existing, already-tested public CMS Blog
 * API (GET /blog, GET /blog/:slug). Both are @Public() routes on the backend
 * (see apps/api/src/modules/cms/blog/blog.controller.ts) — no authentication
 * is used or required here, matching the backend contract exactly.
 */

export interface BlogListItem {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  publishedAt: string | null;
  status: string;
  readingTimeMin: number;
  featuredImageId: string | null;
  authorId: string | null;
}

export interface BlogListResult {
  items: BlogListItem[];
  hasMore: boolean;
}

export interface BlogPostDetail extends BlogListItem {
  content: string;
  seoMetadata?: {
    metaTitle?: string | null;
    metaDescription?: string | null;
  } | null;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

async function apiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_ENDPOINT}${path}`, {
      // Public marketing content: revalidate periodically rather than
      // fetching on every request or caching forever.
      next: { revalidate: 60 },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Blog API request failed with status ${res.status}`);
    }
    const body: Envelope<T> = await res.json();
    return body.data;
  } catch (err) {
    // Failure behavior: callers render a clear "unavailable" UI state
    // instead of crashing the page (see blog list/detail pages).
    console.error('[blog-api]', err);
    return null;
  }
}

export async function listPublishedPosts(): Promise<BlogListResult | null> {
  return apiFetch<BlogListResult>('/blog?limit=20');
}

export async function getPostBySlug(slug: string): Promise<BlogPostDetail | null> {
  return apiFetch<BlogPostDetail>(`/blog/${encodeURIComponent(slug)}`);
}
