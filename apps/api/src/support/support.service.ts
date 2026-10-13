import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { AuditService } from '../common/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { Permissions } from '../auth/rbac/constants/permissions';
import { TicketCommentQueryDto, TicketQueryDto } from './dto/ticket-query.dto';
import {
  ChangeTicketStatusDto,
  CreateTicketCommentDto,
  CreateTicketDto,
  CreateTicketSatisfactionDto,
  UpdateTicketDto,
} from './dto/ticket.dto';
import { generateTrackingNumber, normalizeTrackingNumber } from './tracking-number.util';
import { allowedTransitions, canTransition } from './ticket-status.util';
import { AutomationService } from '../integrations/automation.service';

/**
 * Phase 49G: Core Support / Ticketing domain service.
 *
 * Authorization has exactly two edges and no third:
 *
 *  - REQUESTER — the person who filed the ticket. Always sees their own ticket and
 *    its non-internal comments, and may respond to it.
 *  - AGENT — a caller holding `admin.support.manage`. Sees and administers every
 *    ticket inside their own tenant, and nothing outside it.
 *
 * Both permissions (`support.tickets`, `admin.support.manage`) already existed in
 * the RBAC catalogue before this phase, so Phase 49G adds NO new permission.
 *
 * Identity NEVER comes from a body field, query parameter or path segment: it is
 * resolved from RequestContextService, exactly as DirectoryService (49D-1),
 * NotificationService (49E) and MessagingService (49F) do. Tenant is likewise a
 * server-derived snapshot and is never projected to the client.
 *
 * Reads are never audited. Only privileged mutations (assignment, status change,
 * admin category/priority edits) are, matching the existing AuditService usage in
 * RoleService.
 */

export const DEFAULT_TICKET_LIMIT = 20;
export const MAX_TICKET_LIMIT = 100;

/** Retries on a tracking-number collision before giving up. */
const TRACKING_NUMBER_ATTEMPTS = 5;

/**
 * Allowlisted person projection, identical in spirit to MESSAGING's
 * MEMBER_USER_SELECT: never passwordHash, tokenVersion, email verification state
 * or tenantId. A denylist would leak every future column.
 */
const TICKET_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  jobTitle: true,
} satisfies Prisma.UserSelect;

const ATTACHMENT_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  size: true,
  commentId: true,
} satisfies Prisma.TicketAttachmentSelect;

/** `tenantId` is intentionally absent: it is internal isolation metadata. */
const TICKET_SELECT = {
  id: true,
  trackingNumber: true,
  type: true,
  priority: true,
  status: true,
  subject: true,
  body: true,
  category: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  requesterId: true,
  assigneeId: true,
  requester: { select: TICKET_USER_SELECT },
  assignee: { select: TICKET_USER_SELECT },
} satisfies Prisma.TicketSelect;

const COMMENT_SELECT = {
  id: true,
  ticketId: true,
  authorId: true,
  body: true,
  isInternal: true,
  createdAt: true,
  author: { select: TICKET_USER_SELECT },
  attachments: { select: ATTACHMENT_SELECT },
} satisfies Prisma.TicketCommentSelect;

const HISTORY_SELECT = {
  id: true,
  fromStatus: true,
  toStatus: true,
  note: true,
  createdAt: true,
  changedById: true,
  changedBy: { select: TICKET_USER_SELECT },
} satisfies Prisma.TicketStatusHistorySelect;

const SATISFACTION_SELECT = {
  id: true,
  rating: true,
  comment: true,
  createdAt: true,
} satisfies Prisma.TicketSatisfactionSelect;

export interface TicketUserDto {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
}

export interface TicketAttachmentRefDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  commentId: string | null;
}

export interface TicketDto {
  id: string;
  trackingNumber: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  subject: string;
  body: string;
  category: string | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  requester: TicketUserDto;
  assignee: TicketUserDto | null;
  /** True when the caller may administer this ticket (agent-only actions). */
  canManage: boolean;
  /** Transitions the caller can actually perform right now. */
  availableTransitions: TicketStatus[];
}

export interface TicketCommentDto {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  createdAt: Date;
  author: TicketUserDto;
  attachments: TicketAttachmentRefDto[];
}

export interface TicketStatusHistoryDto {
  id: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  note: string | null;
  createdAt: Date;
  changedBy: TicketUserDto;
}

