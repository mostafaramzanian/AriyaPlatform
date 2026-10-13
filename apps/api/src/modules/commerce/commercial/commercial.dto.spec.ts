import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CommercialAssignmentRuleInputDto,
  CommercialDocumentQueryDto,
  CreateCommercialAssignmentDto,
  CreateCommercialConfigurationDto,
  CreateCommercialGroupDto,
  UpdateCommercialConfigurationDto,
  UpdateCommercialGroupDto,
} from './commercial.dto';

/**
 * PHASE GAP-8 (FORK A): THE COMMERCIAL SLICE'S PLATFORM-USER FIELDS ARE OPAQUE.
 *
 * `liaisonUserId` and `approverUserId` name a Core identity. The platform's contract
 * for one is `@IsString() @MaxLength(64)` (`User.id` is TEXT; UUID v4 is only the mint
 * default; the seeded administrator is `super-admin-user`). Every test below asserts
 * exactly that contract — and, in the last block, that the Commerce-OWNED ids in the
 * SAME FILE still refuse anything that is not a UUID v4, so the alignment cannot creep
 * from identity references into row identifiers.
 *
 * Membership is NOT decided here: a present value is verified as a tenant member by
 * `CommercialLiaisonResolver.assertTenantMember` → `CommerceIdentityGateway.assertMember`
 * at write/validate/publish time. The DTO decides SHAPE; the gateway decides MEMBERSHIP.
 */

/** Runs the real global pipe behaviour: transform, then validate (whitelist + forbid). */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

/** The seeded platform administrator — a real tenant member whose id is not a UUID. */
const OPAQUE_ADMIN_ID = 'super-admin-user';
/** A UUID-shaped id — legal only as ONE OPAQUE STRING among others, never required. */
const UUID_ID = '9b7c1d20-4321-4cba-9f8e-1a2b3c4d5e6f';
/** The platform identity wire's bound (`MAX_IDENTITY_USER_ID`). */
const IDENTITY_MAX = 64;

/** A valid rule row so rule-level tests never fail on an unrelated field. */
function rule(commercialGroupId: string = UUID_ID) {
  return { label: 'R1', priority: 1, commercialGroupId };
}

/** The minimal valid DRAFT configuration body; per-test overrides state the subject. */
function createConfigPayload(overrides: Record<string, unknown> = {}) {
  return {
    versionLabel: 'V1',
    assignmentTrigger: 'PURCHASE_SUBMITTED',
    noAssignmentBehavior: 'LEAVE_UNASSIGNED',
    matchBehavior: 'HIGHEST_PRIORITY',
    assignmentRules: [rule()],
    approvalActivation: 'NOT_REQUIRED',
    projectionPolicy: 'ALL_LINES',
    ...overrides,
  };
}

describe('Phase GAP-8 — CreateCommercialGroupDto.liaisonUserId (opaque platform id)', () => {
  it('accepts the seeded opaque admin id and a UUID alike — one opaque contract', async () => {
    for (const liaisonUserId of [OPAQUE_ADMIN_ID, UUID_ID]) {
      const { failed } = await check(CreateCommercialGroupDto, {
        code: 'GRP',
        name: 'Group',
        liaisonUserId,
      });
      expect({ liaisonUserId, failed }).toEqual({ liaisonUserId, failed: [] });
    }
  });

  it('accepts an omitted liaison — a group with no configured liaison is a real state', async () => {
    expect((await check(CreateCommercialGroupDto, { code: 'GRP', name: 'Group' })).failed).toEqual(
      []
    );
  });

  it('refuses empty, over-long and non-string identities at the pipe', async () => {
    const base = { code: 'GRP', name: 'Group' };
    expect((await check(CreateCommercialGroupDto, { ...base, liaisonUserId: '' })).failed).toEqual([
      'liaisonUserId',
    ]);
    expect(
      (await check(CreateCommercialGroupDto, { ...base, liaisonUserId: 'i'.repeat(IDENTITY_MAX + 1) }))
        .failed
    ).toEqual(['liaisonUserId']);
    for (const liaisonUserId of [42, { id: 'x' }, ['x']]) {
      const { failed } = await check(CreateCommercialGroupDto, { ...base, liaisonUserId });
      expect({ liaisonUserId, failed }).toEqual({ liaisonUserId, failed: ['liaisonUserId'] });
    }
  });
});

