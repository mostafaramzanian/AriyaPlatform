import { Injectable } from '@nestjs/common';
import { PermissionSource } from './permission-source.contract';
import type { TrustedTokenClaims } from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the CLAIM-ONLY permission source — what a standalone HR runtime
 * binds.
 *
 * There is no database behind this class, and there never will be: it is the
 * implementation that makes "an extracted business runtime authorizes from the token"
 * true by construction rather than by discipline. It holds no Prisma client, imports no
 * Core module, and answers from the verified claims alone.
 *
 * WHY IT IS SHIPPED BEFORE THE RUNTIME THAT BINDS IT
 * -------------------------------------------------
 * Because the alternative is a promise. The combined runtime binds
 * `CorePermissionSource`, which needs Core's catalogue for legacy tokens; if this class
 * did not exist, "HR can authorize without Core" would be a claim about a binding that
 * nobody had written. It is unit-tested now, and a future `hr-app.module.ts` binds it
 * with one line.
 *
 * LEGACY TOKENS GET NOTHING HERE. A legacy token carries no authoritative permissions,
 * and this class has no catalogue to consult, so the answer is an empty authority set —
 * which denies every annotated route. A runtime that binds this source cannot be reached
 * with a shared-secret token and authorize successfully; that is the intended direction
 * of the failure.
 */
@Injectable()
export class TokenPermissionSource extends PermissionSource {
  async getEffectivePermissions(
    _userId: string,
    claims: TrustedTokenClaims | null,
  ): Promise<string[]> {
    if (claims?.trust !== 'asymmetric') return [];
    return [...claims.perm];
  }
}