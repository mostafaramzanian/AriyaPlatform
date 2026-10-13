import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { PlatformIdentityController } from './platform-identity.controller';
import {
  CAPABILITY_CREDENTIAL_RESOLVER,
  type CapabilityCredentialResolver,
} from '../../module-platform/capability-credential.resolver';
import {
  MODULE_ID_HEADER,
  MODULE_REQUEST_HEADER,
  MODULE_SIGNATURE_HEADER,
  MODULE_TENANT_HEADER,
  MODULE_TIMESTAMP_HEADER,
  signModuleRequest,
} from '../../module-platform/module-signature';
import {
  USER_DIRECTORY,
  type DirectoryUserProfile,
  type UserDirectoryContract,
} from '../user-directory/user-directory.contract';
import {
  IDENTITY_ROUTE_SEGMENTS,
  PLATFORM_IDENTITY_CONTRACT,
  type IdentityProfilesRequestDto,
  type IdentityUserRequestDto,
} from './identity.contract';

/**
 * Phase ARCH-3B (§7/§8): the `platform.identity@v1` TRANSPORT.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------------
 * The port's own rules (`findProfiles` returns what exists, `filterTenantMembers` returns ids
 * only) are tested in `user-directory.spec.ts` and are NOT re-asserted through this controller. The
 * adapter's SQL is not touched, because this layer never sees `PrismaService` at all. What is
 * asserted here is the thing the transport ADDS:
 *
 *  1. THE CAPABILITY IS THE GATE. A usable credential for `platform.identity@v1` is required and
 *     is the only descriptor ever resolved; the sibling `platform.audit@v1` credential on the same
 *     A8 store opens nothing here. Rejections are a uniform 401 and reach NO domain code — not even
 *     a tenant read.
 *  2. THE TENANT IS THE SIGNED ONE. It is inside the HMAC, so it cannot be swapped after signing,
 *     and it is what the port is asked about — there is no tenant field in any body.
 *  3. TENANT AUTHORITY IS STILL CORE'S. Every answer is narrowed to the signed tenant: a foreign id
 *     is absent rather than described, and `tenant-of-user` can never name a tenant other than the
 *     caller's own.
 *  4. THE RESPONSE IS AN ALLOWLIST, ENFORCED HERE. An adapter returning credential-adjacent columns
 *     alongside the profile does not put them on the wire.
 */

const SECRET = 'i'.repeat(64);
const AUDIT_SECRET = 'a'.repeat(64);

const MODULE = 'hr';
const TENANT = 'tenant-north';
/** A second tenant, used only to prove that a signed tenant cannot be swapped for another. */
const OTHER_TENANT = 'tenant-south';

/** Derived from the contract, so a renamed segment cannot silently pass this file. */
const PATHS = {
  findProfiles: `/api/v1/platform/v1/identity/${IDENTITY_ROUTE_SEGMENTS.findProfiles}`,
  filterTenantMembers: `/api/v1/platform/v1/identity/${IDENTITY_ROUTE_SEGMENTS.filterTenantMembers}`,
  findTenantMember: `/api/v1/platform/v1/identity/${IDENTITY_ROUTE_SEGMENTS.findTenantMember}`,
  findTenantId: `/api/v1/platform/v1/identity/${IDENTITY_ROUTE_SEGMENTS.findTenantId}`,
} as const;

/** The signed tenant's members, and the profiles Core holds for them. */
const MEMBERS = new Set(['u-1', 'u-2']);
const FOREIGN = 'u-foreign';

const profile = (
  id: string,
  overrides: Partial<DirectoryUserProfile> = {}
): DirectoryUserProfile => ({
  id,
  firstName: `First-${id}`,
  lastName: `Last-${id}`,
  avatarUrl: null,
  jobTitle: 'Engineer',
  department: 'Engineering',
  ...overrides,
});

const PROFILES: Record<string, DirectoryUserProfile> = {
  'u-1': profile('u-1'),
  'u-2': profile('u-2', { firstName: null, lastName: null, jobTitle: null, department: null }),
  [FOREIGN]: profile(FOREIGN),
};

