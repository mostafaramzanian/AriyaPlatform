import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
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
  verifyModuleRequest,
} from '../../module-platform/module-signature';
import {
  USER_DIRECTORY,
  type DirectoryUserProfile,
  type UserDirectoryContract,
} from '../user-directory/user-directory.contract';
import {
  IDENTITY_ROUTE_SEGMENTS,
  PLATFORM_IDENTITY_CONTRACT,
  IdentityProfilesRequestDto,
  IdentityUserRequestDto,
  type IdentityProfileResponse,
} from './identity.contract';

/**
 * Phase ARCH-3B (§7/§8): the `platform.identity@v1` TRANSPORT, owned by Core.
 *
 * WHY THIS CLASS IS THE POINT OF A7
 * ---------------------------------
 * The port (`user-directory.contract.ts`) and its Core adapter already existed, and HR already
 * consumes them IN-PROCESS through `HrIdentityGateway`. What did not exist is a way for a
 * business runtime that is a SEPARATE PROCESS to answer an identity question at all — so before
 * this file, `platform.identity@v1` was a declaration rather than a consumption point. This is
 * the route group A7 names: `/platform/v1/identity`, one route per `UserDirectoryContract`
 * operation, and nothing else.
 *
 * THE ORDER OF CHECKS IS THE SECURITY MODEL, and every step refuses rather than works around:
 *   1. the AUTH HEADERS are present — without a signature there is nothing to verify;
 *   2. the CAPABILITY CREDENTIAL is resolved through A8's seam for the ONE descriptor
 *      `platform.identity@v1`. An unknown module, an unknown capability, an expired envelope and
 *      an undecryptable one are ALL `undefined` and therefore all one uniform 401 — the resolver
 *      deliberately does not let this surface tell them apart;
 *   3. the TIMESTAMP is inside ±5 minutes and the HMAC matches over a canonical string that
 *      covers the moduleId, the requestId, THE TENANT and the body;
 *   4. the TENANT, when the operation is tenant-scoped, is the one that was SIGNED — never one
 *      read from the body;
 *   5. only then is the operation executed, against the port.
 *
 * WHY `@Public()`, AND WHY THAT IS NOT "UNAUTHENTICATED"
 * -----------------------------------------------------
 * `JwtAuthGuard` is registered globally (APP_GUARD), and a module has no Aria user to present, so
 * the JWT path is bypassed and authentication is the HMAC verified below — identically to
 * `ModuleRegistrationController`. The two controllers are separate classes for exactly this
 * reason: `@Public()` routes sitting among `@Roles()`-gated siblings is the shape in which a
 * later copy-paste ends up accidentally public.
 *
 * TENANT AUTHORITY COMES FROM CORE, NOT FROM THE SIGNATURE (A7, explicitly)
 * ------------------------------------------------------------------------
 * The signed `tid` says which tenant the CALLER claims; it "never substitutes for Core's own
 * membership check". So every tenant-scoped operation below passes the signed tenant to
 * `UserDirectoryContract`, which applies Core's own membership rule against `core_db`. There is
 * no membership logic in this file, and no second rule anywhere in this folder — a signature
 * that verified perfectly still cannot make a foreign id look like a member.
 *
 * WHY THERE IS NO PRISMA HERE
 * ---------------------------
 * This transport holds a credential resolver and a directory port. It imports neither
 * `PrismaService` nor `PrismaModule` (see `platform-identity.module.ts`), so no Core row can leak
 * through a DTO: the widest thing it can return is `DirectoryUserProfile`, the allowlist the port
 * already defines.
 *
 * THE RAW-BODY COMPROMISE, STATED IDENTICALLY TO 49M AND 49L
 * ---------------------------------------------------------
 * The signature is verified over `JSON.stringify(dto)` — the DTO AFTER validation — not over the
 * exact received bytes, because this application configures no raw-body parser and adding one
 * globally would change request handling for every existing route. `forbidNonWhitelisted`
 * guarantees no extra property survives validation, so the reconstruction is exact for any
 * well-formed sender. A sender must therefore serialise canonically (DTO field order, no extra
 * whitespace). Recorded as the same deferred hardening item the registration surface carries,
 * rather than described as byte-exact.
 */
