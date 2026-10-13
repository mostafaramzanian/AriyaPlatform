import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationType, Prisma } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { NotificationService } from '../notifications/notification.service';
import { CONNECTION_REGISTRY, ConnectionRegistryPort } from './connection-registry';
import { ConversationQueryDto, MessageQueryDto } from './dto/conversation-query.dto';
import {
  CreateConversationDto,
  MAX_GROUP_PARTICIPANTS,
  SendMessageDto,
} from './dto/conversation.dto';

/**
 * Phase 49F: Internal Messaging domain service.
 *
 * Postgres is authoritative. Every write commits BEFORE anything is published to
 * a socket (`persist-then-emit`), so a fan-out that fails, or a client that was
 * offline, degrades to a plain HTTP re-read — never to a lost message.
 *
 * Authorization is membership, and only membership: every read and write starts
 * from a `ConversationMember` row for the authenticated subject. There is no role
 * that grants access to someone else's conversation, and no identity ever comes
 * from a body field, query parameter or path segment — it is resolved from
 * RequestContextService exactly as DirectoryService (49D-1) and
 * NotificationService (49E) do.
 *
 * This service does not use Kafka, Redis, Bull or Socket.IO. Fan-out goes through
 * ConnectionRegistryPort, whose only implementation is in-process.
 */

export const DEFAULT_MESSAGE_LIMIT = 30;
export const MAX_MESSAGE_LIMIT = 100;

/**
 * Allowlisted member projection. Never contains passwordHash, refreshTokenHash,
 * tokenVersion, email verification state or tenantId — the same allowlist
 * discipline as DIRECTORY_SELECT, for the same reason (a denylist leaks every
 * future column).
 */
const MEMBER_USER_SELECT = {
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
} satisfies Prisma.MessageAttachmentSelect;

/** `storageKey` is intentionally absent: downloads go through an authorized route. */
const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  senderId: true,
  body: true,
  clientMessageId: true,
  createdAt: true,
  attachments: { select: ATTACHMENT_SELECT },
} satisfies Prisma.MessageSelect;

/**
 * Conversation row shape shared by the list and single-item reads, so both
 * projections can never drift apart. `tenantId` is absent: it is internal
 * isolation metadata and must not reach the browser.
 */
const CONVERSATION_SELECT = {
  id: true,
  type: true,
  name: true,
  createdBy: true,
  lastMessageAt: true,
  createdAt: true,
  members: { select: { userId: true, lastReadAt: true, user: { select: MEMBER_USER_SELECT } } },
  // The rail shows a preview, so the newest message rides along with the row
  // rather than costing one extra query per conversation.
  messages: { select: MESSAGE_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
} satisfies Prisma.ConversationSelect;

export interface MessagingUserDto {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
}

export interface MessageAttachmentDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  clientMessageId: string | null;
  createdAt: Date;
  attachments: MessageAttachmentDto[];
}

export interface ConversationDto {
  id: string;
  type: ConversationType;
  name: string | null;
  createdBy: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  members: MessagingUserDto[];
  lastMessage: MessageDto | null;
  unreadCount: number;
}

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface UnreadCountResult {
  count: number;
}

export interface MarkReadResult {
  conversationId: string;
  lastReadAt: Date;
}

