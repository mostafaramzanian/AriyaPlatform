import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  TenantResolver,
  type TenantResolution,
  type TenantResolutionInput,
} from '../platform/auth/tenant-resolver.contract';

/**
 * Phase 51-HR-ARCH-3A: Core's binding of the tenant port — claim-first, database only for
 * the migration bridge.
 *
 * WHY THIS IS NOT "THE OLD CODE WITH AN IF"
 * -----------------------------------------
 * The old code was unconditional: every authenticated request read `User.tenantId` from
 * Core. This class resolves from the `tid` claim at asymmetric trust, so on the target
 * deployment the query does not happen at all — and because HR reads its tenant from
 * `RequestContextService`, which this feeds, HR's whole authorization path stops touching
 * Core without one line of HR code changing.
 *
 * The bridge branch is retained deliberately, and it is not a fallback: it is the
 * pre-migration answer for pre-migration tokens. A deployment on RS256 has no legacy
 * tokens to fall back TO, because HMAC acceptance is disabled the moment asymmetric
 * material is configured (`TokenPolicy.legacyAccepted`).
 *
 * `source` is reported rather than inferred so "no query happened" is assertable. The
 * suite that proves HR's path is Core-free asserts `source === 'claim'`.
 */
@Injectable()
export class CoreTenantResolver extends TenantResolver {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async resolve(input: TenantResolutionInput): Promise<TenantResolution> {
    const claims = input.claims;

    if (claims?.trust === 'asymmetric') {
      return claims.tid
        ? { tenantId: claims.tid, source: 'claim' }
        : { tenantId: null, source: 'none' };
    }

    if (!input.userId) {
      return { tenantId: null, source: 'none' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { tenantId: true },
    });

    return { tenantId: user?.tenantId ?? null, source: 'core-database' };
  }
}