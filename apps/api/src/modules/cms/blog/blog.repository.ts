import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { CmsPrismaService } from '../../../database/cms-prisma.service';
import { Prisma, BlogStatus } from '../../../generated/cms-client';

@Injectable()
export class BlogRepository {
  private readonly logger = new Logger(BlogRepository.name);
  constructor(private readonly prisma: CmsPrismaService) {}

  async list(opts: { cursor?: string; limit?: number; filter?: { status?: string; tagId?: string; categoryId?: string; authorId?: string; deleted?: boolean } }) {
    const limit = opts.limit || 20;
    // Phase 34H: `deleted: true` inverts the soft-delete filter so the admin
    // trash view can find rows that archive()/softDelete() stamped with
    // `deletedAt`. It is opt-in and only ever set by the admin listing route:
    // when it is absent (every pre-existing caller) the query is unchanged.
    //
    // This flag is what makes an archived post reachable at all. archive()
    // sets `status = ARCHIVED` *and* `deletedAt = now()`, so the ordinary
    // `status=ARCHIVED` admin list is structurally always empty.
    const deletedOnly = opts.filter?.deleted === true;
    const where: Prisma.BlogPostWhereInput = deletedOnly
      ? { deletedAt: { not: null } }
      : { deletedAt: null };
    // Phase 34: the only caller that never passes an explicit status filter
    // is the @Public() GET /blog controller action — i.e. anonymous, public
    // callers. Previously this defaulted to merely excluding ARCHIVED posts,
    // which meant DRAFT/REVIEW/SCHEDULED content was publicly listable.
    // Every other caller (getLatestPosts/getArchivedPosts,
    // and any future admin listing) already passes its own explicit status
    // filter, so defaulting the no-filter case to PUBLISHED-only is safe and
    // does not change any existing internal caller's behavior.
    //
    // The trash view is the one legitimate "no status filter" caller that must
    // not be narrowed to PUBLISHED: softDelete() leaves `status` untouched, so
    // a deleted post can sit in any status and all of them must be listed.
    if (!opts.filter?.status) {
      if (!deletedOnly) where.status = 'PUBLISHED';
    } else {
      where.status = opts.filter.status as BlogStatus | undefined;
    }
    if (opts.filter?.authorId) {
      where.authorId = opts.filter.authorId;
    }

    // filter by tag/category using relational filters if provided
    if (opts.filter?.tagId) {
      (where as any).tags = { some: { tagId: opts.filter.tagId } };
    }
    if (opts.filter?.categoryId) {
      (where as any).categories = { some: { categoryId: opts.filter.categoryId } };
    }

    const posts = await this.prisma.blogPost.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(limit, 100) + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        slug: true,
        excerpt: true,
        publishedAt: true,
        status: true,
        readingTimeMin: true,
        featuredImageId: true,
        authorId: true,
      },
    });
    const hasMore = posts.length > Math.min(limit, 100);
    if (hasMore) posts.pop();
    return { items: posts, hasMore };
  }

  async findBySlug(slug: string) {
    // Phase 34: this is the sole implementation behind the @Public()
    // GET /blog/:slug controller action — must only ever return published
    // content to anonymous callers (see list() above for the same fix).
    return this.prisma.blogPost.findFirst({
      where: { slug, deletedAt: null, status: 'PUBLISHED' },
      include: { seoMetadata: true, featuredImage: true },
    });
  }

  async findById(id: string) {
    return this.prisma.blogPost.findUnique({
      where: { id },
      include: {
        seoMetadata: true,
        featuredImage: true,
        categories: { select: { categoryId: true } },
        tags: { select: { tagId: true } },
      },
    });
  }

  async listCategories() {
    return this.prisma.category.findMany({ where: { deletedAt: null }, orderBy: { displayOrder: 'asc' } });
  }

  async findCategoryBySlug(slug: string) {
    return this.prisma.category.findFirst({ where: { slug, deletedAt: null } });
  }

  async listTags() {
    return this.prisma.tag.findMany({ where: { deletedAt: null }, orderBy: { usage: 'desc' } });
  }

  async findTagBySlug(slug: string) {
    return this.prisma.tag.findFirst({ where: { slug, deletedAt: null } });
  }

  async search(query: string, opts: { cursor?: string; limit?: number }) {
    const limit = opts.limit || 20;
    // Use basic full text search via postgres plainto_tsquery and ranking
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT b.id, b.title, b.slug, b.excerpt, b.publishedAt, b.readingTimeMin, b.featuredImageId
      FROM "BlogPost" b
      WHERE b."deletedAt" IS NULL AND b.status = 'PUBLISHED' AND (
        to_tsvector('english', coalesce(b.title,'') || ' ' || coalesce(b.content,'')) @@ plainto_tsquery('english', ${query})
      )
      ORDER BY ts_rank(to_tsvector('english', coalesce(b.title,'') || ' ' || coalesce(b.content,'')), plainto_tsquery('english', ${query})) DESC, b."publishedAt" DESC
      LIMIT ${Math.min(limit,100)};
    `;
    return { items: rows, hasMore: false };
  }

  async findRelated(id: string, limit = 5) {
    // Find tags and categories for the post, then find other posts sharing them
    const tagRows = await this.prisma.blogPostTag.findMany({ where: { blogPostId: id }, select: { tagId: true } });
    const catRows = await this.prisma.blogPostCategory.findMany({ where: { blogPostId: id }, select: { categoryId: true } });
    const tagIds = tagRows.map((r) => r.tagId);
    const categoryIds = catRows.map((r) => r.categoryId);

    const related = await this.prisma.blogPost.findMany({
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        id: { not: id },
        OR: [
          ...(tagIds.length ? [{ tags: { some: { tagId: { in: tagIds } } } }] : []),
          ...(categoryIds.length ? [{ categories: { some: { categoryId: { in: categoryIds } } } }] : []),
        ],
      },
      orderBy: [{ publishedAt: 'desc' }],
      take: limit,
      select: { id: true, title: true, slug: true, excerpt: true, publishedAt: true, featuredImageId: true },
    });
    return related;
  }

  async createWithUniqueSlug(data: Prisma.BlogPostCreateInput, baseSlug: string, maxAttempts = 50) {
    // Acquire a lightweight advisory lock per baseSlug to avoid race conditions across processes.
    const hash = this.hashToInt32(baseSlug);
    // Attempt to acquire PostgreSQL advisory lock for the duration of this transaction if supported by the client
    try {
      if (typeof (this.prisma as any).$executeRaw === 'function') {
        await (this.prisma as any).$executeRaw`SELECT pg_advisory_xact_lock(${hash})`;
      }
    } catch {
      this.logger.debug('Advisory lock unavailable or failed, proceeding without it');
    }

    let attempt = 0;
    let candidate = baseSlug;
    while (attempt < maxAttempts) {
      try {
        const payload: Prisma.BlogPostCreateInput = { ...data, slug: candidate };
        const created = await this.prisma.blogPost.create({ data: payload });
        return created;
      } catch (error: unknown) {
        const prismaError = error as { code?: string; meta?: { target?: string[] } };
        if (prismaError?.code === 'P2002' && Array.isArray(prismaError.meta?.target) && prismaError.meta?.target.includes('slug')) {
          attempt += 1;
          candidate = `${baseSlug}-${attempt}`;
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException('Unable to generate unique slug after retries');
  }

  private hashToInt32(value: string): number {
    // fnv-1a 32-bit
    let h = 2166136261 >>> 0;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // convert to signed 32-bit int range
    return (h & 0xffffffff) | 0;
  }

  async create(data: Prisma.BlogPostCreateInput) {
    return this.prisma.blogPost.create({ data });
  }

  async createWithRelations(data: Prisma.BlogPostCreateInput, categoryIds: string[] = [], tagIds: string[] = []) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.blogPost.create({ data });
      await this.attachRelationsInternal(tx, created.id, categoryIds, tagIds);
      return created;
    });
  }

  async attachRelations(blogPostId: string, categoryIds: string[] = [], tagIds: string[] = []) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.attachRelationsInternal(tx, blogPostId, categoryIds, tagIds);
    });
  }

  async update(id: string, data: Prisma.BlogPostUpdateInput, editorId?: string) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const payload: Prisma.BlogPostUpdateInput = {
        ...data,
        updatedAt: new Date(),
      };
      if (editorId) (payload as Prisma.BlogPostUpdateInput & { editorId?: string }).editorId = editorId;
      const updated = await tx.blogPost.update({ where: { id }, data: payload });
      return updated;
    });
  }

  async softDelete(id: string) {
    return this.prisma.blogPost.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async restore(id: string) {
    return this.prisma.blogPost.update({ where: { id }, data: { deletedAt: null } });
  }

  async publish(id: string, dto: { metaTitle?: string | null; metaDescription?: string | null; publishedAt?: Date }) {
    const publishedAt = dto.publishedAt || new Date();
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.blogPost.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt, lastPublishedAt: publishedAt } });
      await tx.seoMetadata.upsert({
        where: { blogPostId: id },
        create: { blogPostId: id, metaTitle: dto.metaTitle, metaDescription: dto.metaDescription },
        update: { metaTitle: dto.metaTitle, metaDescription: dto.metaDescription },
      });
      return updated;
    });
  }

  async unpublish(id: string) {
    return this.prisma.blogPost.update({ where: { id }, data: { status: 'DRAFT', publishedAt: null } });
  }

  async schedule(id: string, scheduledAt: Date) {
    return this.prisma.blogPost.update({ where: { id }, data: { scheduledAt, status: 'SCHEDULED' } });
  }

  async archive(id: string) {
    return this.prisma.blogPost.update({ where: { id }, data: { status: 'ARCHIVED', deletedAt: new Date() } });
  }

  private async attachRelationsInternal(tx: Prisma.TransactionClient, blogPostId: string, categoryIds: string[] = [], tagIds: string[] = []) {
    if (categoryIds.length) {
      const bpcs = categoryIds.map((categoryId) => ({ blogPostId, categoryId }));
      await tx.blogPostCategory.createMany({ data: bpcs, skipDuplicates: true });
    }
    if (tagIds.length) {
      const bpts = tagIds.map((tagId) => ({ blogPostId, tagId }));
      await tx.blogPostTag.createMany({ data: bpts, skipDuplicates: true });
      await tx.$executeRawUnsafe(`UPDATE "Tag" SET "usage" = "usage" + 1 WHERE id = ANY($1::uuid[])`, tagIds);
    }
  }
}
