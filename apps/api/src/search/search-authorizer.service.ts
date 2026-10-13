import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { PlatformSearchSourceType } from './search.constants';
import {
  calendarHref,
  directoryHref,
  messagesHref,
  notificationsHref,
  surveyHref,
  ticketHref,
} from './search-routes';
import type { AuthorizedSource, SearchScope } from './search.types';

/**
 * Phase 49J: the authorization stage.
 *
 * THIS IS THE SECURITY BOUNDARY OF GLOBAL SEARCH. The projection is not; the index is
 * not; the tenant column on `SearchDocument` is a redundant filter, not a guarantee.
 * Every candidate arrives here as nothing but a (`sourceType`, `sourceId`) pair, and
 * it can only leave as a result if THIS class re-reads the authoritative row and that
 * row satisfies the source's own visibility rule.
 *
 * The rules are not reinvented here — each one mirrors the service that owns the
 * source, and the mirroring is deliberate and documented per method:
 *   MESSAGE / CONVERSATION → `ConversationMember` membership (MessagingService: the
 *                            ONLY authorization edge, no role can substitute)
 *   TICKET                 → tenant + (requester OR `admin.support.manage`)
 *                            (SupportService.visibility)
 *   TICKET_COMMENT         → inherits ticket access, and `isInternal` is EXCLUDED for
 *                            a non-agent (SupportService.listComments)
 *   SURVEY                 → tenant + (PUBLISHED/CLOSED OR `admin.surveys.manage`)
 *                            (SurveysService.visibility)
 *   NOTIFICATION           → tenant + `userId` = caller (NotificationService.ownership)
 *   REMINDER               → tenant + `userId` = caller (ReminderService.requireOwned)
 *   USER                   → tenant, and ONLY for a caller with a tenant
 *                            (DirectoryService.tenantId)
 *
 * NO N+1. Candidates are grouped by source type and each group costs ONE query with
 * `id: { in: [...] }`, so the whole stage is at most eight queries regardless of how
 * many candidates arrived. Nothing here loops over candidates issuing queries.
 *
 * A candidate whose row no longer exists is silently dropped — that is the correct
 * handling of a stale projection, and it is why the projection needs no foreign key.
 *
 * PHASE P-SEARCH-SOURCE — WHAT IS DELIBERATELY ABSENT HERE
 * -------------------------------------------------------
 * This class never sees `EXTERNAL` candidates: its input type is
 * `PlatformSearchSourceType`, the eight platform sources. A row contributed by an
 * independent bounded context is authorized by THAT CONTEXT's own adapter through
 * the platform search source port (`SearchSourceService.authorize`), because this
 * class's whole design — re-read the authoritative row with Core's Prisma client —
 * is impossible for data in another database. Splitting the two is what keeps the
 * platform's rules in one file and the source's rules in the source, rather than
 * half-copying a bounded context's policy into Core.
 */
@Injectable()
export class SearchAuthorizer {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorizes and hydrates every candidate, grouped by source type.
   *
   * Returns a map keyed `sourceType:sourceId` so the caller can re-join against its
   * ranked candidate list without changing the order relevance produced.
   */
  async authorize(
    scope: SearchScope,
    candidates: ReadonlyArray<{ sourceType: PlatformSearchSourceType; sourceId: string }>
  ): Promise<Map<string, AuthorizedSource>> {
    const byType = new Map<PlatformSearchSourceType, string[]>();
    for (const candidate of candidates) {
      const ids = byType.get(candidate.sourceType);
      if (ids) ids.push(candidate.sourceId);
      else byType.set(candidate.sourceType, [candidate.sourceId]);
    }

    const groups = await Promise.all(
      [...byType.entries()].map(([sourceType, ids]) => this.authorizeGroup(scope, sourceType, ids))
    );

    const authorized = new Map<string, AuthorizedSource>();
    for (const group of groups) {
      for (const source of group) {
        authorized.set(`${source.sourceType}:${source.sourceId}`, source);
      }
    }

    return authorized;
  }

  /**
   * Dispatches one source group to its rule.
   *
   * The switch is EXHAUSTIVE over `PlatformSearchSourceType`: the `never`
   * assignment makes a new PLATFORM source a compile error, so such a source can
   * never be added to the projection without someone writing its authorization
   * rule. `EXTERNAL` is outside this type by construction, and a value that
   * somehow arrived anyway falls into `default` and throws — it is never
   * silently authorized.
   */
  private authorizeGroup(
    scope: SearchScope,
    sourceType: PlatformSearchSourceType,
    ids: readonly string[]
  ): Promise<AuthorizedSource[]> {
    switch (sourceType) {
      case 'TICKET':
        return this.tickets(scope, ids);
      case 'TICKET_COMMENT':
        return this.ticketComments(scope, ids);
      case 'SURVEY':
        return this.surveys(scope, ids);
      case 'MESSAGE':
        return this.messages(scope, ids);
      case 'CONVERSATION':
        return this.conversations(scope, ids);
      case 'NOTIFICATION':
        return this.notifications(scope, ids);
      case 'REMINDER':
        return this.reminders(scope, ids);
      case 'USER':
        return this.users(scope, ids);
      default: {
        const exhaustive: never = sourceType;
        throw new Error(`No authorization rule for search source ${String(exhaustive)}`);
      }
    }
  }

