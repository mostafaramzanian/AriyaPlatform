import { Injectable } from '@nestjs/common';
import {
  TenantResolver,
  type TenantResolution,
  type TenantResolutionInput,
} from './tenant-resolver.contract';

/**
 * Phase 51-HR-ARCH-3A: the CLAIM-ONLY tenant resolver — what a standalone HR runtime
 * binds.
 *
 * The `tid` claim, and nothing else. No database, no user-directory lookup, no fallback:
 * a request whose token does not carry a tenant is resolved to NO tenant, and the module
 * above it refuses (HR's `resolveHrActor` throws 403 on an unresolved tenant).
 *
 * A `legacy-hmac` token resolves to no tenant here, deliberately. A shared-secret token
 * is not claim-authoritative, and this resolver has no other authority to consult, so
 * "no tenant" is the honest answer — and the fail-closed one. A runtime that binds this
 * resolver is therefore unusable with legacy tokens, which is correct: such a runtime is
 * the post-migration target, not a participant in the bridge.
 */
@Injectable()
export class ClaimsTenantResolver extends TenantResolver {
  async resolve(input: TenantResolutionInput): Promise<TenantResolution> {
    const claims = input.claims;

    if (claims?.trust === 'asymmetric' && claims.tid) {
      return { tenantId: claims.tid, source: 'claim' };
    }

    return { tenantId: null, source: 'none' };
  }
}