@Injectable()
export class MessagingService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationService,
    @Inject(CONNECTION_REGISTRY) private registry: ConnectionRegistryPort,
  ) {}

  /**
   * Resolves the caller's own scope and asserts it matches the subject passed in.
   * A mismatch is refused rather than trusting the argument, so no code path can
   * act as another user.
   *
   * Over WebSocket there is no HTTP request and therefore no AsyncLocalStorage
   * frame, so the gateway supplies the identity it derived from the JWT. The
   * context is bypassed only when absent entirely — never when it exists and
   * disagrees.
   */
  private scope(
    userId: string,
    tenantId?: string | null,
  ): { userId: string; tenantId: string | null } {
    if (!userId) {
      throw new ForbiddenException('Messaging context is required');
    }

    const context = RequestContextService.get();

    if (context?.userId) {
      if (context.userId !== userId) {
        throw new ForbiddenException('Messaging context is required');
      }
      return { userId, tenantId: context.tenantId ?? null };
    }

    // WS path: the gateway already verified the JWT and read the tenant from the
    // database, so `tenantId` is server-derived, not client input.
    return { userId, tenantId: tenantId ?? null };
  }

  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? DEFAULT_MESSAGE_LIMIT, 1), MAX_MESSAGE_LIMIT);
  }

  /**
   * The single authorization gate. Scoped to both the membership edge AND the
   * conversation's tenant, so a foreign-tenant or non-member conversation is
   * indistinguishable from a non-existent one — both 404, which is why this
   * cannot be used to probe for valid ids.
   */
  private async requireMembership(
    conversationId: string,
    userId: string,
    tenantId: string | null,
  ): Promise<{ id: string; lastReadAt: Date | null }> {
    const membership = await this.prisma.conversationMember.findFirst({
      where: { conversationId, userId, conversation: { tenantId } },
      select: { id: true, lastReadAt: true },
    });

    if (!membership) {
      throw new NotFoundException('Conversation not found');
    }

    return membership;
  }

  /** Every member of a conversation — the fan-out audience. */
  private async memberIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /**
   * Deterministic 1:1 key. Sorting the two ids means (a,b) and (b,a) collapse to
   * the same value, and the UNIQUE constraint then makes a duplicate direct
   * conversation impossible even under a concurrent double create.
   */
  private directKey(tenantId: string | null, a: string, b: string): string {
    return `${tenantId ?? 'null'}:${[a, b].sort().join(':')}`;
  }

  /**
   * Unread = messages in the conversation newer than the member's `lastReadAt`
   * that the member did not send themselves. Read state is conversation-level, so
   * this is one COUNT rather than a per-message receipt join.
   */
  private unreadWhere(
    conversationId: string,
    userId: string,
    lastReadAt: Date | null,
  ): Prisma.MessageWhereInput {
    return {
      conversationId,
      senderId: { not: userId },
      ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
    };
  }

  /**
   * The caller's conversations, newest activity first.
   *
   * Ordered by `lastMessageAt DESC, id DESC` with `createdAt` as the tiebreaker
   * for conversations that have no messages yet, so a freshly created empty
   * conversation still appears rather than sinking below everything.
   */
  async listConversations(userId: string, query: ConversationQueryDto): Promise<PageResult<ConversationDto>> {
    const scope = this.scope(userId);
    const limit = this.clampLimit(query.limit);

    // Over-fetch by one to decide `hasMore` without a second COUNT.
    const rows = await this.prisma.conversation.findMany({
      where: {
        tenantId: scope.tenantId,
        members: { some: { userId: scope.userId } },
      },
      select: CONVERSATION_SELECT,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { items: await this.projectConversations(scope.userId, rows), hasMore };
  }

  /**
   * Shared projection for a batch of already-authorized conversation rows. Both
   * the list read and the single-item read go through this, so the two can never
   * disagree about what a conversation looks like.
   */
  private async projectConversations(
    userId: string,
    rows: Prisma.ConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>[],
  ): Promise<ConversationDto[]> {
    const unreadByConversation = await this.unreadCounts(
      userId,
      rows.map((row) => ({
        id: row.id,
        lastReadAt: row.members.find((m) => m.userId === userId)?.lastReadAt ?? null,
      })),
    );

    return rows.map<ConversationDto>((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      createdBy: row.createdBy,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      members: row.members.map((m) => m.user as MessagingUserDto),
      lastMessage: (row.messages[0] as MessageDto | undefined) ?? null,
      unreadCount: unreadByConversation.get(row.id) ?? 0,
    }));
  }

  /**
   * Re-reads specific conversations for one member. The tenant + membership
   * predicate is applied here too, so this is safe on its own terms rather than
   * relying on the caller having checked.
   */
  private async listConversationsById(
    userId: string,
    tenantId: string | null,
    ids: string[],
  ): Promise<ConversationDto[]> {
    if (ids.length === 0) return [];

    const rows = await this.prisma.conversation.findMany({
      where: { id: { in: ids }, tenantId, members: { some: { userId } } },
      select: CONVERSATION_SELECT,
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });

    return this.projectConversations(userId, rows);
  }

  /**
   * Per-conversation unread counts for a page of conversations.
   *
   * Each member has their own `lastReadAt`, so the cutoffs differ per row and a
   * single groupBy cannot express them. They are issued concurrently and bounded
   * by the page size (max 100), which keeps this predictable rather than fanning
   * out over the whole table.
   */
  private async unreadCounts(
    userId: string,
    conversations: { id: string; lastReadAt: Date | null }[],
  ): Promise<Map<string, number>> {
    const counts = await Promise.all(
      conversations.map(async (conversation) => {
        const count = await this.prisma.message.count({
          where: this.unreadWhere(conversation.id, userId, conversation.lastReadAt),
        });
        return [conversation.id, count] as const;
      }),
    );

    return new Map(counts);
  }

  /** One conversation the caller belongs to. Non-members get 404, not 403. */
  async getConversation(userId: string, conversationId: string): Promise<ConversationDto> {
    const scope = this.scope(userId);
    await this.requireMembership(conversationId, scope.userId, scope.tenantId);

    const page = await this.listConversationsById(scope.userId, scope.tenantId, [conversationId]);
    const conversation = page[0];

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  /**
   * Total unread across every conversation the caller belongs to.
   *
   * Computed from the membership rows rather than a denormalised counter, so it
   * cannot drift out of sync with the messages themselves.
   */
  async unreadCount(userId: string): Promise<UnreadCountResult> {
    const scope = this.scope(userId);

    const memberships = await this.prisma.conversationMember.findMany({
      where: { userId: scope.userId, conversation: { tenantId: scope.tenantId } },
      select: { conversationId: true, lastReadAt: true },
    });

    const counts = await this.unreadCounts(
      scope.userId,
      memberships.map((m) => ({ id: m.conversationId, lastReadAt: m.lastReadAt })),
    );

    let total = 0;
    for (const count of counts.values()) total += count;

    return { count: total };
  }

  /**
   * Creates a conversation, or returns the existing DIRECT one.
   *
   * The caller is always a member and is always the creator — neither can be
   * supplied by the client. Participants must exist in the caller's own tenant, so
   * a valid id from another tenant is rejected exactly like a nonexistent one.
   */
  async createConversation(userId: string, dto: CreateConversationDto): Promise<ConversationDto> {
    const scope = this.scope(userId);

    // Deduplicate the request itself and drop the caller if they listed
    // themselves; what remains must be a non-empty set of other people.
    const others = [...new Set(dto.participantIds)].filter((id) => id !== scope.userId);

    if (others.length === 0) {
      throw new BadRequestException('At least one other participant is required');
    }

    if (dto.type === 'DIRECT' && others.length !== 1) {
      throw new BadRequestException('A direct conversation has exactly one other participant');
    }

    if (dto.type === 'DIRECT' && dto.name) {
      throw new BadRequestException('A direct conversation cannot be named');
    }

    if (dto.type === 'GROUP' && !dto.name) {
      throw new BadRequestException('A group conversation requires a name');
    }

    if (others.length > MAX_GROUP_PARTICIPANTS) {
      throw new BadRequestException(`A conversation supports at most ${MAX_GROUP_PARTICIPANTS} other participants`);
    }

    // Tenant-scoped existence check. Counting inside the tenant means a
    // foreign-tenant participant is indistinguishable from an unknown one.
    const reachable = await this.prisma.user.count({
      where: { id: { in: others }, tenantId: scope.tenantId },
    });

    if (reachable !== others.length) {
      throw new BadRequestException('One or more participants are not available');
    }

    if (dto.type === 'DIRECT') {
      return this.createOrGetDirect(scope.userId, scope.tenantId, others[0]);
    }

    const created = await this.prisma.conversation.create({
      data: {
        type: 'GROUP',
        tenantId: scope.tenantId,
        name: dto.name,
        createdBy: scope.userId,
        members: { create: [scope.userId, ...others].map((id) => ({ userId: id })) },
      },
      select: { id: true },
    });

    const conversation = (await this.listConversationsById(scope.userId, scope.tenantId, [created.id]))[0];

    // Persisted first, then announced — the invitees learn about it only after it
    // is durable.
    this.registry.publishToUsers(others, 'conversation.updated', conversation);

    return conversation;
  }

  /**
   * DIRECT create is idempotent by construction: the deterministic `directKey` is
   * UNIQUE, so a concurrent double create loses the race at the database rather
   * than producing two parallel 1:1 threads. P2002 is therefore an expected
   * outcome, not an error — it means someone else just created the same one.
   */
  private async createOrGetDirect(
    userId: string,
    tenantId: string | null,
    otherId: string,
  ): Promise<ConversationDto> {
    const directKey = this.directKey(tenantId, userId, otherId);

    const existing = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: { id: true },
    });

    if (existing) {
      return (await this.listConversationsById(userId, tenantId, [existing.id]))[0];
    }

    try {
      const created = await this.prisma.conversation.create({
        data: {
          type: 'DIRECT',
          tenantId,
          createdBy: userId,
          directKey,
          members: { create: [{ userId }, { userId: otherId }] },
        },
        select: { id: true },
      });

      const conversation = (await this.listConversationsById(userId, tenantId, [created.id]))[0];
      this.registry.publishToUsers([otherId], 'conversation.updated', conversation);
      return conversation;
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
        const raced = await this.prisma.conversation.findUnique({
          where: { directKey },
          select: { id: true },
        });
        if (raced) {
          return (await this.listConversationsById(userId, tenantId, [raced.id]))[0];
        }
      }
      throw err;
    }
  }

  /**
   * A cursor page of messages, newest first.
   *
   * `after` switches the read into recovery mode: the reconnect path asks for
   * everything newer than the last message it already holds, so a client that was
   * offline catches up from Postgres rather than depending on the socket having
   * been up. This is why a dropped WebSocket frame is never data loss.
   */
  async listMessages(
    userId: string,
    conversationId: string,
    query: MessageQueryDto,
    tenantId?: string | null,
  ): Promise<PageResult<MessageDto>> {
    const scope = this.scope(userId, tenantId);
    await this.requireMembership(conversationId, scope.userId, scope.tenantId);

    const limit = this.clampLimit(query.limit);

    const where: Prisma.MessageWhereInput = { conversationId };

    if (query.after) {
      // Resolve the anchor inside this conversation only, so an id from another
      // conversation cannot be used to shift the window.
      const anchor = await this.prisma.message.findFirst({
        where: { id: query.after, conversationId },
        select: { createdAt: true, id: true },
      });

      if (!anchor) {
        throw new NotFoundException('Message not found');
      }

      // Compare on (createdAt, id) so messages sharing a timestamp are still
      // ordered deterministically and none is skipped or repeated.
      where.OR = [
        { createdAt: { gt: anchor.createdAt } },
        { createdAt: anchor.createdAt, id: { gt: anchor.id } },
      ];
    }

    const rows = await this.prisma.message.findMany({
      where,
      select: MESSAGE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { items: rows as MessageDto[], hasMore };
  }

  /**
   * Persists a message, then fans it out. THE ORDER MATTERS: the transaction
   * commits (message row + the conversation's `lastMessageAt`) before any socket
   * write, so every delivered event corresponds to durable state, and a failed
   * delivery is recoverable by re-reading.
   *
   * The sender is always the authenticated subject. `conversationId` is checked
   * against a membership row first, so this cannot post into a conversation the
   * sender does not belong to (IDOR).
   */
  async sendMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
    tenantId?: string | null,
  ): Promise<MessageDto> {
    const scope = this.scope(userId, tenantId);
    await this.requireMembership(conversationId, scope.userId, scope.tenantId);

    // Idempotent retry: the same key from the same sender in the same
    // conversation returns what was already stored instead of duplicating it.
    if (dto.clientMessageId) {
      const existing = await this.prisma.message.findFirst({
        where: { conversationId, senderId: scope.userId, clientMessageId: dto.clientMessageId },
        select: MESSAGE_SELECT,
      });

      if (existing) return existing as MessageDto;
    }

    const attachmentIds = await this.claimableAttachmentIds(scope.userId, conversationId, dto.attachmentIds);

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: scope.userId,
          body: dto.body,
          clientMessageId: dto.clientMessageId ?? null,
        },
        select: { id: true, createdAt: true },
      });

      if (attachmentIds.length > 0) {
        // Bind by id AND unbound-state, so a concurrent second send cannot steal
        // an attachment that is already attached to another message.
        const bound = await tx.messageAttachment.updateMany({
          where: { id: { in: attachmentIds }, messageId: null },
          data: { messageId: created.id },
        });

        if (bound.count !== attachmentIds.length) {
          throw new BadRequestException('One or more attachments are not available');
        }
      }

      // Denormalised activity timestamp, written in the same transaction so the
      // rail ordering can never disagree with the messages.
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.createdAt },
      });

      return tx.message.findUniqueOrThrow({ where: { id: created.id }, select: MESSAGE_SELECT });
    });

    await this.announceMessage(conversationId, scope.userId, scope.tenantId, message as MessageDto);

    return message as MessageDto;
  }

  /**
   * Validates that every requested attachment is the caller's own, still unbound,
   * AND was uploaded for this exact conversation. Anything else is refused rather
   * than silently skipped, so an attachment id cannot be replayed into another
   * thread or borrowed from another user.
   */
  private async claimableAttachmentIds(
    userId: string,
    conversationId: string,
    requested: string[] | undefined,
  ): Promise<string[]> {
    const ids = [...new Set(requested ?? [])];
    if (ids.length === 0) return [];

    const rows = await this.prisma.messageAttachment.findMany({
      where: { id: { in: ids }, uploadedBy: userId, conversationId, messageId: null },
      select: { id: true },
    });

    if (rows.length !== ids.length) {
      throw new BadRequestException('One or more attachments are not available');
    }

    return ids;
  }

  /**
   * Post-commit fan-out for a new message.
   *
   * Every member gets `message.created`, and each member additionally gets their
   * OWN `conversation.updated` — unread counts are per-member, so a single shared
   * payload would show one person's badge to everybody.
   *
   * Recipients who are offline get an in-app notification instead, reusing
   * NotificationService.createForUser; online recipients do not, because they
   * already saw the message.
   */
  private async announceMessage(
    conversationId: string,
    senderId: string,
    tenantId: string | null,
    message: MessageDto,
  ): Promise<void> {
    const members = await this.memberIds(conversationId);

    this.registry.publishToUsers(members, 'message.created', message);

    await Promise.all(
      members.map(async (memberId) => {
        const [conversation] = await this.listConversationsById(memberId, tenantId, [conversationId]);
        if (conversation) {
          this.registry.publishToUsers([memberId], 'conversation.updated', conversation);
        }
      }),
    );

    const offlineRecipients = members.filter(
      (memberId) => memberId !== senderId && !this.registry.isOnline(memberId),
    );

    await Promise.all(
      offlineRecipients.map((memberId) =>
        this.notifications
          .createForUser({
            userId: memberId,
            type: 'INFORMATION',
            title: 'پیام جدید',
            body: this.notificationPreview(message.body),
            sourceType: 'messaging.message',
            sourceId: message.id,
          })
          // A notification failure must never fail the send: the message is
          // already committed and delivered.
          .catch(() => undefined),
      ),
    );
  }

  /**
   * Notification bodies are plain text and NotificationService refuses `<`/`>`
   * outright, so angle brackets are stripped here rather than allowed to reject
   * an otherwise valid message.
   */
  private notificationPreview(body: string): string {
    const flattened = body.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    if (flattened.length === 0) return 'پیام جدید دریافت شد.';
    return flattened.length > 140 ? `${flattened.slice(0, 139)}…` : flattened;
  }

  /**
   * Advances the caller's read cursor to now and tells the conversation.
   *
   * Monotonic: `lastReadAt` only ever moves forward, so a replayed or out-of-order
   * read event cannot resurrect an unread badge.
   */
  async markRead(
    userId: string,
    conversationId: string,
    tenantId?: string | null,
  ): Promise<MarkReadResult> {
    const scope = this.scope(userId, tenantId);
    const membership = await this.requireMembership(conversationId, scope.userId, scope.tenantId);

    const now = new Date();
    const lastReadAt =
      membership.lastReadAt && membership.lastReadAt > now ? membership.lastReadAt : now;

    await this.prisma.conversationMember.update({
      where: { id: membership.id },
      data: { lastReadAt },
    });

    const members = await this.memberIds(conversationId);
    this.registry.publishToUsers(members, 'message.read', {
      conversationId,
      userId: scope.userId,
      lastReadAt,
    });

    const [conversation] = await this.listConversationsById(scope.userId, scope.tenantId, [
      conversationId,
    ]);
    if (conversation) {
      this.registry.publishToUsers([scope.userId], 'conversation.updated', conversation);
    }

    return { conversationId, lastReadAt };
  }

  /**
   * Ephemeral typing relay. Never persisted, and never echoed to the author — a
   * client does not need to be told that it is typing.
   */
  async relayTyping(
    userId: string,
    conversationId: string,
    isTyping: boolean,
    tenantId?: string | null,
  ): Promise<void> {
    const scope = this.scope(userId, tenantId);
    await this.requireMembership(conversationId, scope.userId, scope.tenantId);

    const others = (await this.memberIds(conversationId)).filter((id) => id !== scope.userId);
    this.registry.publishToUsers(others, 'typing.changed', {
      conversationId,
      userId: scope.userId,
      isTyping,
    });
  }

  /**
   * Announces a presence change to the people who can actually see it: members of
   * the user's own conversations. Presence is never broadcast tenant-wide, so it
   * cannot be used to enumerate who exists.
   */
  async announcePresence(userId: string, status: 'online' | 'offline'): Promise<void> {
    const memberships = await this.prisma.conversationMember.findMany({
      where: { conversation: { members: { some: { userId } } } },
      select: { userId: true },
    });

    const audience = [...new Set(memberships.map((m) => m.userId))].filter((id) => id !== userId);
    this.registry.publishToUsers(audience, 'presence.changed', { userId, status });
  }

  /** Which members of a conversation are currently connected. */
  async presenceFor(
    userId: string,
    conversationId: string,
    tenantId?: string | null,
  ): Promise<{ userId: string; status: 'online' | 'offline' }[]> {
    const scope = this.scope(userId, tenantId);
    await this.requireMembership(conversationId, scope.userId, scope.tenantId);

    const members = await this.memberIds(conversationId);
    return members.map((memberId) => ({
      userId: memberId,
      status: this.registry.isOnline(memberId) ? 'online' : 'offline',
    }));
  }
}
