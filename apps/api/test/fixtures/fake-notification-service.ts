import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from '../../src/notifications/notification.service';

/**
 * GAP-9: the reusable, CONTRACT-DRIVEN double for the Core Notification Center's
 * server-side creation path.
 *
 * WHY IT IS A DOUBLE AND NOT THE REAL SERVICE, IN THE OLDER COMMERCE SUITES
 * -----------------------------------------------------------------------
 * The Commerce integration/lifecycle/tenant/search suites boot a trimmed graph over
 * `commerce_db` with in-memory PLATFORM ports (tenant resolver, directory, audit,
 * search source, publisher). The Core Notification Center owns `core_db`, so binding the
 * real service there would pull a second database into a suite whose subject is Commerce.
 * The dedicated GAP-9 e2e (`commerce-gap9-notifications.e2e-spec.ts`) is where the REAL
 * `NotificationService` runs against the real Core `Notification` table and a real
 * persisted row is asserted.
 *
 * WHAT MAKES IT HONEST
 * --------------------
 * It encodes the SAME FOUR rules the real `createForUser` enforces, in the same order,
 * with the same exception types and the same length bounds (imported from the real
 * service, not retyped):
 *
 *   1. the recipient must exist (`NotFoundException`) — no row for an unknown user;
 *   2. when the caller supplies `tenantId` it is an ASSERTION: it must equal the
 *      recipient's own tenant (`ForbiddenException`) — so a cross-tenant recipient can
 *      never be written, however the caller got the id;
 *   3. title/body are plain text within their bounds (`BadRequestException`);
 *   4. the row is stored under the RECIPIENT's tenant, never the caller's assertion.
 *
 * A Commerce harness therefore cannot pass while production would fail, and the negatives
 * GAP-9 has to prove — unknown recipient, cross-tenant recipient, markup — are exercised
 * through the same refusals Core raises. Every accepted row is recorded so a test can
 * assert recipient, tenant, content and count.
 */

/** One accepted creation, exactly as the fake stored it. */
export interface RecordedUserNotification {
  readonly userId: string;
  /** Always the RECIPIENT's tenant (rule 4) — the caller's assertion is not trusted. */
  readonly tenantId: string | null;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
}

/** The fake, plus the read-backs an assertion needs. */
export interface FakeNotificationService {
  createForUser(input: {
    userId: string;
    tenantId?: string | null;
    type: string;
    title: string;
    body: string;
    sourceType?: string | null;
    sourceId?: string | null;
  }): Promise<RecordedUserNotification>;
  /** Every accepted row, in creation order. */
  readonly created: RecordedUserNotification[];
  /** Rows for one recipient (and, when given, one source reference). */
  forUser(userId: string, sourceId?: string): RecordedUserNotification[];
  reset(): void;
}

function assertPlainText(value: string, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`Notification ${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new BadRequestException(`Notification ${field} exceeds ${max} characters`);
  }
  if (/[<>]/.test(trimmed)) {
    throw new BadRequestException(`Notification ${field} must be plain text`);
  }
  return trimmed;
}

/**
 * Builds the double over a `userId → tenantId` registry — the same map the Commerce
 * e2e harnesses already keep for the tenant resolver and the directory port, so a
 * recipient the harness knows about is a recipient this fake knows about. A user ABSENT
 * from the map is unknown to the fake and is refused exactly as Core refuses an
 * unseeded recipient, which is why a harness that wants an accepted notification must
 * register the recipient here.
 */
export function createFakeNotificationService(
  tenantRegistry: Map<string, string>
): FakeNotificationService {
  const created: RecordedUserNotification[] = [];

  return {
    created,

    async createForUser(input) {
      const tenantId = tenantRegistry.get(input.userId) ?? null;
      if (!tenantRegistry.has(input.userId)) {
        // Rule 1 — mirrors the real service's recipient lookup.
        throw new NotFoundException('Notification recipient not found');
      }

      // Rule 2 — the assertion, when present, must match the recipient.
      if (input.tenantId !== undefined && (input.tenantId ?? null) !== tenantId) {
        throw new ForbiddenException('Notification tenant does not match the recipient');
      }

      const row: RecordedUserNotification = {
        userId: input.userId,
        // Rule 4 — the recipient's own tenant is what is stored.
        tenantId,
        type: input.type,
        title: assertPlainText(input.title, 'title', MAX_TITLE_LENGTH),
        body: assertPlainText(input.body, 'body', MAX_BODY_LENGTH),
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      };
      created.push(row);
      return row;
    },

    forUser(userId: string, sourceId?: string) {
      return created.filter(
        (row) => row.userId === userId && (sourceId === undefined || row.sourceId === sourceId)
      );
    },

    reset() {
      created.length = 0;
    },
  };
}