/**
 * THE MOUNT, AND THE DOUBLE PREFIX, STATED ONCE HERE RATHER THAN DISCOVERED BY A CALLER
 * ------------------------------------------------------------------------------------
 * `main.ts` calls `app.setGlobalPrefix('api/v1')`, so these routes are reachable at
 * `/api/v1/platform/v1/identity/<segment>`. The `platform/v1` half is A7's route group and is kept
 * VERBATIM from the ADR (`IDENTITY_ROUTE_PREFIX` in `identity.contract.ts`) because it is the name a
 * consuming runtime writes into its client, and renaming it to avoid a cosmetic double-`v1` would
 * make the code disagree with the decision it implements. The `api/v1` half is the application-wide
 * prefix every existing route already carries (`/api/v1/modules/...`), so this surface is not a
 * special case and needs no prefix exemption.
 *
 * The signed `path` is the FULL request path, exactly as `ModuleRegistrationController` signs it,
 * so a client signs `/api/v1/platform/v1/identity/profiles` and not the bare segment.
 */
@Controller('platform/v1/identity')
export class PlatformIdentityController {
  private readonly logger = new Logger(PlatformIdentityController.name);

  constructor(
    /**
     * A8's ONE-METHOD seam. Not `ModuleRegistryService`: a transport that needs one read-only
     * question must not be able to admit modules, rotate credentials, read tenant scope or run
     * the sweep, and `module-platform.module.spec.ts` asserts that class stays unexported.
     */
    @Inject(CAPABILITY_CREDENTIAL_RESOLVER)
    private readonly credentials: CapabilityCredentialResolver,
    /** Core's own identity answer, and the only source of tenant authority on this surface. */
    @Inject(USER_DIRECTORY)
    private readonly directory: UserDirectoryContract
  ) {}

  /**
   * `findProfiles` (A5/A6): the batched projection for a whole page, ONE call per page.
   *
   * TENANT-BOUNDED AT THIS BOUNDARY, WHICH THE IN-PROCESS PORT IS NOT — and the asymmetry is the
   * point rather than an inconsistency. `findProfiles(userIds)` takes no tenant because its
   * in-process consumer (HR, through `HrIdentityGateway`) has already established membership at
   * WRITE time, when the employee was linked. A cross-runtime caller has established nothing:
   * presenting a valid `platform.identity@v1` credential would otherwise be enough to read the
   * names of ANY tenant's users, which is the cross-tenant leak A7's tenant-authority row and A5's
   * degradation rule exist to prevent. So the ids are intersected with the SIGNED tenant through
   * the port's own membership rule first, and the projection is read for the survivors only.
   *
   * `filterTenantMembers` answers IDS ONLY, so this costs one extra query and discloses nothing:
   * an id that is not a member is simply absent from the result, exactly as an id with no identity
   * is, and the caller renders `identity: null` for both. This route therefore cannot help a probe
   * distinguish "exists in another tenant" from "never existed".
   */
  @Public()
  @Post(IDENTITY_ROUTE_SEGMENTS.findProfiles)
  @HttpCode(200)
  async findProfiles(
    @Req() req: ExRequest,
    @Body() dto: IdentityProfilesRequestDto
  ): Promise<IdentityProfileResponse[]> {
    const { tenantId } = await this.authenticate(req, dto);

    const members = await this.directory.filterTenantMembers(tenantId, dto.userIds);
    if (members.length === 0) return [];

    const profiles = await this.directory.findProfiles(members);
    return profiles.map((profile) => this.toProfile(profile));
  }

  /**
   * `filterTenantMembers`: the membership check, and the only tenant-boundary answer on this wire.
   *
   * The tenant is the SIGNED one, never a body field — there is no `tenantId` in the DTO and
   * `forbidNonWhitelisted` means one cannot be smuggled in — so a caller cannot ask "are these ids
   * mine in tenant X?" for an X it holds no credential for.
   *
   * The answer is IDS ONLY, which is the property the port calls out as deliberate: the caller
   * learns which of its own ids are in its own tenant and nothing at all about the rest. A route
   * that returned the non-members, or a profile for them, would turn this into the existence
   * oracle an attacker uses to enumerate another tenant's accounts.
   */
  @Public()
  @Post(IDENTITY_ROUTE_SEGMENTS.filterTenantMembers)
  @HttpCode(200)
  async filterTenantMembers(
    @Req() req: ExRequest,
    @Body() dto: IdentityProfilesRequestDto
  ): Promise<string[]> {
    const { tenantId } = await this.authenticate(req, dto);

    return this.directory.filterTenantMembers(tenantId, dto.userIds);
  }

