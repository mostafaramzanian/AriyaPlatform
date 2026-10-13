import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MAX_TICKET_LIMIT, SupportService } from './support.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { NotificationService } from '../notifications/notification.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { AuditService } from '../common/audit.service';
import { Permissions } from '../auth/rbac/constants/permissions';

/**
 * Phase 49G unit coverage for the Support service.
 *
 * Asserts the visibility predicate (tenant + requester, or tenant-wide for an
 * agent), the allowlisted projection, the pagination contract, deterministic
 * ordering, the internal-note filter, the lifecycle guard, the audit boundary
 * (privileged mutations only, never reads) and the notification rule (never the
 * actor). Cross-user and cross-tenant behaviour is additionally proven against a
 * real database in test/support.e2e-spec.ts.
 */

const SENSITIVE_FIELDS = ['tenantId', 'email', 'passwordHash', 'tokenVersion'];

describe('SupportService', () => {
  let service: SupportService;
  let prisma: {
    ticket: Record<string, jest.Mock>;
    ticketAttachment: Record<string, jest.Mock>;
    ticketComment: Record<string, jest.Mock>;
    ticketSatisfaction: Record<string, jest.Mock>;
    ticketStatusHistory: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let permissions: { userHasPermission: jest.Mock };
  let notifications: { createForUser: jest.Mock };
  let audit: { log: jest.Mock };

  const requester = 'user-requester';
  const agent = 'user-agent';
  const tenantA = 'tenant-a';

  const setContext = (userId: string | undefined, tenantId: string | null) =>
    RequestContextService.set({
      requestId: 'r1',
      correlationId: 'c1',
      startTime: Date.now(),
      userId,
      tenantId,
    });

  const person = (id: string) => ({
    id,
    firstName: 'نام',
    lastName: 'خانوادگی',
    avatarUrl: null,
    jobTitle: null,
  });

  const ticketRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'ticket-1',
    tenantId: tenantA,
    trackingNumber: 'TK-ABCDEFGHJK',
    type: 'SUPPORT',
    priority: 'NORMAL',
    status: 'NEW',
    subject: 'موضوع تیکت',
    body: 'متن تیکت',
    category: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: new Date('2026-08-29T10:00:00Z'),
    updatedAt: new Date('2026-08-29T10:00:00Z'),
    requesterId: requester,
    assigneeId: null,
    requester: person(requester),
    assignee: null,
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SupportService,
        {
          provide: PrismaService,
          useValue: {
            ticket: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            ticketComment: { findMany: jest.fn(), create: jest.fn(), findUniqueOrThrow: jest.fn() },
            ticketAttachment: { findMany: jest.fn(), updateMany: jest.fn() },
            ticketStatusHistory: { findMany: jest.fn(), create: jest.fn() },
            ticketSatisfaction: { findUnique: jest.fn(), create: jest.fn() },
            user: { findFirst: jest.fn() },
            $transaction: jest.fn(),
          },
        },
        { provide: PermissionService, useValue: { userHasPermission: jest.fn() } },
        { provide: NotificationService, useValue: { createForUser: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(SupportService);
    prisma = moduleRef.get(PrismaService);
    permissions = moduleRef.get(PermissionService);
    notifications = moduleRef.get(NotificationService);
    audit = moduleRef.get(AuditService);

    permissions.userHasPermission.mockResolvedValue(false);
  });

  describe('scope', () => {
    it('refuses a request with no identity in the context', async () => {
      setContext(undefined, tenantA);
      await expect(service.listTickets(requester, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.ticket.findMany).not.toHaveBeenCalled();
    });

    it('refuses when the context identity differs from the requested subject', async () => {
      setContext('someone-else', tenantA);
      await expect(service.listTickets(requester, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.ticket.findMany).not.toHaveBeenCalled();
    });

    it('resolves agent status from RBAC, never from the request', async () => {
      setContext(agent, tenantA);
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(agent, {});

      expect(permissions.userHasPermission).toHaveBeenCalledWith(
        agent,
        Permissions.ADMIN_SUPPORT_MANAGE,
      );
    });
  });

  describe('visibility', () => {
    it('restricts a non-agent to their own tickets inside their tenant', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, {});

      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ tenantId: tenantA, requesterId: requester });
    });

    it('lets an agent see their whole tenant but never beyond it', async () => {
      setContext(agent, tenantA);
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(agent, {});

      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ tenantId: tenantA });
    });

    it('keeps a null tenant as an explicit predicate rather than dropping it', async () => {
      setContext(requester, null);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, {});

      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ tenantId: null, requesterId: requester });
    });

    it('cannot be widened by a non-agent asking for scope=all', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, { scope: 'all' });

      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where.requesterId).toBe(requester);
    });
  });

  describe('projection', () => {
    it('selects only the approved ticket fields', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, {});

      const { select } = prisma.ticket.findMany.mock.calls[0][0];
      for (const field of SENSITIVE_FIELDS) {
        expect(select).not.toHaveProperty(field);
      }
    });

    it('never projects tenantId or a raw storage key to the caller', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([ticketRow()]);

      const page = await service.listTickets(requester, {});

      expect(page.items[0]).not.toHaveProperty('tenantId');
      expect(JSON.stringify(page.items[0])).not.toContain('storageKey');
    });

    it('offers no lifecycle transitions to a non-agent', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([ticketRow()]);

      const page = await service.listTickets(requester, {});

      expect(page.items[0].canManage).toBe(false);
      expect(page.items[0].availableTransitions).toEqual([]);
    });

    it('offers the real transition set to an agent', async () => {
      setContext(agent, tenantA);
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.ticket.findMany.mockResolvedValue([ticketRow({ status: 'RESOLVED' })]);

      const page = await service.listTickets(agent, {});

      expect(page.items[0].canManage).toBe(true);
      expect(page.items[0].availableTransitions).toEqual(['CLOSED']);
    });
  });

  describe('pagination', () => {
    it('orders deterministically by createdAt DESC, id DESC', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, {});

      const { orderBy } = prisma.ticket.findMany.mock.calls[0][0];
      expect(orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('over-fetches by one and reports hasMore without a second COUNT', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([
        ticketRow({ id: 't1' }),
        ticketRow({ id: 't2' }),
        ticketRow({ id: 't3' }),
      ]);

      const page = await service.listTickets(requester, { limit: 2 });

      expect(prisma.ticket.findMany.mock.calls[0][0].take).toBe(3);
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
    });

    it('reports hasMore=false when the page is not full', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([ticketRow({ id: 't1' })]);

      const page = await service.listTickets(requester, { limit: 2 });

      expect(page.hasMore).toBe(false);
    });

    it('caps an oversized limit instead of failing', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, { limit: 5000 });

      expect(prisma.ticket.findMany.mock.calls[0][0].take).toBe(MAX_TICKET_LIMIT + 1);
    });

    it('skips the cursor row so a page never repeats an item', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findMany.mockResolvedValue([]);

      await service.listTickets(requester, { cursor: 'ticket-1' });

      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.cursor).toEqual({ id: 'ticket-1' });
      expect(args.skip).toBe(1);
    });
  });

  describe('comments', () => {
    it('hides internal notes from a non-agent in the DATABASE predicate', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow());
      prisma.ticketComment.findMany.mockResolvedValue([]);

      await service.listComments(requester, 'ticket-1', {});

      const args = prisma.ticketComment.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ ticketId: 'ticket-1', isInternal: false });
    });

    it('shows internal notes to an agent', async () => {
      setContext(agent, tenantA);
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow());
      prisma.ticketComment.findMany.mockResolvedValue([]);

      await service.listComments(agent, 'ticket-1', {});

      const args = prisma.ticketComment.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ ticketId: 'ticket-1' });
    });

    it('refuses to let a requester author an internal note', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow());

      await expect(
        service.addComment(requester, 'ticket-1', { body: 'متن', isInternal: true }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a comment on a closed ticket', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(
        ticketRow({ status: 'CLOSED', resolvedAt: new Date(), closedAt: new Date() }),
      );

      await expect(service.addComment(requester, 'ticket-1', { body: 'متن' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s an invisible ticket rather than revealing that it exists', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(null);

      await expect(service.listComments(requester, 'ticket-x', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('lifecycle', () => {
    beforeEach(() => {
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.$transaction.mockImplementation(
        async (fn: (tx: Record<string, Record<string, jest.Mock>>) => unknown) =>
          fn({
          ticket: { update: jest.fn().mockResolvedValue(ticketRow({ status: 'RESOLVED' })) },
          ticketStatusHistory: { create: jest.fn() },
          ticketComment: { create: jest.fn(), findUniqueOrThrow: jest.fn() },
          ticketAttachment: { updateMany: jest.fn() },
        }),
      );
    });

    it('refuses a status change from a non-agent', async () => {
      setContext(requester, tenantA);
      permissions.userHasPermission.mockResolvedValue(false);

      await expect(
        service.changeStatus(requester, 'ticket-1', { status: 'RESOLVED' }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
    });

    it('refuses an illegal transition and names the legal set', async () => {
      setContext(agent, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'NEW' }));

      await expect(service.changeStatus(agent, 'ticket-1', { status: 'CLOSED' })).rejects.toThrow(
        /allowed/,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses any transition out of CLOSED — there is no reopen', async () => {
      setContext(agent, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(
        ticketRow({ status: 'CLOSED', resolvedAt: new Date(), closedAt: new Date() }),
      );

      await expect(
        service.changeStatus(agent, 'ticket-1', { status: 'IN_PROGRESS' }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('audits a status change and notifies the requester, never the actor', async () => {
      setContext(agent, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'IN_PROGRESS' }));

      await service.changeStatus(agent, 'ticket-1', { status: 'RESOLVED' });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ticket.status.change',
          resource: 'ticket',
          resourceId: 'ticket-1',
          userId: agent,
        }),
      );

      expect(notifications.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: requester, sourceType: 'ticket', sourceId: 'ticket-1' }),
      );
      expect(notifications.createForUser).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: agent }),
      );
    });

    it('never notifies the actor when the agent resolves their own ticket', async () => {
      setContext(agent, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(
        ticketRow({ status: 'IN_PROGRESS', requesterId: agent, requester: person(agent) }),
      );

      await service.changeStatus(agent, 'ticket-1', { status: 'RESOLVED' });

      expect(notifications.createForUser).not.toHaveBeenCalled();
    });
  });

  describe('audit boundary', () => {
    it('never audits a read', async () => {
      setContext(agent, tenantA);
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.ticket.findMany.mockResolvedValue([ticketRow()]);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow());
      prisma.ticketAttachment.findMany.mockResolvedValue([]);
      prisma.ticketStatusHistory.findMany.mockResolvedValue([]);
      prisma.ticketSatisfaction.findUnique.mockResolvedValue(null);
      prisma.ticketComment.findMany.mockResolvedValue([]);

      await service.listTickets(agent, {});
      await service.getTicket(agent, 'ticket-1');
      await service.listComments(agent, 'ticket-1', {});

      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('satisfaction', () => {
    it('refuses submission by anyone but the requester', async () => {
      setContext(agent, tenantA);
      permissions.userHasPermission.mockResolvedValue(true);
      prisma.ticket.findFirst.mockResolvedValue(
        ticketRow({ status: 'RESOLVED', resolvedAt: new Date() }),
      );

      await expect(
        service.submitSatisfaction(agent, 'ticket-1', { rating: 5 }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.ticketSatisfaction.create).not.toHaveBeenCalled();
    });

    it('refuses submission before the ticket is resolved', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'IN_PROGRESS' }));

      await expect(
        service.submitSatisfaction(requester, 'ticket-1', { rating: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts one submission on a resolved ticket', async () => {
      setContext(requester, tenantA);
      prisma.ticket.findFirst.mockResolvedValue(
        ticketRow({ status: 'RESOLVED', resolvedAt: new Date() }),
      );
      prisma.ticketSatisfaction.create.mockResolvedValue({
        id: 's1',
        rating: 4,
        comment: null,
        createdAt: new Date(),
      });

      const result = await service.submitSatisfaction(requester, 'ticket-1', { rating: 4 });

      expect(result.rating).toBe(4);
      expect(prisma.ticketSatisfaction.create.mock.calls[0][0].data.submittedById).toBe(requester);
    });
  });
});



