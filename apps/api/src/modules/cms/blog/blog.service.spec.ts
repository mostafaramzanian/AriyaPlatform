import { BadRequestException, ConflictException } from '@nestjs/common';
import { BlogService } from './blog.service';

const mockRepo = () => ({
  createWithUniqueSlug: jest.fn(),
  attachRelations: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
  publish: jest.fn(),
  unpublish: jest.fn(),
  schedule: jest.fn(),
  archive: jest.fn(),
  list: jest.fn(),
  findBySlug: jest.fn(),
});

const mockPublisher = () => ({ publish: jest.fn() });

const mockRequestContextService = () => ({
  getContext: jest.fn().mockReturnValue({ requestId: 'test-id', correlationId: 'test-corr-id' }),
  getRequestId: jest.fn().mockReturnValue('test-id'),
  getCorrelationId: jest.fn().mockReturnValue('test-corr-id'),
  getUserId: jest.fn().mockReturnValue(undefined),
  getDurationMs: jest.fn().mockReturnValue(0),
});

describe('BlogService', () => {
  let service: BlogService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(() => {
    repo = mockRepo();
    const publisher = mockPublisher();
    const cacheService = { get: jest.fn(), set: jest.fn(), del: jest.fn(), wrap: jest.fn(async (_k: string, _ttl: number, _tags: string[], fn: any) => fn()), invalidateTags: jest.fn() };
    const requestContextService = mockRequestContextService();
    service = new BlogService(repo as any, publisher as any, cacheService as any, requestContextService as any);
  });

  it('creates post and publishes event', async () => {
    const dto = { title: 'Hello', content: 'Hello world content', categories: [], tags: [] };
    repo.createWithUniqueSlug.mockResolvedValue({ id: '1', slug: 'hello' });
    repo.attachRelations.mockResolvedValue(undefined);
    await service.createPost(dto as any, 'user-1');
    expect(repo.createWithUniqueSlug).toHaveBeenCalled();
    expect(repo.attachRelations).toHaveBeenCalled();
  });

  it('rejects invalid status transition on update', async () => {
    repo.findById.mockResolvedValue({ id: '1', status: 'PUBLISHED', slug: 's', updatedAt: new Date('2025-01-01T00:00:00.000Z'), deletedAt: null });
    await expect(service.updatePost('1', { status: 'DRAFT' } as any)).rejects.toThrow(BadRequestException);
  });

  it('rejects optimistic locking conflicts', async () => {
    repo.findById.mockResolvedValue({ id: '1', status: 'DRAFT', slug: 's', updatedAt: new Date('2025-01-01T00:00:00.000Z'), deletedAt: null });
    await expect(service.updatePost('1', { expectedUpdatedAt: '2025-01-02T00:00:00.000Z' } as any)).rejects.toThrow(ConflictException);
  });
});
