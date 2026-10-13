import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PositionsService } from './positions.service';
import { PositionRepository } from './positions.repository';
import { HrActor } from '../hr-actor';

/**
 * Phase 51-HR-2: a duplicate POSITION code is a conflict (409), not a 500.
 *
 * The same defect as `OrganizationService.create` — `Position_tenantId_code_key` is the
 * arbiter of uniqueness, and its violation used to escape as a raw Prisma `P2002`, which
 * this runtime has no filter to translate, so `POST /hr/positions` answered 500 for a
 * duplicate the caller could fix. `title`, deliberately, is NOT unique: "کارشناس" is a
 * legitimate title in several units, so only the code can collide.
 *
 * A FAKE, NOT A DATABASE: the composite `Position_tenant_unit_fkey` and the per-tenant
 * unique index are the real guarantees and live in `hr_db`; `hr-runtime.e2e-spec.ts`
 * asserts the constraints exist. This file pins what the SERVICE decides.
 */

const TENANT = 'tenant-a';
const UNIT_ID = '6f1c2f2a-0f0e-4a1c-9c1e-8f2b1d3a4c5e';

const ACTOR: HrActor = {
  tenantId: TENANT,
  userId: 'user-1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

/** A Prisma unique-constraint violation, as the driver raises it. */
function uniqueViolation(target = 'Position_tenantId_code_key') {
  return Object.assign(new Error('Unique constraint failed on the fields: (`tenant_id`,`code`)'), {
    code: 'P2002',
    meta: { target },
  });
}

interface FakeHrPrisma {
  position: {
    create: jest.Mock;
    update: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
}

function makeService() {
  const prisma: FakeHrPrisma = {
    position: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(async (arg: unknown): Promise<unknown> =>
      Promise.all(arg as Promise<unknown>[])
    ),
  };

  const organization = { assertUnitIsUsable: jest.fn() };
  const audit = { record: jest.fn() };
  // The REAL repository over the fake client, so the assertions below still read the query
  // the database would run — `where`, `select` and `data` reach Prisma unchanged.
  const service = new PositionsService(
    new PositionRepository(prisma as never),
    organization as never,
    audit as never
  );

  return { service, prisma, organization, audit };
}

describe('PositionsService.create — a duplicate code is a conflict', () => {
  it('refuses a code this tenant already uses, tenant-scoped, writing nothing', async () => {
    const { service, prisma, organization, audit } = makeService();
    organization.assertUnitIsUsable.mockResolvedValue(undefined);
    prisma.position.findFirst.mockResolvedValue({ id: 'pos-existing' });

    await expect(
      service.create(ACTOR, { code: 'POS-ENG', title: 'کارشناس', organizationUnitId: UNIT_ID })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.position.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, code: 'POS-ENG' },
      select: { id: true },
    });
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('translates the loser of a concurrent insert (P2002) into the same 409', async () => {
    const { service, prisma, organization, audit } = makeService();
    organization.assertUnitIsUsable.mockResolvedValue(undefined);
    prisma.position.findFirst.mockResolvedValue(null);
    prisma.position.create.mockRejectedValue(uniqueViolation());

    await expect(
      service.create(ACTOR, { code: 'POS-ENG', title: 'کارشناس', organizationUnitId: UNIT_ID })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.position.create).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does NOT report an unrelated database failure as a conflict', async () => {
    const { service, prisma, organization } = makeService();
    organization.assertUnitIsUsable.mockResolvedValue(undefined);
    prisma.position.findFirst.mockResolvedValue(null);
    const outage = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'P1001',
    });
    prisma.position.create.mockRejectedValue(outage);

    await expect(
      service.create(ACTOR, { code: 'POS-ENG', title: 'کارشناس', organizationUnitId: UNIT_ID })
    ).rejects.toBe(outage);
  });

  it('checks the UNIT before the code, so an unusable unit is never reported as a duplicate', async () => {
    const { service, prisma, organization, audit } = makeService();
    organization.assertUnitIsUsable.mockRejectedValue(
      new ConflictException('Organization unit is not active')
    );

    await expect(
      service.create(ACTOR, { code: 'POS-ENG', title: 'کارشناس', organizationUnitId: UNIT_ID })
    ).rejects.toBeInstanceOf(ConflictException);

    // A position must belong to a unit that exists, is the actor's, and is active — that
    // refusal has to come first, or the caller would be told the code is taken when the
    // real problem is the unit.
    expect(organization.assertUnitIsUsable).toHaveBeenCalledWith(ACTOR, UNIT_ID);
    expect(prisma.position.findFirst).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('propagates a missing unit as a 404 rather than inventing a position', async () => {
    const { service, prisma, organization } = makeService();
    organization.assertUnitIsUsable.mockRejectedValue(
      new NotFoundException('Organization unit not found')
    );

    await expect(
      service.create(ACTOR, { code: 'POS-ENG', title: 'کارشناس', organizationUnitId: UNIT_ID })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.position.create).not.toHaveBeenCalled();
  });

  it('creates the position under the ACTOR tenant, defaulting the status to the schema, and audits it', async () => {
    const { service, prisma, organization, audit } = makeService();
    organization.assertUnitIsUsable.mockResolvedValue(undefined);
    prisma.position.findFirst.mockResolvedValue(null);
    const created = {
      id: 'pos-1',
      tenantId: TENANT,
      organizationUnitId: UNIT_ID,
      code: 'POS-ENG',
      title: 'کارشناس',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prisma.position.create.mockResolvedValue(created);

    await expect(
      service.create(ACTOR, { code: 'POS-ENG', title: 'کارشناس', organizationUnitId: UNIT_ID })
    ).resolves.toBe(created);

    // An omitted `status` is left to the schema's default rather than sent as `undefined`:
    // the column has a default for exactly this reason.
    expect(prisma.position.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        organizationUnitId: UNIT_ID,
        code: 'POS-ENG',
        title: 'کارشناس',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: 'create',
        resource: 'hr.position',
        resourceId: 'pos-1',
      })
    );
  });
});
