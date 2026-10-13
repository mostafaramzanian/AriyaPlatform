import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DirectoryService, MAX_DIRECTORY_LIMIT } from './directory.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

/**
 * Phase 49D-1 unit coverage for the Organization Directory reads.
 *
 * Asserts the tenant predicate, the explicit (allowlisted) projection, the
 * pagination contract and the deterministic ordering. Cross-tenant behaviour is
 * additionally proven against a real database in
 * test/users-directory-tenant.e2e-spec.ts.
 */

const SENSITIVE_FIELDS = [
  'passwordHash',
  'tokenVersion',
  'tenantId',
  'emailVerified',
  'createdAt',
  'updatedAt',
];

describe('DirectoryService', () => {
  let service: DirectoryService;
  let prisma: PrismaService;

  const tenantA = 'tenant-a';

  const setContext = (tenantId: string | null) =>
    RequestContextService.set({
      requestId: 'r1',
      correlationId: 'c1',
      startTime: Date.now(),
      tenantId,
    });

  const member = (id = 'user-1') => ({
    id,
    firstName: 'سارا',
    lastName: 'محمدی',
    email: `${id}@example.com`,
    phone: '021-1234',
    avatarUrl: null,
    status: 'EMPLOYEE',
    department: 'مالی',
    jobTitle: 'حسابدار',
    extension: '204',
    managerId: null,
    manager: null,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        DirectoryService,
        {
          provide: PrismaService,
          useValue: { user: { findMany: jest.fn(), findFirst: jest.fn() } },
        },
      ],
    }).compile();

    service = moduleRef.get(DirectoryService);
    prisma = moduleRef.get(PrismaService);
  });

  describe('tenant scope', () => {
    it('throws ForbiddenException when the request has no tenant context', async () => {
      setContext(null);
      await expect(service.listDirectory({})).rejects.toThrow(ForbiddenException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('scopes the list query to the tenant from RequestContextService', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      const args = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ tenantId: tenantA });
    });

    it('scopes the manager relation to the same tenant, so foreign managers resolve to null', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      const args = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(args.select.manager.where).toEqual({ tenantId: tenantA });
    });
  });

  describe('projection', () => {
    it('selects only the approved directory fields', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      const { select } = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(Object.keys(select).sort()).toEqual(
        [
          'avatarUrl',
          'department',
          'email',
          'extension',
          'firstName',
          'id',
          'jobTitle',
          'lastName',
          'manager',
          'managerId',
          'phone',
          'status',
        ].sort(),
      );
    });

    it('never requests a sensitive field', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      const { select } = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      for (const field of SENSITIVE_FIELDS) {
        expect(select).not.toHaveProperty(field);
        expect(select.manager.select).not.toHaveProperty(field);
      }
    });

    it('bounds the manager projection to display fields only', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      const { select } = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(Object.keys(select.manager.select).sort()).toEqual(
        ['avatarUrl', 'firstName', 'id', 'jobTitle', 'lastName'].sort(),
      );
    });
  });

  describe('pagination', () => {
    it('defaults to a limit of 20 and over-fetches by one', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      expect((prisma.user.findMany as jest.Mock).mock.calls[0][0].take).toBe(21);
    });

    it('caps the limit at 100 instead of rejecting the request', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ limit: 5000 });

      expect((prisma.user.findMany as jest.Mock).mock.calls[0][0].take).toBe(
        MAX_DIRECTORY_LIMIT + 1,
      );
    });

    it('reports hasMore and drops the over-fetched row', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        member('user-1'),
        member('user-2'),
        member('user-3'),
      ]);

      const result = await service.listDirectory({ limit: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.items.map((item) => item.id)).toEqual(['user-1', 'user-2']);
    });

    it('reports hasMore=false when the page is not full', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([member('user-1')]);

      const result = await service.listDirectory({ limit: 2 });

      expect(result.hasMore).toBe(false);
      expect(result.items).toHaveLength(1);
    });

    it('applies the cursor by skipping the cursor row itself', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ cursor: 'user-9' });

      const args = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(args.cursor).toEqual({ id: 'user-9' });
      expect(args.skip).toBe(1);
    });

    it('orders deterministically, breaking ties on id', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({});

      expect((prisma.user.findMany as jest.Mock).mock.calls[0][0].orderBy).toEqual([
        { firstName: 'asc' },
        { lastName: 'asc' },
        { id: 'asc' },
      ]);
    });
  });

  describe('filters', () => {
    it('searches name, email, phone and extension for q', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ q: 'سارا' });

      const { where } = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(where.tenantId).toBe(tenantA);
      expect(where.OR).toEqual([
        { firstName: { contains: 'سارا', mode: 'insensitive' } },
        { lastName: { contains: 'سارا', mode: 'insensitive' } },
        { email: { contains: 'سارا', mode: 'insensitive' } },
        { phone: { contains: 'سارا', mode: 'insensitive' } },
        { extension: { contains: 'سارا', mode: 'insensitive' } },
      ]);
    });

    it('filters by department', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ department: 'مالی' });

      expect((prisma.user.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        tenantId: tenantA,
        department: 'مالی',
      });
    });

    it('filters by jobTitle', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ jobTitle: 'حسابدار' });

      expect((prisma.user.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        tenantId: tenantA,
        jobTitle: 'حسابدار',
      });
    });

    it('filters by managerId', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ managerId: 'user-boss' });

      expect((prisma.user.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        tenantId: tenantA,
        managerId: 'user-boss',
      });
    });

    it('combines filters conjunctively with the tenant predicate', async () => {
      setContext(tenantA);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDirectory({ department: 'مالی', jobTitle: 'حسابدار', q: 'سارا' });

      const { where } = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
      expect(where.tenantId).toBe(tenantA);
      expect(where.department).toBe('مالی');
      expect(where.jobTitle).toBe('حسابدار');
      expect(where.OR).toHaveLength(5);
    });
  });

  describe('getDirectoryMember', () => {
    it('reads a single member scoped to the tenant', async () => {
      setContext(tenantA);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(member('user-1'));

      const result = await service.getDirectoryMember('user-1');

      const args = (prisma.user.findFirst as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ id: 'user-1', tenantId: tenantA });
      expect(result.id).toBe('user-1');
    });

    it('throws NotFoundException for an unknown or foreign-tenant id', async () => {
      setContext(tenantA);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.getDirectoryMember('user-other')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException without tenant context', async () => {
      setContext(null);
      await expect(service.getDirectoryMember('user-1')).rejects.toThrow(ForbiddenException);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('uses the same allowlisted projection as the list', async () => {
      setContext(tenantA);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(member('user-1'));

      await service.getDirectoryMember('user-1');

      const { select } = (prisma.user.findFirst as jest.Mock).mock.calls[0][0];
      for (const field of SENSITIVE_FIELDS) {
        expect(select).not.toHaveProperty(field);
      }
      expect(select.manager.where).toEqual({ tenantId: tenantA });
    });
  });
});
