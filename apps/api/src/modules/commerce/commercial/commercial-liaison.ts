import { BadRequestException, Injectable } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { COMMERCIAL_FAILURE } from './commercial.constants';
import type { CommercialApprovalApprover } from './commercial-status';

/**
 * Phase C1 Step P (P1, P10, §3-K): the ONE place a commercial liaison is resolved.
 *
 * THE PATH IS CLOSED AND IT IS THE IDENTITY GATEWAY'S
 * --------------------------------------------------
 * Commercial Group → configured opaque `userId` → `CommerceIdentityGateway` →
 * `USER_DIRECTORY` validation. There is no second path: no Core Prisma, no HR Prisma, no
 * `user` table, no `RoleHolderDirectory`, no manager shortcut. `USER_DIRECTORY` is
 * injected exactly once in this module (`commerce-identity.gateway.ts`) and this file
 * reaches it only through that gateway, which is what keeps gate I7's single-consumer
 * claim true after P adds two more consumers.
 *
 * FAILURES ARE NAMED AND NEVER FALL BACK (§3-K)
 * ---------------------------------------------
 *  - no `liaisonUserId` configured          → `COMMERCIAL_LIAISON_NOT_CONFIGURED`
 *  - configured user is not a tenant member → `COMMERCIAL_LIAISON_NOT_TENANT_MEMBER`
 *
 * Both REFUSE the operation. There is no "first admin", no "the requester", no
 * "whoever is available": a fallback user would make §3-C's stored `resolvedUserId` a
 * value the configuration never stated, and history would then claim somebody was
 * responsible who never was.
 *
 * WHY THE GATEWAY'S `BadRequestException` IS MATCHED PRECISELY
 * ------------------------------------------------------------
 * `assertMember` refuses with one documented message and nothing else. Re-throwing
 * *any* `BadRequestException` as `…NOT_TENANT_MEMBER` would re-label an unrelated
 * failure, so the match is on that message: a directory fault keeps its own error and
 * reaches the caller as what it is.
 */

/** The group shape resolution needs — structural, so no generated client is imported. */
export interface CommercialLiaisonGroup {
  readonly id: string;
  readonly liaisonUserId: string | null;
}

/** The exact refusal `CommerceIdentityGateway.assertMember` produces (its own doc). */
const NOT_A_TENANT_MEMBER = 'userId is not a member of this tenant';

/**
 * Reads the gateway's refusal off the RESPONSE rather than off `error.message`.
 *
 * `BadRequestException` may be constructed with a string (as the gateway does) or an
 * object (as this file does); Nest normalises both into a response body, and only
 * `getResponse()` is guaranteed to expose the original message either way. Matching on
 * a string the exception class happens to build would make the single-consumer
 * assertion depend on Nest's internals rather than on the gateway's own contract.
 */
function isNotATenantMemberRefusal(error: BadRequestException): boolean {
  const body = error.getResponse();
  if (typeof body === 'string') return body === NOT_A_TENANT_MEMBER;
  const message = (body as { readonly message?: unknown }).message;
  return message === NOT_A_TENANT_MEMBER;
}

@Injectable()
export class CommercialLiaisonResolver {
  constructor(private readonly identity: CommerceIdentityGateway) {}

  /**
   * The configured liaison of a group, validated as a tenant member — §3-K's rule, in
   * one method, so both the assignment trigger and the configuration service answer
   * "who is the liaison?" identically.
   */
  async resolveGroupLiaison(
    actor: CommerceActor,
    group: CommercialLiaisonGroup,
    purpose: string
  ): Promise<string> {
    if (!group.liaisonUserId) {
      throw new BadRequestException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_LIAISON_NOT_CONFIGURED,
        message: `Commercial group ${group.id} has no configured liaison (${purpose}).`,
      });
    }

    await this.assertTenantMember(actor, group.liaisonUserId, purpose);
    return group.liaisonUserId;
  }

  /**
   * A configured identity may only be used inside the ACTOR'S tenant — the same check
   * `assertMember` performs, reported with the commercial vocabulary so a caller learns
   * WHICH configured identity was wrong rather than "some userId".
   */
  async assertTenantMember(actor: CommerceActor, userId: string, purpose: string): Promise<void> {
    if (!(await this.isTenantMember(actor, userId))) {
      throw new BadRequestException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_LIAISON_NOT_TENANT_MEMBER,
        message: `The configured user for ${purpose} is not a member of this tenant.`,
      });
    }
  }

  /**
   * The same question as a BOOLEAN, for the caller that must report a checklist failure
   * rather than a resolution failure (§7.5 asks "is this approver a tenant member?" and
   * §7 answers it with `COMMERCIAL_CONFIGURATION_INVALID`, not with §3-K's liaison
   * code — so the two callers need the fact without this class choosing the error).
   *
   * A directory FAULT is not an answer and is rethrown unchanged: a timeout must never
   * be read as "not a member", which would refuse a publish for an infrastructure
   * reason and leave an administrator chasing the wrong problem.
   */
  async isTenantMember(actor: CommerceActor, userId: string): Promise<boolean> {
    try {
      await this.identity.assertMember(actor, userId);
      return true;
    } catch (error) {
      if (error instanceof BadRequestException && isNotATenantMemberRefusal(error)) return false;
      throw error;
    }
  }

  /**
   * §3-G's approver resolution AT ACTIVATION. The stored configuration states HOW, and
   * the resolution itself is always one of the two executable answers (P10):
   *
   *  - `LINE_COMMERCIAL_LIAISON` → the line's CURRENT assignment user. It was resolved
   *    and validated when the assignment happened; it is re-validated here because
   *    §3-G says "validated through the gateway" at activation too, and a member who
   *    left the tenant between assignment and activation must not become an approver.
   *  - `CONFIGURED_USER`          → the configuration's own `approverUserId`, validated
   *    at publish (§7.5) and again here (§3-G).
   *
   * `assignmentUserId` is handed in rather than looked up: the caller already read the
   * line's current row, and a resolver that read it again could resolve against a
   * different moment than the one it was asked about.
   */
  async resolveApprovalApprover(
    actor: CommerceActor,
    approver: CommercialApprovalApprover,
    input: { readonly approverUserId: string | null; readonly assignmentUserId: string | null },
    purpose: string
  ): Promise<string> {
    const userId =
      approver === 'LINE_COMMERCIAL_LIAISON' ? input.assignmentUserId : input.approverUserId;

    if (!userId) {
      throw new BadRequestException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_LIAISON_NOT_CONFIGURED,
        message: `No ${approver} identity is configured for ${purpose}.`,
      });
    }

    await this.assertTenantMember(actor, userId, purpose);
    return userId;
  }
}
