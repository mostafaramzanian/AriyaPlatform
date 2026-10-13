import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { IntegrationService } from './integration.service';
import { RequestContextService } from '../common/request-context.service';

/**
 * Phase 49L §3/§22/§33: the emit façade every business module depends on.
 *
 * WHAT THIS FILE IS REALLY ASSERTING: that a business module cannot be broken by the
 * integration platform, and cannot reach into it.
 *
 *  - `emit` NEVER REJECTS. Not for a provider failure (the service already returns for
 *    those), and not for a programming error either — an unknown event type or an
 *    over-large payload is a bug in the CALLER, and from a user's point of view a ticket
 *    must still be created. The bug is logged loudly and surfaced by the service's own
 *    spec; it is not allowed to become a 500.
 *  - THE SURFACE IS TWO METHODS. `AutomationService` is what `IntegrationsModule`
 *    exports; `IntegrationService` is not. The shape assertion below is the structural
 *    version of "business modules must not call the webhook URL": there is no
 *    configuration, provider, URL or secret reachable from here at all.
 *  - `actorFromContext` CARRIES IDS ONLY (§10).
 */

describe('AutomationService', () => {
  let service: AutomationService;
  let integrations: { trigger: jest.Mock };

  const input = {
    eventType: 'ticket.created' as const,
    source: 'support' as const,
    payload: { ticketId: 't-1' },
  };

  beforeEach(async () => {
    integrations = { trigger: jest.fn().mockResolvedValue({ dispatched: true, status: 'SENT' }) };

    const moduleRef = await Test.createTestingModule({
      providers: [AutomationService, { provide: IntegrationService, useValue: integrations }],
    }).compile();

    service = moduleRef.get(AutomationService);
  });

  it('forwards the input unchanged and returns the normalized result', async () => {
    await expect(service.emit(input)).resolves.toEqual({ dispatched: true, status: 'SENT' });
    expect(integrations.trigger).toHaveBeenCalledWith(input);
  });

  it('SUPPRESSES a caller bug rather than failing the business operation', async () => {
    integrations.trigger.mockRejectedValue(new BadRequestException('Unknown event type'));

    await expect(service.emit(input)).resolves.toEqual({
      dispatched: false,
      status: 'SKIPPED',
      errorCode: 'EMIT_REJECTED',
    });
  });

  it('suppresses ANY throw, including a non-Error rejection', async () => {
    for (const rejection of [new Error('boom'), 'boom', null, undefined, 42]) {
      integrations.trigger.mockRejectedValueOnce(rejection);
      await expect(service.emit(input)).resolves.toMatchObject({ dispatched: false });
    }
  });

  it('exposes exactly two methods — no configuration surface at all', () => {
    const surface = Object.getOwnPropertyNames(AutomationService.prototype).filter(
      (name) => name !== 'constructor',
    );

    // THE structural guarantee. A module holding this object cannot configure an
    // integration, read a secret, choose a destination or touch the retry pass.
    expect(surface.sort()).toEqual(['actorFromContext', 'emit']);
  });

  describe('actorFromContext', () => {
    it('returns type and id only, never richer identity', () => {
      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
        userId: 'user-9',
        userEmail: 'admin@localhost',
        userRole: 'SUPER_ADMIN',
      });

      const actor = service.actorFromContext();

      expect(actor).toEqual({ type: 'user', id: 'user-9' });
      expect(Object.keys(actor!)).toEqual(['type', 'id']);
    });

    it('returns undefined with no authenticated user, rather than a synthetic actor', () => {
      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
      });

      // "No human did this" is information — a background pass is not a user.
      expect(service.actorFromContext()).toBeUndefined();
    });
  });
});
