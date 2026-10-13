import { BlogRepository } from './blog.repository';
import { CmsPrismaService } from '../../../database/cms-prisma.service';

describe('BlogRepository (unit)', () => {
  let repo: BlogRepository;
  let prisma: Partial<Record<string, jest.Mock<any, any>>> & any;

  beforeEach(() => {
    // minimal prisma mock
    prisma = {
      blogPost: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
      blogPostCategory: { createMany: jest.fn() },
      blogPostTag: { createMany: jest.fn() },
      seoMetadata: { upsert: jest.fn() },
      $executeRawUnsafe: jest.fn(),
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    } as any;
    repo = new BlogRepository(prisma as unknown as CmsPrismaService);
  });

  it('createWithUniqueSlug retries on P2002 and succeeds', async () => {
    const data = { title: 't' } as any;
    let call = 0;
    prisma.blogPost.create = jest.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        const e: any = new Error('Unique');
        e.code = 'P2002';
        e.meta = { target: ['slug'] };
        throw e;
      }
      return { id: '1', slug: 't-1' };
    });

    const res = await repo.createWithUniqueSlug(data, 't', 3);
    expect(prisma.blogPost.create).toHaveBeenCalledTimes(2);
    expect(res.slug).toBe('t-1');
  });

  it('createWithRelations creates post and relations and increments tag usage', async () => {
    const created = { id: 'p1', slug: 's' } as any;
    prisma.blogPost.create = jest.fn().mockResolvedValue(created);
    prisma.blogPostCategory.createMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.blogPostTag.createMany = jest.fn().mockResolvedValue({ count: 2 });
    prisma.$executeRawUnsafe = jest.fn().mockResolvedValue(undefined);

    await repo.createWithRelations({ title: 't' } as any, ['c1'], ['t1', 't2']);
    expect(prisma.blogPost.create).toHaveBeenCalled();
    expect(prisma.blogPostCategory.createMany).toHaveBeenCalled();
    expect(prisma.blogPostTag.createMany).toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('list uses cursor pagination and limits', async () => {
    prisma.blogPost.findMany = jest.fn().mockResolvedValue([{ id: '1' }]);
    await repo.list({ cursor: undefined, limit: 5 });
    expect(prisma.blogPost.findMany).toHaveBeenCalled();
  });

  // Phase 34: regression coverage for the public content-exposure fix.
  it('list defaults to PUBLISHED-only when no status filter is given (public route)', async () => {
    prisma.blogPost.findMany = jest.fn().mockResolvedValue([]);
    await repo.list({ limit: 5 });
    const where = (prisma.blogPost.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe('PUBLISHED');
  });

  it('list respects an explicit status filter when one is provided', async () => {
    prisma.blogPost.findMany = jest.fn().mockResolvedValue([]);
    await repo.list({ limit: 5, filter: { status: 'DRAFT' } });
    const where = (prisma.blogPost.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe('DRAFT');
  });

  it('findBySlug only ever queries for PUBLISHED posts', async () => {
    prisma.blogPost.findFirst = jest.fn().mockResolvedValue(null);
    await repo.findBySlug('some-slug');
    const where = (prisma.blogPost.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe('PUBLISHED');
  });

  // Phase 34H: the archived/trash listing. archive() stamps `deletedAt`
  // alongside `status = ARCHIVED`, so without inverting the soft-delete filter
  // those rows are unreachable from every listing.
  it('list excludes soft-deleted rows for every pre-existing caller', async () => {
    prisma.blogPost.findMany = jest.fn().mockResolvedValue([]);
    await repo.list({ limit: 5, filter: { status: 'ARCHIVED' } });
    const where = (prisma.blogPost.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe('ARCHIVED');
  });

  it('list with deleted:true returns only soft-deleted rows and does not narrow status', async () => {
    prisma.blogPost.findMany = jest.fn().mockResolvedValue([]);
    await repo.list({ limit: 5, filter: { deleted: true } });
    const where = (prisma.blogPost.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.deletedAt).toEqual({ not: null });
    // softDelete() leaves `status` untouched, so a deleted DRAFT must still be
    // listed — the PUBLISHED-only public default must not be applied here.
    expect(where.status).toBeUndefined();
  });

  it('list with deleted:false behaves exactly like an ordinary active list', async () => {
    prisma.blogPost.findMany = jest.fn().mockResolvedValue([]);
    await repo.list({ limit: 5, filter: { deleted: false, status: 'DRAFT' } });
    const where = (prisma.blogPost.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe('DRAFT');
  });

  it('publish updates post and upserts seo metadata within transaction', async () => {
    prisma.blogPost.update = jest.fn().mockResolvedValue({ id: '1', status: 'PUBLISHED' });
    prisma.seoMetadata.upsert = jest.fn().mockResolvedValue({});
    await repo.publish('1', { metaTitle: 'm' });
    expect(prisma.blogPost.update).toHaveBeenCalled();
    expect(prisma.seoMetadata.upsert).toHaveBeenCalled();
  });
});
