import { Logger } from '@nestjs/common';
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseFilters, UseInterceptors, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiConflictResponse, ApiForbiddenResponse, ApiInternalServerErrorResponse, ApiNotFoundResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags, ApiUnauthorizedResponse, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { BlogService } from './blog.service';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { RateLimit } from '../common/rate-limit.decorator';
import { CreateBlogDto } from './dto/create-blog.dto';
import { UpdateBlogDto } from './dto/update-blog.dto';
import { PublishBlogDto } from './dto/publish-blog.dto';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Public } from '../../../auth/decorators/public.decorator';
import { BlogResponseInterceptor } from './blog-response.interceptor';
import { StandardExceptionFilter } from '../../../common/filters/standard-exception.filter';

@ApiTags('Blog')
@ApiBearerAuth()
@UseInterceptors(BlogResponseInterceptor)
@UseFilters(StandardExceptionFilter)
@Controller('blog')
export class BlogController {
  private readonly logger = new Logger(BlogController.name);
  constructor(private readonly blogService: BlogService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List blog posts (cursor pagination)', security: [] })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor for pagination' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size', example: 20 })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by category id' })
  @ApiQuery({ name: 'tag', required: false, description: 'Filter by tag id' })
  @ApiResponse({ status: 200, description: 'Blog posts returned successfully' })
  @ApiBadRequestResponse({ description: 'Invalid pagination parameters' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  @UseGuards(RateLimitGuard)
  @RateLimit({ key: 'public', points: 60, duration: 60 })
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '20',
    @Query('category') category?: string,
    @Query('tag') tag?: string,
  ) {
    const filter: any = {};
    if (category) filter.categoryId = category;
    if (tag) filter.tagId = tag;
    const payload: any = { cursor, limit: parseInt(limit, 10) };
    if (Object.keys(filter).length > 0) payload.filter = filter;
    return this.blogService.list(payload);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List blog categories' })
  async listCategories() {
    return this.blogService.listCategories();
  }

  @Get('categories/:slug')
  @ApiOperation({ summary: 'Get category by slug' })
  async getCategory(@Param('slug') slug: string) {
    return this.blogService.getCategoryBySlug(slug);
  }

  @Get('tags')
  @ApiOperation({ summary: 'List blog tags' })
  async listTags() {
    return this.blogService.listTags();
  }

  @Get('tags/:slug')
  @ApiOperation({ summary: 'Get tag by slug' })
  async getTag(@Param('slug') slug: string) {
    return this.blogService.getTagBySlug(slug);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search blog posts' })
  @ApiQuery({ name: 'q', required: true })
  async search(@Query('q') q: string, @Query('cursor') cursor?: string, @Query('limit') limit = '20') {
    return this.blogService.search(q, { cursor, limit: parseInt(limit, 10) });
  }

  @Get('latest')
  @ApiOperation({ summary: 'Latest posts' })
  async latest(@Query('limit') limit = '10') {
    return this.blogService.getLatestPosts(parseInt(limit, 10));
  }

  @Get('archive')
  @ApiOperation({ summary: 'Archived posts' })
  async archiveList(@Query('cursor') cursor?: string, @Query('limit') limit = '20') {
    return this.blogService.getArchivedPosts({ cursor, limit: parseInt(limit, 10) });
  }

  @Get('related/:slug')
  @ApiOperation({ summary: 'Related posts for a slug' })
  async related(@Param('slug') slug: string, @Query('limit') limit = '5') {
    return this.blogService.related(slug, parseInt(limit, 10));
  }

  @Get('admin')
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Admin list blog posts by status' })
  @ApiQuery({ name: 'status', required: true, description: 'Status filter: DRAFT | REVIEW | SCHEDULED | PUBLISHED | ARCHIVED' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor for pagination' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size', example: '20' })
  @ApiResponse({ status: 200, description: 'Admin blog posts returned successfully' })
  @ApiBadRequestResponse({ description: 'Invalid status or pagination parameters' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  async adminList(
    @Query('status') status: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '20',
  ) {
    const allowedStatuses = ['DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'];
    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException(`Invalid status. Allowed: ${allowedStatuses.join(', ')}`);
    }
    return this.blogService.list({ cursor, limit: parseInt(limit, 10), filter: { status } });
  }

  /**
   * Phase 34H: durable discovery of archived / soft-deleted posts.
   *
   * `BlogRepository.archive()` sets `status = ARCHIVED` *and* `deletedAt`, and
   * `softDelete()` sets `deletedAt` while leaving `status` untouched. Every
   * other list query filters `deletedAt: null`, so before this route an
   * archived or deleted post was unreachable from any listing — restore was
   * only possible while the id was still on screen in the same page session.
   *
   * This route is declared before `admin/:id` on purpose: Nest matches in
   * declaration order and `admin/:id` would otherwise swallow `admin/trash`.
   * No status filter is accepted because a soft-deleted post keeps whatever
   * status it had, so all statuses must be listed together. Same permission as
   * the rest of the admin listing surface (`blog.write`), which is also what
   * `POST /blog/:id/restore` already requires — no new permission is added.
   */
  @Get('admin/trash')
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Admin list archived / soft-deleted blog posts (restorable)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor for pagination' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size', example: '20' })
  @ApiResponse({ status: 200, description: 'Archived / deleted blog posts returned successfully' })
  @ApiBadRequestResponse({ description: 'Invalid pagination parameters' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  async adminTrashList(@Query('cursor') cursor?: string, @Query('limit') limit = '20') {
    return this.blogService.list({ cursor, limit: parseInt(limit, 10), filter: { deleted: true } });
  }

  @Get('admin/:id')
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Get any blog post by id for admin editing' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiResponse({ status: 200, description: 'Blog post returned successfully' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  async adminGetById(@Param('id') id: string) {
    return this.blogService.getAdminPost(id);
  }

  @Get(':slug')
  @Public()
  @ApiOperation({ summary: 'Get blog post by slug', security: [] })
  @ApiParam({ name: 'slug', description: 'Blog post slug' })
  @ApiResponse({ status: 200, description: 'Blog post returned successfully' })
  @ApiBadRequestResponse({ description: 'Invalid slug parameter' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  @UseGuards(RateLimitGuard)
  @RateLimit({ key: 'public', points: 120, duration: 60 })
  async get(@Param('slug') slug: string) {
    return this.blogService.findBySlug(slug);
  }

  @Post()
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Create blog post' })
  @ApiBody({ type: CreateBlogDto })
  @ApiResponse({ status: 201, description: 'Blog post created successfully' })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiConflictResponse({ description: 'Slug collision' })
  @ApiUnprocessableEntityResponse({ description: 'Input validation failed' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async create(@Body() dto: CreateBlogDto, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    const start = Date.now();
    this.logger.debug({ start, requestId: (req as any)?.headers?.['x-request-id'] || null }, 'Blog create start');
    const res = await this.blogService.createPost(dto, userId);
    const end = Date.now();
    this.logger.debug({ durationMs: end - start, requestId: (req as any)?.headers?.['x-request-id'] || null }, 'Blog create end');
    return res;
  }

  @Patch(':id')
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Update blog post' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiBody({ type: UpdateBlogDto })
  @ApiResponse({ status: 200, description: 'Blog post updated successfully' })
  @ApiBadRequestResponse({ description: 'Validation or workflow failure' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiConflictResponse({ description: 'Optimistic lock or slug conflict' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiUnprocessableEntityResponse({ description: 'Input validation failed' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async update(@Param('id') id: string, @Body() dto: UpdateBlogDto, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    return this.blogService.updatePost(id, dto, userId);
  }

  @Delete(':id')
  @Roles(Permissions.BLOG_DELETE)
  @ApiOperation({ summary: 'Soft-delete blog post' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiResponse({ status: 200, description: 'Blog post deleted successfully' })
  @ApiBadRequestResponse({ description: 'Deletion failed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async remove(@Param('id') id: string, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    return this.blogService.deletePost(id, userId);
  }

  @Post(':id/publish')
  @Roles(Permissions.BLOG_PUBLISH)
  @ApiOperation({ summary: 'Publish blog post' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiBody({ type: PublishBlogDto })
  @ApiResponse({ status: 200, description: 'Blog post published successfully' })
  @ApiBadRequestResponse({ description: 'Workflow or validation failure' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiConflictResponse({ description: 'Optimistic lock conflict' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiUnprocessableEntityResponse({ description: 'Input validation failed' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async publish(@Param('id') id: string, @Body() dto: PublishBlogDto, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    return this.blogService.publishPost(id, dto, userId);
  }

  // Compatibility: accept PATCH for publish (tests expect PATCH)
  @Patch(':id/publish')
  @Roles(Permissions.BLOG_PUBLISH)
  @ApiOperation({ summary: 'Publish blog post (compat PATCH)' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiBody({ type: PublishBlogDto })
  @ApiResponse({ status: 200, description: 'Blog post published successfully' })
  async publishPatch(@Param('id') id: string, @Body() dto: PublishBlogDto, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    return this.blogService.publishPost(id, dto, userId);
  }

  @Post(':id/archive')
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Archive a blog post' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiResponse({ status: 200, description: 'Blog post archived successfully' })
  @ApiBadRequestResponse({ description: 'Archive workflow failure' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async archive(@Param('id') id: string, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    return this.blogService.archivePost(id, userId);
  }

  @Post(':id/schedule')
  @Roles(Permissions.BLOG_PUBLISH)
  @ApiOperation({ summary: 'Schedule a blog post to publish later' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiBody({ type: PublishBlogDto })
  @ApiResponse({ status: 200, description: 'Blog post scheduled successfully' })
  @ApiBadRequestResponse({ description: 'Scheduling validation failure' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiConflictResponse({ description: 'Optimistic lock conflict' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiUnprocessableEntityResponse({ description: 'Input validation failed' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async schedule(@Param('id') id: string, @Body() dto: PublishBlogDto, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    if (!dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required');
    }
    return this.blogService.schedulePost(id, dto.scheduledAt, userId);
  }

  @Post(':id/restore')
  @Roles(Permissions.BLOG_WRITE)
  @ApiOperation({ summary: 'Restore a soft-deleted blog post' })
  @ApiParam({ name: 'id', description: 'Blog post id' })
  @ApiResponse({ status: 200, description: 'Blog post restored successfully' })
  @ApiBadRequestResponse({ description: 'Restore workflow failure' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  @ApiNotFoundResponse({ description: 'Blog post not found' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  async restore(@Param('id') id: string, @Req() req: { user?: { sub?: string } }) {
    const userId = req.user?.sub;
    return this.blogService.restorePost(id, userId);
  }
}
