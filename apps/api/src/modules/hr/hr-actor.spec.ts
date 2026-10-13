import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService, RequestContext } from '../../common/request-context.service';
import { resolveHrActor } from './hr-actor';

/**
 * Phase 51-HR-1: the actor-resolution rules of the HR module.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every HR service method scopes every query by `actor.tenantId`, so the correctness of
 * the WHOLE module reduces to one question: can a caller influence that value? These
 * specs pin the answer — no. They are deliberately hostile about it:
 *
 *   * a request whose context carries no tenant gets a 403, never an unscoped read;
 *   * a `tenantId` / `userId` planted on the request body or on `req.user` is ignored;
 *   * `req.user.tenantId` is NOT consulted even when present, because a value the
 *     authentication layer put on the request object is not the resolved context.
 */

type ActorRequest = Request & {
  user?: { sub?: string; id?: string; tenantId?: string; userId?: string };
  body?: Record<string, unknown>;
};

/** A request as Express hands it to a controller. */
function makeRequest(overrides: Partial<ActorRequest> = {}): ActorRequest {
  return {
    ip: '10.0.0.7',
    headers: { 'user-agent': 'jest' },
    ...overrides,
  } as unknown as ActorRequest;
}

/**
 * Enters a context for the duration of one test.
 *
 * `beforeEach` always enters a context — with NO tenant by default — so the fail-closed
 * assertion cannot pass merely because an earlier test forgot to clear the store, and
 * `requestId`/`correlationId` start as `undefined` so the placeholder fallback is
 * reachable without a second setup helper.
 */
function enterContext(context: Partial<RequestContext> = {}): void {
  RequestContextService.set({
    requestId: undefined as unknown as string,
    correlationId: undefined as unknown as string,
    startTime: Date.now(),
    ...context,
  });
}

describe('resolveHrActor', () => {
  beforeEach(() => {
    enterContext();
  });

  it('refuses a request with no resolved tenant instead of reading unscoped', () => {
    // The failure mode this prevents: a missing tenant becoming "no tenant predicate",
    // which is how a multi-tenant module returns another tenant's personnel records.
    expect(() => resolveHrActor(makeRequest())).toThrow(ForbiddenException);
    // An explicitly null tenant is not a tenant either.
    enterContext({ tenantId: null });
    expect(() => resolveHrActor(makeRequest())).toThrow(ForbiddenException);
  });

  it('derives the tenant from the resolved context, not from the request object', () => {
    enterContext({ tenantId: 'tenant-a' });

    const actor = resolveHrActor(
      // `req.user.tenantId` is a DIFFERENT tenant: if the resolver ever preferred the
      // request object, this assertion is what would catch it.
      makeRequest({ user: { sub: 'user-1', tenantId: 'tenant-b' } })
    );

    expect(actor.tenantId).toBe('tenant-a');
  });

  it('ignores a client-planted tenantId and userId in the body', () => {
    enterContext({ tenantId: 'tenant-a' });

    const actor = resolveHrActor(
      makeRequest({
        user: { sub: 'user-1' },
        body: { tenantId: 'tenant-b', userId: 'someone-else', employeeCode: 'E-1' },
      })
    );

    expect(actor.tenantId).toBe('tenant-a');
    expect(actor.userId).toBe('user-1');
  });

  it('prefers the authenticated principal over the context user, and falls back to it', () => {
    enterContext({ tenantId: 'tenant-a', userId: 'context-user' });

    expect(resolveHrActor(makeRequest({ user: { sub: 'sub-user' } })).userId).toBe('sub-user');
    expect(resolveHrActor(makeRequest({ user: { id: 'id-user' } })).userId).toBe('id-user');
    // No principal on the request at all: the context's user is the only identity left,
    // and a null userId is legitimate (a machine/script caller), not an error.
    expect(resolveHrActor(makeRequest()).userId).toBe('context-user');

    enterContext({ tenantId: 'tenant-a' });
    expect(resolveHrActor(makeRequest()).userId).toBeNull();
  });

  it('carries the audit fields every HR write needs, and tolerates their absence', () => {
    enterContext({ tenantId: 'tenant-a', requestId: 'req-4', correlationId: 'corr-4' });

    const actor = resolveHrActor(makeRequest({ user: { sub: 'user-1' } }));

    expect({
      requestId: actor.requestId,
      correlationId: actor.correlationId,
      ip: actor.ip,
      userAgent: actor.userAgent,
    }).toEqual({
      requestId: 'req-4',
      correlationId: 'corr-4',
      ip: '10.0.0.7',
      userAgent: 'jest',
    });

    // A request with no user-agent and no ip must still resolve: AuditService requires
    // the fields to be PRESENT, not necessarily populated.
    const bare = resolveHrActor(makeRequest({ ip: undefined, headers: {} }));
    expect({ ip: bare.ip, userAgent: bare.userAgent }).toEqual({ ip: null, userAgent: null });
    expect(bare.requestId).toBe('req-4');

    // With no request id in the context at all, the placeholder keeps the audit row
    // writable rather than writing `undefined` into a required column.
    enterContext({ tenantId: 'tenant-a' });
    expect(resolveHrActor(makeRequest()).requestId).toBe('hr-request');
  });
});