/**
 * The two parts of an Express request this controller reads: `path` and `headers`.
 *
 * A cast is unavoidable — `ExRequest` carries an entire HTTP framework — but it is made ONCE, here,
 * and named, rather than `as any` at each call site. If the transport ever starts reading the base URL,
 * the query string or the raw body, the compiler points at this line instead of the request silently
 * arriving as `any` in a handful of tests.
 */
interface RequestStub {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

const asRequest = (stub: RequestStub): ExRequest => stub as unknown as ExRequest;

/**
 * Builds a request whose signature is CORRECT for the given body, path and tenant.
 *
 * The signature is produced with the SAME helper the transport verifies with, so a canonicalisation
 * change breaks this file instead of silently accepting a wrong signature. `tenantId: null` is
 * expressed by OMITTING the header, which is the only way a sender could try to sign the null slot
 * the scheme supports.
 */
const signedRequest = (
  body: unknown,
  overrides: {
    moduleId?: string;
    path?: string;
    tenantId?: string | null;
    timestamp?: string;
    secret?: string;
    requestId?: string;
  } = {}
) => {
  const moduleId = overrides.moduleId ?? MODULE;
  const path = overrides.path ?? PATHS.findProfiles;
  const tenantId = overrides.tenantId === undefined ? TENANT : overrides.tenantId;
  const timestamp = overrides.timestamp ?? String(Date.now());
  const requestId = overrides.requestId ?? 'req-1';

  const signature = signModuleRequest(overrides.secret ?? SECRET, {
    method: 'POST',
    path,
    timestamp,
    identity: { moduleId, requestId, tenantId },
    body: JSON.stringify(body),
  });

  return asRequest({
    path,
    headers: {
      [MODULE_ID_HEADER]: moduleId,
      [MODULE_SIGNATURE_HEADER]: signature,
      [MODULE_TIMESTAMP_HEADER]: timestamp,
      [MODULE_REQUEST_HEADER]: requestId,
      ...(tenantId === null ? {} : { [MODULE_TENANT_HEADER]: tenantId }),
    },
  });
};

describe('PlatformIdentityController', () => {
  let controller: PlatformIdentityController;
  let credentials: CapabilityCredentialResolver & { resolveCapabilityCredential: jest.Mock };
  let directory: UserDirectoryContract & {
    findProfiles: jest.Mock;
    filterTenantMembers: jest.Mock;
    findTenantMember: jest.Mock;
    findTenantId: jest.Mock;
  };

  beforeEach(async () => {
    // The resolver answers PER CAPABILITY, exactly as A8 does: the same module may hold several
    // credentials, and only the one matching the descriptor asked for comes back.
    credentials = {
      resolveCapabilityCredential: jest.fn(async (_moduleId: string, capability: string) =>
        capability === PLATFORM_IDENTITY_CONTRACT ? SECRET : AUDIT_SECRET
      ),
    };

    // An in-memory Core: membership and profiles, with the foreign id present in Core but NOT in
    // the caller's tenant. That is the state every leak test below needs.
    directory = {
      findProfiles: jest.fn(async (userIds: readonly string[]) =>
        userIds.filter((id) => PROFILES[id]).map((id) => PROFILES[id])
      ),
      filterTenantMembers: jest.fn(async (_tenantId: string, userIds: readonly string[]) =>
        userIds.filter((id) => MEMBERS.has(id))
      ),
      findTenantMember: jest.fn(async (_tenantId: string, userId: string) =>
        MEMBERS.has(userId) ? (PROFILES[userId] ?? null) : null
      ),
      findTenantId: jest.fn(async () => TENANT),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformIdentityController],
      providers: [
        { provide: CAPABILITY_CREDENTIAL_RESOLVER, useValue: credentials },
        { provide: USER_DIRECTORY, useValue: directory },
      ],
    }).compile();

    controller = moduleRef.get(PlatformIdentityController);
  });

