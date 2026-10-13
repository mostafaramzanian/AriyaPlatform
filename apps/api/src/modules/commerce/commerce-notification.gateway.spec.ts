import { ForbiddenException } from '@nestjs/common';
import { CommerceNotificationGateway } from './commerce-notification.gateway';

/**
 * GAP-9: the Commerce notification gateway's own contract.
 *
 * WHAT IS PINNED HERE, AND WHY IT IS THE GATEWAY'S BUSINESS
 * --------------------------------------------------------
 * The recipient RESOLUTION belongs to the calling Commerce service (each caller derives
 * its ids from the rows its own transition created) — but the rules that make those ids
 * SAFE and USEFUL are this file's, and they are the four a reviewer cannot see in a
 * service:
 *
 *  1. the exact caller-supplied ids reach Core, in order, deduplicated — one logical
 *     transition can never produce two rows for one user;
 *  2. the actor's `tenantId` travels as Core's tenant ASSERTION (Core refuses a recipient
 *     whose own tenant differs), which is what keeps tenant isolation Core-enforced;
 *  3. an empty list is a NO-OP, because "no authoritative recipient" must never become an
 *     invented one or an error;
 *  4. a Core refusal is REPORTED and SWALLOWED — the business transition has already
 *     committed by the time this runs, so an absent alert must not report it as failed.
 *
 * The Core side of every one of those rules (recipient existence, tenant snapshot, content
 * bounds) is exercised against the REAL service in
 * `test/commerce-gap9-notifications.e2e-spec.ts`.
 */

/** The two surfaces this gateway holds, taken from its own signature. */
type PublisherPort = ConstructorParameters<typeof CommerceNotificationGateway>[0];
type NotificationPort = ConstructorParameters<typeof CommerceNotificationGateway>[1];

interface CreateForUserInput {
  userId: string;
  tenantId?: string | null;
  type: string;
  title: string;
  body: string;
  sourceType?: string | null;
  sourceId?: string | null;
}

function build() {
  const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForUser: jest.fn() };
  notifications.createForUser.mockImplementation(async (input: CreateForUserInput) => ({
    id: `n-${input.userId}`,
    ...input,
  }));

  const gateway = new CommerceNotificationGateway(
    publisher as unknown as PublisherPort,
    notifications as unknown as NotificationPort
  );

  return { gateway, publisher, notifications };
}

const actor = {
  tenantId: 'tenant-a',
  userId: 'actor-1',
  requestId: 'request-1',
  correlationId: 'correlation-1',
};

/** Every input Core's creation path received, in call order. */
const coreInputs = (notifications: { createForUser: jest.Mock }): CreateForUserInput[] =>
  notifications.createForUser.mock.calls.map((call: unknown[]) => call[0] as CreateForUserInput);

describe('CommerceNotificationGateway — the user-addressed surface (GAP-9)', () => {
  it('hands Core the exact recipients, the actor tenant assertion and the caller content', async () => {
    const { gateway, notifications } = build();

    await gateway.notifyUsers(actor, ['owner-1', 'owner-2'], {
      type: 'INFORMATION',
      title: 'سند PR-1 منتظر تأیید شماست',
      body: 'سند خرید شماره PR-1 اکنون منتظر تصمیم شماست.',
      sourceType: 'purchase-document',
      sourceId: 'doc-1',
    });

    expect(coreInputs(notifications)).toEqual([
      {
        userId: 'owner-1',
        // The ASSERTION, from the actor — never a caller-supplied placement.
        tenantId: 'tenant-a',
        type: 'INFORMATION',
        title: 'سند PR-1 منتظر تأیید شماست',
        body: 'سند خرید شماره PR-1 اکنون منتظر تصمیم شماست.',
        sourceType: 'purchase-document',
        sourceId: 'doc-1',
      },
      {
        userId: 'owner-2',
        tenantId: 'tenant-a',
        type: 'INFORMATION',
        title: 'سند PR-1 منتظر تأیید شماست',
        body: 'سند خرید شماره PR-1 اکنون منتظر تصمیم شماست.',
        sourceType: 'purchase-document',
        sourceId: 'doc-1',
      },
    ]);
  });

  it('deduplicates recipients at the boundary — one transition, one row per user', async () => {
    const { gateway, notifications } = build();

    // Two domain paths that resolved the same owner, plus a blank id an upstream mapper
    // may leave behind: none of them may become a second row or an unknown-recipient call.
    await gateway.notifyUsers(actor, ['owner-1', 'owner-1', '', 'owner-1', 'owner-2'], {
      type: 'INFORMATION',
      title: 'ت',
      body: 'ب',
    });

    expect(coreInputs(notifications).map((input) => input.userId)).toEqual(['owner-1', 'owner-2']);
  });

  it('is a no-op when no authoritative recipient exists', async () => {
    const { gateway, notifications } = build();

    await gateway.notifyUsers(actor, [], { type: 'INFORMATION', title: 'ت', body: 'ب' });

    // No invented recipient, no error, no call.
    expect(notifications.createForUser).not.toHaveBeenCalled();
  });

  it('states a null source reference rather than an undefined one', async () => {
    const { gateway, notifications } = build();

    await gateway.notifyUsers(actor, ['owner-1'], { type: 'SYSTEM', title: 'ت', body: 'ب' });

    // Core normalises a missing reference to null; passing null keeps the call shape
    // explicit instead of relying on that.
    expect(coreInputs(notifications)[0]).toMatchObject({ sourceType: null, sourceId: null });
  });

  it('never fails the business operation: a Core refusal is reported, not thrown', async () => {
    const { gateway, notifications } = build();
    notifications.createForUser
      // The first recipient is refused exactly as Core refuses a cross-tenant recipient.
      .mockRejectedValueOnce(new ForbiddenException('Notification tenant does not match'))
      .mockImplementationOnce(async (input: CreateForUserInput) => ({ id: 'n-2', ...input }));

    await expect(
      gateway.notifyUsers(actor, ['foreign-tenant-user', 'owner-2'], {
        type: 'INFORMATION',
        title: 'ت',
        body: 'ب',
      })
    ).resolves.toBeUndefined();

    // The refused recipient did not stop the next one: every recipient is attempted.
    expect(coreInputs(notifications).map((input) => input.userId)).toEqual([
      'foreign-tenant-user',
      'owner-2',
    ]);
  });

  it('keeps the transport envelope behaviour unchanged (regression of the pre-GAP-9 surface)', async () => {
    const { gateway, publisher } = build();

    await gateway.publish(actor, 'commerce.purchase_document.submitted', {
      documentId: 'doc-1',
      // A payload that tries to displace a platform-owned key.
      tenantId: 'forged-tenant',
      correlationId: 'forged-correlation',
    });

    expect(publisher.publish).toHaveBeenCalledWith('commerce.purchase_document.submitted', {
      documentId: 'doc-1',
      tenantId: 'tenant-a',
      correlationId: 'correlation-1',
      emittedAt: expect.any(String),
    });
  });
});
