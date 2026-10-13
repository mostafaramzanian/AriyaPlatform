import { BlogController } from './blog.controller';

const mockService = () => ({
  list: jest.fn(),
  findBySlug: jest.fn(),
  createPost: jest.fn(),
  updatePost: jest.fn(),
  deletePost: jest.fn(),
  publishPost: jest.fn(),
  schedulePost: jest.fn(),
  archivePost: jest.fn(),
  restorePost: jest.fn(),
});

describe('BlogController (unit)', () => {
  let controller: BlogController;
  let service: ReturnType<typeof mockService>;

  beforeEach(() => {
    service = mockService();
    controller = new BlogController(service as any);
  });

  it('list calls service with parsed params', async () => {
    service.list.mockResolvedValue({ items: [], hasMore: false });
    await controller.list(undefined, '10');
    expect(service.list).toHaveBeenCalledWith({ cursor: undefined, limit: 10 });
  });

  it('get calls findBySlug', async () => {
    service.findBySlug.mockResolvedValue({ id: '1' });
    await controller.get('slug');
    expect(service.findBySlug).toHaveBeenCalledWith('slug');
  });

  // Phase 34H: archived/soft-deleted posts must be discoverable so that
  // POST /blog/:id/restore is reachable after a page reload.
  describe('adminTrashList', () => {
    it('asks the service for soft-deleted rows only, with no status filter', async () => {
      service.list.mockResolvedValue({ items: [], hasMore: false });
      await controller.adminTrashList(undefined, '20');
      expect(service.list).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 20,
        filter: { deleted: true },
      });
    });

    it('forwards cursor and limit for pagination', async () => {
      service.list.mockResolvedValue({ items: [], hasMore: false });
      await controller.adminTrashList('cursor-1', '5');
      expect(service.list).toHaveBeenCalledWith({
        cursor: 'cursor-1',
        limit: 5,
        filter: { deleted: true },
      });
    });
  });

  // The active admin listing must keep behaving exactly as before: it never
  // passes `deleted`, so the repository keeps its `deletedAt: null` filter.
  it('adminList still filters by status only and never opts into deleted rows', async () => {
    service.list.mockResolvedValue({ items: [], hasMore: false });
    await controller.adminList('ARCHIVED', undefined, '20');
    expect(service.list).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 20,
      filter: { status: 'ARCHIVED' },
    });
  });

  it('adminList rejects an unknown status', async () => {
    await expect(controller.adminList('TRASH', undefined, '20')).rejects.toThrow(/Invalid status/);
    expect(service.list).not.toHaveBeenCalled();
  });
});