  describe('the capability credential is the gate', () => {
    it('resolves the credential for platform.identity@v1 and for no other descriptor', async () => {
      const body = { userIds: ['u-1'] };

      await controller.findProfiles(signedRequest(body), body);

      expect(credentials.resolveCapabilityCredential).toHaveBeenCalledWith(
        MODULE,
        PLATFORM_IDENTITY_CONTRACT
      );
      expect(credentials.resolveCapabilityCredential).toHaveBeenCalledTimes(1);
    });

    it('refuses a module that holds only the sibling platform.audit@v1 credential', async () => {
      // A8 stores ONE credential per (module, capability). A module admitted for audit and not for
      // identity resolves to `undefined` for THIS descriptor, and the surface must fail closed
      // rather than fall back to any other credential that happens to verify.
      credentials.resolveCapabilityCredential.mockResolvedValue(undefined);

      const body = { userIds: ['u-1'] };

      await expect(
        controller.findProfiles(signedRequest(body, { secret: AUDIT_SECRET }), body)
      ).rejects.toThrow(UnauthorizedException);

      // The descriptor asked for is still the identity one, so isolation is by capability and not
      // by which secret a caller happens to hold.
      expect(credentials.resolveCapabilityCredential).toHaveBeenCalledWith(
        MODULE,
        PLATFORM_IDENTITY_CONTRACT
      );
      // No identity was read: a rejection cannot be mined for who exists.
      expect(directory.filterTenantMembers).not.toHaveBeenCalled();
      expect(directory.findProfiles).not.toHaveBeenCalled();
    });

    it('verifies with the IDENTITY credential, so an audit signature authenticates nothing', async () => {
      const body = { userIds: ['u-1'] };

      await expect(
        controller.findProfiles(signedRequest(body, { secret: AUDIT_SECRET }), body)
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a module with no credential at all, before any read', async () => {
      credentials.resolveCapabilityCredential.mockResolvedValue(undefined);

      const body = { userIds: ['u-1'] };

      await expect(controller.findProfiles(signedRequest(body), body)).rejects.toThrow(
        UnauthorizedException
      );
      expect(directory.findProfiles).not.toHaveBeenCalled();
    });
  });

  describe('the signature, the path and the tenant are bound to one request', () => {
    const body = () => ({ userIds: ['u-1'] });

    it('accepts a correctly signed request and answers for the signed tenant', async () => {
      const request = body();

      const response = await controller.findProfiles(signedRequest(request), request);

      expect(response).toEqual([PROFILES['u-1']]);
      expect(directory.filterTenantMembers).toHaveBeenCalledWith(TENANT, ['u-1']);
    });

    it('refuses every rejection with one identical 401', async () => {
      // An oracle that separates "unknown module" from "bad signature" from "expired credential"
      // tells an attacker which modules exist and which credentials are stale. `ModuleRegistration`
      // asserts the same property on its surface; this is the sibling assertion.
      const messages: string[] = [];
      const request = body();

      credentials.resolveCapabilityCredential.mockResolvedValue(undefined);
      await controller
        .findProfiles(signedRequest(request), request)
        .catch((err) => messages.push(err.message));

      credentials.resolveCapabilityCredential.mockResolvedValue(SECRET);
      await controller
        .findProfiles(signedRequest(request, { secret: AUDIT_SECRET }), request)
        .catch((err) => messages.push(err.message));

      await controller
        .findProfiles(
          signedRequest(request, { timestamp: String(Date.now() - 10 * 60 * 1000) }),
          request
        )
        .catch((err) => messages.push(err.message));

      expect(messages).toHaveLength(3);
      expect(new Set(messages).size).toBe(1);
    });

    it('refuses a request with no auth headers at all', async () => {
      await expect(
        controller.findProfiles(asRequest({ path: PATHS.findProfiles, headers: {} }), body())
      ).rejects.toThrow(UnauthorizedException);

      // Not even a credential lookup: an unsigned request cannot probe the registry.
      expect(credentials.resolveCapabilityCredential).not.toHaveBeenCalled();
      expect(directory.filterTenantMembers).not.toHaveBeenCalled();
    });

    it('refuses a request with no TENANT header', async () => {
      // The scheme can sign a `null` tenant, and this surface deliberately cannot use it: every
      // operation here is tenant-scoped, so "which tenant?" has no answer and the call is refused
      // rather than answered tenant-lessly.
      const request = body();

      await expect(
        controller.findProfiles(signedRequest(request, { tenantId: null }), request)
      ).rejects.toThrow(UnauthorizedException);
      expect(directory.findProfiles).not.toHaveBeenCalled();
    });

    it('refuses a signature over a DIFFERENT body', async () => {
      const signed = signedRequest(body());

      await expect(controller.findProfiles(signed, { userIds: [FOREIGN] })).rejects.toThrow(
        UnauthorizedException
      );
      expect(directory.findProfiles).not.toHaveBeenCalled();
    });

    it('cannot be replayed from one route onto another', async () => {
      // The PATH is inside the canonical string, so a `profiles` signature is not a
      // `tenant-members` signature.
      const request = body();
      const signedForProfiles = signedRequest(request);

      // The SAME signature against a DIFFERENT route, rebuilt through the one stub helper rather than
      // spread: a spread of an `ExRequest` is no longer the type this controller accepts, and turning
      // that into a cast would hide the very thing under test.
      const replayed = asRequest({
        path: PATHS.filterTenantMembers,
        headers: signedForProfiles.headers,
      });

      await expect(controller.filterTenantMembers(replayed, request)).rejects.toThrow(
        UnauthorizedException
      );
    });

    it('cannot have its tenant swapped after signing', async () => {
      // The tenant is a SIGNED value rather than a header the verifier trusts: presenting the same
      // signature with another tenant in the header must not verify, or the tenant-bound answers
      // below would be declarative rather than enforced.
      const request = body();
      const signed = signedRequest(request, { tenantId: TENANT });
      signed.headers[MODULE_TENANT_HEADER] = OTHER_TENANT;

      await expect(controller.findProfiles(signed, request)).rejects.toThrow(UnauthorizedException);
      expect(directory.filterTenantMembers).not.toHaveBeenCalled();
    });
  });

  describe("tenant authority is Core's, and every answer is narrowed to the signed tenant", () => {
    it('never describes a user outside the signed tenant, and never even fetches one', async () => {
      // THE ORDER MATTERS: membership is intersected FIRST, so the foreign profile is not loaded
      // and then filtered — it is never read at all. A later "filter before returning" refactor
      // would pass a leak test that only inspected the response, which is why the port call itself
      // is asserted.
      const request = { userIds: ['u-1', FOREIGN] };

      const response = await controller.findProfiles(
        signedRequest(request, { path: PATHS.findProfiles }),
        request
      );

      expect(response).toEqual([PROFILES['u-1']]);
      expect(directory.filterTenantMembers).toHaveBeenCalledWith(TENANT, ['u-1', FOREIGN]);
      expect(directory.findProfiles).toHaveBeenCalledWith(['u-1']);
    });

    it('answers an empty page when nothing requested is a member', async () => {
      const request = { userIds: [FOREIGN] };

      const response = await controller.findProfiles(
        signedRequest(request, { path: PATHS.findProfiles }),
        request
      );

      expect(response).toEqual([]);
      // `[]` is the honest answer and is NOT an error: an id that does not exist and an id that
      // exists in another tenant are indistinguishable to this caller, by design.
      expect(directory.findProfiles).not.toHaveBeenCalled();
    });

    it('takes the tenant from the signed header, never from the body', async () => {
      // A body cannot nominate a tenant: the field is not in the contract and the signed header is
      // the only source, so even a body carrying one is ignored rather than honoured. The cast names
      // the extra field explicitly — an object literal may not carry it, which is the property this
      // test relies on, so the smuggle has to be stated rather than typed in by accident.
      const request = {
        userIds: ['u-1'],
        tenantId: OTHER_TENANT,
      } as unknown as IdentityProfilesRequestDto;

      await controller.filterTenantMembers(
        signedRequest(request, { path: PATHS.filterTenantMembers }),
        request
      );

      expect(directory.filterTenantMembers).toHaveBeenCalledWith(TENANT, ['u-1']);
      expect(directory.filterTenantMembers).not.toHaveBeenCalledWith(OTHER_TENANT, ['u-1']);
    });

    it('answers membership as ids only', async () => {
      const request = { userIds: ['u-1', FOREIGN, 'u-2'] };

      const response = await controller.filterTenantMembers(
        signedRequest(request, { path: PATHS.filterTenantMembers }),
        request
      );

      expect(response).toEqual(['u-1', 'u-2']);
      // Strings, so this route cannot become a second, unprojected read path for profile data.
      expect(response.every((id) => typeof id === 'string')).toBe(true);
    });

    it('answers null for a foreign user rather than their profile', async () => {
      const request = { userId: FOREIGN };

      const response = await controller.findTenantMember(
        signedRequest(request, { path: PATHS.findTenantMember }),
        request
      );

      expect(response).toBeNull();
      expect(directory.findTenantMember).toHaveBeenCalledWith(TENANT, FOREIGN);
    });

    it('names the SIGNED tenant in tenant-of-user and consults no registry for it', async () => {
      // The interesting half is the negative: A7 fixes tenant authority as Core's own membership
      // check, so `findTenantId` on the port is not called at all — Core never asks a registry which
      // tenant a user belongs to.
      const request = { userId: 'u-1' };

      const response = await controller.findTenantId(
        signedRequest(request, { path: PATHS.findTenantId }),
        request
      );

      expect(response).toEqual({ tenantId: TENANT });
      expect(directory.findTenantId).not.toHaveBeenCalled();
    });

    it('cannot be made to name a foreign tenant through its body', async () => {
      // Same smuggle as the batched route above, against the single-id route's DTO.
      const request = {
        userId: 'u-1',
        tenantId: OTHER_TENANT,
      } as unknown as IdentityUserRequestDto;

      const response = await controller.findTenantId(
        signedRequest(request, { path: PATHS.findTenantId }),
        request
      );

      expect(response).toEqual({ tenantId: TENANT });
      expect(JSON.stringify(response)).not.toContain(OTHER_TENANT);
    });
  });

  describe('the response is an allowlist, not a projection of the adapter row', () => {
    /**
     * Property names that must never appear in a serialised transport response.
     *
     * `tenantId` is in the list deliberately: the responder knows the tenant, but it is the CALLER's
     * own tenant, already known to the caller, so returning it would only create a field for a
     * foreign tenant to be smuggled through later.
     */
    const FORBIDDEN = [
      'secretCiphertext',
      'secretIv',
      'secretAuthTag',
      'passwordHash',
      'password',
      'roles',
      'permissions',
      'tenantId',
      'membershipId',
      'deletedAt',
    ];

    const PROFILE_FIELDS = ['avatarUrl', 'department', 'firstName', 'id', 'jobTitle', 'lastName'];

    /** A row as a careless adapter could hand it over: the profile plus everything it joined to. */
    const polluted = {
      ...profile('u-1'),
      passwordHash: '$2b$10$LEAK',
      roles: ['SUPER_ADMIN'],
      permissions: ['admin.modules.manage'],
      tenantId: OTHER_TENANT,
      membershipId: 'm-1',
      deletedAt: null,
      secretCiphertext: 'cipher',
      secretIv: 'iv',
      secretAuthTag: 'tag',
    };

    it('serialises exactly the six profile fields and nothing else', async () => {
      // THE RUNTIME ASSERTION, not a documentation claim: the object handed to this layer carries
      // every credential-adjacent column, and the response must be free of them by CONSTRUCTION
      // rather than by the adapter remembering to be careful.
      directory.findProfiles.mockResolvedValue([polluted]);
      const request = { userIds: ['u-1'] };

      const response = await controller.findProfiles(signedRequest(request), request);

      expect(response).toEqual([profile('u-1')]);
      expect(Object.keys(response[0]).sort()).toEqual(PROFILE_FIELDS);

      const serialised = JSON.stringify(response);
      for (const forbidden of FORBIDDEN) {
        expect(serialised).not.toContain(forbidden);
      }
    });

    it('keeps a null field null rather than dropping it', async () => {
      // A dropped field and an absent field are different answers to a UI that renders "…" for
      // unknown and nothing for not-applicable, so the allowlist copies the key even when empty.
      const request = { userIds: ['u-2'] };

      const response = await controller.findProfiles(signedRequest(request), request);

      expect(response[0]).toEqual(PROFILES['u-2']);
      expect(Object.keys(response[0]).sort()).toEqual(PROFILE_FIELDS);
      expect(response[0].firstName).toBeNull();
    });

    it('projects the single-member answer through the same allowlist', async () => {
      directory.findTenantMember.mockResolvedValue(polluted);
      const request = { userId: 'u-1' };

      const response = await controller.findTenantMember(signedRequest(request), request);

      expect(response).toEqual(profile('u-1'));
    });
  });
});
