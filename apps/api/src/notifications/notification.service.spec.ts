import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MAX_NOTIFICATION_LIMIT, NotificationService } from './notification.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

/**
 * Phase 49E unit coverage for the Notification Center.
 *
 * Asserts the ownership predicate (userId + tenantId), the allowlisted
 * projection, the pagination contract, deterministic ordering, mark-read
 * idempotency and the content/source validation on the server-side creation
 * path. Cross-user and cross-tenant behaviour is additionally proven against a
 * real database in test/notifications.e2e-spec.ts.
 */

const SENSITIVE_FIELDS = ['userId', 'tenantId'];

describe('NotificationService', () => {
  let service: NotificationService;
  let prisma: PrismaService;

  const userA = 'user-a';
  const tenantA = 'tenant-a';

  const setContext = (userId: string | undefined, tenantId: string | null) =>
    RequestContextService.set({
      requestId: 'r1',
      correlationId: 'c1',
      startTime: Date.now(),
      userId,
      tenantId,
    });

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'n1',
    type: 'SYSTEM',
    title: 'ورود جدید',
    body: 'ورود موفق از دستگاه جدید ثبت شد.',
    readAt: null,
    sourceType: null,
    sourceId: null,
    createdAt: new Date('2026-08-28T10:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: PrismaService,
          useValue: {
            notification: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              count: jest.fn(),
              updateMany: jest.fn(),
              create: jest.fn(),
            },
            user: { findUnique: jest.fn() },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(NotificationService);
    prisma = moduleRef.get(PrismaService);
  });

  describe('ownership scope', () => {
    it('refuses a request with no identity in the context', async () => {
      setContext(undefined, tenantA);
      await expect(service.listNotifications(userA, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    });

    it('refuses when the context identity differs from the requested subject', async () => {
      setContext('someone-else', tenantA);
      await expect(service.listNotifications(userA, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    });

    it('scopes the list query to the caller and their tenant', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, {});

      const args = (prisma.notification.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ userId: userA, tenantId: tenantA });
    });

    it('keeps a null tenant as an explicit predicate rather than dropping it', async () => {
      setContext(userA, null);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, {});

      const args = (prisma.notification.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ userId: userA, tenantId: null });
    });
  });

  describe('projection', () => {
    it('selects only the approved notification fields', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, {});

      const { select } = (prisma.notification.findMany as jest.Mock).mock.calls[0][0];
      expect(Object.keys(select).sort()).toEqual(
        ['body', 'createdAt', 'id', 'readAt', 'sourceId', 'sourceType', 'title', 'type'].sort(),
      );
      for (const field of SENSITIVE_FIELDS) {
        expect(select).not.toHaveProperty(field);
      }
    });
  });

  describe('pagination and ordering', () => {
    it('uses the default limit and over-fetches by one', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, {});

      expect((prisma.notification.findMany as jest.Mock).mock.calls[0][0].take).toBe(21);
    });

    it('caps an oversized limit instead of failing', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, { limit: 5000 });

      expect((prisma.notification.findMany as jest.Mock).mock.calls[0][0].take).toBe(
        MAX_NOTIFICATION_LIMIT + 1,
      );
    });

    it('orders newest first with id as the deterministic tie-break', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, {});

      expect((prisma.notification.findMany as jest.Mock).mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('reports hasMore and trims the extra row', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([
        row({ id: 'n1' }),
        row({ id: 'n2' }),
        row({ id: 'n3' }),
      ]);

      const result = await service.listNotifications(userA, { limit: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.items.map((item) => item.id)).toEqual(['n1', 'n2']);
    });

    it('skips the cursor row so pages never overlap', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, { cursor: 'n2' });

      const args = (prisma.notification.findMany as jest.Mock).mock.calls[0][0];
      expect(args.cursor).toEqual({ id: 'n2' });
      expect(args.skip).toBe(1);
    });

    it('sends no cursor on the first page', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, {});

      const args = (prisma.notification.findMany as jest.Mock).mock.calls[0][0];
      expect(args.cursor).toBeUndefined();
      expect(args.skip).toBeUndefined();
    });

    it('filters by unread and read state', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.listNotifications(userA, { state: 'unread' });
      expect((prisma.notification.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        userId: userA,
        tenantId: tenantA,
        readAt: null,
      });

      await service.listNotifications(userA, { state: 'read' });
      expect((prisma.notification.findMany as jest.Mock).mock.calls[1][0].where).toEqual({
        userId: userA,
        tenantId: tenantA,
        readAt: { not: null },
      });
    });
  });

  describe('unread count', () => {
    it('counts only the caller unread rows and never lists them', async () => {
      setContext(userA, tenantA);
      (prisma.notification.count as jest.Mock).mockResolvedValue(4);

      const result = await service.getUnreadCount(userA);

      expect(result).toEqual({ count: 4 });
      expect((prisma.notification.count as jest.Mock).mock.calls[0][0].where).toEqual({
        userId: userA,
        tenantId: tenantA,
        readAt: null,
      });
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    });

    it('refuses without a matching identity', async () => {
      setContext(undefined, tenantA);
      await expect(service.getUnreadCount(userA)).rejects.toThrow(ForbiddenException);
      expect(prisma.notification.count).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('stamps readAt and scopes the update to the caller', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue({ id: 'n1', readAt: null });
      (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.markRead(userA, 'n1');

      expect(result.id).toBe('n1');
      expect(result.readAt).toBeInstanceOf(Date);
      expect((prisma.notification.updateMany as jest.Mock).mock.calls[0][0].where).toEqual({
        userId: userA,
        tenantId: tenantA,
        id: 'n1',
      });
    });

    it('is idempotent: a second call keeps the original readAt and issues no update', async () => {
      setContext(userA, tenantA);
      const readAt = new Date('2026-08-28T09:00:00Z');
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue({ id: 'n1', readAt });

      const result = await service.markRead(userA, 'n1');

      expect(result).toEqual({ id: 'n1', readAt });
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });

    it('throws NotFound for another user\u2019s or an unknown id, revealing nothing', async () => {
      setContext(userA, tenantA);
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.markRead(userA, 'n-foreign')).rejects.toThrow(NotFoundException);
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });

    it('refuses without a matching identity', async () => {
      setContext('someone-else', tenantA);
      await expect(service.markRead(userA, 'n1')).rejects.toThrow(ForbiddenException);
      expect(prisma.notification.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead', () => {
    it('updates only the caller\u2019s unread rows and reports the count', async () => {
      setContext(userA, tenantA);
      (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      const result = await service.markAllRead(userA);

      expect(result).toEqual({ updated: 3 });
      expect((prisma.notification.updateMany as jest.Mock).mock.calls[0][0].where).toEqual({
        userId: userA,
        tenantId: tenantA,
        readAt: null,
      });
    });

    it('is safe to repeat: the second call matches nothing', async () => {
      setContext(userA, tenantA);
      (prisma.notification.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 3 })
        .mockResolvedValueOnce({ count: 0 });

      await service.markAllRead(userA);
      await expect(service.markAllRead(userA)).resolves.toEqual({ updated: 0 });
    });

    it('refuses without a matching identity', async () => {
      setContext(undefined, tenantA);
      await expect(service.markAllRead(userA)).rejects.toThrow(ForbiddenException);
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('createForUser (server-side only)', () => {
    const recipient = { id: 'user-b', tenantId: 'tenant-b' };

    beforeEach(() => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(recipient);
      (prisma.notification.create as jest.Mock).mockImplementation(async ({ data }) => ({
        ...row(),
        ...data,
      }));
    });

    it('requires an existing recipient', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createForUser({ userId: 'ghost', type: 'SYSTEM', title: 'ت', body: 'ب' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('snapshots the recipient tenant and ignores nothing about it', async () => {
      await service.createForUser({
        userId: recipient.id,
        type: 'SECURITY',
        title: 'ورود جدید',
        body: 'ورود از دستگاه ناشناس',
      });

      expect((prisma.notification.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        userId: recipient.id,
        tenantId: recipient.tenantId,
        type: 'SECURITY',
      });
    });

    it('refuses a tenant assertion that does not match the recipient', async () => {
      await expect(
        service.createForUser({
          userId: recipient.id,
          tenantId: 'tenant-a',
          type: 'SYSTEM',
          title: 'ت',
          body: 'ب',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('never writes the caller-supplied tenant even when it matches', async () => {
      await service.createForUser({
        userId: recipient.id,
        tenantId: recipient.tenantId,
        type: 'SYSTEM',
        title: 'ت',
        body: 'ب',
      });

      expect((prisma.notification.create as jest.Mock).mock.calls[0][0].data.tenantId).toBe(
        recipient.tenantId,
      );
    });

    it('rejects blank, oversized and markup-bearing content', async () => {
      const base = { userId: recipient.id, type: 'SYSTEM' as const };

      await expect(
        service.createForUser({ ...base, title: '   ', body: 'ب' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createForUser({ ...base, title: 'ت', body: '  ' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createForUser({ ...base, title: 'x'.repeat(161), body: 'ب' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createForUser({ ...base, title: 'ت', body: 'x'.repeat(1001) }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createForUser({ ...base, title: '<script>x</script>', body: 'ب' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createForUser({ ...base, title: 'ت', body: '<img onerror=1>' }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('trims accepted content', async () => {
      await service.createForUser({
        userId: recipient.id,
        type: 'SYSTEM',
        title: '  عنوان  ',
        body: '  متن  ',
      });

      expect((prisma.notification.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        title: 'عنوان',
        body: 'متن',
      });
    });

    it('normalises a blank source reference to null and rejects an unsafe one', async () => {
      await service.createForUser({
        userId: recipient.id,
        type: 'SYSTEM',
        title: 'ت',
        body: 'ب',
        sourceType: '   ',
        sourceId: undefined,
      });

      expect((prisma.notification.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        sourceType: null,
        sourceId: null,
      });

      await expect(
        service.createForUser({
          userId: recipient.id,
          type: 'SYSTEM',
          title: 'ت',
          body: 'ب',
          sourceType: 'audit log',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns the same allowlisted projection as the reads', async () => {
      await service.createForUser({
        userId: recipient.id,
        type: 'SYSTEM',
        title: 'ت',
        body: 'ب',
      });

      const { select } = (prisma.notification.create as jest.Mock).mock.calls[0][0];
      for (const field of SENSITIVE_FIELDS) {
        expect(select).not.toHaveProperty(field);
      }
    });
  });
});
