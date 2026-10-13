import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService, RequestContext } from '../../common/request-context.service';
import { resolveProductionActor } from './production-actor';

/**
 * Phase PRODUCTION-BOM-HEADER: the actor-resolution rules of the Production module.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every Production service scopes its work by `actor.tenantId`, so the whole module's
 * isolation reduces to one question: can a caller influence that value? These specs pin
 * the answer — no — and they mirror `commerce-actor.spec.ts` case for case, because a
 * Production-only weakening of any rule would be a silent divergence between modules
 * that claim the same guarantee:
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

describe('resolveProductionActor', () => {
  beforeEach(() => {
    enterContext();
  });

  it('refuses a request with no resolved tenant instead of reading unscoped', () => {
    // The failure mode this prevents: a missing tenant becoming "no tenant predicate",
    // which is how a multi-tenant module returns another tenant's BOM headers.
    expect(() => resolveProductionActor(makeRequest())).toThrow(ForbiddenException);
    // An explicitly null tenant is not a tenant either — `tenantId: null` is the
    // authoritative "no tenant" answer, and swallowing it would turn a decision into a
    // missing value.
    enterContext({ tenantId: null });
    expect(() => resolveProductionActor(makeRequest())).toThrow(ForbiddenException);
  });

  it('derives the tenant from the resolved context, not from the request object', () => {
    enterContext({ tenantId: 'tenant-a' });

    const actor = resolveProductionActor(
      makeRequest({
        // Every client-writable route to a tenant id, planted at once: a body field and
        // a principal claim. Neither may reach the actor.
        body: { tenantId: 'tenant-b' },
        user: { sub: 'user-1', tenantId: 'tenant-b', userId: 'tenant-b' },
      })
    );

    expect(actor.tenantId).toBe('tenant-a');
  });

  it('resolves the user from the principal, the context, then null — in that order', () => {
    enterContext({ tenantId: 'tenant-a', userId: 'context-user' });

    expect(resolveProductionActor(makeRequest({ user: { sub: 'sub-user' } })).userId).toBe(
      'sub-user'
    );
    expect(resolveProductionActor(makeRequest({ user: { id: 'id-user' } })).userId).toBe('id-user');
    // No principal on the request at all: the context's user is the only identity left,
    // and a null userId is legitimate (a machine/script caller), not an error.
    expect(resolveProductionActor(makeRequest()).userId).toBe('context-user');

    enterContext({ tenantId: 'tenant-a' });
    expect(resolveProductionActor(makeRequest()).userId).toBeNull();
  });

  it('carries the audit fields every Production write needs, and tolerates their absence', () => {
    enterContext({ tenantId: 'tenant-a', requestId: 'req-4', correlationId: 'corr-4' });

    const actor = resolveProductionActor(makeRequest({ user: { sub: 'user-1' } }));

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
    const bare = resolveProductionActor(makeRequest({ ip: undefined, headers: {} }));
    expect({ ip: bare.ip, userAgent: bare.userAgent }).toEqual({ ip: null, userAgent: null });
    expect(bare.requestId).toBe('req-4');

    // With no request id in the context at all, the placeholder keeps the audit row
    // writable rather than writing `undefined` into a required column.
    enterContext({ tenantId: 'tenant-a' });
    expect(resolveProductionActor(makeRequest()).requestId).toBe('production-request');
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

    const actor = resolveProductionActor(
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
    const source = readFileSync(join(__dirname, 'production-actor.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

    expect(specifiers).toEqual([
      '@nestjs/common',
      'express',
      '../../common/request-context.service',
    ]);
  });
});
