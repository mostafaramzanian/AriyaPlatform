import { Injectable, Logger } from '@nestjs/common';
import { NotificationPublisher } from '../../notifications/notification.publisher';
import { NotificationService } from '../../notifications/notification.service';

/**
 * The bounded set of Core `NotificationType` categories, mirrored as string literals.
 *
 * WHY IT IS NOT IMPORTED. The generated Core client is a persistence artifact and gate I9
 * (commerce-gateways.spec.ts) forbids every gateway from importing `generated/*` — the
 * gateway holds no client, no table and no query. The Core enum is a CLOSED union of
 * these exact four strings (prisma/core/schema.prisma, `enum NotificationType`), so a
 * literal mirror is structurally identical at the call site: passing it to
 * `NotificationService.createForUser` type-checks against the real contract, and a new
 * Core category would surface as a compile question here rather than silently drifting.
 */
export type CommerceUserNotificationType = 'SYSTEM' | 'SECURITY' | 'ANNOUNCEMENT' | 'INFORMATION';

/**
 * The content of ONE user-addressed notification — the caller's words, never the
 * gateway's. `sourceType`/`sourceId` are Core's plain, non-FK back-reference to the
 * Commerce entity that produced the notification (the same convention
 * `support.service.ts` and `correspondence.service.ts` use), so the notification stays
 * traceable to its authoritative row.
 */
export interface CommerceUserNotificationContent {
  readonly type: CommerceUserNotificationType;
  readonly title: string;
  readonly body: string;
  readonly sourceType?: string | null;
  readonly sourceId?: string | null;
}

/**
 * Phase C1 Step H (§21.H / gate I9): the ONE surface through which Commerce emits a
 * platform notification.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Notification is a platform capability reached through an interface, not a channel a
 * business module may dial itself. The alternative — a Commerce service importing
 * `NotificationPublisher` directly and composing an envelope for its own service — puts
 * `tenantId`, `correlationId` and `emittedAt` under N callers' control, and those three
 * fields are exactly what the delivery pipeline filters and reports on. Gate I9 names
 * this gateway as the single consumer so that a Commerce event is envelope-shaped
 * wherever it comes from.
 *
 * TWO SURFACES, ONE DOOR (GAP-9)
 * ------------------------------
 * The transport surface (`publish`) predates GAP-9 and is unchanged: it publishes an AMQP
 * domain event, envelope-owned here (the three platform fields are applied LAST so a
 * payload key can never displace them — `tenantId` from the actor, `correlationId` from
 * the actor falling back to its `requestId`, and an `emittedAt` produced here rather
 * than trusted from a caller's clock). GAP-9 adds the USER-ADDRESS surface
 * (`notifyUsers`): the in-process Core Notification Center contract
 * `NotificationService.createForUser` is reached ONLY through this class, so Commerce
 * business services never see Core's creation input, tenant-snapshot rule or
 * persistence — they see typed recipients plus content. `NotificationService` is
 * injected here and nowhere else under `src/modules/commerce/**`; gate I9 scans for
 * exactly that.
 *
 * THE RECIPIENT IS THE CALLER'S, RESOLVED FROM AUTHORITATIVE STATE BEFORE THIS CALL
 * --------------------------------------------------------------------------------
 * Core's Center accepts an explicit `userId` and resolves NO audience: it loads the
 * recipient, refuses a tenant assertion that does not match them, and snapshots the
 * recipient's own tenant. So this method (a) forwards the exact ids the caller resolved
 * from Commerce's own domain rows, (b) passes the ACTOR's tenant as that assertion — a
 * recipient outside the actor's tenant is refused by Core, never written — and (c) never
 * invents, expands or looks up a recipient. Recipients are DEDUPLICATED here, at this
 * boundary, so two domain paths that resolve the same owner for one atomic transition
 * produce ONE notification per user.
 *
 * IT OWNS NOTHING ELSE
 * --------------------
 * No Prisma handle of any kind, no scheduling, no retry policy of its own, and no new
 * failure channel. A user-notification failure never fails the business operation that
 * committed before it — the established Core convention (`support.service.ts` and
 * `correspondence.service.ts` both swallow-and-report after their write succeeded), so
 * failures surface here as a `warn` carrying identifiers only, never the title or body.
 * The transport `publish` propagates as it always has: `NotificationPublisher.publish`
 * treats delivery as best-effort and never throws.
 *
 * THE ACTOR PARAMETER IS STRUCTURAL, ON PURPOSE
 * ---------------------------------------------
 * Declared inline rather than as a named actor type, for the reason documented in
 * `commerce-identity.gateway.ts`: `commerce-actor.ts` arrives in step I, and structural
 * typing means the Step-I actor satisfies this signature unchanged.
 */
