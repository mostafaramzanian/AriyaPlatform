import { Injectable } from '@nestjs/common';
import { PermissionSource } from '../../../platform/auth/permission-source.contract';
import type { TrustedTokenClaims } from '../../../platform/auth/token-contract';
import { PermissionService } from './permission.service';

/**
 * Phase 51-HR-ARCH-3A: Core's binding of the permission port — claim-first, catalogue
 * only for the migration bridge.
 *
 * THE RULE, IN ONE SENTENCE
 * -------------------------
 * An ASYMMETRIC token's permissions are the `perm` claim and nothing else; a LEGACY-HMAC
 * token's permissions are Core's cached catalogue, exactly as before this phase.
 *
 * WHY NOT "USE THE CLAIM WHEN IT IS PRESENT"
 * ------------------------------------------
 * Because a shared-secret token can carry an arbitrary `perm` claim, and its holder could
 * write any list into it. The distinction that matters is not whether a claim is present
 * but whether the token's TRUST LEVEL makes claims authoritative — and only the verifier
 * can establish that. A `perm` claim on a legacy token is therefore ignored, and the
 * database answer is used, which is also exactly what happened before this phase.
 *
 * WHY THIS CLASS STILL HOLDS A `PermissionService`
 * ------------------------------------------------
 * Because the combined runtime serves legacy tokens today. The claim-only implementation
 * that a standalone HR runtime binds is `TokenPermissionSource`, and the property that
 * matters — "at asymmetric trust, no Core query happens" — is asserted directly: this
 * class never reaches `PermissionService` on that path, and the integration suite proves
 * it with a Prisma spy that fails the test if it is touched.
 */
@Injectable()
export class CorePermissionSource extends PermissionSource {
  constructor(private readonly permissions: PermissionService) {
    super();
  }

  async getEffectivePermissions(
    userId: string,
    claims: TrustedTokenClaims | null,
  ): Promise<string[]> {
    if (claims?.trust === 'asymmetric') {
      return [...claims.perm];
    }

    return this.permissions.getUserPermissions(userId);
  }
}