export interface TicketSatisfactionDto {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
}

export interface TicketDetailDto extends TicketDto {
  attachments: TicketAttachmentRefDto[];
  statusHistory: TicketStatusHistoryDto[];
  satisfaction: TicketSatisfactionDto | null;
}

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

interface Scope {
  userId: string;
  tenantId: string | null;
  isAgent: boolean;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly notifications: NotificationService,
    // Phase 49L. @Optional() for the same reason `audit` is: every existing
    // SupportService spec builds a trimmed test module, and making automation
    // mandatory would break all of them while proving nothing. A missing emitter is
    // a no-op, which is also exactly what an unconfigured integration does — so the
    // absent-dependency behaviour and the absent-configuration behaviour agree.
    @Optional() private readonly automation?: AutomationService,
    // Optional for the same reason RoleService makes it optional: a trimmed test
    // module must be able to exercise the domain rules without wiring the audit
    // pipeline, and a missing audit sink must never break business logic.
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Resolves the caller's own scope and asserts it matches the subject the
   * controller passed in. A mismatch is refused rather than trusting the argument,
   * so no code path can act as another user.
   *
   * `isAgent` is resolved from the RBAC permission service — never from a role name
   * string, a header, or anything the client controls.
   */
  private async scope(userId: string): Promise<Scope> {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Support context is required');
    }

    const isAgent = await this.permissions.userHasPermission(
      userId,
      Permissions.ADMIN_SUPPORT_MANAGE,
    );