  /**
   * `findTenantMember`: one member of the SIGNED tenant, or `null`.
   *
   * `null` is a VALUE here, not an error, and the collapse is a security decision: "no such user"
   * and "exists but not in my tenant" are one answer, so a probe over this route cannot populate a
   * list of foreign account ids. That is why there is no 404 and no `FORBIDDEN` branch below.
   */
  @Public()
  @Post(IDENTITY_ROUTE_SEGMENTS.findTenantMember)
  @HttpCode(200)
  async findTenantMember(
    @Req() req: ExRequest,
    @Body() dto: IdentityUserRequestDto
  ): Promise<IdentityProfileResponse | null> {
    const { tenantId } = await this.authenticate(req, dto);

    const profile = await this.directory.findTenantMember(tenantId, dto.userId);
    return profile ? this.toProfile(profile) : null;
  }

  /**
   * `findTenantId`: the tenant of one user — ANSWERED AGAINST THE SIGNED TENANT.
   *
   * This is the one operation whose port form takes no tenant (`findTenantId(userId)`, for
   * background work that has no request context to read one from), and it is the one operation
   * that could therefore NOMINATE a foreign tenant. It does not: the answer is either the caller's
   * own signed tenant or `null`, decided by the port's membership rule, because a route that named
   * an arbitrary tenant for an arbitrary user id would be a cross-tenant disclosure and would make
   * every rule above decorative.
   *
   * The narrowing is stated rather than hidden: on this wire the operation confirms or denies that
   * a user is a member of the CALLER'S tenant, and never reveals where else a user might live. A
   * caller that genuinely needs "which tenant is this, globally?" is asking for a `@v2` (A2) with a
   * different authorization story, not for a flag on this route.
   *
   * The body is an OBJECT (`{ tenantId }`) rather than a bare string so that a future route cannot
   * be confused with this one by a client that keys on shape; the value is `null`-capable, which a
   * bare empty body could not express.
   */
  @Public()
  @Post(IDENTITY_ROUTE_SEGMENTS.findTenantId)
  @HttpCode(200)
  async findTenantId(
    @Req() req: ExRequest,
    @Body() dto: IdentityUserRequestDto
  ): Promise<{ tenantId: string | null }> {
    const { tenantId } = await this.authenticate(req, dto);

    const members = await this.directory.filterTenantMembers(tenantId, [dto.userId]);
    return { tenantId: members.length > 0 ? tenantId : null };
  }

