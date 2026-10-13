import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { OrganizationRepository } from './organization.repository';
import { HrActor } from '../hr-actor';

/**
 * Phase 51-HR-2: a duplicate organization-unit code is a CONFLICT (409), not a 500.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `OrganizationUnit_tenantId_code_key` makes `code` unique per tenant, and it is the
 * authority on that fact — but nothing in this runtime translated its violation into an
 * HTTP status. `AppModule` registers no global exception filter (`StandardExceptionFilter`
 * is applied by `@UseFilters` on the blog controller alone), so a raw Prisma `P2002`
 * reached the client as a **500 `DATABASE_ERROR`**. Two things are wrong with that: the
 * status is not the one the API contract promises for a duplicate, and a 5xx tells the
 * caller to retry a request that can never succeed.
 *
 * WHAT IS PINNED, AND WHY EACH ASSERTION IS FALSIFIABLE
 * ----------------------------------------------------
 *   1. The pre-check refuses a code that already exists, and it is TENANT-SCOPED — the
 *      predicate is asserted literally, because a predicate missing `tenantId` would
 *      either leak another tenant's existence or fail to catch a real duplicate.
 *   2. The INSERT is still guarded: the pre-check is a read, so two concurrent creates
 *      both pass it and the loser gets `P2002`. That loser must be a 409 too. A test that
 *      only covered the pre-check would pass with the defect still present.
 *   3. Only that ONE failure is translated. A connection loss must surface as itself:
 *      a plausible wrong message hides a real incident.
 *   4. A refused create writes NOTHING — no row and no audit entry (§12) — while a
 *      completed one audits `create` against `hr.organization_unit`.
 *
 * A FAKE, NOT A DATABASE. The composite foreign keys, the self-parent CHECK and the cycle
 * trigger are the real guarantees and live in `hr_db`'s own SQL (`hr-runtime.e2e-spec.ts`
 * asserts they exist). This file pins the decisions the SERVICE makes around them.
 */

const TENANT = 'tenant-a';

const ACTOR: HrActor = {
  tenantId: TENANT,
  userId: 'user-1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

/** A Prisma unique-constraint violation, as the driver raises it. */
function uniqueViolation(target = 'OrganizationUnit_tenantId_code_key') {
  return Object.assign(new Error('Unique constraint failed on the fields: (`tenant_id`,`code`)'), {
    code: 'P2002',
    meta: { target },
  });
}

/**
 * The Prisma surface `OrganizationRepository` uses. Written out rather than inferred because
 * the fake is passed to the repository as `never`; the interface is what keeps the shape
 * honest for the reader.
 *
 * The service is built on the REAL repository over this fake. That is deliberate: the
 * assertions below are on the arguments that reach Prisma (`where`, `select`, `data`), and a
 * mocked repository would let the two layers disagree about a predicate while every
 * expectation still passed. Only the client is faked, so the query the database would run is
 * still the query this file describes.
 */
interface FakeHrPrisma {
  organizationUnit: {
    create: jest.Mock;
    update: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  position: { count: jest.Mock };
  employee: { count: jest.Mock };
  $transaction: jest.Mock;
}

function makeService() {
  const prisma: FakeHrPrisma = {
    organizationUnit: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    position: { count: jest.fn() },
    employee: { count: jest.fn() },
    $transaction: jest.fn(async (arg: unknown): Promise<unknown> =>
      Promise.all(arg as Promise<unknown>[])
    ),
  };

  const audit = { record: jest.fn() };
  const service = new OrganizationService(
    new OrganizationRepository(prisma as never),
    audit as never
  );

  return { service, prisma, audit };
}

describe('OrganizationService.create — a duplicate code is a conflict', () => {
  it('refuses a code this tenant already uses, tenant-scoped, writing nothing', async () => {
    const { service, prisma, audit } = makeService();
    prisma.organizationUnit.findFirst.mockResolvedValue({ id: 'unit-existing' });

    await expect(service.create(ACTOR, { code: 'HQ', name: 'دفتر مرکزی' })).rejects.toBeInstanceOf(
      ConflictException
    );

    // The predicate itself is asserted: `code` alone would make this tenant's duplicate
    // invisible to a second tenant's create, and would let a code from ANOTHER tenant
    // block this one.
    expect(prisma.organizationUnit.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, code: 'HQ' },
      select: { id: true },
    });
    expect(prisma.organizationUnit.create).not.toHaveBeenCalled();
    // §12: a refused mutation leaves no row in the audit trail claiming it happened.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('translates the loser of a concurrent insert (P2002) into the same 409', async () => {
    const { service, prisma, audit } = makeService();
    // The pre-check passes — this is exactly what two simultaneous creates look like —
    // and the INSERT is what the database rejects.
    prisma.organizationUnit.findFirst.mockResolvedValue(null);
    prisma.organizationUnit.create.mockRejectedValue(uniqueViolation());

    await expect(service.create(ACTOR, { code: 'HQ', name: 'دفتر مرکزی' })).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(prisma.organizationUnit.create).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does NOT report an unrelated database failure as a conflict', async () => {
    const { service, prisma } = makeService();
    prisma.organizationUnit.findFirst.mockResolvedValue(null);
    const outage = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'P1001',
    });
    prisma.organizationUnit.create.mockRejectedValue(outage);

    // The original error, not a ConflictException: reporting a dropped connection as
    // "this code is already taken" would be a plausible message for the wrong problem.
    await expect(service.create(ACTOR, { code: 'HQ', name: 'دفتر مرکزی' })).rejects.toBe(outage);
  });

  it('creates a root unit under the ACTOR tenant and audits the create', async () => {
    const { service, prisma, audit } = makeService();
    prisma.organizationUnit.findFirst.mockResolvedValue(null);
    const created = {
      id: 'unit-1',
      tenantId: TENANT,
      code: 'HQ',
      name: 'دفتر مرکزی',
      parentId: null,
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prisma.organizationUnit.create.mockResolvedValue(created);

    await expect(service.create(ACTOR, { code: 'HQ', name: 'دفتر مرکزی' })).resolves.toBe(created);

    // `tenantId` is the ACTOR's and is never taken from the request: no HR DTO has such a
    // field, and `forbidNonWhitelisted` would reject one. An omitted parentId is stored as
    // NULL — the root — rather than left undefined.
    expect(prisma.organizationUnit.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT, code: 'HQ', name: 'دفتر مرکزی', parentId: null },
    });
    // The ACTOR is the first argument, and the act carries no tenant of its own: the gateway
    // stamps `tenantId` from the actor, so a service cannot name a different tenant — the field
    // does not exist on what it passes.
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: 'create',
        resource: 'hr.organization_unit',
        resourceId: 'unit-1',
        newValue: { code: 'HQ', name: 'دفتر مرکزی', parentId: null },
      })
    );
  });
});
