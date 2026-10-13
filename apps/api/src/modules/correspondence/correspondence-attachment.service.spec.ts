import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RequestContextService } from '../../common/request-context.service';
import type { CorrespondenceService } from './correspondence.service';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  CorrespondenceAttachmentService,
} from './correspondence-attachment.service';

/**
 * Phase 50: the ATTACHMENT-LIST contract. The listing endpoint must apply the
 * SAME letter-visibility predicate as every other read (it takes the predicate
 * from CorrespondenceService, never a weaker local one) and must project
 * METADATA ONLY — storageKey is a server secret and never crosses the boundary.
 * The full authorization matrix (recipient/referral/manager edges, cross-tenant
 * invisibility) is the letter predicate's own responsibility and is pinned by
 * the real-Postgres integration suite; this file pins what the LIST layer adds.
 */
describe('CorrespondenceAttachmentService.listForLetter', () => {
  const TENANT = 'tenant-1';
  const USER = 'user-1';
  const LETTER = '11111111-1111-4111-8111-111111111111';

  function makeService(rows: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const findFirst = jest.fn().mockResolvedValue({ id: LETTER });
    const prisma = {
      letter: { findFirst },
      letterAttachment: { findMany },
    };
    const correspondence = {
      visiblePredicateFor: jest
        .fn()
        .mockResolvedValue({ tenantId: TENANT, where: { OR: [{ senderId: USER }] } }),
    } as unknown as CorrespondenceService;
    const service = new CorrespondenceAttachmentService(
      prisma as never,
      {} as never,
      correspondence,
    );
    return { service, findMany, findFirst, correspondence };
  }

  function withContext(run: () => Promise<unknown>): Promise<unknown> {
    RequestContextService.set({
      requestId: 'req-1',
      correlationId: 'corr-1',
      startTime: Date.now(),
      userId: USER,
      tenantId: TENANT,
    });
    return run();
  }

  it('projects metadata ONLY — storageKey never appears in the result', async () => {
    const { service, findMany } = makeService([
      {
        id: 'att-1',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        storageKey: 'correspondence/x/y/report.pdf',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    await withContext(async () => {
      const result = await service.listForLetter(USER, LETTER);
      expect(result).toEqual([
        { id: 'att-1', fileName: 'report.pdf', mimeType: 'application/pdf', size: 1024 },
      ]);
    });

    // The query itself must not even select storageKey.
    const select = findMany.mock.calls[0][0].select as Record<string, unknown>;
    expect(Object.keys(select).sort()).toEqual(['fileName', 'id', 'mimeType', 'size']);
  });

  it('applies the SAME visibility predicate plus the tenant and throws 404 when the letter is invisible', async () => {
    const { service, findMany, findFirst, correspondence } = makeService([]);

    await withContext(async () => {
      await service.listForLetter(USER, LETTER);
    });

    expect(correspondence.visiblePredicateFor).toHaveBeenCalledWith(USER);
    // Letter existence edge: scoped by id + tenant + the caller's visibility
    // predicate — the SAME 404 contract as the letter detail and download paths.
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        AND: [{ id: LETTER, tenantId: TENANT }, { OR: [{ senderId: USER }] }],
      },
      select: { id: true },
    });
    // Attachments are queried only after the letter edge passed, by letterId.
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ letterId: LETTER });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });

    // The invisible-letter contract: no letter edge → 404, no attachment query.
    findFirst.mockResolvedValue(null);
    findMany.mockClear();
    await withContext(async () => {
      await expect(service.listForLetter(USER, LETTER)).rejects.toThrow(NotFoundException);
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses when the request context does not belong to the caller', async () => {
    const { service } = makeService([]);

    RequestContextService.set({
      requestId: 'req-2',
      correlationId: 'corr-2',
      startTime: Date.now(),
      userId: 'someone-else',
      tenantId: TENANT,
    });

    await expect(service.listForLetter(USER, LETTER)).rejects.toThrow(ForbiddenException);
  });

  it('refuses when there is no request context at all', async () => {
    const { service } = makeService([]);
    await expect(service.listForLetter(USER, LETTER)).rejects.toThrow(ForbiddenException);
  });
});

describe('ALLOWED_ATTACHMENT_MIME_TYPES', () => {
  it('is an allowlist and deliberately excludes SVG (executable document)', () => {
    expect(ALLOWED_ATTACHMENT_MIME_TYPES.has('image/svg+xml')).toBe(false);
    expect(ALLOWED_ATTACHMENT_MIME_TYPES.has('application/pdf')).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIME_TYPES.has('image/png')).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIME_TYPES.has('text/html')).toBe(false);
  });
});
