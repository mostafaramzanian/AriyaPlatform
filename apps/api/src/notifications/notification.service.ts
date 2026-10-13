import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType, Prisma } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { NotificationQueryDto } from './dto/notification-query.dto';

/**
 * Phase 49E: persistent in-app Notification Center (COL-008, COL-009, COL-016).
 *
 * Scope is USER-SCOPED + TENANT CONTEXT. Every read and write is keyed on the
 * authenticated recipient resolved from RequestContextService (populated by the
 * global TenantContextInterceptor) — never from a query parameter, body field or
 * path segment. Same pattern as DirectoryService (Phase 49D-1).
 *
 * Notifications are NOT created by clients. `createForUser` is the single
 * server-side creation path; no HTTP route reaches it.
 *
 * This service does not publish, consume or reshape RabbitMQ events.
 * NotificationPublisher remains untouched event infrastructure.
 */

export const DEFAULT_NOTIFICATION_LIMIT = 20;
export const MAX_NOTIFICATION_LIMIT = 100;
export const MAX_TITLE_LENGTH = 160;
export const MAX_BODY_LENGTH = 1000;
export const MAX_SOURCE_LENGTH = 64;

/**
 * Allowlisted projection. Never contains `userId` or `tenantId`: the recipient is
 * always the caller, so echoing the id adds nothing, and the tenant is internal
 * isolation metadata that must not reach the browser.
 */
const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  readAt: true,
  sourceType: true,
  sourceId: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: Date | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
}

export interface NotificationListResult {
  items: NotificationDto[];
  hasMore: boolean;
}

export interface UnreadCountResult {
  count: number;
}

export interface MarkReadResult {
  id: string;
  readAt: Date;
}

export interface MarkAllReadResult {
  updated: number;
}

/** Server-side creation contract. Not reachable from any HTTP route. */
export interface CreateNotificationInput {
  userId: string;
  /** Optional assertion: when provided it must equal the recipient's tenant. */
  tenantId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  sourceType?: string | null;
  sourceId?: string | null;
}

@Injectable()
export class NotificationService {
  constructor(private prisma: PrismaService) {}

  /**
   * Resolves the caller's own scope. The identity must come from the request
   * context that the interceptor populated from the database, and it must match
   * the subject the controller passed in — so a mismatch is refused rather than
   * silently trusting the argument.
   */
  private scope(userId: string): { userId: string; tenantId: string | null } {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Notification context is required');
    }