    return { userId, tenantId: context.tenantId ?? null, isAgent };
  }

  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? DEFAULT_TICKET_LIMIT, 1), MAX_TICKET_LIMIT);
  }

  /**
   * The single visibility predicate, used by every read.
   *
   * An agent sees their whole tenant; everyone else sees only tickets they filed.
   * Tenant is always part of the predicate, including when it is null — dropping a
   * null tenant would silently widen the query to every tenant-less ticket in the
   * database.
   */
  private visibility(scope: Scope): Prisma.TicketWhereInput {
    if (scope.isAgent) {
      return { tenantId: scope.tenantId };
    }

    return { tenantId: scope.tenantId, requesterId: scope.userId };
  }

  /**
   * Loads one ticket the caller is allowed to see, or throws 404.
   *
   * A ticket in another tenant, or someone else's ticket seen by a non-agent, is
   * indistinguishable from a non-existent one — both 404 — which is why ticket ids
   * cannot be probed.
   */
  private async requireVisible(scope: Scope, id: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, ...this.visibility(scope) },
      select: { ...TICKET_SELECT, tenantId: true },
    });

    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    return ticket;
  }

  /** Agent-only gate for the administrative routes. */
  private requireAgent(scope: Scope): void {
    if (!scope.isAgent) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  private projectUser(user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    jobTitle: string | null;
  }): TicketUserDto {
    return user;
  }

  private projectTicket(
    scope: Scope,
    row: Prisma.TicketGetPayload<{ select: typeof TICKET_SELECT }>,
  ): TicketDto {
    return {
      id: row.id,
      trackingNumber: row.trackingNumber,
      type: row.type,
      priority: row.priority,
      status: row.status,
      subject: row.subject,
      body: row.body,
      category: row.category,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      requester: this.projectUser(row.requester),
      assignee: row.assignee ? this.projectUser(row.assignee) : null,
      canManage: scope.isAgent,
      // A requester is shown no transitions at all: they cannot move the
      // lifecycle, so offering them would misrepresent what the API allows.
      availableTransitions: scope.isAgent ? allowedTransitions(row.status) : [],
    };
  }

  /**
   * Cursor page of tickets the caller may see, newest first.
   *
   * `scope=all` is honoured only for an agent; for anyone else it collapses to
   * their own tickets, because the visibility predicate is applied unconditionally
   * and the requester filter is additive. A non-agent therefore cannot widen their
   * result set by choosing a scope.
   */
  async listTickets(userId: string, query: TicketQueryDto): Promise<PageResult<TicketDto>> {
    const scope = await this.scope(userId);
    const limit = this.clampLimit(query.limit);

    const where: Prisma.TicketWhereInput = {
      ...this.visibility(scope),
      ...(query.scope === 'mine' ? { requesterId: scope.userId } : {}),
      ...(query.scope === 'assigned' ? { assigneeId: scope.userId } : {}),
      ...(query.status ? { status: query.status as TicketStatus } : {}),
      ...(query.type ? { type: query.type as TicketType } : {}),
      ...(query.priority ? { priority: query.priority as TicketPriority } : {}),
    };

    // Over-fetch by one to decide `hasMore` without a second COUNT.
    const rows = await this.prisma.ticket.findMany({
      where,
      select: TICKET_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { items: rows.map((row) => this.projectTicket(scope, row)), hasMore };
  }

  /** One ticket, with its attachments, lifecycle trail and satisfaction record. */
  async getTicket(userId: string, id: string): Promise<TicketDetailDto> {
    const scope = await this.scope(userId);
    const ticket = await this.requireVisible(scope, id);

    const [attachments, statusHistory, satisfaction] = await Promise.all([
      this.prisma.ticketAttachment.findMany({
        // Only bound attachments are listed. A pending upload is inert until the
        // comment (or the ticket create) that claims it commits.
        where: { ticketId: id, NOT: { commentId: null } },
        select: ATTACHMENT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.ticketStatusHistory.findMany({
        where: { ticketId: id },
        select: HISTORY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.ticketSatisfaction.findUnique({
        where: { ticketId: id },
        select: SATISFACTION_SELECT,
      }),
    ]);

    return {
      ...this.projectTicket(scope, ticket),
      attachments,
      statusHistory: statusHistory.map((row) => ({
        id: row.id,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        note: row.note,
        createdAt: row.createdAt,
        changedBy: this.projectUser(row.changedBy),
      })),
      satisfaction: satisfaction ?? null,
    };
  }

  /**
   * Tracking-number lookup. Tenant-scoped and visibility-scoped exactly like the id
   * lookup, so knowing (or guessing) a number is not sufficient to read a ticket —
   * a foreign tenant's number is a 404.
   */
  async getTicketByTrackingNumber(userId: string, raw: string): Promise<TicketDetailDto> {
    const scope = await this.scope(userId);

    const trackingNumber = normalizeTrackingNumber(raw);
    if (!trackingNumber) {
      // Malformed input is a 404, not a 400: a distinct error would confirm which
      // shapes are real tracking numbers.
      throw new NotFoundException('Ticket not found');
    }

    const found = await this.prisma.ticket.findFirst({
      where: { trackingNumber, ...this.visibility(scope) },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException('Ticket not found');
    }

    return this.getTicket(userId, found.id);
  }

  /**
   * Cursor page of comments on a ticket the caller may see.
   *
   * A non-agent never receives internal notes: the predicate excludes them, so the
   * filtering happens in the database rather than in a projection that could be
   * bypassed by a future code path.
   */
  async listComments(
    userId: string,
    ticketId: string,
    query: TicketCommentQueryDto,
  ): Promise<PageResult<TicketCommentDto>> {
    const scope = await this.scope(userId);
    await this.requireVisible(scope, ticketId);

    const limit = this.clampLimit(query.limit);

    const rows = await this.prisma.ticketComment.findMany({
      where: { ticketId, ...(scope.isAgent ? {} : { isInternal: false }) },
      select: COMMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return {
      items: rows.map((row) => ({
        id: row.id,
        ticketId: row.ticketId,
        body: row.body,
        isInternal: row.isInternal,
        createdAt: row.createdAt,
        author: this.projectUser(row.author),
        attachments: row.attachments,
      })),
      hasMore,
    };
  }

  /**
   * Files a new ticket for the authenticated caller.
   *
   * The requester, tenant and tracking number are all server-derived. A tracking
   * number collision is resolved by retrying with fresh entropy rather than by
   * locking or by a sequence table — the UNIQUE index is the arbiter, so two
   * concurrent creates can never share a number.
   *
   * The creation history row (`null → NEW`) is written in the SAME transaction as
   * the ticket, so a ticket can never exist without a lifecycle trail.
   */
  async createTicket(userId: string, dto: CreateTicketDto): Promise<TicketDto> {
    const scope = await this.scope(userId);

    for (let attempt = 0; attempt < TRACKING_NUMBER_ATTEMPTS; attempt++) {
      const trackingNumber = generateTrackingNumber();

      try {
        const ticket = await this.prisma.$transaction(async (tx) => {
          const created = await tx.ticket.create({
            data: {
              tenantId: scope.tenantId,
              trackingNumber,
              requesterId: scope.userId,
              type: dto.type as TicketType,
              priority: (dto.priority ?? 'NORMAL') as TicketPriority,
              status: 'NEW',
              subject: dto.subject,
              body: dto.body,
            },
            select: TICKET_SELECT,
          });

          await tx.ticketStatusHistory.create({
            data: {
              ticketId: created.id,
              fromStatus: null,
              toStatus: 'NEW',
              changedById: scope.userId,
            },
          });

          return created;
        });

        // AFTER the transaction has committed, never inside it (§44). Holding a
        // Postgres transaction open across an outbound HTTP call would put a network
        // round-trip inside a lock window — the classic way an optional integration
        // takes down a database. Emitting here also means the event describes a ticket
        // that definitely exists.
        //
        // The event id is DERIVED from the ticket (`ticket.created:<id>`) rather than
        // random, so a client that retries the create and hits an already-created
        // ticket cannot produce a second delivery for the same ticket.
        //
        // PAYLOAD IS MINIMISED (§11): four ids and enums. Not the subject, not the
        // body, not the requester's profile — the consumer calls the authorized ticket
        // API if it needs more, with its own credential and its own authorization.
        await this.automation?.emit({
          eventType: 'ticket.created',
          source: 'support',
          eventId: `ticket.created:${ticket.id}`,
          payload: {
            ticketId: ticket.id,
            trackingNumber: ticket.trackingNumber,
            type: ticket.type,
            priority: ticket.priority,
            status: ticket.status,
          },
          actor: { type: 'user', id: scope.userId },
        });

        return this.projectTicket(scope, ticket);
      } catch (err) {
        if (this.isTrackingNumberCollision(err)) {
          continue;
        }
        throw err;
      }
    }

    // Reaching here means N independent 10-character draws all collided, which is
    // effectively impossible — so it is reported rather than retried forever.
    throw new BadRequestException('Could not allocate a tracking number, please retry');
  }

  /** True for a unique-violation specifically on the tracking number index. */
  private isTrackingNumberCollision(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }

    const target = (err.meta as { target?: string[] | string } | undefined)?.target;
    const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');

    return fields.includes('trackingNumber');
  }

  /**
   * Claims pending attachments and binds them to a ticket (and optionally a
   * comment).
   *
   * The predicate is the ownership pair: the attachment must be unbound, uploaded by
   * this caller, and already scoped to THIS ticket. An id belonging to someone else,
   * to another ticket, or already bound therefore cannot be replayed — and the count
   * check means a partially-valid batch fails as a whole rather than silently
   * dropping ids.
   */
  private async bindAttachments(
    tx: Prisma.TransactionClient,
    input: {
      ticketId: string;
      commentId: string | null;
      uploaderId: string;
      attachmentIds?: string[];
    },
  ): Promise<void> {
    const ids = input.attachmentIds ?? [];
    if (ids.length === 0) return;

    const unique = [...new Set(ids)];

    const result = await tx.ticketAttachment.updateMany({
      where: {
        id: { in: unique },
        ticketId: input.ticketId,
        uploadedBy: input.uploaderId,
        commentId: null,
      },
      data: { commentId: input.commentId },
    });

    if (result.count !== unique.length) {
      throw new BadRequestException('One or more attachments are not available');
    }
  }

  /**
   * Administrative patch: assignment, priority, category. Agent-only.
   *
   * Every field here is a privileged mutation, so the whole operation is audited
   * with a before/after snapshot. A no-op patch (nothing actually changed) writes
   * neither an audit row nor a notification.
   */
  async updateTicket(userId: string, id: string, dto: UpdateTicketDto): Promise<TicketDto> {
    const scope = await this.scope(userId);
    this.requireAgent(scope);

    const before = await this.requireVisible(scope, id);

    // A closed ticket is immutable: allowing an edit after closure would make the
    // terminal state meaningless.
    if (before.status === 'CLOSED') {
      throw new BadRequestException('A closed ticket cannot be modified');
    }

    if (dto.assigneeId !== undefined) {
      await this.assertAssignable(scope, before.requesterId, dto.assigneeId);
    }

    const data: Prisma.TicketUpdateInput = {
      ...(dto.assigneeId !== undefined ? { assignee: { connect: { id: dto.assigneeId } } } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority as TicketPriority } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
    };

    if (Object.keys(data).length === 0) {
      return this.projectTicket(scope, before);
    }

    const updated = await this.prisma.ticket.update({
      where: { id },
      select: TICKET_SELECT,
      data,
    });

    const changedFields = Object.keys(dto).filter(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );

    await this.emitAudit({
      action: 'ticket.update',
      actorId: scope.userId,
      resourceId: id,
      changedFields,
      oldValue: {
        assigneeId: before.assigneeId,
        priority: before.priority,
        category: before.category,
      },
      newValue: {
        assigneeId: updated.assigneeId,
        priority: updated.priority,
        category: updated.category,
      },
    });

    // Only a genuine change of assignee notifies, and never the actor themselves.
    if (dto.assigneeId !== undefined && dto.assigneeId !== before.assigneeId) {
      await this.notifyUser(dto.assigneeId, scope.userId, {
        title: 'یک تیکت به شما اختصاص یافت',
        body: `تیکت ${updated.trackingNumber} به شما اختصاص داده شد.`,
        sourceId: id,
      });
    }

    // Phase 49L. `changedFields` travels in the payload so a workflow can branch on
    // WHAT changed without receiving before/after values — the audit trail already
    // holds those, behind `admin.audit.read`.
    //
    // The event id includes the UPDATE COUNT rather than only the ticket id: two
    // legitimately different updates to one ticket are two events, so a fixed
    // `ticket.updated:<id>` would make the second one look like a duplicate and drop
    // it. `updatedAt` is the natural discriminator the row already carries.
    await this.automation?.emit({
      eventType: 'ticket.updated',
      source: 'support',
      eventId: `ticket.updated:${id}:${updated.updatedAt.getTime()}`,
      payload: {
        ticketId: id,
        status: updated.status,
        priority: updated.priority,
        changedFields,
      },
      actor: { type: 'user', id: scope.userId },
    });

    return this.projectTicket(scope, updated);
  }

  /**
   * An assignee must be a real user inside the caller's own tenant, and must not be
   * the requester. Resolving the candidate through the tenant predicate means an
   * agent cannot assign a ticket to someone in another tenant — which would leak
   * that user's existence and hand them a cross-tenant notification.
   */
  private async assertAssignable(
    scope: Scope,
    requesterId: string,
    assigneeId: string,
  ): Promise<void> {
    if (assigneeId === requesterId) {
      throw new BadRequestException('The requester cannot be the assignee');
    }

    const candidate = await this.prisma.user.findFirst({
      where: { id: assigneeId, tenantId: scope.tenantId },
      select: { id: true },
    });

    if (!candidate) {
      throw new BadRequestException('Assignee not found');
    }
  }

  /**
   * Moves a ticket through the lifecycle. Agent-only.
   *
   * The state machine in ticket-status.util.ts is the only authority on validity, so
   * an illegal jump (or a reopen from CLOSED, which has no successors) is refused
   * with the legal set named in the message rather than silently ignored.
   *
   * The ticket update and its history row commit in ONE transaction, so the current
   * status and the trail can never disagree.
   */
  async changeStatus(
    userId: string,
    id: string,
    dto: ChangeTicketStatusDto,
  ): Promise<TicketDto> {
    const scope = await this.scope(userId);
    this.requireAgent(scope);

    const before = await this.requireVisible(scope, id);
    const next = dto.status as TicketStatus;

    if (!canTransition(before.status, next)) {
      const allowed = allowedTransitions(before.status);
      throw new BadRequestException(
        allowed.length === 0
          ? `A ${before.status} ticket cannot change status`
          : `Cannot move from ${before.status} to ${next}; allowed: ${allowed.join(', ')}`,
      );
    }

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ticket.update({
        where: { id },
        select: TICKET_SELECT,
        data: {
          status: next,
          // Set once, on first arrival, and never cleared — mirrors the
          // Ticket_resolved_requires_status / _closed_requires_status CHECKs.
          ...(next === 'RESOLVED' && !before.resolvedAt ? { resolvedAt: now } : {}),
          ...(next === 'CLOSED'
            ? { closedAt: now, ...(before.resolvedAt ? {} : { resolvedAt: now }) }
            : {}),
        },
      });

      await tx.ticketStatusHistory.create({
        data: {
          ticketId: id,
          fromStatus: before.status,
          toStatus: next,
          changedById: scope.userId,
          note: dto.note ?? null,
        },
      });

      return row;
    });

    await this.emitAudit({
      action: 'ticket.status.change',
      actorId: scope.userId,
      resourceId: id,
      changedFields: ['status'],
      oldValue: { status: before.status },
      newValue: { status: next },
      reason: dto.note ?? undefined,
    });

    // The requester is told what happened to their ticket; the acting agent is not
    // notified about their own action.
    await this.notifyUser(before.requesterId, scope.userId, {
      title:
        next === 'RESOLVED'
          ? 'تیکت شما حل شد'
          : next === 'CLOSED'
            ? 'تیکت شما بسته شد'
            : 'وضعیت تیکت شما تغییر کرد',
      body: `وضعیت تیکت ${updated.trackingNumber} به ${next} تغییر کرد.`,
      sourceId: id,
    });

    // Phase 49L. ONLY `RESOLVED` emits `ticket.resolved`, and every other transition
    // emits nothing at all. That is a §6 decision, not an oversight: `ticket.resolved`
    // is the state change an external workflow has a real reason to act on (satisfaction
    // survey, SLA close-out, downstream notification), while emitting an event for
    // NEW→OPEN→PENDING churn would be traffic no consumer wants and a fan-out per
    // internal status tweak.
    //
    // CLOSED is deliberately silent too: closure follows resolution, and a workflow that
    // needs both would fire twice for one logical outcome.
    if (next === 'RESOLVED') {
      await this.automation?.emit({
        eventType: 'ticket.resolved',
        source: 'support',
        // Stable per ticket: a ticket reaching RESOLVED twice (reopened, then resolved
        // again) is deliberately ONE event. The alternative — keying on the timestamp —
        // would let a reopen/resolve loop re-trigger a satisfaction survey repeatedly.
        eventId: `ticket.resolved:${id}`,
        payload: {
          ticketId: id,
          trackingNumber: updated.trackingNumber,
          priority: updated.priority,
          status: updated.status,
        },
        actor: { type: 'user', id: scope.userId },
      });
    }

    return this.projectTicket(scope, updated);
  }

  /**
   * Adds a comment to a ticket the caller may see.
   *
   * `isInternal` is agent-only and is REFUSED (not downgraded) for a requester, so
   * an internal note can never be authored by the wrong party. Attachments are
   * claimed in the same transaction as the comment, so a comment is never persisted
   * with a half-bound file set.
   */
  async addComment(
    userId: string,
    ticketId: string,
    dto: CreateTicketCommentDto,
  ): Promise<TicketCommentDto> {
    const scope = await this.scope(userId);
    const ticket = await this.requireVisible(scope, ticketId);

    if (ticket.status === 'CLOSED') {
      throw new BadRequestException('A closed ticket cannot receive comments');
    }

    if (dto.isInternal && !scope.isAgent) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticketComment.create({
        data: {
          ticketId,
          authorId: scope.userId,
          body: dto.body,
          isInternal: Boolean(dto.isInternal),
        },
        select: COMMENT_SELECT,
      });

      await this.bindAttachments(tx, {
        ticketId,
        commentId: created.id,
        uploaderId: scope.userId,
        attachmentIds: dto.attachmentIds,
      });

      // Re-read so the returned comment carries the attachments that were just
      // bound rather than the empty set captured before the update.
      return tx.ticketComment.findUniqueOrThrow({
        where: { id: created.id },
        select: COMMENT_SELECT,
      });
    });

    // An internal note is invisible to the requester, so it never notifies them.
    if (!comment.isInternal) {
      await this.notifyCommentAudience(ticket, scope.userId);
    }

    return {
      id: comment.id,
      ticketId: comment.ticketId,
      body: comment.body,
      isInternal: comment.isInternal,
      createdAt: comment.createdAt,
      author: this.projectUser(comment.author),
      attachments: comment.attachments,
    };
  }

  /**
   * Who hears about a public comment: the requester and the assignee, minus the
   * author. The actor is never notified about their own comment.
   */
  private async notifyCommentAudience(
    ticket: { id: string; trackingNumber: string; requesterId: string; assigneeId: string | null },
    actorId: string,
  ): Promise<void> {
    const audience = [...new Set([ticket.requesterId, ticket.assigneeId].filter(Boolean))].filter(
      (id) => id !== actorId,
    ) as string[];

    for (const recipient of audience) {
      await this.notifyUser(recipient, actorId, {
        title: 'پاسخ جدید روی تیکت',
        body: `پاسخ جدیدی روی تیکت ${ticket.trackingNumber} ثبت شد.`,
        sourceId: ticket.id,
      });
    }
  }

  /**
   * Requester satisfaction, at most once, only on a RESOLVED or CLOSED ticket.
   *
   * Only the requester may submit: an agent rating their own resolution would be
   * meaningless. The UNIQUE constraint on `ticketId` is the real arbiter of
   * once-only, so a concurrent double submit fails at the database rather than
   * creating two records.
   */
  async submitSatisfaction(
    userId: string,
    ticketId: string,
    dto: CreateTicketSatisfactionDto,
  ): Promise<TicketSatisfactionDto> {
    const scope = await this.scope(userId);
    const ticket = await this.requireVisible(scope, ticketId);

    if (ticket.requesterId !== scope.userId) {
      throw new ForbiddenException('Only the requester can submit satisfaction');
    }

    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') {
      throw new BadRequestException('Satisfaction can only be submitted for a resolved ticket');
    }

    try {
      return await this.prisma.ticketSatisfaction.create({
        data: {
          ticketId,
          submittedById: scope.userId,
          rating: dto.rating,
          comment: dto.comment ?? null,
        },
        select: SATISFACTION_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('Satisfaction has already been submitted for this ticket');
      }
      throw err;
    }
  }

  /**
   * Notifies one recipient through the existing 49E Notification Center.
   *
   * Two rules are enforced here rather than at each call site, so no future caller
   * can forget them:
   *  - the ACTOR is never notified about their own action; and
   *  - a notification failure never fails the business operation that caused it —
   *    the ticket change has already committed, and a lost notification is
   *    recoverable by re-reading the ticket.
   *
   * `sourceType`/`sourceId` are the plain, non-FK back-reference the Notification
   * model already documents, so the notification survives ticket deletion.
   */
  private async notifyUser(
    recipientId: string | null | undefined,
    actorId: string,
    payload: { title: string; body: string; sourceId: string },
  ): Promise<void> {
    if (!recipientId || recipientId === actorId) return;

    try {
      await this.notifications.createForUser({
        userId: recipientId,
        type: 'INFORMATION',
        title: payload.title,
        body: payload.body,
        sourceType: 'ticket',
        sourceId: payload.sourceId,
      });
    } catch {
      // Swallowed deliberately: see the method comment. Nothing is logged here
      // that could contain ticket content.
    }
  }

  /**
   * Audits a privileged mutation. Same shape and same optional-service tolerance as
   * RoleService#emitAudit.
   *
   * READS ARE NEVER AUDITED — only assignment, status change and admin
   * category/priority edits reach this method.
   */
  private async emitAudit(opts: {
    action: string;
    actorId: string;
    resourceId: string;
    changedFields?: string[];
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
  }): Promise<void> {
    if (!this.audit) return;

    const ctx = RequestContextService.get();

    await this.audit.log({
      requestId: ctx?.requestId ?? `support-${Date.now()}`,
      correlationId: ctx?.correlationId,
      userId: opts.actorId,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      action: opts.action,
      resource: 'ticket',
      resourceId: opts.resourceId,
      changedFields: opts.changedFields,
      oldValue: opts.oldValue,
      newValue: opts.newValue,
      success: true,
      reason: opts.reason ?? null,
      durationMs: ctx ? Date.now() - ctx.startTime : undefined,
    });
  }

  /**
   * Resolves the caller's scope and asserts they can see the ticket. Exposed for
   * SupportAttachmentService, so the upload/download paths reuse EXACTLY the same
   * visibility rule as the read routes instead of reimplementing it.
   */
  async assertTicketVisible(
    userId: string,
    ticketId: string,
  ): Promise<{ ticketId: string; isAgent: boolean }> {
    const scope = await this.scope(userId);
    const ticket = await this.requireVisible(scope, ticketId);

    return { ticketId: ticket.id, isAgent: scope.isAgent };
  }
}







