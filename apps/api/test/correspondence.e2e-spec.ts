import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/database/prisma.module';
// Phase 50-MOD-CORR: the module moved out of Core, owns its own database and its own
// scheduler. Users/tenants stay in CORE (the spec seeds them through PrismaService);
// letters live in correspondence_db and are read through the module's own client.
import { CorrespondenceModule } from '../src/modules/correspondence/correspondence.module';
import { CorrespondenceService } from '../src/modules/correspondence/correspondence.service';
import { CorrespondencePrismaService } from '../src/modules/correspondence/database/correspondence-prisma.service';
import {
  MAX_SEND_ATTEMPTS,
  ScheduledSendDispatcherService,
} from '../src/modules/correspondence/jobs/scheduled-send.dispatcher';
import { instantToJalaliDate } from '../src/calendar/jalali.util';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

/**
 * Phase 50 — Official Correspondence E2E against the real Core database, real
 * MinIO and the real authorization stack.
 *
 * Modelled exactly on surveys.e2e-spec.ts (49H)/messaging.e2e-spec.ts (49F): a
 * minimal test guard supplies identity in a header, the REAL
 * TenantContextInterceptor resolves tenant from the database, and the REAL
 * RolesGuard + PermissionService enforce the one @Roles gate
 * (`correspondence.manage`). Nothing about authorization, tenant scope or object
 * storage is stubbed — attachments go to the REAL MinIO configured by
 * test/jest-setup.ts (MINIO_* from .env.e2e).
 *
 * Actors, each proving a different edge:
 *   sender    — author of every fixture letter (SENDER edge).
 *   recipient — TO recipient (need-to-know edge).
 *   bccUser   — BCC recipient (own-row-only privacy edge).
 *   stranger  — same tenant, NO edge on any fixture letter.
 *   foreign   — a second tenant (structural invisibility).
 */
class CorrTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

/** Fields that must never appear on a projected letter. */
const FORBIDDEN_LETTER_FIELDS = ['tenantId', 'senderId', 'bodyHtml'];

