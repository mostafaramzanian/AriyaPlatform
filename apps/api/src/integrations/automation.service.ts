import { Injectable, Logger } from '@nestjs/common';
import { IntegrationService } from './integration.service';
import { RequestContextService } from '../common/request-context.service';
import type {
  AutomationDispatchResult,
  IntegrationActorContext,
  TriggerAutomationInput,
} from './integration.contract';

/**
 * Phase 49L §3/§33: the ONLY thing a business module is allowed to depend on.
 *
 * WHY THIS THIN FAÇADE EXISTS AT ALL, GIVEN `IntegrationService.trigger`
 * ---------------------------------------------------------------------
 * `IntegrationService` also owns configuration writes, secret rotation, the
 * connection test and the retry pass. A business module that imported it would gain
 * the ability to rotate a secret or delete an integration from inside a ticket
 * handler — not because anyone would, but because the seam would permit it, and
 * seams that permit the wrong thing eventually get used for it.
 *
 * `AutomationService` exposes exactly two methods, both of which only EMIT. There is
 * no configuration surface here, no provider, no URL, no secret, no HTTP concept and
 * no n8n. That is what makes "business modules must not directly call the n8n
 * webhook URL" a structural property rather than a convention: from a module's
 * position, the URL is not reachable.
 *
 * IT ALSO NEVER THROWS FOR AN INTEGRATION FAILURE. `IntegrationService.trigger`
 * already returns rather than raises for every state of the world, and `emit` below
 * additionally catches PROGRAMMING errors — an unknown event type, an over-large
 * payload — so a bad automation call can never fail a ticket creation. Those bugs
 * are logged loudly and surfaced in tests; they are not allowed to reach a user.
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(private readonly integrations: IntegrationService) {}

  /**
   * Emits one domain event, best-effort.
   *
   * THE METHOD A BUSINESS MODULE CALLS. It cannot fail the caller: every error path
   * is caught here, so a module may call it inside a handler without a try/catch and
   * without wondering whether automation is configured.
   *
   * IT IS DELIBERATELY NOT CALLED INSIDE A TRANSACTION anywhere. Holding a Postgres
   * transaction open across an outbound HTTP call would put a network round-trip
   * inside a lock window — the classic way an optional integration takes down a
   * database. Every caller emits AFTER its `$transaction` has committed, so an event
   * describes a change that definitely happened.
   */
  async emit(input: TriggerAutomationInput): Promise<AutomationDispatchResult> {
    try {
      return await this.integrations.trigger(input);
    } catch (err) {
      // A throw here is a CALLER bug (unknown event type, over-large payload), not a
      // state of the world. It is logged with the event type so it is findable, and
      // swallowed so the business operation still succeeds — §22 applies to
      // programming errors too, from the user's point of view.
      this.logger.error(
        {
          eventType: input.eventType,
          source: input.source,
          err: err instanceof Error ? err.message : 'unknown',
        },
        'Automation emit failed and was suppressed to protect the business operation',
      );

      return { dispatched: false, status: 'SKIPPED', errorCode: 'EMIT_REJECTED' };
    }
  }

  /**
   * Builds the actor context from the current request, or returns undefined.
   *
   * A CONVENIENCE THAT ENFORCES §10: the result carries `type` and `id` and nothing
   * else, so a caller cannot accidentally attach an email, a role list or a session
   * by reaching for `req.user` itself. When there is no authenticated user — a
   * background pass, a system-initiated change — it returns undefined rather than a
   * synthetic actor, because "no human did this" is information.
   */
  actorFromContext(): IntegrationActorContext | undefined {
    const userId = RequestContextService.get()?.userId;
    return userId ? { type: 'user', id: userId } : undefined;
  }
}
