import { Injectable, Optional, BadRequestException, NotFoundException, ConflictException, InternalServerErrorException, Logger } from '@nestjs/common';
import { BlogRepository } from './blog.repository';
import { CreateBlogDto } from './dto/create-blog.dto';
import { UpdateBlogDto } from './dto/update-blog.dto';
import { PublishBlogDto } from './dto/publish-blog.dto';
import { NotificationPublisher } from '../../../notifications/notification.publisher';
import { CacheService } from '../../../common/cache.service';
import { RequestContextService } from '../../../common/request-context.service';
import { Prisma } from '../../../generated/cms-client';
import { sanitizeMarkdown, sanitizeText, normalizeSlug } from '../common/sanitize.util';
import { calculateReadingTime } from '../common/reading-time.util';
import { AuditService } from '../../../common/audit.service';

@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(
    private readonly repo: BlogRepository,
    private readonly publisher: NotificationPublisher,
    private readonly cacheService: CacheService,
    private readonly requestContextService: RequestContextService,
    // Phase 33K: Audit is a best-effort, optional Core capability (matches the
    // pre-existing `auditService?.log(...)` call-site pattern below, which was
    // already written to tolerate its absence). @Optional() completes that
    // intent at the Nest DI level: when BlogModule is composed for a CMS-only
    // process (no Core PrismaService available), Audit is simply skipped
    // instead of the module graph failing to resolve.
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private getAuditContext() {
    const ctx = RequestContextService.get();
    return {
      requestId: ctx?.requestId || 'unknown',
      correlationId: ctx?.correlationId,
      userId: ctx?.userId,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
    };
  }

  async list(opts: { cursor?: string; limit?: number; filter?: { status?: string; tagId?: string; categoryId?: string; deleted?: boolean } } = {}) {
    const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
    const result = await this.repo.list({ cursor: opts.cursor, limit, filter: opts.filter });
    // sanitize output fields
    result.items = result.items.map((it) => ({
      ...it,
      title: sanitizeText(it.title),
      excerpt: it.excerpt ? sanitizeText(it.excerpt) : it.excerpt,
    }));
    return result;
  }

  async findBySlug(slug: string) {
    const cacheKey = `blog:slug:${slug}`;
    const result = await this.cacheService.wrap(cacheKey, 60 * 5, ['blog:slug'], async () => {
      const post = await this.repo.findBySlug(slug);
      if (!post) return null as any;
      // sanitize content before returning public response
      post.title = sanitizeText(post.title);
      if (post.excerpt) post.excerpt = sanitizeText(post.excerpt);
      if (post.content) post.content = sanitizeMarkdown(post.content);
      return post;
    });
    if (!result) throw new NotFoundException('Post not found');
    return result;
  }

  async getAdminPost(id: string) {
    const post = await this.repo.findById(id);
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');
    return post;
  }

  async listCategories() {
    return this.repo.listCategories();
  }

  async getCategoryBySlug(slug: string) {
    const cat = await this.repo.findCategoryBySlug(slug);
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  async listTags() {
    return this.repo.listTags();
  }

  async getTagBySlug(slug: string) {
    const tag = await this.repo.findTagBySlug(slug);
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async search(query: string, opts: { cursor?: string; limit?: number }) {
    if (!query || query.trim().length === 0) throw new BadRequestException('q is required');
    const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
    return this.repo.search(query, { cursor: opts.cursor, limit });
  }

  async related(slug: string, limit = 5) {
    const post = await this.repo.findBySlug(slug);
    if (!post) throw new NotFoundException('Post not found');
    const related = await this.repo.findRelated(post.id, limit);
    return related;
  }

  /**
   * Get latest published posts with cache tagging
   */
  async getLatestPosts(limit = 10) {
    const cacheKey = `blog:latest:${limit}`;
    try {
      return await this.cacheService.wrap(cacheKey, 60 * 10, ['blog:latest', 'blog:list'], async () => {
        return this.repo.list({
          limit: Math.min(Math.max(limit, 1), 100),
          filter: { status: 'PUBLISHED' },
        });
      });
    } catch (error) {
      // Temporary debug logging to capture root cause of 500 during load testing
      this.logger.error({ err: error && (error as any).stack ? (error as any).stack : error }, 'getLatestPosts failed');
      throw error;
    }
  }

  /**
   * Get archived posts with cache tagging
   */
  async getArchivedPosts(opts: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
    const cacheKey = `blog:archive:${limit}:${opts.cursor || 'root'}`;
    return this.cacheService.wrap(cacheKey, 60 * 5, ['blog:archive', 'blog:list'], async () => {
      return this.repo.list({
        cursor: opts.cursor,
        limit,
        filter: { status: 'ARCHIVED' },
      });
    });
  }

  async createPost(dto: CreateBlogDto, userId?: string) {
    try {
      const title = sanitizeText(dto.title);
      const content = sanitizeMarkdown(dto.content);
      const excerpt = dto.excerpt ? sanitizeText(dto.excerpt) : this.autoExcerpt(content);
      const normalizedSlug = normalizeSlug(dto.slug || title);
      const readingTime = calculateReadingTime(content);
      const data = {
        title,
        content,
        excerpt,
        readingTimeMin: readingTime,
        status: 'DRAFT',
        slug: normalizedSlug,
      } as Prisma.BlogPostCreateInput;

      if (userId) {
        // DC-CMS-01: authorId is a plain identifier (no physical FK/relation to Core.User)
        data.authorId = userId;
      }
      if (dto.featuredImageId) {
        (data as Prisma.BlogPostCreateInput & { featuredImage?: { connect: { id: string } } }).featuredImage = { connect: { id: dto.featuredImageId } };
      }

      // Create SeoMetadata if provided
      if (dto.metaTitle || dto.metaDescription || dto.canonicalUrl) {
        const seoData = {
          metaTitle: dto.metaTitle || undefined,
          metaDescription: dto.metaDescription || undefined,
          canonicalUrl: dto.canonicalUrl || undefined,
        };
        this.logger.debug({ seoData }, 'Creating SeoMetadata');
        (data as Prisma.BlogPostCreateInput & { seoMetadata?: { create: any } }).seoMetadata = {
          create: seoData,
        };
      }

      this.logger.debug({ data }, `Creating blog post with slug: ${normalizedSlug}`);
      const created = await this.repo.createWithUniqueSlug(data, normalizedSlug, 50);
      this.logger.debug({ created }, `Blog post created with id: ${created.id}`);

      await this.repo.attachRelations(created.id, dto.categories || [], dto.tags || []);
      this.logger.debug(`Relations attached to blog post ${created.id}`);

      // persist audit record (synchronous DB write - lightweight)
      try {
        const ctx = this.getAuditContext();
        await this.auditService?.log({
          ...ctx,
          action: 'created',
          resource: 'blog',
          resourceId: created.id,
          oldValue: null,
          newValue: created,
          changedFields: Object.keys(created),
          success: true,
        });
      } catch (e) {
        this.logger.warn({ err: e }, 'Audit log failed for create');
      }

      // Publish notification (non-critical, don't fail if publisher unavailable)
      try {
        await this.publisher.publish('blog.created', { id: created.id, slug: created.slug, authorId: userId });
        this.logger.debug(`Published blog.created event for ${created.id}`);
      } catch (e) {
        this.logger.warn({ err: e }, 'Failed to publish blog.created event');
      }

      // Invalidate caches (non-critical)
      try {
        await this.invalidateCaches(created.slug);
        this.logger.debug(`Caches invalidated for slug: ${created.slug}`);
      } catch (e) {
        this.logger.warn({ err: e }, 'Failed to invalidate caches after blog create');
      }

      return created;
    } catch (error: unknown) {
      this.logger.error({ err: error, dto, userId }, 'Blog create failed');
      throw error;
    }
  }

  async updatePost(id: string, dto: UpdateBlogDto, userId?: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Post not found');
    if (existing.deletedAt) throw new BadRequestException('Cannot update deleted post');
    await this.assertOptimisticLock(existing, dto.expectedUpdatedAt);

    if (dto.status && !this.isValidTransition(existing.status, dto.status)) {
      throw new BadRequestException(`Invalid status transition from ${existing.status} to ${dto.status}`);
    }

    const updateData: Prisma.BlogPostUpdateInput = {};
    if (dto.title !== undefined) updateData.title = sanitizeText(dto.title);
    if (dto.content !== undefined) {
      const sanitizedContent = sanitizeMarkdown(dto.content);
      updateData.content = sanitizedContent;
      updateData.readingTimeMin = calculateReadingTime(sanitizedContent);
    }
    if (dto.excerpt !== undefined) updateData.excerpt = sanitizeText(dto.excerpt);
    if (dto.slug !== undefined) updateData.slug = normalizeSlug(dto.slug);
    if (dto.featuredImageId !== undefined) {
      updateData.featuredImage = dto.featuredImageId ? { connect: { id: dto.featuredImageId } } : { disconnect: true };
    }
    if (dto.status !== undefined) updateData.status = dto.status as Prisma.BlogPostUpdateInput['status'];

    try {
      const updated = await this.repo.update(id, updateData, userId);
      if (!updated) {
        await this.invalidateCaches(existing.slug);
        return existing;
      }

      // audit
      try {
        const ctx = this.getAuditContext();
        await this.auditService?.log({
          ...ctx,
          action: 'updated',
          resource: 'blog',
          resourceId: updated.id,
          oldValue: existing,
          newValue: updated,
          changedFields: Object.keys(updateData as object),
          success: true,
        });
      } catch (e) {
        this.logger.warn({ err: e }, 'Audit log failed for update');
      }

      // Publish notification (non-critical)
      try {
        await this.publisher.publish('blog.updated', { id: updated.id ?? id });
      } catch (e) {
        this.logger.warn({ err: e }, 'Failed to publish blog.updated event');
      }

      // Invalidate caches (non-critical)
      try {
        await this.invalidateCaches(updated.slug);
      } catch (e) {
        this.logger.warn({ err: e }, 'Failed to invalidate caches after blog update');
      }

      return updated;
    } catch (error: unknown) {
      if (this.isPrismaConflict(error)) throw new ConflictException('Slug already exists');
      this.logger.error({ err: error }, 'Blog update failed');
      throw new InternalServerErrorException('Failed updating post');
    }
  }

  async deletePost(id: string, userId?: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Post not found');
    if (existing.deletedAt) throw new BadRequestException('Post already deleted');
    const deleted = await this.repo.softDelete(id);
    try {
      const ctx = this.getAuditContext();
      await this.auditService?.log({
        ...ctx,
        action: 'deleted',
        resource: 'blog',
        resourceId: deleted.id,
        oldValue: existing,
        newValue: deleted,
        changedFields: ['deletedAt'],
        success: true,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Audit log failed for delete');
    }
    try {
      await this.publisher.publish('blog.deleted', { id, userId });
    } catch (e) {
      this.logger.warn({ err: e }, 'Failed to publish blog.deleted event');
    }
    try {
      await this.invalidateCaches(existing.slug);
    } catch (e) {
      this.logger.warn({ err: e }, 'Failed to invalidate caches after blog delete');
    }
    return deleted;
  }

  async restorePost(id: string, userId?: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Post not found');
    if (!existing.deletedAt) throw new BadRequestException('Post is not deleted');
    const restored = await this.repo.restore(id);
    try {
      const ctx = this.getAuditContext();
      await this.auditService?.log({
        ...ctx,
        action: 'restored',
        resource: 'blog',
        resourceId: restored.id,
        oldValue: existing,
        newValue: restored,
        changedFields: ['deletedAt'],
        success: true,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Audit log failed for restore');
    }
    try {
      await this.publisher.publish('blog.restored', { id, userId });
    } catch (e) {
      this.logger.warn({ err: e }, 'Failed to publish blog.restored event');
    }
    try {
      await this.invalidateCaches(existing.slug);
    } catch (e) {
      this.logger.warn({ err: e }, 'Failed to invalidate caches after blog restore');
    }
    return restored;
  }

  async publishPost(id: string, dto: PublishBlogDto, userId?: string) {
    const post = await this.repo.findById(id);
    if (!post) throw new NotFoundException('Post not found');
    if (post.deletedAt) throw new BadRequestException('Cannot publish deleted post');
    await this.assertOptimisticLock(post, dto.expectedUpdatedAt);
    if (!post.title || !post.content) throw new BadRequestException('Title and content are required before publishing');
    if (!post.seoMetadata?.metaTitle && !dto.metaTitle) throw new BadRequestException('SEO title is required before publishing');
    if (!this.isValidTransition(post.status, 'PUBLISHED')) {
      throw new BadRequestException(`Cannot publish from status ${post.status}`);
    }
    const publishedAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    const published = await this.repo.publish(id, { metaTitle: dto.metaTitle ?? post.seoMetadata?.metaTitle, metaDescription: dto.metaDescription ?? post.seoMetadata?.metaDescription, publishedAt });
    try {
      const ctx = this.getAuditContext();
      await this.auditService?.log({
        ...ctx,
        action: 'published',
        resource: 'blog',
        resourceId: published.id,
        oldValue: post,
        newValue: published,
        changedFields: ['status', 'publishedAt'],
        success: true,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Audit log failed for publish');
    }
    await this.publisher.publish('blog.published', { id, publishedAt, userId });
    await this.invalidateCaches(post.slug);
    return published;
  }

  async unpublishPost(id: string, userId?: string) {
    const post = await this.repo.findById(id);
    if (!post) throw new NotFoundException('Post not found');
    if (post.deletedAt) throw new BadRequestException('Cannot unpublish deleted post');
    if (post.status !== 'PUBLISHED') throw new BadRequestException('Only published posts can be unpublished');
    const unpub = await this.repo.unpublish(id);
    try {
      const ctx = this.getAuditContext();
      await this.auditService?.log({
        ...ctx,
        action: 'unpublished',
        resource: 'blog',
        resourceId: unpub.id,
        oldValue: post,
        newValue: unpub,
        changedFields: ['status', 'publishedAt'],
        success: true,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Audit log failed for unpublish');
    }
    await this.publisher.publish('blog.unpublished', { id, userId });
    await this.invalidateCaches(post.slug);
    return unpub;
  }

  async schedulePost(id: string, scheduledAt: string, userId?: string) {
    const post = await this.repo.findById(id);
    if (!post) throw new NotFoundException('Post not found');
    if (post.deletedAt) throw new BadRequestException('Cannot schedule deleted post');
    if (!this.isValidTransition(post.status, 'SCHEDULED')) throw new BadRequestException(`Cannot schedule from ${post.status}`);
    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      throw new BadRequestException('scheduledAt must be a valid future date');
    }
    const scheduled = await this.repo.schedule(id, scheduledDate);
    try {
      const ctx = this.getAuditContext();
      await this.auditService?.log({
        ...ctx,
        action: 'scheduled',
        resource: 'blog',
        resourceId: scheduled.id,
        oldValue: post,
        newValue: scheduled,
        changedFields: ['status', 'scheduledAt'],
        success: true,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Audit log failed for schedule');
    }
    await this.publisher.publish('blog.scheduled', { id, scheduledAt, userId });
    await this.invalidateCaches(post.slug);
    return scheduled;
  }

  async archivePost(id: string, userId?: string) {
    const post = await this.repo.findById(id);
    if (!post) throw new NotFoundException('Post not found');
    if (post.deletedAt) throw new BadRequestException('Cannot archive deleted post');
    if (post.status === 'ARCHIVED') throw new BadRequestException('Post already archived');
    if (!this.isValidTransition(post.status, 'ARCHIVED')) throw new BadRequestException(`Cannot archive from ${post.status}`);
    const archived = await this.repo.archive(id);
    try {
      const ctx = this.getAuditContext();
      await this.auditService?.log({
        ...ctx,
        action: 'archived',
        resource: 'blog',
        resourceId: archived.id,
        oldValue: post,
        newValue: archived,
        changedFields: ['status'],
        success: true,
      });
    } catch (e) {
      this.logger.warn({ err: e }, 'Audit log failed for archive');
    }
    await this.publisher.publish('blog.archived', { id, userId });
    await this.invalidateCaches(post.slug);
    return archived;
  }

  private isValidTransition(from: string | null, to: string) {
    const flow = ['DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'];
    const fromIndex = from ? flow.indexOf(from) : -1;
    if (fromIndex === -1 && to === 'DRAFT') return true;
    if (from === to) return true;
    if (from === 'DRAFT' && to === 'REVIEW') return true;
    if (from === 'REVIEW' && (to === 'SCHEDULED' || to === 'PUBLISHED')) return true;
    if (from === 'SCHEDULED' && to === 'PUBLISHED') return true;
    if (from === 'PUBLISHED' && to === 'ARCHIVED') return true;
    return false;
  }

  private async assertOptimisticLock(existing: { updatedAt: Date | null }, expectedUpdatedAt?: string) {
    if (!expectedUpdatedAt) return;
    const expectedDate = new Date(expectedUpdatedAt);
    if (Number.isNaN(expectedDate.getTime())) throw new BadRequestException('expectedUpdatedAt must be a valid ISO8601 date');
    const currentValue = existing.updatedAt ? existing.updatedAt.toISOString() : null;
    const expectedValue = expectedDate.toISOString();
    if (currentValue !== expectedValue) {
      throw new ConflictException('The post was modified by another request');
    }
  }

  private autoExcerpt(content: string, length = 180) {
    const plain = content.replace(/[#>*_`~!]/g, '');
    return plain.substring(0, length).trim();
  }

  private isPrismaConflict(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
  }

  private async invalidateCaches(slug?: string) {
    // Invalidate specific keys + tag sets so dependent caches are removed
    try {
      await this.cacheService.del('blog:latest');
      await this.cacheService.del('blog:homepage');
      if (slug) await this.cacheService.del(`blog:slug:${slug}`);
      // invalidate tag-based caches (best-effort)
      await this.cacheService.invalidateTags(['blog:latest', 'blog:homepage', 'blog:slug']);
    } catch (e) {
      this.logger.warn({ err: e }, 'Cache invalidation failed');
    }
  }

  create = this.createPost;
  update = this.updatePost;
  softDelete = this.deletePost;
  publish = this.publishPost;
  schedule = this.schedulePost;
  archive = this.archivePost;
  restore = this.restorePost;
}