@Injectable()
export class CommerceNotificationGateway {
  private readonly logger = new Logger(CommerceNotificationGateway.name);

  constructor(
    private readonly publisher: NotificationPublisher,
    private readonly notifications: NotificationService
  ) {}

  /**
   * Emit one platform event, stamped with the actor's tenant and correlation.
   *
   * `tenantId` is the first key the consumer filter uses, so a missing one would make
   * the event unfilterable rather than merely anonymous; taking it from `actor` and
   * applying it after the spread makes it impossible to omit by accident or to supply
   * from the request body.
   */
  async publish(
    actor: { tenantId: string; requestId: string; correlationId?: string },
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.publisher.publish(eventType, {
      ...payload,
      // Applied last so a payload key cannot displace a platform-owned field.
      correlationId: actor.correlationId ?? actor.requestId,
      tenantId: actor.tenantId,
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Create ONE in-app Notification Center row per distinct recipient (GAP-9).
   *
   * THE CONTRACT, STATED SO A CALLER CANNOT MISUSE IT:
   *  - `recipientUserIds` are exact Core user ids the caller already resolved from
   *    authoritative Commerce state. An empty list (no authoritative recipient) is a
   *    no-op, not an error — a transition with nobody to tell simply tells nobody;
   *  - duplicates collapse HERE, at this boundary: one logical transition yields at most
   *    one notification per user, no matter how many domain paths named them;
   *  - `actor.tenantId` travels as Core's tenant ASSERTION: Core refuses a recipient
   *    whose own tenant differs, so a cross-tenant recipient can never be written even
   *    if a caller passed one by mistake. Isolation itself stays Core-owned;
   *  - a failure (recipient missing, tenant mismatch, invalid content) is logged with
   *    identifiers only and NEVER thrown: by the time this runs the business transition
   *    has committed, and its act cannot be repeated — failing the request now would
   *    report a committed business operation as failed over an absent alert.
   */
  async notifyUsers(
    actor: { tenantId: string; requestId: string; correlationId?: string },
    recipientUserIds: readonly string[],
    content: CommerceUserNotificationContent
  ): Promise<void> {
    const recipients = [
      ...new Set(
        recipientUserIds.filter((userId) => typeof userId === 'string' && userId.length > 0)
      ),
    ];
    if (recipients.length === 0) return;

    for (const recipientUserId of recipients) {
      try {
        await this.notifications.createForUser({
          userId: recipientUserId,
          // The actor's tenant as an assertion, never as a placement override: Core
          // snapshots the RECIPIENT's tenant and refuses a mismatch (GAP-9 §7).
          tenantId: actor.tenantId,
          type: content.type,
          title: content.title,
          body: content.body,
          sourceType: content.sourceType ?? null,
          sourceId: content.sourceId ?? null,
        });
      } catch (err) {
        // Identifiers only — never the title/body, which are business content.
        this.logger.warn(
          {
            stage: 'commerce.notification.user.failed',
            recipientUserId,
            sourceType: content.sourceType ?? null,
            sourceId: content.sourceId ?? null,
            err: err instanceof Error ? err.message : String(err),
          },
          'Commerce user notification was not created; the business transition is unaffected'
        );
      }
    }
  }
}