describe('Phase GAP-8 — UpdateCommercialGroupDto.liaisonUserId (opaque, null clears)', () => {
  it('accepts an opaque replacement, and keeps null = "clear"', async () => {
    expect(
      (await check(UpdateCommercialGroupDto, { liaisonUserId: OPAQUE_ADMIN_ID })).failed
    ).toEqual([]);
    const cleared = await check(UpdateCommercialGroupDto, { liaisonUserId: null });
    expect(cleared.failed).toEqual([]);
    expect(cleared.instance.liaisonUserId).toBeNull();
  });

  it('refuses empty, over-long and non-string identities at the pipe', async () => {
    expect((await check(UpdateCommercialGroupDto, { liaisonUserId: '' })).failed).toEqual([
      'liaisonUserId',
    ]);
    expect(
      (await check(UpdateCommercialGroupDto, { liaisonUserId: 'i'.repeat(IDENTITY_MAX + 1) })).failed
    ).toEqual(['liaisonUserId']);
    expect((await check(UpdateCommercialGroupDto, { liaisonUserId: 42 })).failed).toEqual([
      'liaisonUserId',
    ]);
  });
});
describe('Phase GAP-8 — CreateCommercialConfigurationDto.approverUserId (opaque platform id)', () => {
  it('accepts the seeded opaque admin id and a UUID alike — one opaque contract', async () => {
    for (const approverUserId of [OPAQUE_ADMIN_ID, UUID_ID]) {
      const { failed } = await check(
        CreateCommercialConfigurationDto,
        createConfigPayload({ approvalApprover: 'CONFIGURED_USER', approverUserId })
      );
      expect({ approverUserId, failed }).toEqual({ approverUserId, failed: [] });
    }
  });

  it('refuses empty, over-long and non-string identities at the pipe', async () => {
    expect(
      (
        await check(
          CreateCommercialConfigurationDto,
          createConfigPayload({ approvalApprover: 'CONFIGURED_USER', approverUserId: '' })
        )
      ).failed
    ).toEqual(['approverUserId']);
    expect(
      (
        await check(
          CreateCommercialConfigurationDto,
          createConfigPayload({
            approvalApprover: 'CONFIGURED_USER',
            approverUserId: 'i'.repeat(IDENTITY_MAX + 1),
          })
        )
      ).failed
    ).toEqual(['approverUserId']);
    for (const approverUserId of [7, { id: 'x' }]) {
      const { failed } = await check(
        CreateCommercialConfigurationDto,
        createConfigPayload({ approvalApprover: 'CONFIGURED_USER', approverUserId })
      );
      expect({ approverUserId, failed }).toEqual({ approverUserId, failed: ['approverUserId'] });
    }
  });
});


describe('Phase GAP-8 — UpdateCommercialConfigurationDto.approverUserId (opaque, null clears)', () => {
  it('accepts an opaque replacement, and keeps null = "clear"', async () => {
    expect(
      (await check(UpdateCommercialConfigurationDto, { approverUserId: OPAQUE_ADMIN_ID })).failed
    ).toEqual([]);
    const cleared = await check(UpdateCommercialConfigurationDto, { approverUserId: null });
    expect(cleared.failed).toEqual([]);
    expect(cleared.instance.approverUserId).toBeNull();
  });

  it('refuses empty, over-long and non-string identities at the pipe', async () => {
    expect((await check(UpdateCommercialConfigurationDto, { approverUserId: '' })).failed).toEqual([
      'approverUserId',
    ]);
    expect(
      (await check(UpdateCommercialConfigurationDto, { approverUserId: 'i'.repeat(IDENTITY_MAX + 1) }))
        .failed
    ).toEqual(['approverUserId']);
    expect((await check(UpdateCommercialConfigurationDto, { approverUserId: 42 })).failed).toEqual([
      'approverUserId',
    ]);
  });
});

/**
 * REGRESSION GUARD (preflight §6.2): the opaque contract applies ONLY to platform-user
 * references. Commerce-OWNED row ids in this very file still require a UUID v4 —
 * widening them would let a caller address rows that cannot exist.
 */
describe('Phase GAP-8 — Commerce-owned ids in commercial.dto.ts stay UUID v4', () => {
  it('refuses a non-UUID commercialGroupId on an assignment rule', async () => {
    expect(
      (
        await check(
          CommercialAssignmentRuleInputDto,
          rule('not-a-uuid') as unknown as Record<string, unknown>
        )
      ).failed
    ).toEqual(['commercialGroupId']);
    expect(
      (await check(CommercialAssignmentRuleInputDto, rule() as unknown as Record<string, unknown>))
        .failed
    ).toEqual([]);
  });

  it('refuses a non-UUID documentId on the document-scoped read', async () => {
    expect((await check(CommercialDocumentQueryDto, { documentId: 'not-a-uuid' })).failed).toEqual([
      'documentId',
    ]);
    expect((await check(CommercialDocumentQueryDto, { documentId: UUID_ID })).failed).toEqual([]);
  });

  it('refuses a non-UUID lineId/groupId on a manual assignment', async () => {
    expect(
      (await check(CreateCommercialAssignmentDto, { lineId: 'not-a-uuid', groupId: UUID_ID })).failed
    ).toEqual(['lineId']);
    expect(
      (await check(CreateCommercialAssignmentDto, { lineId: UUID_ID, groupId: 'not-a-uuid' })).failed
    ).toEqual(['groupId']);
  });
});