  /**
   * The five-step verification, and the ONLY authentication in this controller.
   *
   * Returns the VERIFIED `(moduleId, tenantId)` pair, which is what every route above acts on —
   * so the runtime a request acts as is the one whose credential signed it, and the tenant it acts
   * for is the one that was SIGNED, never one named in a body field.
   *
   * WHY `tenantId` IS `string` AND NOT `string | null`, WHEN `ModuleSignatureIdentity` ALLOWS NULL
   * --------------------------------------------------------------------------------------------
   * `ModuleRegistrationController` signs `tenantId: null`, because a module's own registration is a
   * platform-level act rather than a tenant-scoped one. Every operation on THIS surface is
   * tenant-scoped: all four of the port's questions are about tenant membership or tenant
   * authority. So a missing tenant header is refused at step (1) rather than being signed as null,
   * and the null slot the signature scheme supports is simply never reachable here. That is
   * stricter than the scheme requires, and it is the correct direction to be strict in: a caller
   * that cannot state which tenant it is acting for cannot be given a tenant-bound answer.
   *
   * WHY THERE IS NO EXPIRY CHECK IN THIS METHOD
   * -------------------------------------------
   * `resolveCapabilityCredential` enforces expiry inside A8 and returns `undefined` for it, which
   * is why the seam exposes no expiry value for this file to interpret (see
   * `capability-credential.resolver.ts`). Four failure reasons — unknown module, unknown capability,
   * expired envelope, undecryptable envelope — arrive here as ONE `undefined`, and are therefore one
   * uniform 401. This surface cannot tell them apart, so neither can a caller probing it.
   */
  private async authenticate(
    req: ExRequest,
    body: unknown
  ): Promise<{ moduleId: string; tenantId: string }> {
    const presentedModuleId = this.header(req, MODULE_ID_HEADER);
    const presentedSignature = this.header(req, MODULE_SIGNATURE_HEADER);
    const timestamp = this.header(req, MODULE_TIMESTAMP_HEADER);
    const requestId = this.header(req, MODULE_REQUEST_HEADER);
    const presentedTenantId = this.header(req, MODULE_TENANT_HEADER);

    // (1) A signature, a signer identity and a tenant must all be present. Without a signature
    // there is nothing to verify; without a tenant there is no answer this surface may give.
    if (
      !presentedModuleId ||
      !presentedSignature ||
      !timestamp ||
      !requestId ||
      !presentedTenantId
    ) {
      this.reject('MISSING_HEADERS', {});
    }

    // (2) The caller must hold a usable credential for THIS capability. `platform.identity@v1` is
    // the only descriptor ever resolved here, so a credential issued for `platform.audit@v1` — the
    // sibling capability on the same A8 store — authenticates nothing on this surface. The two
    // transports are isolated by the descriptor, not by convention.
    const secret = await this.credentials.resolveCapabilityCredential(
      presentedModuleId,
      PLATFORM_IDENTITY_CONTRACT
    );

    if (!secret) {
      this.reject('CAPABILITY_DENIED', { moduleId: presentedModuleId });
    }

    // (3) The HMAC over the canonical request: method, path, timestamp, the caller id, the request
    // id, THE TENANT and the body. The tenant is inside the signature and not merely a header, so
    // it cannot be swapped after signing — which is what makes the tenant-bound answers above
    // trustworthy rather than merely declared.
    const verification = verifyModuleRequest(
      secret,
      {
        method: 'POST',
        path: req.path,
        timestamp,
        identity: {
          moduleId: presentedModuleId,
          requestId,
          tenantId: presentedTenantId,
        },
        body: JSON.stringify(body),
      },
      presentedSignature
    );

    if (!verification.ok) {
      this.reject(verification.reason ?? 'INVALID_SIGNATURE', { moduleId: presentedModuleId });
    }

    // (4) Tenant AUTHORITY is still not established — this only fixes which tenant was signed. The
    // routes above hand it to the port, which applies Core's own membership rule against `core_db`.
    return { moduleId: presentedModuleId, tenantId: presentedTenantId };
  }

  /** Case-insensitive single header read. Express lower-cases keys; be explicit anyway. */
  private header(req: ExRequest, name: string): string | undefined {
    const value = req.headers[name] ?? req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Logs the reason and throws a UNIFORM 401.
   *
   * Returns `never`, which is what lets the call sites above narrow: after `this.reject(...)`
   * TypeScript knows `secret` is a `string`, so no non-null assertion appears anywhere in this
   * file.
   *
   * The reason never reaches the caller. Nothing about the credential, the expected signature or
   * which of the checks failed is disclosed — this log line is the ONLY place a distinguishing
   * reason is recorded, and it names the module id rather than any credential material.
   */
  private reject(reason: string, context: Record<string, unknown>): never {
    this.logger.warn({ ...context, reason }, 'Platform identity request rejected');
    throw new UnauthorizedException('Platform identity request rejected');
  }
  /**
   * The response projection, applied EXPLICITLY rather than by returning the port's object.
   *
   * A7 states the response body is "the `DirectoryUserProfile` allowlist and nothing else, ever".
   * Today the port already honours that structurally, so this method is a no-op — and that is
   * exactly why it is written: it moves "and nothing else, ever" out of one adapter and into the
   * transport. If `DirectoryUserProfile` ever grows a field, or an adapter ever returns
   * `passwordHash`, `tokenVersion`, a role list or a credential column alongside the allowlist, it
   * does not reach the wire, because the six fields below are the only ones copied. A test asserts a
   * serialised body contains no credential-column name for that reason.
   *
   * `id` is copied first and unconditionally because it is the one non-nullable field; the rest are
   * copied as-is, `null` included, rather than defaulted — a nameless identity must render as
   * nameless and not as an empty string that looks like a name Core never had.
   *
   * The return type is the wire contract's `IdentityProfileResponse`, which is an alias of the port's
   * own projection rather than a second declaration: the compiler therefore fails here if the port and
   * the wire ever describe different shapes, instead of the wire silently widening.
   */
  private toProfile(profile: DirectoryUserProfile): IdentityProfileResponse {
    return {
      id: profile.id,
      firstName: profile.firstName,
      lastName: profile.lastName,
      avatarUrl: profile.avatarUrl,
      jobTitle: profile.jobTitle,
      department: profile.department,
    };
  }
}
