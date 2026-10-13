import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService, RequestContext } from '../../common/request-context.service';
import { resolveCommerceActor } from './commerce-actor';

/**
 * Phase C1 Step I (§21.I / gate I10): the actor-resolution rules of the Commerce module.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every Commerce service will scope its work by `actor.tenantId`, so the correctness of
 * the whole module reduces to one question: can a caller influence that value? These
 * specs pin the answer — no. They are deliberately hostile about it, and they mirror
 * `hr-actor.spec.ts` case for case, because a Commerce-only weakening of any rule would
 * be a silent divergence between two modules that claim the same guarantee:
 *
 *   * a request whose context carries no tenant gets a 403, never an unscoped read;
 *   * a `tenantId` / `userId` planted on the request body or on `req.user` is ignored;
 *   * `req.user.tenantId` is NOT consulted even when present, because a value the
 *     authentication layer put on the request object is not the resolved context.
 *
 * FALSIFIABILITY NOTE: the compiler cannot prevent a future implementation from reading
 * `req.user.tenantId` instead of `RequestContextService`, or from falling back to an
 * unscoped path when the tenant is absent. Those regressions type-check and boot, so
 * they require runtime assertions — which is exactly what the tenant cases below are.
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

describe('resolveCommerceActor', () => {
  beforeEach(() => {
    enterContext();
  });

  it('refuses a request with no resolved tenant instead of reading unscoped', () => {
    // The failure mode this prevents: a missing tenant becoming "no tenant predicate",
    // which is how a multi-tenant module returns another tenant's purchase documents.
    expect(() => resolveCommerceActor(makeRequest())).toThrow(ForbiddenException);
    // An explicitly null tenant is not a tenant either — `tenantId: null` is the
    // authoritative "no tenant" answer, and swallowing it would turn a decision into
    // a missing value.
    enterContext({ tenantId: null });
    expect(() => resolveCommerceActor(makeRequest())).toThrow(ForbiddenException);
  });

  it('derives the tenant from the resolved context, not from the request object', () => {
    enterContext({ tenantId: 'tenant-a' });

    const actor = resolveCommerceActor(
      // `req.user.tenantId` is a DIFFERENT tenant: if the resolver ever preferred the
      // request object, this assertion is what would catch it.
      makeRequest({ user: { sub: 'user-1', tenantId: 'tenant-b' } })
    );

    expect(actor.tenantId).toBe('tenant-a');
  });

  it('ignores a client-planted tenantId and userId in the body', () => {
    enterContext({ tenantId: 'tenant-a' });

    const actor = resolveCommerceActor(
      makeRequest({
        user: { sub: 'user-1' },
        body: { tenantId: 'tenant-b', userId: 'someone-else', supplierId: 'S-1' },
      })
    );

    expect(actor.tenantId).toBe('tenant-a');
    expect(actor.userId).toBe('user-1');
  });

  it('prefers the authenticated principal over the context user, and falls back to it', () => {
    enterContext({ tenantId: 'tenant-a', userId: 'context-user' });

    expect(resolveCommerceActor(makeRequest({ user: { sub: 'sub-user' } })).userId).toBe(
      'sub-user'
    );
    expect(resolveCommerceActor(makeRequest({ user: { id: 'id-user' } })).userId).toBe('id-user');
    // No principal on the request at all: the context's user is the only identity left,
    // and a null userId is legitimate (a machine/script caller), not an error.
    expect(resolveCommerceActor(makeRequest()).userId).toBe('context-user');

    enterContext({ tenantId: 'tenant-a' });
    expect(resolveCommerceActor(makeRequest()).userId).toBeNull();
  });

  it('carries the audit fields every Commerce write needs, and tolerates their absence', () => {
    enterContext({ tenantId: 'tenant-a', requestId: 'req-4', correlationId: 'corr-4' });

    const actor = resolveCommerceActor(makeRequest({ user: { sub: 'user-1' } }));

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

    // A request with no user-agent and no ip must still resolve: the audit contract
    // requires the fields to be PRESENT, not necessarily populated.
    const bare = resolveCommerceActor(makeRequest({ ip: undefined, headers: {} }));
    expect({ ip: bare.ip, userAgent: bare.userAgent }).toEqual({ ip: null, userAgent: null });
    expect(bare.requestId).toBe('req-4');

    // With no request id in the context at all, the placeholder keeps the audit row
    // writable rather than writing `undefined` into a required column.
    enterContext({ tenantId: 'tenant-a' });
    expect(resolveCommerceActor(makeRequest()).requestId).toBe('commerce-request');
  });

  it('returns exactly the actor shape — no request data smuggled through', () => {
    // Falsifiable: an implementation that spread `...req` or `...context` onto the actor
    // would still satisfy every field assertion above while handing services the raw
    // request object (and with it a client-writable `user.tenantId`). The closed key
    // list is what makes "the actor is the only typed context passed down" checkable.
    enterContext({
      tenantId: 'tenant-a',
      userId: 'context-user',
      userEmail: 'a@example.test',
      userRole: 'admin',
    });

    const actor = resolveCommerceActor(
      makeRequest({ user: { sub: 'user-1' }, body: { tenantId: 'tenant-b' } })
    );

    expect(Object.keys(actor).sort()).toEqual([
      'correlationId',
      'ip',
      'requestId',
      'tenantId',
      'userAgent',
      'userId',
    ]);
  });

  it('depends on no database and no platform port', () => {
    // Falsifiable: the resolver must stay executable as a plain function over an
    // in-memory request — no Prisma client, no generated client, no platform contract.
    // Such an import type-checks (Nest's DI is structural) and boots, so only pinning
    // the import surface catches it. Read from disk rather than imported, so the
    // assertion still fails if a future import throws at module load.
    const source = readFileSync(join(__dirname, 'commerce-actor.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

    expect(specifiers).toEqual([
      '@nestjs/common',
      'express',
      '../../common/request-context.service',
    ]);
  });
});