describe('Correspondence E2E (draft lifecycle, idempotency, numbering, tenant isolation, BCC privacy, attachments, archive, search, referral)', () => {
  let app: INestApplication;
  /** CORE client — identity only (users, tenants, roles). */
  let prisma: PrismaService;
  /** The module's OWN client — letters and everything that hangs off them. */
  let corrDb: CorrespondencePrismaService;
  let dispatcher: ScheduledSendDispatcherService;
  let correspondenceService: CorrespondenceService;

  const now = Date.now();

  let tenantAId: string;
  let tenantBId: string;
  const createdUsers: string[] = [];
  const createdLetterIds: string[] = [];
  const createdFolderIds: string[] = [];

  let senderId: string;
  let recipientId: string;
  let bccId: string;
  let strangerId: string;
  let stranger2Id: string;
  let foreignId: string;

  let letterSentId: string;
  let letterSentNumber: string;
  let letterToStrangerId: string;
  let letterToStrangerNumber: string;
  let letterAttachedDraftId: string;
  let letterAttachedId: string;
  let attachmentId: string;
  let draftForeverId: string;

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `corr-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    createdUsers.push(user.id);
    return user;
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const post = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).post(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const patch = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).patch(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const del = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).delete(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  /** Creates a DRAFT through the public route. */
  const createDraft = async (callerId: string, overrides: Record<string, unknown> = {}) => {
    const res = await post('/correspondence/drafts', callerId).send({
      subject: `نامه آزمایشی E2E ${now}`,
      body: '<p>متن نامه آزمایشی E2E.</p>',
      ...overrides,
    });
    expect(res.status).toBe(201);
    createdLetterIds.push(res.body.id);
    return res.body;
  };

  const updateDraft = (callerId: string, letterId: string, payload: Record<string, unknown>) =>
    patch(`/correspondence/drafts/${letterId}`, callerId).send(payload);

  const sendDraft = (callerId: string, letterId: string, sendKey: string) =>
    post(`/correspondence/drafts/${letterId}/send`, callerId).send({ sendKey });

  const letterNumberCounter = (letterNumber: string) => Number(letterNumber.split('-')[2]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [CorrespondenceModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: CorrTestGuard },
        // The REAL RolesGuard, so the one @Roles(...) gate (classification) is
        // genuinely enforced against the seeded grants.
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors: ValidationError[]) =>
          new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: errors.length,
          }),
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    corrDb = app.get(CorrespondencePrismaService);
    dispatcher = app.get(ScheduledSendDispatcherService);
    correspondenceService = app.get(CorrespondenceService);

    const tenantA = await prisma.tenant.create({ data: { code: `corr-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `corr-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    senderId = (await makeUser({ tenantId: tenantAId, firstName: 'فرستنده', lastName: 'آزمون' })).id;
    recipientId = (await makeUser({ tenantId: tenantAId, firstName: 'گیرنده', lastName: 'آزمون' })).id;
    bccId = (await makeUser({ tenantId: tenantAId, firstName: 'مخفی', lastName: 'آزمون' })).id;
    // Never contacted by anyone — a true no-edge identity for referral refusal.
    stranger2Id = (await makeUser({ tenantId: tenantAId, firstName: 'غریبه ۲', lastName: 'آزمون' })).id;

    strangerId = (await makeUser({ tenantId: tenantAId, firstName: 'غریبه', lastName: 'آزمون' })).id;
    foreignId = (await makeUser({ tenantId: tenantBId, firstName: 'خارجی', lastName: 'مستأجر دیگر' })).id;

    // letterSent: the shared SENT letter (TO recipient + BCC recipient).
    const letterSent = await createDraft(senderId, { subject: `نامه ارسالی مشترک E2E ${now}` });
    letterSentId = letterSent.id;
    await updateDraft(senderId, letterSentId, {
      recipientIds: [recipientId],
      bccIds: [bccId],
    });
    const sent = await sendDraft(senderId, letterSentId, `corr-e2e-${now}-1`);
    expect(sent.status).toBe(200);
    letterSentNumber = sent.body.letterNumber;

    // letterToStranger: gives the stranger a REAL need-to-know edge (search).
    const letterToStranger = await createDraft(senderId, {
      subject: `نامه مخصوص غریبه E2E ${now}`,
    });
    letterToStrangerId = letterToStranger.id;
    await updateDraft(senderId, letterToStrangerId, { recipientIds: [strangerId] });
    const sent2 = await sendDraft(senderId, letterToStrangerId, `corr-e2e-${now}-2`);
    expect(sent2.status).toBe(200);
    letterToStrangerNumber = sent2.body.letterNumber;

    // letterAttached: starts as a DRAFT (the upload gate is DRAFT-only).
    letterAttachedDraftId = (
      await createDraft(senderId, { subject: `نامه پیوست‌دار E2E ${now}` })
    ).id;

    // draftForever: never sent — for the SENT-only lifecycle gates.
    draftForeverId = (
      await createDraft(senderId, { subject: `پیش‌نویس بی‌گیرنده E2E ${now}` })
    ).id;
  });

  // 1 — create draft
  it('creates a DRAFT with no letter number and a clean projection', async () => {
    const letter = await createDraft(senderId, { subject: `ایجاد پیش‌نویس E2E ${now}` });
    expect(letter.status).toBe('DRAFT');
    expect(letter.letterNumber).toBeNull();
    for (const field of FORBIDDEN_LETTER_FIELDS) {
      expect(letter).not.toHaveProperty(field);
    }
    expect(letter.sender.id).toBe(senderId);
  });

  // 2 — update draft + recipient validation
  it('updates MY draft and rejects a cross-tenant recipient wholesale', async () => {
    const updated = await updateDraft(senderId, draftForeverId, {
      subject: `پیش‌نویس ویرایش‌شده E2E ${now}`,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.subject).toContain('ویرایش‌شده');

    const rejected = await updateDraft(senderId, draftForeverId, {
      recipientIds: [foreignId],
    });
    expect(rejected.status).toBe(400);

    // Whole-request rejection: no partial recipient row may exist.
    const rows = await corrDb.letterRecipient.count({ where: { letterId: draftForeverId } });
    expect(rows).toBe(0);
  });

  // 3 — send + server letter numbering
  it('sends a draft, mints the number SERVER-side, and refuses identity spoofing', async () => {
    expect(letterSentNumber).toMatch(/^AR-\d{4}-\d{5}$/);
    const letter = await get(`/correspondence/${letterSentId}`, senderId);
    expect(letter.status).toBe(200);
    expect(letter.body.status).toBe('SENT');
    expect(letter.body.letterNumber).toBe(letterSentNumber);

    // A client-injected senderId/tenantId is rejected by forbidNonWhitelisted.
    const spoofed = await post('/correspondence/drafts', senderId).send({
      subject: `دستکاری هویت E2E ${now}`,
      body: '<p>spoof</p>',
      senderId: foreignId,
      tenantId: tenantBId,
    });
    expect([400, 422]).toContain(spoofed.status);
  });

  // 4 — send idempotency
  it('replays the SAME sendKey into the SAME letter — exactly one logical send', async () => {
    const replay = await sendDraft(senderId, letterSentId, `corr-e2e-${now}-1`);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(letterSentId);
    expect(replay.body.letterNumber).toBe(letterSentNumber);

    // No duplicate Letter row, and exactly ONE SENT tracking event.
    const letterCount = await corrDb.letter.count({ where: { id: letterSentId } });
    expect(letterCount).toBe(1);
    const sentEvents = await corrDb.letterTrackingEvent.count({
      where: { letterId: letterSentId, type: 'SENT' },
    });
    expect(sentEvents).toBe(1);
  });

  // 5 — numbering is sequential per tenant
  it('mints strictly increasing numbers for consecutive sends in one tenant', async () => {
    const first = letterNumberCounter(letterSentNumber);
    const second = letterNumberCounter(letterToStrangerNumber);
    expect(second).toBeGreaterThan(first);
  });

  // 6 — same-tenant authorized access (sender + recipient edges)
  it('gives the SENDER and the TO recipient full read access to the sent letter', async () => {
    for (const [userId, edge] of [
      [senderId, 'SENDER'],
      [recipientId, 'RECIPIENT'],
    ] as const) {
      const detail = await get(`/correspondence/${letterSentId}`, userId);
      expect(detail.status).toBe(200);
      expect(detail.body.viewerEdge).toBe(edge);

      const content = await get(`/correspondence/${letterSentId}/content`, userId);
      expect(content.status).toBe(200);
      expect(content.body.bodyHtml).toBeTruthy();
      expect(Array.isArray(content.body.attachments)).toBe(true);
    }
  });

  // 7 — same-tenant unauthorized access
  it('gives a same-tenant stranger NOTHING (404, indistinguishable from nonexistent)', async () => {
    expect((await get(`/correspondence/${letterSentId}`, strangerId)).status).toBe(404);
    expect((await get(`/correspondence/${letterSentId}/content`, strangerId)).status).toBe(404);
    expect((await get(`/correspondence/${letterSentId}/attachments`, strangerId)).status).toBe(404);
    expect((await get(`/correspondence/${letterSentId}/referrals`, strangerId)).status).toBe(404);
  });

  // 8 — cross-tenant isolation
  it('is structurally invisible to a second tenant (letter, list, tracking)', async () => {
    expect((await get(`/correspondence/${letterSentId}`, foreignId)).status).toBe(404);
    expect((await get(`/correspondence/${letterSentId}/attachments`, foreignId)).status).toBe(404);
    expect((await get(`/correspondence/${letterSentId}/tracking`, foreignId)).status).toBe(404);
  });

  // 9 — BCC privacy (projection rule)
  it('shows BCC identities ONLY to the sender — never to TO or BCC recipients', async () => {
    const toView = await get(`/correspondence/${letterSentId}/content`, recipientId);
    expect(toView.status).toBe(200);
    expect(toView.body.canSeeBcc).toBe(false);
    const toRows = toView.body.recipients as Array<{ kind: string; user: { id: string } }>;
    expect(toRows.some((row) => row.kind === 'BCC')).toBe(false);
    expect(toRows.some((row) => row.user.id === bccId)).toBe(false);
    expect(toRows.some((row) => row.user.id === recipientId)).toBe(true);

    const bccView = await get(`/correspondence/${letterSentId}/content`, bccId);
    expect(bccView.status).toBe(200);
    expect(bccView.body.canSeeBcc).toBe(false);
    const bccRows = bccView.body.recipients as Array<{ kind: string; user: { id: string } }>;
    // Own row so their BCC state renders, PLUS the public TO row — and never
    // another BCC entry.
    expect(bccRows).toHaveLength(2);
    expect(bccRows.filter((row) => row.kind === 'BCC')).toHaveLength(1);
    expect(bccRows.find((row) => row.kind === 'BCC')?.user.id).toBe(bccId);
    expect(bccRows.every((row) => row.user.id === bccId || row.user.id === recipientId)).toBe(
      true,
    );

    const senderView = await get(`/correspondence/${letterSentId}/content`, senderId);
    expect(senderView.status).toBe(200);
    expect(senderView.body.canSeeBcc).toBe(true);
    const senderRows = senderView.body.recipients as Array<{
      kind: string;
      user: { id: string };
    }>;
    expect(senderRows.some((row) => row.kind === 'BCC' && row.user.id === bccId)).toBe(true);
  });

  // 10 — attachment upload to MY draft (real MinIO, metadata-only response)
  it('uploads an attachment to MY draft and returns metadata ONLY', async () => {
    const pdf = Buffer.from('%PDF-1.4 correspondence e2e fixture', 'utf8');
    const upload = await post('/correspondence/attachments', senderId)
      .field('letterId', letterAttachedDraftId)
      .attach('file', pdf, { filename: 'e2e-attachment.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    expect(upload.body.fileName).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(upload.body.mimeType).toBe('application/pdf');
    expect(upload.body.size).toBe(pdf.length);
    expect(upload.body).not.toHaveProperty('storageKey');
    attachmentId = upload.body.id;

    // The storage key is a server secret; the row must carry it, the API must not.
    const row = await corrDb.letterAttachment.findFirst({ where: { id: attachmentId } });
    expect(row?.storageKey).toContain('correspondence/');
  });

  // 11 — upload-after-send is refused (the DRAFT gate)
  it('refuses uploading to a letter that is no longer editable', async () => {
    // Send the attachment letter first.
    await updateDraft(senderId, letterAttachedDraftId, { recipientIds: [recipientId] });
    const sent = await sendDraft(senderId, letterAttachedDraftId, `corr-e2e-${now}-3`);
    expect(sent.status).toBe(200);
    letterAttachedId = letterAttachedDraftId;

    const pdf = Buffer.from('%PDF-1.4 late upload attempt', 'utf8');
    const late = await post('/correspondence/attachments', senderId)
      .field('letterId', letterAttachedId)
      .attach('file', pdf, { filename: 'late-upload.pdf', contentType: 'application/pdf' });
    expect(late.status).toBe(404);
  });

  // 12 — attachment list (authorized, metadata only)
  it('lists a letter attachment with metadata ONLY for entitled viewers', async () => {
    for (const userId of [senderId, recipientId]) {
      const list = await get(`/correspondence/${letterAttachedId}/attachments`, userId);
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body).toHaveLength(1);
      expect(Object.keys(list.body[0]).sort()).toEqual(['fileName', 'id', 'mimeType', 'size']);
      expect(JSON.stringify(list.body)).not.toContain('storageKey');
    }
  });

  // 13 — attachment list authorization
  it('refuses the attachment list to a stranger and to another tenant (404)', async () => {
    expect(
      (await get(`/correspondence/${letterAttachedId}/attachments`, strangerId)).status,
    ).toBe(404);
    expect(
      (await get(`/correspondence/${letterAttachedId}/attachments`, foreignId)).status,
    ).toBe(404);
  });

  // 14 — attachment download authorization
  it('mints the download URL ONLY for entitled viewers; storageKey never crosses', async () => {
    for (const userId of [senderId, recipientId]) {
      const download = await get(`/correspondence/attachments/${attachmentId}/download`, userId);
      expect(download.status).toBe(200);
      expect(download.body.url).toMatch(/^http/);
      expect(download.body.fileName).toBeTruthy();
      expect(download.body).not.toHaveProperty('storageKey');
    }

    expect(
      (await get(`/correspondence/attachments/${attachmentId}/download`, strangerId)).status,
    ).toBe(404);
    expect(
      (await get(`/correspondence/attachments/${attachmentId}/download`, foreignId)).status,
    ).toBe(404);
  });

  // 15 — search authorization + filtering
  it('scopes search to the caller visibility and honors the filters', async () => {
    // The sender finds their own letter by exact number.
    const byNumber = await get(
      `/correspondence/search?letterNumber=${encodeURIComponent(letterSentNumber)}&limit=10`,
      senderId,
    );
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.items.some((row: { id: string }) => row.id === letterSentId)).toBe(true);

    // The stranger finds ONLY the letter addressed to them.
    const strangerSearch = await get(
      `/correspondence/search?q=${encodeURIComponent(`نامه مخصوص غریبه E2E ${now}`)}&limit=10`,
      strangerId,
    );
    expect(strangerSearch.status).toBe(200);
    expect(strangerSearch.body.items).toHaveLength(1);
    expect(strangerSearch.body.items[0].id).toBe(letterToStrangerId);

    // Another tenant: structurally invisible in search too.
    const foreignSearch = await get(
      `/correspondence/search?letterNumber=${encodeURIComponent(letterSentNumber)}&limit=10`,
      foreignId,
    );
    expect(foreignSearch.status).toBe(200);
    expect(foreignSearch.body.items).toHaveLength(0);

    // Attachment filter.
    const withAttachment = await get(`/correspondence/search?hasAttachments=yes&limit=50`, senderId);
    expect(withAttachment.status).toBe(200);
    expect(
      withAttachment.body.items.some((row: { id: string }) => row.id === letterAttachedId),
    ).toBe(true);
  });

  // 16 — archive behavior (create, MOVE into a folder, unarchive, gates)
  it('archives a SENT letter, MOVES it between folders without duplicating, and unarchives', async () => {
    const archived = await post(`/correspondence/${letterSentId}/archive`, senderId).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.folderId).toBeNull();

    const folder = await post('/correspondence/archive/folders', senderId).send({
      name: `پوشه E2E ${now}`,
    });
    expect(folder.status).toBe(201);
    createdFolderIds.push(folder.body.id);

    // Re-archive INTO the folder — the upsert MOVES the entry (never duplicates).
    const moved = await post(`/correspondence/${letterSentId}/archive`, senderId).send({
      folderId: folder.body.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.folderId).toBe(folder.body.id);

    const entryCount = await corrDb.letterArchive.count({
      where: { letterId: letterSentId, userId: senderId },
    });
    expect(entryCount).toBe(1);

    const inFolder = await get(
      `/correspondence/archive?folderId=${folder.body.id}&limit=10`,
      senderId,
    );
    expect(inFolder.status).toBe(200);
    expect(
      inFolder.body.items.some((row: { letterId: string }) => row.letterId === letterSentId),
    ).toBe(true);

    // Unarchive: the row survives (removedAt), the letter itself survives.
    const unarchived = await del(`/correspondence/${letterSentId}/archive`, senderId);
    expect(unarchived.status).toBe(200);
    expect(unarchived.body.removed).toBe(true);
    const entry = await corrDb.letterArchive.findFirst({
      where: { letterId: letterSentId, userId: senderId },
    });
    expect(entry?.removedAt).not.toBeNull();
    const letterStill = await corrDb.letter.findFirst({ where: { id: letterSentId } });
    expect(letterStill).not.toBeNull();
  });

  it('refuses archiving a DRAFT and refuses archiving without a letter edge', async () => {
    const draftGate = await post(`/correspondence/${draftForeverId}/archive`, senderId).send({});
    expect(draftGate.status).toBe(409);

    const strangerGate = await post(`/correspondence/${letterSentId}/archive`, strangerId).send({});
    expect(strangerGate.status).toBe(404);
  });

  // 17 — referral authorization
  it('lets an entitled viewer refer a SENT letter and refuses everyone else', async () => {
    const created = await post(`/correspondence/${letterSentId}/referrals`, recipientId).send({
      toUserId: strangerId,
      level: 'REVIEW',
      instruction: 'لطفاً بررسی فرمایید.',
      clientKey: `corr-e2e-ref-${now}`,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');

    // Same clientKey replays into the same referral (idempotent).
    const replay = await post(`/correspondence/${letterSentId}/referrals`, recipientId).send({
      toUserId: strangerId,
      level: 'REVIEW',
      clientKey: `corr-e2e-ref-${now}`,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(created.body.id);

    // A same-tenant user with NO edge (never a recipient/referral target) → 404.
    const stranger2Referral = await post(`/correspondence/${letterSentId}/referrals`, stranger2Id)
      .send({ toUserId: recipientId, level: 'INFORM' });
    expect(stranger2Referral.status).toBe(404);
    const foreignReferral = await post(`/correspondence/${letterSentId}/referrals`, foreignId)
      .send({ toUserId: foreignId, level: 'INFORM' });
    expect(foreignReferral.status).toBe(404);

    // Referral of a DRAFT (SENT-only), self-referral, cross-tenant target.
    const draftReferral = await post(`/correspondence/${draftForeverId}/referrals`, senderId)
      .send({ toUserId: recipientId, level: 'INFORM' });
    expect(draftReferral.status).toBe(409);
    const selfReferral = await post(`/correspondence/${letterSentId}/referrals`, senderId)
      .send({ toUserId: senderId, level: 'INFORM' });
    expect(selfReferral.status).toBe(400);
    const crossTenantTarget = await post(`/correspondence/${letterSentId}/referrals`, senderId)
      .send({ toUserId: foreignId, level: 'INFORM' });
    expect(crossTenantTarget.status).toBe(400);
  });

  // ==========================================================================
  // Phase 50-MOD-CORR: the scheduled-send dispatcher (defects D2, D8, D9, D10).
  // These run against the REAL correspondence database and the REAL scheduler
  // provider, driving the clock instead of sleeping.
  // ==========================================================================

  /**
   * A Jalali schedule key safely in the future — the send route refuses a deadline
   * under a minute away. `days` controls the day; the time is fixed at 23:59 Tehran,
   * and `due` is a clock that is unambiguously past it.
   */
  const futureScheduleKey = (days: number) => {
    const target = new Date(now + days * 24 * 60 * 60 * 1000);
    const { jy, jm, jd } = instantToJalaliDate(target);

    return {
      scheduledAtDate: `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`,
      scheduledAtTime: '23:59',
      due: new Date(now + (days + 2) * 24 * 60 * 60 * 1000),
    };
  };

  /** Creates an addressed draft and schedules it through the public route. */
  const scheduleLetter = async (subject: string, key: string, days = 2) => {
    const draft = await createDraft(senderId, { subject });
    await updateDraft(senderId, draft.id, { recipientIds: [recipientId] });

    const when = futureScheduleKey(days);
    const res = await post(`/correspondence/drafts/${draft.id}/send`, senderId).send({
      scheduledAtDate: when.scheduledAtDate,
      scheduledAtTime: when.scheduledAtTime,
      sendKey: key,
    });

    return { id: draft.id, res, due: when.due };
  };

  // 18 — scheduling stores a committed, ready letter with a clock and no number
  it('stores a future send as SCHEDULED (no number, clock set) instead of SENT', async () => {
    const scheduled = await scheduleLetter(`نامه زمان‌بندیشده E2E ${now}`, `corr-e2e-sched-${now}`);

    expect(scheduled.res.status).toBe(200);
    expect(scheduled.res.body.status).toBe('SCHEDULED');
    expect(scheduled.res.body.letterNumber).toBeNull();

    const row = await corrDb.letter.findUnique({ where: { id: scheduled.id } });
    expect(row?.status).toBe('SCHEDULED');
    expect(row?.scheduledAt).not.toBeNull();
    expect(row?.sentAt).toBeNull();
    expect(row?.letterNumber).toBeNull();
    // D1/D2 in one assertion pair: the state the enum allowed and the CHECK used to
    // refuse is now storable, and it carries the clock the dispatcher needs.
    expect(row?.readyAt).not.toBeNull();
    expect(row?.sendAttempts).toBe(0);

    // The dispatcher must NOT touch a letter that is not due yet.
    expect(await dispatcher.processDue(new Date(now))).toBe(0);
  });

  // 19 — due dispatch, exactly once, with the number minted by the normal send path
  it('sends a due SCHEDULED letter exactly once and is idempotent on the next tick', async () => {
    const scheduled = await scheduleLetter(`نامه ارسال زمان‌بندی E2E ${now}`, `corr-e2e-sched2-${now}`);

    const sent = await dispatcher.processDue(scheduled.due);
    // The tick may legitimately carry more than this letter (earlier cases leave their
    // own scheduled letters due); what must hold is that THIS one was sent.
    expect(sent).toBeGreaterThanOrEqual(1);

    const row = await corrDb.letter.findUnique({ where: { id: scheduled.id } });
    expect(row?.status).toBe('SENT');
    expect(row?.letterNumber).toMatch(/^AR-\d{4}-\d{5}$/);
    expect(row?.sentAt).not.toBeNull();
    // The clock is cleared on send, so the partial index stops carrying the row.
    expect(row?.scheduledAt).toBeNull();
    expect(row?.sendAttempts).toBe(1);

    // Recipients were delivered and the timeline recorded the send, exactly as a
    // manual send does — the dispatcher adds no second code path.
    const recipient = await corrDb.letterRecipient.findFirst({
      where: { letterId: scheduled.id, userId: recipientId },
    });
    expect(recipient?.deliveredAt).not.toBeNull();
    const sentEvents = await corrDb.letterTrackingEvent.count({
      where: { letterId: scheduled.id, type: 'SENT' },
    });
    expect(sentEvents).toBeGreaterThanOrEqual(1);

    // Idempotency, proven on THIS row rather than by a global count: a second tick
    // must not re-claim it (attempts stay 1) and must not mint a second number.
    await dispatcher.processDue(scheduled.due);
    const afterSecondTick = await corrDb.letter.findUnique({ where: { id: scheduled.id } });
    expect(afterSecondTick?.sendAttempts).toBe(1);
    expect(afterSecondTick?.letterNumber).toBe(row?.letterNumber);
  });

  // 20 — the retry bound: an exhausted letter stops being scanned, and is NOT cancelled
  it('stops scanning a letter that exhausted its attempts and leaves it SCHEDULED', async () => {
    const scheduled = await scheduleLetter(`نامه تلاش‌تمام E2E ${now}`, `corr-e2e-exhaust-${now}`);

    await corrDb.letter.update({
      where: { id: scheduled.id },
      data: { sendAttempts: MAX_SEND_ATTEMPTS, lastSendError: 'exhausted by test' },
    });

    expect(await dispatcher.processDue(scheduled.due)).toBe(0);

    const row = await corrDb.letter.findUnique({ where: { id: scheduled.id } });
    expect(row?.status).toBe('SCHEDULED');
    expect(row?.sendAttempts).toBe(MAX_SEND_ATTEMPTS);
    expect(row?.lastSendError).toBe('exhausted by test');
  });

  // 21 — a claimed-but-failed send is RECORDED, never thrown, never refunded
  it('records lastSendError when a claimed send fails, without failing the tick', async () => {
    const scheduled = await scheduleLetter(`نامه خطای ارسال E2E ${now}`, `corr-e2e-fail-${now}`);

    jest
      .spyOn(correspondenceService, 'dispatchScheduledLetter')
      .mockRejectedValueOnce(new Error('smtp down'));

    await expect(dispatcher.processDue(scheduled.due)).resolves.toBe(0);

    const row = await corrDb.letter.findUnique({ where: { id: scheduled.id } });
    expect(row?.status).toBe('SCHEDULED');
    expect(row?.sendAttempts).toBe(1);
    expect(row?.lastSendError).toContain('smtp down');
    expect(row?.lastSendAttemptAt).not.toBeNull();

    jest.restoreAllMocks();
  });

  // 22 — D2: the send path can now LOAD a SCHEDULED letter, so "send now" works
  it('lets the sender send a SCHEDULED letter immediately (the path used to refuse it)', async () => {
    const scheduled = await scheduleLetter(`نامه ارسال فوری E2E ${now}`, `corr-e2e-now-${now}`);

    const res = await post(`/correspondence/drafts/${scheduled.id}/send`, senderId).send({
      sendKey: `corr-e2e-now2-${now}`,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SENT');
    expect(res.body.letterNumber).toMatch(/^AR-\d{4}-\d{5}$/);

    // A SENT letter is never claimed again by the dispatcher, even while OTHER letters
    // (from the earlier failure case, still retrying) are due in the same tick.
    await dispatcher.processDue(scheduled.due);
    const after = await corrDb.letter.findUnique({ where: { id: scheduled.id } });
    expect(after?.status).toBe('SENT');
    expect(after?.sendAttempts).toBe(0);
    expect(after?.letterNumber).toBe(res.body.letterNumber);
  });

  afterAll(async () => {
    // Letters cascade to recipients/attachments/tracking/archive/referrals, but
    // the order is explicit so a RESTRICT foreign key cannot strand teardown.
    await corrDb.letterTrackingEvent.deleteMany({ where: { letterId: { in: createdLetterIds } } });
    await corrDb.letterReferral.deleteMany({ where: { letterId: { in: createdLetterIds } } });
    await corrDb.letterAttachment.deleteMany({ where: { letterId: { in: createdLetterIds } } });
    await corrDb.letterRecipient.deleteMany({ where: { letterId: { in: createdLetterIds } } });
    await corrDb.letterArchive.deleteMany({ where: { letterId: { in: createdLetterIds } } });
    await corrDb.letter.deleteMany({ where: { id: { in: createdLetterIds } } });
    // Folders no longer have an owner FK to Core's "User" (DC-CORR-01), so this
    // ordering is no longer required for integrity — it is kept because the two
    // databases are cleaned independently and explicitly.
    await corrDb.archiveFolder.deleteMany({ where: { id: { in: createdFolderIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await app.close();
  });
});