    return { userId, tenantId: context.tenantId ?? null };
  }

  /**
   * Base predicate for every read/update. `userId` enforces ownership and
   * `tenantId` enforces tenant consistency, so a notification created in another
   * tenant context is invisible even to its own recipient.
   */
  private ownership(userId: string): Prisma.NotificationWhereInput {
    const { userId: id, tenantId } = this.scope(userId);
    return { userId: id, tenantId };
  }

  async listNotifications(
    userId: string,
    query: NotificationQueryDto,
  ): Promise<NotificationListResult> {
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_NOTIFICATION_LIMIT, 1),
      MAX_NOTIFICATION_LIMIT,
    );

    const where: Prisma.NotificationWhereInput = this.ownership(userId);

    if (query.state === 'unread') where.readAt = null;
    if (query.state === 'read') where.readAt = { not: null };

    // Over-fetch by one to decide `hasMore` without a second COUNT query. The
    // ordering is deterministic (id breaks ties) so the cursor is stable.
    const rows = await this.prisma.notification.findMany({
      where,
      select: NOTIFICATION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { items: rows, hasMore };
  }

  /**
   * Bounded count query — never materialises notification rows. Served by
   * Notification_userId_readAt_idx.
   */
  async getUnreadCount(userId: string): Promise<UnreadCountResult> {
    const count = await this.prisma.notification.count({
      where: { ...this.ownership(userId), readAt: null },
    });

    return { count };
  }

  /**
   * Idempotent: an already-read notification keeps its original `readAt` and the
   * call still succeeds. A foreign or unknown id is indistinguishable — both are
   * 404 — so the endpoint cannot be used to probe other users' notifications.
   */
  async markRead(userId: string, id: string): Promise<MarkReadResult> {
    const where = { ...this.ownership(userId), id };

    const existing = await this.prisma.notification.findFirst({
      where,
      select: { id: true, readAt: true },
    });

    if (!existing) {
      throw new NotFoundException('Notification not found');
    }

    if (existing.readAt) {
      return { id: existing.id, readAt: existing.readAt };
    }

    // updateMany (not update) so the ownership predicate is part of the UPDATE
    // statement itself; `update` would only accept the primary key.
    const readAt = new Date();
    await this.prisma.notification.updateMany({ where, data: { readAt } });

    return { id: existing.id, readAt };
  }

  /**
   * Marks every unread notification of the CALLER as read. Scoped by the same
   * ownership predicate, so it can never touch another user or tenant. Repeating
   * it is safe: the second call matches nothing and reports 0.
   */
  async markAllRead(userId: string): Promise<MarkAllReadResult> {
    const result = await this.prisma.notification.updateMany({
      where: { ...this.ownership(userId), readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: result.count };
  }

  /**
   * The single server-side creation path (Phase 49E §12/§31).
   *
   * Callable only from approved Core application code. It validates that the
   * recipient exists, snapshots the recipient's tenant, and bounds/validates the
   * content. `tenantId`, when supplied by the caller, is treated as an assertion
   * that must match the recipient — never as a way to place a notification into
   * another tenant.
   */
  async createForUser(input: CreateNotificationInput): Promise<NotificationDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, tenantId: true },
    });

    if (!user) {
      throw new NotFoundException('Notification recipient not found');
    }

    if (input.tenantId !== undefined && (input.tenantId ?? null) !== user.tenantId) {
      throw new ForbiddenException('Notification tenant does not match the recipient');
    }

    return this.prisma.notification.create({
      data: {
        userId: user.id,
        // Always the recipient's own tenant — never the caller-supplied value.
        tenantId: user.tenantId,
        type: input.type,
        title: this.assertPlainText(input.title, 'title', MAX_TITLE_LENGTH),
        body: this.assertPlainText(input.body, 'body', MAX_BODY_LENGTH),
        sourceType: this.assertSourceRef(input.sourceType, 'sourceType'),
        sourceId: this.assertSourceRef(input.sourceId, 'sourceId'),
      },
      select: NOTIFICATION_SELECT,
    });
  }

  /**
   * Notification content is plain text. Markup is refused outright rather than
   * escaped, so nothing that could ever be interpreted as HTML is persisted —
   * the stored value stays human-readable and the UI never needs to unescape it
   * (and never uses dangerouslySetInnerHTML).
   */
  private assertPlainText(value: string, field: string, max: number): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`Notification ${field} is required`);
    }

    const trimmed = value.trim();

    if (trimmed.length > max) {
      throw new BadRequestException(`Notification ${field} exceeds ${max} characters`);
    }

    if (/[<>]/.test(trimmed)) {
      throw new BadRequestException(`Notification ${field} must be plain text`);
    }

    return trimmed;
  }

  /**
   * Source references are opaque identifiers, so the character set is closed. A
   * blank value normalises to null rather than an empty string.
   */
  private assertSourceRef(value: string | null | undefined, field: string): string | null {
    if (value === undefined || value === null) return null;

    const trimmed = String(value).trim();
    if (trimmed.length === 0) return null;

    if (trimmed.length > MAX_SOURCE_LENGTH) {
      throw new BadRequestException(`Notification ${field} exceeds ${MAX_SOURCE_LENGTH} characters`);
    }

    if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
      throw new BadRequestException(`Notification ${field} contains unsupported characters`);
    }

    return trimmed;
  }
}