  /**
   * TICKET — mirrors `SupportService.visibility`.
   *
   * An agent (`admin.support.manage`) sees their whole tenant; anyone else sees only
   * tickets they filed. The tenant predicate is applied UNCONDITIONALLY, including
   * when it is null: dropping a null tenant would widen the query to every
   * tenant-less ticket in the database, which is the exact bug the support service
   * documents.
   *
   * Note what is NOT here: `assigneeId` does not grant visibility to a non-agent.
   * Assignment is an agent-only operation, so an assignee is by construction an
   * agent and already covered by the tenant branch.
   */
  private async tickets(scope: SearchScope, ids: readonly string[]): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.ticket.findMany({
      where: {
        id: { in: [...ids] },
        tenantId: scope.tenantId,
        ...(scope.isSupportAgent ? {} : { requesterId: scope.userId }),
      },
      select: { id: true, subject: true, body: true, trackingNumber: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'TICKET' as const,
      sourceId: row.id,
      title: `${row.trackingNumber} — ${row.subject}`,
      snippetFields: [row.subject, row.body],
      timestamp: row.updatedAt,
      navigation: { href: ticketHref(row.id) },
    }));
  }

  /**
   * TICKET_COMMENT — mirrors `SupportService.listComments`.
   *
   * TWO conditions, both required:
   *  1. the caller can see the PARENT TICKET (the nested `ticket` filter repeats the
   *     ticket rule rather than trusting that the comment was indexed);
   *  2. `isInternal` comments are EXCLUDED for a non-agent — excluded, not flagged
   *     and not redacted, because an internal note's existence is itself information.
   *
   * A comment result navigates to the ticket page with the comment id as an anchor,
   * since there is no standalone comment route.
   */
  private async ticketComments(
    scope: SearchScope,
    ids: readonly string[]
  ): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.ticketComment.findMany({
      where: {
        id: { in: [...ids] },
        ...(scope.isSupportAgent ? {} : { isInternal: false }),
        ticket: {
          tenantId: scope.tenantId,
          ...(scope.isSupportAgent ? {} : { requesterId: scope.userId }),
        },
      },
      select: {
        id: true,
        body: true,
        createdAt: true,
        ticket: { select: { id: true, subject: true, trackingNumber: true } },
      },
    });

    return rows.map((row) => ({
      sourceType: 'TICKET_COMMENT' as const,
      sourceId: row.id,
      title: `${row.ticket.trackingNumber} — ${row.ticket.subject}`,
      snippetFields: [row.body],
      timestamp: row.createdAt,
      navigation: { href: ticketHref(row.ticket.id), anchor: row.id },
    }));
  }

  /**
   * SURVEY — mirrors `SurveysService.visibility`.
   *
   * A manager (`admin.surveys.manage`) sees every survey in their tenant, drafts
   * included. Everyone else sees only PUBLISHED or CLOSED surveys: a DRAFT is
   * INVISIBLE rather than merely un-answerable, so an unfinished questionnaire cannot
   * be read early through search.
   *
   * The availability window (`startsAt`/`endsAt`) is deliberately NOT applied. It
   * governs ANSWERING, not existence — `SurveysService.getSurvey` uses the same
   * `visibility` predicate — and a survey that closed yesterday must remain findable.
   */
  private async surveys(scope: SearchScope, ids: readonly string[]): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.survey.findMany({
      where: {
        id: { in: [...ids] },
        tenantId: scope.tenantId,
        ...(scope.isSurveyManager ? {} : { status: { in: ['PUBLISHED', 'CLOSED'] } }),
      },
      select: { id: true, title: true, description: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'SURVEY' as const,
      sourceId: row.id,
      title: row.title,
      snippetFields: [row.title, row.description],
      timestamp: row.updatedAt,
      navigation: { href: surveyHref(row.id) },
    }));
  }

  /**
   * MESSAGE — mirrors `MessagingService.requireMembership`.
   *
   * MEMBERSHIP IS THE ONLY EDGE. No permission and no role grants access to a
   * conversation the caller does not belong to, so there is no agent/manager branch
   * here and there must never be one. The predicate reads exactly as the messaging
   * service's does: `conversation: { tenantId, members: { some: { userId } } }`.
   *
   * `Message` HAS NO `tenantId` COLUMN — isolation is reached only through
   * `Conversation.tenantId`, which is why the filter is nested rather than flat. The
   * indexer records that same conversation tenant on the projection row.
   *
   * A message result navigates to the messaging page with the CONVERSATION id as the
   * anchor: there is no per-message route, and the client selects the thread.
   */
  private async messages(scope: SearchScope, ids: readonly string[]): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        id: { in: [...ids] },
        conversation: {
          tenantId: scope.tenantId,
          members: { some: { userId: scope.userId } },
        },
      },
      select: {
        id: true,
        body: true,
        createdAt: true,
        conversation: { select: { id: true, name: true, type: true } },
      },
    });

    return rows.map((row) => ({
      sourceType: 'MESSAGE' as const,
      sourceId: row.id,
      // A DIRECT conversation is never named — the UI titles it after the other
      // participant, which this stage deliberately does not resolve: doing so would
      // mean projecting another user's identity into a search result.
      title: row.conversation.name ?? 'گفتگو',
      snippetFields: [row.body],
      timestamp: row.createdAt,
      navigation: { href: messagesHref(), anchor: row.conversation.id },
    }));
  }

  /**
   * CONVERSATION — same membership rule, applied to the conversation itself.
   *
   * Only GROUP conversations are indexed (a DIRECT conversation has no stored name),
   * but the filter does not assume that: it re-checks membership, which is what makes
   * it safe even if the indexer's source policy ever changes.
   */
  private async conversations(
    scope: SearchScope,
    ids: readonly string[]
  ): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.conversation.findMany({
      where: {
        id: { in: [...ids] },
        tenantId: scope.tenantId,
        members: { some: { userId: scope.userId } },
      },
      select: { id: true, name: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'CONVERSATION' as const,
      sourceId: row.id,
      title: row.name ?? 'گفتگو',
      snippetFields: [row.name],
      timestamp: row.updatedAt,
      navigation: { href: messagesHref(), anchor: row.id },
    }));
  }

  /**
   * NOTIFICATION — mirrors `NotificationService.ownership`.
   *
   * `userId` = caller AND tenant consistency. Both, not either: `userId` alone would
   * still return a notification created while the user was in another tenant, which
   * is precisely what the notification service's `ownership()` guards against.
   */
  private async notifications(
    scope: SearchScope,
    ids: readonly string[]
  ): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.notification.findMany({
      where: { id: { in: [...ids] }, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, title: true, body: true, createdAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'NOTIFICATION' as const,
      sourceId: row.id,
      title: row.title,
      snippetFields: [row.title, row.body],
      timestamp: row.createdAt,
      navigation: { href: notificationsHref(), anchor: row.id },
    }));
  }

  /**
   * REMINDER — mirrors `ReminderService.requireOwned`.
   *
   * A reminder is strictly personal: ownership plus tenant consistency, with no
   * sharing, no delegation and no administrative override anywhere in 49I.
   */
  private async reminders(scope: SearchScope, ids: readonly string[]): Promise<AuthorizedSource[]> {
    const rows = await this.prisma.reminder.findMany({
      where: { id: { in: [...ids] }, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, title: true, note: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'REMINDER' as const,
      sourceId: row.id,
      title: row.title,
      snippetFields: [row.title, row.note],
      timestamp: row.updatedAt,
      navigation: { href: calendarHref(), anchor: row.id },
    }));
  }

  /**
   * USER — mirrors `DirectoryService`, INCLUDING its strictness.
   *
   * `DirectoryService.tenantId()` THROWS when the caller has no tenant, so a
   * tenant-less caller has no directory at all. That is reproduced here as an early
   * empty return rather than as a `tenantId: null` query, because the two are not the
   * same rule: querying `tenantId: null` would invent a "tenant-less directory" the
   * Directory API does not have, and would expose every unassigned user to every
   * other unassigned user.
   *
   * OBSERVED CONSEQUENCE IN THE CURRENT RUNTIME DATA, recorded rather than worked
   * around: all 9 users in `core_db` have `tenantId = NULL`, so today NO caller can
   * reach the USER source through search. Loosening the rule to make the source
   * reachable would weaken the Directory's own policy, which this phase is not
   * permitted to do.
   *
   * The projection is the DIRECTORY allowlist — name, job title, department. Never
   * `passwordHash`, `tokenVersion`, `emailVerified`, `status`, `tenantId` or any token
   * record; `email` and `phone` are indexed and searchable (the Directory already
   * exposes them to same-tenant colleagues) but are not echoed into a snippet, so a
   * search result cannot become a contact-detail export.
   */
  private async users(scope: SearchScope, ids: readonly string[]): Promise<AuthorizedSource[]> {
    if (scope.tenantId === null) {
      return [];
    }

    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...ids] }, tenantId: scope.tenantId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        department: true,
        updatedAt: true,
      },
    });

    return rows.map((row) => ({
      sourceType: 'USER' as const,
      sourceId: row.id,
      title: [row.firstName, row.lastName].filter(Boolean).join(' ') || 'همکار',
      snippetFields: [row.jobTitle, row.department],
      timestamp: row.updatedAt,
      navigation: { href: directoryHref(row.id) },
    }));
  }
}
