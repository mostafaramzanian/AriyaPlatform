import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { LetterStatus, Prisma } from '../../generated/correspondence-client';
import { CorrespondencePrismaService } from './database/correspondence-prisma.service';
import { RequestContextService } from '../../common/request-context.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../notifications/notification.service';
import { PermissionService } from '../../auth/rbac/services/permission.service';
import { Permissions } from '../../auth/rbac/constants/permissions';
// Phase 50-MOD-CORR: the module's ONLY window onto Core identity. It must not import
// PrismaService or the Core client — see the module header and the isolation spec.
import {
  USER_DIRECTORY,
  type UserDirectoryContract,
} from '../../platform/user-directory/user-directory.contract';
import { LetterNumberService } from './letter-number.service';
import type { AttachmentRefDto } from './correspondence-attachment.service';
import { sanitizeLetterBody } from './correspondence-sanitize.util';
import {
  canRecipientRead,
  canRecipientView,
  canTransitionLetterStatus,
  isLetterEditable,
  isSendableLetterStatus,
} from './letter-status.util';
import {
  CorrSearchQueryDto,
  CreateArchiveFolderDto,
  CreateLetterDraftDto,
  CreateReferralDto,
  CorrespondenceQueryDto,
  MAX_RECIPIENTS,
  UpdateLetterDraftDto,
} from './dto/letter.dto';
import {
  jalaliWallTimeToInstant,
  parseJalaliDateKey,
} from '../../calendar/jalali.util';

/**
 * Phase 50: Official Correspondence / مکاتبات اداری — domain service.
 *
 * Authorization has FOUR edges and no fifth:
 *
 *  - SENDER — owns their drafts and outgoing letters. Only the sender may edit,
 *    send, cancel, delete or attach to a draft, and only while it is editable.
 *  - RECIPIENT — a row in LetterRecipient (TO/CC/BCC) is the need-to-know edge for
 *    reading, view/read marking, and referral of a letter addressed to them.
 *  - REFERRAL TARGET — a row in LetterReferral addressed to the caller.
 *  - TENANT MANAGER — `correspondence.manage`: tenant-wide read (including BCC
 *    identities) and classification change after send. `correspondence.confidential.read`
 *    extends the manager's visible set to confidential letters; WITHOUT it the
 *    manager's tenant-wide view still filters confidential letters out.
 *
 * Identity NEVER comes from a body field, query parameter or path segment: it is
 * resolved from RequestContextService, exactly as DirectoryService (49D-1),
 * NotificationService (49E), MessagingService (49F), SupportService (49G) and
 * SurveysService (49H) do. Tenant is likewise a server-derived snapshot and is never
 * projected to the client.
 *
 * BCC PRIVACY IS A PROJECTION RULE: BCC rows exist for delivery, but their identities
 * are selected ONLY for the sender and for a tenant manager holding
 * correspondence.manage (+ confidential.read when the letter is confidential). A CC
 * or TO recipient never learns who was BCC'd; a BCC recipient sees only their own BCC
 * status, not the other BCC entries.
 *
 * Every recipient id arriving from a client is VERIFIED against the tenant before a
 * row is written; a cross-tenant id makes the whole request fail (404-safe wording),
 * never a partial send.
 *
 * Reads are never audited. Security-sensitive mutations (send, classification
 * change, deletion) are, matching the existing AuditService usage in SurveysService.
 */

export const DEFAULT_CORRESPONDENCE_LIMIT = 20;
export const MAX_CORRESPONDENCE_LIMIT = 100;
export const MAX_TRACKING_EVENTS = 200;

/** Every letter must live in a tenant: personal letters across tenants have no directory to address. */
export class TenantContextRequiredError extends ForbiddenException {
  constructor() {
    super('تنظیمات سازمانی نامه یافت نشد. بدون سازمان نمی‌توان نامه ثبت کرد.');
  }
}

/** Never projected to the client: internal isolation metadata. */
const LETTER_BASE_SELECT = {
  id: true,
  letterNumber: true,
  subject: true,
  category: true,
  urgency: true,
  classification: true,
  status: true,
  letterDate: true,
  sentAt: true,
  readyAt: true,
  createdAt: true,
  updatedAt: true,
  senderId: true,
  signatureId: true,
} satisfies Prisma.LetterSelect;

/**
 * The letter row shape every list/detail projection starts from.
 *
 * `senderId` is selected and the `sender` RELATION IS GONE. After the extraction
 * there is no relation to Core's `"User"` to include (DC-CORR-01: no cross-database
 * foreign key), and the previous `sender: { select: CORR_USER_SELECT }` cannot be
 * expressed any more — that select was even typed `Prisma.UserSelect`, a type this
 * client does not have. Identity is hydrated separately, in ONE batched call per page
 * through `USER_DIRECTORY` (see `profilesById`), which is also strictly better: the
 * old per-row relation read became N+1 as soon as a page had more than one letter.
 */
export type LetterBaseRow = Prisma.LetterGetPayload<{ select: typeof LETTER_BASE_SELECT }>;

/**
 * Identity placeholder for an id the directory no longer knows.
 *
 * THIS IS A DELIBERATE BEHAVIOUR OF THE EXTRACTED MODULE, not an oversight. Cutting
 * the `ON DELETE CASCADE` foreign keys from identity to business documents (D2) means
 * a deleted user no longer deletes their letters, referrals, attachments, signatures
 * or archive entries — so a letter can legitimately outlive its author. When that
 * happens the projection still names the historical actor by id and renders their
 * name as «کاربر» (see `displayUserName`), instead of throwing or fabricating a person.
 */
export function unknownUserProfile(id: string): CorrUserDto {
  return {
    id,
    firstName: null,
    lastName: null,
    avatarUrl: null,
    jobTitle: null,
    department: null,
  };
}

export interface CorrUserDto {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
}

export interface CorrRecipientDto {
  id: string;
  user: CorrUserDto;
  kind: 'TO' | 'CC' | 'BCC';
  state: string;
  deliveredAt: Date | null;
  viewedAt: Date | null;
  readAt: Date | null;
}

export interface CorrLetterDto {
  id: string;
  letterNumber: string | null;
  subject: string;
  category: string | null;
  urgency: string;
  classification: string;
  status: LetterStatus;
  letterDate: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sender: CorrUserDto;
  /** Detail projection only. */
  recipients?: CorrRecipientDto[];
  /** True when the caller may see BCC identities on this letter. */
  canSeeBcc?: boolean;
  /** The caller's own edge on this letter, for action-button decisions. */
  viewerEdge?: 'SENDER' | 'RECIPIENT' | 'REFERRAL_TARGET' | 'MANAGER' | null;
  viewerState?: string | null;
}

export interface CorrListResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface CorrScope {
  userId: string;
  tenantId: string;
  canManage: boolean;
  canReadConfidential: boolean;
  canWriteConfidential: boolean;
}

/**
 * Server-side projection: strips internal metadata (tenantId, senderId as an
 * authorization fact — the sender is still projected as a person, allowlisted) and
 * never includes BCC rows on its own; BCC is attached only by the detail path after
 * the caller's entitlement is resolved.
 *
 * `sender` is now a PARAMETER rather than a relation on the row: identity does not
 * live in this database any more, so it is resolved by the caller — once per page,
 * through `USER_DIRECTORY` — and passed in. Keeping this function pure is what lets
 * the unit spec pin the projection without a database.
 */
export function projectLetter(letter: LetterBaseRow, sender: CorrUserDto): CorrLetterDto {
  return {
    id: letter.id,
    letterNumber: letter.letterNumber,
    subject: letter.subject,
    category: letter.category,
    urgency: letter.urgency,
    classification: letter.classification,
    status: letter.status,
    letterDate: letter.letterDate,
    sentAt: letter.sentAt,
    createdAt: letter.createdAt,
    updatedAt: letter.updatedAt,
    sender,
  };
}

/** One cartable row, whichever source produced it. */
export interface InboxItemDto {
  source: 'RECIPIENT' | 'REFERRAL';
  itemId: string;
  letter: CorrLetterDto;
  myState?: string;
  myKind?: string;
  viewedAt?: Date | null;
  readAt?: Date | null;
  attachmentCount: number;
  referral?: {
    id: string;
    level: string;
    urgency: string;
    instruction: string | null;
    isConfidential: boolean;
    status: string;
    createdAt: Date;
    from: CorrUserDto;
  };
}

export interface ReferralDto {
  id: string;
  letterId: string;
  from: CorrUserDto;
  to: CorrUserDto;
  urgency: string;
  level: string;
  instruction: string | null;
  isConfidential: boolean;
  status: string;
  viewedAt: Date | null;
  actedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface ArchiveFolderDto {
  id: string;
  name: string;
  parentId: string | null;
  entryCount: number;
  createdAt: Date;
  children?: ArchiveFolderDto[];
}

export interface ArchiveEntryDto {
  id: string;
  letterId: string;
  folderId: string | null;
  archivedAt: Date;
  removedAt: Date | null;
}

export interface TrackingEventDto {
  id: string;
  type: string;
  actor: CorrUserDto | null;
  recipientUserId: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface CorrSearchItemDto extends CorrLetterDto {
  attachmentCount: number;
}

/**
 * Persian-tolerant query normalization: Arabic Yeh/Kaf fold onto their Persian
 * forms and ZWNJ collapses, mirroring search/persian-normalize (49J) without
 * importing it (that module is Core-search infrastructure with its own bundle).
 */
export function normalizePersianQuery(input: string): string {
  return (input ?? '')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/\u200C/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses an ISO date bound; BadRequest rather than a silent null when malformed —
 * a malformed filter must never silently widen the result set.
 */
export function parseDateBound(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException('بازه تاریخ معتبر نیست.');
  }
  return date;
}

/** Resolved, deduplicated recipient plan for one letter. */
export interface RecipientPlan {
  rows: { userId: string; kind: 'TO' | 'CC' | 'BCC' }[];
}

export function displayUserName(user: CorrUserDto | null | undefined): string {
  if (!user) return 'نامشخص';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'کاربر';
}

/**
 * Parses the client's Jalali date key into the canonical letter-date instant:
 * midnight at the START of that Jalali day in Asia/Tehran. Null when absent,
 * BadRequest when malformed — never a silent fallback to a wrong day.
 */
export function letterDateToInstant(key: string | null | undefined): Date | null {
  if (!key) return null;
  const parsed = parseJalaliDateKey(key);
  if (!parsed) {
    throw new BadRequestException('تاریخ نامه معتبر نیست.');
  }
  return jalaliWallTimeToInstant(parsed.jy, parsed.jm, parsed.jd, 0, 0);
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses the client's Jalali date + wall-clock time into a canonical timestamp.
 * Null when neither is present. BadRequest when either is malformed.
 */
export function scheduledAtToInstant(
  date: string | null | undefined,
  time: string | null | undefined,
): Date | null {
  if (!date) return null;
  const parsed = parseJalaliDateKey(date);
  if (!parsed) {
    throw new BadRequestException('تاریخ زمان ارسال معتبر نیست.');
  }
  const timeMatch = TIME_PATTERN.exec(time ?? '00:00');
  if (!timeMatch) {
    throw new BadRequestException('زمان ارسال معتبر نیست.');
  }
  return jalaliWallTimeToInstant(parsed.jy, parsed.jm, parsed.jd, Number(timeMatch[1]), Number(timeMatch[2]));
}

/**
 * Deduplicates and layers the three recipient arrays into at most one row per user:
 * TO wins over CC, CC wins over BCC (the stronger need-to-know edge decides the
 * single kind, as the schema documents).
 */
export function buildRecipientPlan(
  recipientIds: string[] | undefined,
  ccIds: string[] | undefined,
  bccIds: string[] | undefined,
): RecipientPlan {
  const byUser = new Map<string, 'TO' | 'CC' | 'BCC'>();

  for (const id of recipientIds ?? []) byUser.set(id, 'TO');
  for (const id of ccIds ?? []) if (!byUser.has(id)) byUser.set(id, 'CC');
  for (const id of bccIds ?? []) if (!byUser.has(id)) byUser.set(id, 'BCC');

  if (byUser.size > MAX_RECIPIENTS) {
    throw new BadRequestException('تعداد گیرندگان بیش از حد مجاز است.');
  }

  return {
    rows: Array.from(byUser.entries()).map(([userId, kind]) => ({ userId, kind })),
  };
}

@Injectable()
export class CorrespondenceService {
  constructor(
    private readonly prisma: CorrespondencePrismaService,
    /**
     * Phase 50-MOD-CORR: identity arrives through the platform PORT, never through
     * Core's client. This is the module's only dependency on Core data.
     */
    @Inject(USER_DIRECTORY) private readonly users: UserDirectoryContract,
    private readonly permissions: PermissionService,
    private readonly numbers: LetterNumberService,
    @Optional() private readonly notifications?: NotificationService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * THE identity hydration path — every projection goes through it.
   *
   * ONE directory call per page, keyed by id, because the alternative (a relation per
   * row) is an N+1 read against another database and another connection pool. Ids the
   * directory does not know are NOT errors: an actor may have been deleted while their
   * letters survived (D2), so they map to `unknownUserProfile` at the call site.
   */
  private async profilesById(ids: readonly string[]): Promise<Map<string, CorrUserDto>> {
    const unique = Array.from(new Set(ids.filter((id) => Boolean(id))));
    if (unique.length === 0) return new Map();

    const profiles = await this.users.findProfiles(unique);
    return new Map(profiles.map((profile) => [profile.id, profile]));
  }

  /** One letter, sender hydrated. */
  private async projectLetterFor(letter: LetterBaseRow): Promise<CorrLetterDto> {
    const profiles = await this.profilesById([letter.senderId]);
    return projectLetter(letter, profiles.get(letter.senderId) ?? unknownUserProfile(letter.senderId));
  }

  /** A page of letters, senders hydrated in a single directory call. */
  private async projectLetterPage(rows: LetterBaseRow[]): Promise<CorrLetterDto[]> {
    if (rows.length === 0) return [];
    const profiles = await this.profilesById(rows.map((row) => row.senderId));

    return rows.map((row) =>
      projectLetter(row, profiles.get(row.senderId) ?? unknownUserProfile(row.senderId)),
    );
  }

  /**
   * Resolves the caller's scope. The identity must come from the request context
   * that the interceptor populated from the database, and it must match the subject
   * the controller passed in. Tenant is REQUIRED for every correspondence
   * operation: there is no personal-letter-without-organization domain here.
   */
  private async scope(userId: string): Promise<CorrScope> {
    const context = RequestContextService.get();

    if (!userId || !context?.userId || context.userId !== userId) {
      throw new ForbiddenException('Correspondence context is required');
    }

    const tenantId = context.tenantId ?? null;
    if (!tenantId) {
      throw new TenantContextRequiredError();
    }

    const [canManage, canReadConfidential, canWriteConfidential] = await Promise.all([
      this.permissions.userHasPermission(userId, Permissions.CORRESPONDENCE_MANAGE),
      this.permissions.userHasPermission(userId, Permissions.CORRESPONDENCE_CONFIDENTIAL_READ),
      this.permissions.userHasPermission(userId, Permissions.CORRESPONDENCE_CONFIDENTIAL_MANAGE),
    ]);

    return { userId, tenantId, canManage, canReadConfidential, canWriteConfidential };
  }

  /**
   * Builds a scope from the DATABASE for background jobs (no request context).
   *
   * Tenant now comes from the platform directory port instead of Core's `"User"`
   * table. Nothing else about the rule changed: a user with no tenant cannot have a
   * background scope, so the caller skips the row rather than inventing one.
   */
  private async buildScopeFromUser(userId: string): Promise<CorrScope | null> {
    const tenantId = await this.users.findTenantId(userId);
    if (!tenantId) return null;
    const [canManage, canReadConfidential, canWriteConfidential] = await Promise.all([
      this.permissions.userHasPermission(userId, Permissions.CORRESPONDENCE_MANAGE),
      this.permissions.userHasPermission(userId, Permissions.CORRESPONDENCE_CONFIDENTIAL_READ),
      this.permissions.userHasPermission(userId, Permissions.CORRESPONDENCE_CONFIDENTIAL_MANAGE),
    ]);
    return { userId, tenantId, canManage, canReadConfidential, canWriteConfidential };
  }

  /**
   * THE scheduler's only entry point: send ONE due, SCHEDULED letter.
   *
   * The unbounded `setInterval` + `processScheduledSends` loop that used to live here
   * is GONE (defect D8): it had no replica guard, no `unref()`, no batch bound and no
   * overlap guard, so EVERY API replica re-ran an unbounded cross-tenant scan every 60
   * seconds. Polling now belongs to `ScheduledSendDispatcherService`
   * (`jobs/scheduled-send.dispatcher.ts`), which claims each row atomically and calls
   * this method — one rule, in one place, on the sanctioned dispatcher pattern.
   *
   * What remains here is the SEND decision and nothing else. It RE-ASSERTS the due
   * invariant (`status = SCHEDULED` and `scheduledAt <= now`) rather than trusting its
   * caller, then reuses `sendDraft`, so number minting, the conditional flip, recipient
   * delivery, the tracking event, the notification fan-out and the audit row are
   * IDENTICAL to a manual send.
   *
   * Returns true when THIS call performed the send. A letter another replica already
   * sent returns false (the flip inside `sendDraft` is conditional, so it cannot send
   * twice), and a letter whose sender is gone or has no tenant returns false instead of
   * throwing — the dispatcher must keep walking its bounded batch either way.
   */
  async dispatchScheduledLetter(letterId: string, now: Date = new Date()): Promise<boolean> {
    const letter = await this.prisma.letter.findFirst({
      where: { id: letterId, status: 'SCHEDULED', scheduledAt: { lte: now } },
      select: { id: true, senderId: true },
    });

    if (!letter) return false;

    const scope = await this.buildScopeFromUser(letter.senderId);
    if (!scope) return false;

    await this.sendDraft(letter.senderId, letter.id, null, null, scope);
    return true;
  }

  private async validateClientLetterNumber(
    scope: CorrScope,
    letterNumber: string | null,
    excludeLetterId: string | null,
  ): Promise<void> {
    if (!letterNumber) return;
    const existing = await this.prisma.letter.findFirst({
      where: {
        tenantId: scope.tenantId,
        letterNumber,
        ...(excludeLetterId ? { id: { not: excludeLetterId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('شماره نامه قبلاً استفاده شده است.');
    }
  }

  private async resolveSignature(
    scope: CorrScope,
    signatureId: string,
  ): Promise<{ id: string; storageKey: string }> {
    const signature = await this.prisma.letterSignature.findFirst({
      where: { id: signatureId, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, storageKey: true },
    });
    if (!signature) {
      throw new NotFoundException('امضای انتخاب‌شده یافت نشد.');
    }
    return signature;
  }

  private async resolveTempAttachments(
    scope: CorrScope,
    ids: string[],
  ): Promise<Array<{ id: string; fileName: string; mimeType: string; size: number; storageKey: string }>> {
    const rows = await this.prisma.letterTempAttachment.findMany({
      where: { id: { in: ids }, uploadedBy: scope.userId, tenantId: scope.tenantId },
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException('یک یا چند پیوست موقت یافت نشد.');
    }
    return rows;
  }

  /**
   * VERIFIES every recipient id against the caller's tenant and returns only real,
   * in-tenant users. A single foreign or unknown id fails the WHOLE request before
   * any write happens — a letter is never partially addressed.
   */
  private async resolveRecipients(
    scope: CorrScope,
    plan: RecipientPlan,
  ): Promise<RecipientPlan> {
    if (plan.rows.length === 0) return { rows: [] };

    const ids = Array.from(new Set(plan.rows.map((row) => row.userId)));

    // Membership is answered by the platform directory port, which returns the ids
    // that are in THIS tenant. It therefore preserves the property the direct query
    // had: the result can never distinguish "does not exist" from "belongs to another
    // tenant", so the error below stays unusable as an existence probe.
    const memberIds = await this.users.filterTenantMembers(scope.tenantId, ids);

    const found = new Set(memberIds);
    const missing = ids.filter((id) => !found.has(id));

    if (missing.length > 0) {
      // Deliberately identical wording for "does not exist" and "another tenant's
      // user": the error must not be usable to probe which ids exist elsewhere.
      throw new BadRequestException('یک یا چند گیرنده در سازمان شما یافت نشد.');
    }

    return { rows: plan.rows.filter((row) => found.has(row.userId)) };
  }

  /**
   * Replaces the whole recipient set of a letter. Whole-set semantics, like the
   * survey questionnaire: a partial patch of an ordered, deduplicated structure
   * cannot express removal. Runs inside the caller's transaction when provided.
   */
  private async writeRecipients(
    tx: Prisma.TransactionClient,
    letterId: string,
    tenantId: string,
    plan: RecipientPlan,
  ): Promise<void> {
    await tx.letterRecipient.deleteMany({ where: { letterId } });

    if (plan.rows.length === 0) return;

    await tx.letterRecipient.createMany({
      data: plan.rows.map((row) => ({
        letterId,
        userId: row.userId,
        tenantId,
        kind: row.kind,
        state: 'DELIVERED',
      })),
    });
  }

  /**
   * The SINGLE letter access predicate: which letters may this caller SEE. Owner,
   * any recipient, any referral target — plus the tenant-manager extension when the
   * caller holds manage (+ confidential.read for confidential letters). Tenant is
   * part of every branch, so the predicate can never leak across tenants.
   */
  private visibleLetterWhere(scope: CorrScope): Prisma.LetterWhereInput {
    const participantBranches: Prisma.LetterWhereInput[] = [
      { senderId: scope.userId },
      { recipients: { some: { userId: scope.userId } } },
      { referrals: { some: { toUserId: scope.userId } } },
    ];

    if (scope.canManage) {
      // Tenant-wide ordinary letters; confidential ones additionally require
      // correspondence.confidential.read.
      return {
        tenantId: scope.tenantId,
        OR: [
          ...participantBranches,
          {
            classification: {
              in: scope.canReadConfidential
                ? ['NORMAL', 'CONFIDENTIAL', 'SECRET']
                : ['NORMAL'],
            },
          },
        ],
      };
    }

    return { tenantId: scope.tenantId, OR: participantBranches };
  }

  /** Creates a DRAFT. The sender is the caller; the number stays NULL until send. */
  async createDraft(userId: string, dto: CreateLetterDraftDto): Promise<CorrLetterDto> {
    const scope = await this.scope(userId);

    if (dto.classification && dto.classification !== 'NORMAL' && !scope.canWriteConfidential) {
      throw new ForbiddenException('دسترسی طبقه‌بندی محرمانه را ندارید.');
    }

    const plan = await this.resolveRecipients(
      scope,
      buildRecipientPlan(dto.recipientIds, dto.ccIds, dto.bccIds),
    );

    const bodyHtml = sanitizeLetterBody(dto.body);
    const letterDate = letterDateToInstant(dto.letterDate);
    const scheduledAt = scheduledAtToInstant(dto.scheduledAtDate, dto.scheduledAtTime);

    await this.validateClientLetterNumber(scope, dto.letterNumber ?? null, null);
    const signature = dto.signatureId ? await this.resolveSignature(scope, dto.signatureId) : null;
    const tempAttachments = dto.tempAttachmentIds?.length
      ? await this.resolveTempAttachments(scope, dto.tempAttachmentIds)
      : [];

    const created = await this.prisma.$transaction(async (tx) => {
      const letter = await tx.letter.create({
        data: {
          tenantId: scope.tenantId,
          subject: dto.subject,
          bodyHtml,
          category: dto.category ?? null,
          urgency: dto.urgency ?? 'NORMAL',
          classification: dto.classification ?? 'NORMAL',
          letterDate,
          scheduledAt,
          senderId: scope.userId,
          status: 'DRAFT',
          letterNumber: dto.letterNumber ?? null,
          signatureId: signature?.id ?? null,
        },
        select: { id: true },
      });

      await this.writeRecipients(tx, letter.id, scope.tenantId, plan);

      for (const temp of tempAttachments) {
        await tx.letterAttachment.create({
          data: {
            id: temp.id,
            letterId: letter.id,
            uploadedBy: scope.userId,
            fileName: temp.fileName,
            mimeType: temp.mimeType,
            size: temp.size,
            storageKey: temp.storageKey,
          },
        });
        await tx.letterTempAttachment.delete({ where: { id: temp.id } });
      }

      await tx.letterTrackingEvent.create({
        data: {
          letterId: letter.id,
          type: 'CREATED',
          actorId: scope.userId,
          metadata: { status: 'DRAFT' },
        },
      });

      return letter;
    });

    return this.getLetterFor(scope, created.id);
  }

  /**
   * Edits a DRAFT (or a READY_TO_SEND recall). Only the sender, only while
   * editable, only inside their tenant. When a recipient array is present the WHOLE
   * set is replaced. Re-sanitizes any new body.
   */
  async updateDraft(
    userId: string,
    letterId: string,
    dto: UpdateLetterDraftDto,
  ): Promise<CorrLetterDto> {
    const scope = await this.scope(userId);

    const letter = await this.prisma.letter.findFirst({
      where: {
        id: letterId,
        senderId: scope.userId,
        tenantId: scope.tenantId,
      },
      select: { id: true, status: true, classification: true },
    });

    if (!letter) {
      throw new NotFoundException('پیش‌نویس یافت نشد.');
    }

    if (!isLetterEditable(letter.status)) {
      throw new ConflictException('نامه ارسال‌شده قابل ویرایش نیست.');
    }

    if (
      dto.classification !== undefined &&
      dto.classification !== 'NORMAL' &&
      !scope.canWriteConfidential
    ) {
      throw new ForbiddenException('دسترسی طبقه‌بندی محرمانه را ندارید.');
    }

    // Raising requires the confidential permission; lowering an already-raised
    // classification requires it too (the sender governs their draft's classification
    // only if they may create confidential correspondence at all).
    if (
      dto.classification !== undefined &&
      dto.classification === 'NORMAL' &&
      letter.classification !== 'NORMAL' &&
      !scope.canWriteConfidential
    ) {
      throw new ForbiddenException('کاهش طبقه‌بندی مجاز نیست.');
    }

    const plan =
      dto.recipientIds !== undefined || dto.ccIds !== undefined || dto.bccIds !== undefined
        ? await this.resolveRecipients(
            scope,
            buildRecipientPlan(dto.recipientIds, dto.ccIds, dto.bccIds),
          )
        : null;

    await this.validateClientLetterNumber(scope, dto.letterNumber ?? null, letter.id);
    const signature =
      dto.signatureId !== undefined
        ? dto.signatureId
          ? await this.resolveSignature(scope, dto.signatureId)
          : null
        : undefined;
    const tempAttachments =
      dto.tempAttachmentIds?.length
        ? await this.resolveTempAttachments(scope, dto.tempAttachmentIds)
        : [];

    await this.prisma.$transaction(async (tx) => {
      await tx.letter.update({
        where: { id: letter.id },
        data: {
          ...(dto.subject !== undefined ? { subject: dto.subject } : {}),
          ...(dto.body !== undefined ? { bodyHtml: sanitizeLetterBody(dto.body) } : {}),
          ...(dto.category !== undefined ? { category: dto.category ?? null } : {}),
          ...(dto.urgency !== undefined ? { urgency: dto.urgency } : {}),
          ...(dto.classification !== undefined ? { classification: dto.classification } : {}),
          ...(dto.letterDate !== undefined
            ? { letterDate: letterDateToInstant(dto.letterDate) }
            : {}),
          ...(dto.scheduledAtDate !== undefined
            ? { scheduledAt: scheduledAtToInstant(dto.scheduledAtDate, dto.scheduledAtTime) }
            : {}),
          ...(dto.letterNumber !== undefined ? { letterNumber: dto.letterNumber ?? null } : {}),
          ...(signature !== undefined ? { signatureId: signature?.id ?? null } : {}),
        },
      });

      if (plan) {
        await this.writeRecipients(tx, letter.id, scope.tenantId, plan);
      }

      for (const temp of tempAttachments) {
        const existing = await tx.letterAttachment.findUnique({ where: { id: temp.id } });
        if (!existing) {
          await tx.letterAttachment.create({
            data: {
              id: temp.id,
              letterId: letter.id,
              uploadedBy: scope.userId,
              fileName: temp.fileName,
              mimeType: temp.mimeType,
              size: temp.size,
              storageKey: temp.storageKey,
            },
          });
          await tx.letterTempAttachment.delete({ where: { id: temp.id } });
        }
      }
    });

    return this.getLetterFor(scope, letter.id);
  }

  /**
   * Deletes a draft — HARD delete, but only of a DRAFT or CANCELLED draft the
   * caller owns. A SENT letter is never deleted by this route; "حذف از لیست" for
   * sent letters is `removeSentFromList` (a soft, per-sender flag) and never
   * destroys the canonical business record.
   */
  async deleteDraft(userId: string, letterId: string): Promise<{ deleted: true; id: string }> {
    const scope = await this.scope(userId);

    const result = await this.prisma.letter.deleteMany({
      where: {
        id: letterId,
        senderId: scope.userId,
        tenantId: scope.tenantId,
        status: { in: ['DRAFT', 'CANCELLED'] },
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('پیش‌نویس یافت نشد یا قابل حذف نیست.');
    }

    return { deleted: true, id: letterId };
  }

  /**
   * Explicit canonical transition, server-validated via the pure transition table.
   * DRAFT → READY_TO_SEND (stamp readyAt), READY_TO_SEND → DRAFT (unmark), and
   * DRAFT → CANCELLED (terminal). SENT cannot be reached here — send is its own
   * audited operation — and CANCELLED is terminal.
   */
  async changeStatus(
    userId: string,
    letterId: string,
    target: 'READY_TO_SEND' | 'DRAFT' | 'CANCELLED',
  ): Promise<CorrLetterDto> {
    const scope = await this.scope(userId);

    return this.prisma.$transaction(async (tx) => {
      const letter = await tx.letter.findFirst({
        where: {
          id: letterId,
          senderId: scope.userId,
          tenantId: scope.tenantId,
        },
        select: { id: true, status: true },
      });

      if (!letter) {
        throw new NotFoundException('نامه یافت نشد.');
      }

      if (!canTransitionLetterStatus(letter.status, target)) {
        throw new ConflictException(
          `انتقال وضعیت از ${letter.status} به ${target} مجاز نیست.`,
        );
      }

      const data: Prisma.LetterUpdateInput =
        target === 'READY_TO_SEND'
          ? { status: 'READY_TO_SEND', readyAt: new Date() }
          : target === 'DRAFT'
            ? { status: 'DRAFT', readyAt: null }
            : { status: 'CANCELLED', cancelledAt: new Date() };

      await tx.letter.update({ where: { id: letter.id }, data });

      await tx.letterTrackingEvent.create({
        data: {
          letterId: letter.id,
          type: 'CREATED',
          actorId: scope.userId,
          metadata: { transition: `${letter.status} -> ${target}` },
        },
      });

      return this.getLetterFor(scope, letter.id);
    });
  }

  /**
   * THE send. Exactly-once semantics, in order:
   *
   *  1. A retried send with the SAME `sendKey` returns the already-sent letter
   *     (idempotent success) — the UNIQUE index on Letter.sendKey arbitrates, so a
   *     concurrent retry that lost the first race cannot mint a second SENT row.
   *  2. Otherwise the number is minted inside the send transaction, and the row is
   *     flipped with a CONDITIONAL update (`status IN (DRAFT, READY_TO_SEND)` in the
   *     UPDATE itself). A concurrent double-send of the same draft: exactly one
   *     conditional update matches; the loser gets 409, and nothing is sent twice.
   *  3. Recipients are delivered in the same transaction (deliveredAt stamped),
   *     tracking gets SENT, and notifications + audit follow after commit.
   *
   * A lost race burns one number (a gap in the sequence). Gaps are acceptable for a
   * business numbering scheme and far preferable to a double send.
   */
  async sendDraft(
    userId: string,
    letterId: string,
    sendKey?: string | null,
    scheduledAt?: Date | null,
    providedScope?: CorrScope,
  ): Promise<CorrLetterDto> {
    const scope = providedScope ?? await this.scope(userId);

    // Idempotent replay: same key, same caller, same tenant → return the sent letter.
    if (sendKey) {
      const existing = await this.prisma.letter.findFirst({
        where: {
          sendKey,
          senderId: scope.userId,
          tenantId: scope.tenantId,
          status: 'SENT',
        },
        select: { id: true },
      });

      if (existing) {
        return this.getLetterFor(scope, existing.id);
      }
    }

    const letter = await this.prisma.letter.findFirst({
      where: {
        id: letterId,
        senderId: scope.userId,
        tenantId: scope.tenantId,
        // SCHEDULED IS IN THE LOAD PREDICATE — this is the OTHER half of defect D2.
        // Before the extraction this path listed only DRAFT/READY_TO_SEND, so the
        // scheduler could never load the letter the send was FOR: a SCHEDULED row was
        // refused by its own send path ("پیش‌نویس یافت نشد یا قابل ارسال نیست") and the
        // clock state was terminal in practice. The transition SCHEDULED → SENT is
        // legal in the state machine, and the conditional flip below already listed
        // SCHEDULED, so only this predicate disagreed with them.
        //
        // It also makes a manual "send now" of a scheduled letter possible for its
        // sender, which is the same legal transition reached earlier than the clock.
        status: { in: ['DRAFT', 'READY_TO_SEND', 'SCHEDULED'] },
      },
      select: {
        id: true,
        status: true,
        letterDate: true,
        letterNumber: true,
        _count: { select: { recipients: true } },
      },
    });

    if (!letter) {
      throw new NotFoundException('پیش‌نویس یافت نشد یا قابل ارسال نیست.');
    }

    if ((letter._count?.recipients ?? 0) === 0) {
      throw new BadRequestException('نامه بدون گیرنده قابل ارسال نیست.');
    }

    const now = new Date();
    if (scheduledAt && scheduledAt.getTime() <= now.getTime() + 60_000) {
      throw new BadRequestException('زمان ارسال زمان‌دار باید حداقل یک دقیقه در آینده باشد.');
    }
    const isScheduled = scheduledAt && scheduledAt.getTime() > now.getTime() + 60_000;

    if (isScheduled) {
      await this.prisma.$transaction(async (tx) => {
        await tx.letter.updateMany({
          where: {
            id: letter.id,
            senderId: scope.userId,
            tenantId: scope.tenantId,
            status: { in: ['DRAFT', 'READY_TO_SEND'] },
          },
          data: {
            status: 'SCHEDULED',
            scheduledAt,
            letterDate: scheduledAt,
            readyAt: now,
            ...(sendKey ? { sendKey } : {}),
          },
        });

        await tx.letterTrackingEvent.create({
          data: {
            letterId: letter.id,
            type: 'SENT', // recorded now; the actual delivery happens at scheduledAt
            actorId: scope.userId,
            metadata: { scheduledAt: scheduledAt.toISOString() },
          },
        });
      });

      await this.audit?.log({
        requestId: RequestContextService.get()?.requestId ?? `corr-${letter.id}`,
        correlationId: RequestContextService.get()?.correlationId,
        userId: scope.userId,
        action: 'correspondence_letter_scheduled',
        resource: 'correspondence',
        resourceId: letter.id,
        success: true,
        reason: `scheduledAt=${scheduledAt.toISOString()}`,
      });

      return this.getLetterFor(scope, letter.id);
    }

    const sentAt = now;
    const letterDate = letter.letterDate ?? sentAt;

    const { sentLetterId, letterNumber } = await this.prisma.$transaction(async (tx) => {
      // Numbering INSIDE the send transaction: a rolled-back send never burns a
      // number, and the allocation is atomic against concurrent sends.
      // If the client already provided a letter number while composing, reuse it.
      const number = letter.letterNumber
        ? { letterNumber: letter.letterNumber }
        : await this.numbers.allocateNext(scope.tenantId, sentAt);

      const flipped = await tx.letter.updateMany({
        where: {
          id: letter.id,
          senderId: scope.userId,
          tenantId: scope.tenantId,
          status: { in: ['DRAFT', 'READY_TO_SEND', 'SCHEDULED'] },
        },
        data: {
          status: 'SENT',
          sentAt,
          letterDate,
          letterNumber: number.letterNumber,
          scheduledAt: null,
          ...(letter.status === 'DRAFT' ? { readyAt: sentAt } : {}),
          ...(sendKey ? { sendKey } : {}),
        },
      });

      if (flipped.count === 0) {
        // A concurrent send won the race. 409 — never a silent double send.
        throw new ConflictException('نامه هم‌زمان ارسال شده است.');
      }

      await tx.letterRecipient.updateMany({
        where: { letterId: letter.id },
        data: { deliveredAt: sentAt },
      });

      await tx.letterTrackingEvent.create({
        data: {
          letterId: letter.id,
          type: 'SENT',
          actorId: scope.userId,
          metadata: { letterNumber: number.letterNumber },
        },
      });

      return { sentLetterId: letter.id, letterNumber: number.letterNumber };
    });

    // Post-commit, best-effort: notifications to every recipient except the sender.
    // A notification failure never fails the send (Postgres is authoritative).
    if (this.notifications) {
      await this.notifyRecipients(scope, sentLetterId);
    }

    await this.audit?.log({
      requestId: RequestContextService.get()?.requestId ?? `corr-${sentLetterId}`,
      correlationId: RequestContextService.get()?.correlationId,
      userId: scope.userId,
      action: 'correspondence_letter_sent',
      resource: 'correspondence',
      resourceId: sentLetterId,
      success: true,
      reason: `letterNumber=${letterNumber}`,
    });

    return this.getLetterFor(scope, sentLetterId);
  }


  /** Best-effort fan-out of one notification per recipient, skipping the sender. */
  private async notifyRecipients(scope: CorrScope, letterId: string): Promise<void> {
    if (!this.notifications) return;

    const rows = await this.prisma.letterRecipient.findMany({
      where: { letterId },
      select: { userId: true },
    });

    const letter = await this.prisma.letter.findUnique({
      where: { id: letterId },
      select: { subject: true, urgency: true },
    });
    if (!letter) return;

    const urgent = letter.urgency === 'URGENT' || letter.urgency === 'CRITICAL';

    for (const row of rows) {
      if (row.userId === scope.userId) continue;
      try {
        await this.notifications.createForUser({
          userId: row.userId,
          tenantId: scope.tenantId,
          type: urgent ? 'ANNOUNCEMENT' : 'INFORMATION',
          title: urgent ? 'نامه فوری جدید' : 'نامه جدید',
          body: letter.subject,
          sourceType: 'correspondence-letter',
          sourceId: letterId,
        });
      } catch (err) {
        // Never fail the send for a notification; log without leaking content.
        console.warn(
          `[correspondence] notification failed letter=${letterId} recipient=${row.userId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }


  /** Bounded pagination helper — over-fetch by one to decide `hasMore`. */
  private pageBounds(query: { cursor?: string; limit?: number }): {
    take: number;
    cursor: { id: string } | undefined;
  } {
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_CORRESPONDENCE_LIMIT, 1),
      MAX_CORRESPONDENCE_LIMIT,
    );

    return {
      take: limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
    };
  }

  /** Splits the over-fetched page into `{ items, hasMore }`. */
  private toPage<T>(rows: T[], take: number): CorrListResult<T> {
    const hasMore = rows.length > take;
    return { items: rows.slice(0, take), hasMore };
  }

  /** My drafts AND ready-to-send letters, newest first. */
  async listDrafts(userId: string, query: CorrespondenceQueryDto): Promise<CorrListResult<CorrLetterDto>> {
    const scope = await this.scope(userId);
    const { take, cursor } = this.pageBounds(query);

    const rows = await this.prisma.letter.findMany({
      where: {
        tenantId: scope.tenantId,
        senderId: scope.userId,
        status: { in: query.status ? [query.status] : ['DRAFT', 'READY_TO_SEND'] },
      },
      select: LETTER_BASE_SELECT,
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      take,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });

    return this.toPage(await this.projectLetterPage(rows), take);
  }

  /**
   * My outgoing SENT letters (the "نامه‌های ارسالی" page), newest first. Rows the
   * sender removed from their own list ("حذف از لیست") stay out — the letter itself
   * is untouched, only this view is.
   */
  async listSent(userId: string, query: CorrespondenceQueryDto): Promise<CorrListResult<CorrLetterDto>> {
    const scope = await this.scope(userId);
    const { take, cursor } = this.pageBounds(query);

    const rows = await this.prisma.letter.findMany({
      where: {
        tenantId: scope.tenantId,
        senderId: scope.userId,
        status: 'SENT',
        senderRemovedAt: null,
      },
      select: LETTER_BASE_SELECT,
      orderBy: [{ sentAt: 'desc' as const }, { id: 'desc' as const }],
      take,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });

    return this.toPage(await this.projectLetterPage(rows), take);
  }

  /**
   * "حذف از لیست" for the sender's OWN outgoing view — a soft, per-sender stamp.
   * The canonical letter, its recipients and its tracking are untouched, exactly as
   * the phase contract demands.
   */
  async removeSentFromList(userId: string, letterId: string): Promise<{ removed: true; id: string }> {
    const scope = await this.scope(userId);

    const result = await this.prisma.letter.updateMany({
      where: {
        id: letterId,
        senderId: scope.userId,
        tenantId: scope.tenantId,
        status: 'SENT',
        senderRemovedAt: null,
      },
      data: { senderRemovedAt: new Date() },
    });

    if (result.count === 0) {
      // Idempotent: an already-removed letter also matches nothing here — resolve
      // it so the response is honest rather than a misleading 404.
      const already = await this.prisma.letter.findFirst({
        where: {
          id: letterId,
          senderId: scope.userId,
          tenantId: scope.tenantId,
          senderRemovedAt: { not: null },
        },
        select: { id: true },
      });

      if (!already) {
        throw new NotFoundException('نامه یافت نشد.');
      }
    }

    return { removed: true, id: letterId };
  }


  /**
   * My inbox (کارتابل): TWO sources composed into one list, because the reference's
   * cartable really has both:
   *  - RECIPIENT — letters where I hold a LetterRecipient row (TO/CC/BCC) that I
   *    have not removed, delivered by a SENT letter in my tenant;
   *  - REFERRAL — letters referred TO me with a PENDING or VIEWED referral.
   *
   * Each item carries its `source` so the UI can distinguish "نامه دریافتی" from
   * "ارجاع دریافتی". Ordering is per-source and merged client-side is NOT allowed
   * to flatten tenant boundaries: every branch carries tenantId, and the projections
   * are allowlisted.
   */
  async listInbox(userId: string, query: CorrespondenceQueryDto): Promise<CorrListResult<InboxItemDto>> {
    const scope = await this.scope(userId);
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_CORRESPONDENCE_LIMIT, 1),
      MAX_CORRESPONDENCE_LIMIT,
    );

    const recipientRows = await this.prisma.letterRecipient.findMany({
      where: {
        userId: scope.userId,
        tenantId: scope.tenantId,
        removedAt: null,
        deliveredAt: { not: null },
        letter: { tenantId: scope.tenantId, status: 'SENT' },
      },
      select: {
        id: true,
        kind: true,
        state: true,
        deliveredAt: true,
        viewedAt: true,
        readAt: true,
        letter: {
          select: {
            ...LETTER_BASE_SELECT,
            bodyHtml: true,
            _count: { select: { attachments: true } },
          },
        },
      },
      orderBy: [{ deliveredAt: 'desc' as const }, { id: 'desc' as const }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = recipientRows.length > limit;
    const page = recipientRows.slice(0, limit);
    // ONE directory call for the whole page (see projectLetterPage), replacing what
    // used to be a per-row `letter.sender` relation through Core's client.
    const letters = await this.projectLetterPage(
      page.map((row) => row.letter as unknown as LetterBaseRow),
    );

    const items: InboxItemDto[] = page.map((row, index) => ({
      source: 'RECIPIENT',
      itemId: row.id,
      letter: letters[index],
      myState: row.state,
      myKind: row.kind,
      viewedAt: row.viewedAt,
      readAt: row.readAt,
      attachmentCount: (row.letter as unknown as { _count: { attachments: number } })._count.attachments,
    }));

    return { items, hasMore };
  }

  /**
   * Removes an inbox item (my recipient row) from MY inbox. Never touches the
   * letter, other recipients, or the sender's view.
   */
  async removeInboxItem(userId: string, letterId: string, remove: boolean): Promise<{ removed: boolean; id: string }> {
    const scope = await this.scope(userId);

    const result = await this.prisma.letterRecipient.updateMany({
      where: {
        letterId,
        userId: scope.userId,
        tenantId: scope.tenantId,
        letter: { tenantId: scope.tenantId },
      },
      data: { removedAt: remove ? new Date() : null },
    });

    if (result.count === 0) {
      throw new NotFoundException('نامه در صندوق شما یافت نشد.');
    }

    return { removed: true, id: letterId };
  }

  /** Bounded count of undelivered-viewed inbox items for the sidebar badge. */
  async countInboxUnread(userId: string): Promise<{ count: number }> {
    const scope = await this.scope(userId);

    const count = await this.prisma.letterRecipient.count({
      where: {
        userId: scope.userId,
        tenantId: scope.tenantId,
        removedAt: null,
        deliveredAt: { not: null },
        viewedAt: null,
        letter: { tenantId: scope.tenantId, status: 'SENT' },
      },
    });

    return { count };
  }

  /**
   * Letters referred TO me (PENDING or VIEWED) — the referral half of the cartable.
   * Composed by the SAME listInbox contract over a different source row.
   */
  async listReferralInbox(userId: string, query: CorrespondenceQueryDto): Promise<CorrListResult<InboxItemDto>> {
    const scope = await this.scope(userId);
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_CORRESPONDENCE_LIMIT, 1),
      MAX_CORRESPONDENCE_LIMIT,
    );

    const rows = await this.prisma.letterReferral.findMany({
      where: {
        toUserId: scope.userId,
        tenantId: scope.tenantId,
        status: { in: ['PENDING', 'VIEWED'] },
        letter: { tenantId: scope.tenantId, status: 'SENT' },
      },
      select: {
        id: true,
        level: true,
        urgency: true,
        instruction: true,
        isConfidential: true,
        status: true,
        createdAt: true,
        // The `from` RELATION is gone (DC-CORR-01); the id is selected and the person
        // is resolved below, in the same batched directory call as the letter senders.
        fromUserId: true,
        letter: {
          select: {
            ...LETTER_BASE_SELECT,
            bodyHtml: true,
            _count: { select: { attachments: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    // ONE directory call for the page, covering BOTH the letter senders and the
    // referral authors: a cartable page costs one identity read, not 2N.
    const profiles = await this.profilesById([
      ...page.map((row) => row.letter.senderId),
      ...page.map((row) => row.fromUserId),
    ]);

    const items: InboxItemDto[] = page.map((row) => ({
      source: 'REFERRAL',
      itemId: row.id,
      letter: projectLetter(
        row.letter as unknown as LetterBaseRow,
        profiles.get(row.letter.senderId) ?? unknownUserProfile(row.letter.senderId),
      ),
      referral: {
        id: row.id,
        level: row.level,
        urgency: row.urgency,
        instruction: row.instruction,
        isConfidential: row.isConfidential,
        status: row.status,
        createdAt: row.createdAt,
        from: profiles.get(row.fromUserId) ?? unknownUserProfile(row.fromUserId),
      },
      attachmentCount: (row.letter as unknown as { _count: { attachments: number } })._count.attachments,
    }));

    return { items, hasMore };
  }


  /**
   * Resolves the caller's EDGE on one letter, or null when the caller has none.
   * Order matters: SENDER first (strongest personal edge), then RECIPIENT, then
   * REFERRAL_TARGET, then MANAGER. Every lookup carries the tenant — a letter in
   * another tenant is structurally invisible here, and a nonexistent one is
   * indistinguishable from an unauthorized one (both resolve to null → 404), so ids
   * cannot be probed.
   */
  private async resolveViewerEdge(
    scope: CorrScope,
    letterId: string,
  ): Promise<{
    edge: 'SENDER' | 'RECIPIENT' | 'REFERRAL_TARGET' | 'MANAGER';
    letter: Prisma.LetterGetPayload<{ select: typeof LETTER_BASE_SELECT }>;
    myRecipient: { id: string; kind: string; state: string } | null;
  } | null> {
    const letter = await this.prisma.letter.findFirst({
      where: { id: letterId, tenantId: scope.tenantId },
      select: LETTER_BASE_SELECT,
    });

    if (!letter) return null;

    if (letter.senderId === scope.userId) {
      return { edge: 'SENDER', letter, myRecipient: null };
    }

    const myRecipient = await this.prisma.letterRecipient.findFirst({
      where: { letterId, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, kind: true, state: true },
    });

    if (myRecipient) {
      return { edge: 'RECIPIENT', letter, myRecipient };
    }

    const myReferral = await this.prisma.letterReferral.findFirst({
      where: { letterId, toUserId: scope.userId, tenantId: scope.tenantId },
      select: { id: true },
    });

    if (myReferral) {
      return { edge: 'REFERRAL_TARGET', letter, myRecipient: null };
    }

    // Tenant manager. Confidential letters additionally require
    // correspondence.confidential.read — the manage grant alone does NOT
    // silently open محرمانه/سری content.
    if (scope.canManage) {
      const confidential = letter.classification !== 'NORMAL';
      if (!confidential || scope.canReadConfidential) {
        return { edge: 'MANAGER', letter, myRecipient: null };
      }
    }

    return null;
  }

  /**
   * THE detail projection. BCC privacy is decided HERE and only here:
   *  - the SENDER sees every BCC identity (they addressed the letter);
   *  - a tenant manager holding correspondence.manage sees BCC identities only with
   *    correspondence.confidential.read when the letter is confidential;
   *  - everyone else — including TO and CC recipients and other managers — sees the
   *    TO/CC rows and, if THEY were BCC'd, exactly their own row (marked kind BCC)
   *    and never the other BCC entries.
   */
  async getLetterFor(scope: CorrScope, letterId: string): Promise<CorrLetterDto> {
    const resolved = await this.resolveViewerEdge(scope, letterId);

    if (!resolved) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    const { edge, letter } = resolved;

    const isSender = edge === 'SENDER';
    const canSeeBcc =
      isSender ||
      (scope.canManage &&
        (letter.classification === 'NORMAL' || scope.canReadConfidential));

    const recipients = await this.prisma.letterRecipient.findMany({
      where: {
        letterId,
        // BCC identities are only ever selected for the entitled viewer. Everyone
        // else keeps their OWN row (so their BCC status renders) and nothing more.
        ...(canSeeBcc ? {} : { OR: [{ kind: { not: 'BCC' } }, { userId: scope.userId }] }),
      },
      select: {
        id: true,
        // The `user` RELATION is gone (DC-CORR-01): its id is selected here and the
        // person is resolved in the batched directory call below.
        userId: true,
        kind: true,
        state: true,
        deliveredAt: true,
        viewedAt: true,
        readAt: true,
      },
      orderBy: [{ kind: 'asc' as const }, { id: 'asc' as const }],
    });

    // Sender + every visible recipient in ONE directory call for the whole detail view.
    const profiles = await this.profilesById([
      letter.senderId,
      ...recipients.map((row) => row.userId),
    ]);

    return {
      ...projectLetter(
        letter,
        profiles.get(letter.senderId) ?? unknownUserProfile(letter.senderId),
      ),
      recipients: recipients.map((row) => ({
        id: row.id,
        user: profiles.get(row.userId) ?? unknownUserProfile(row.userId),
        kind: row.kind as 'TO' | 'CC' | 'BCC',
        state: row.state,
        deliveredAt: row.deliveredAt,
        viewedAt: row.viewedAt,
        readAt: row.readAt,
      })),
      canSeeBcc,
      viewerEdge: edge,
      viewerState: resolved.myRecipient?.state ?? null,
    };
  }


  /** Public detail entrypoint: resolves the scope, then the entitled projection. */
  async getLetter(userId: string, letterId: string): Promise<CorrLetterDto> {
    const scope = await this.scope(userId);
    return this.getLetterFor(scope, letterId);
  }

  /**
   * The caller's visible-letter predicate + tenant, for sibling services
   * (attachments) that must apply the SAME authorization edge without duplicating
   * it. Security-critical: exported deliberately narrow — the predicate alone can
   * never grant access to a letter the caller cannot see.
   */
  async visiblePredicateFor(userId: string): Promise<{
    tenantId: string;
    where: Prisma.LetterWhereInput;
  }> {
    const scope = await this.scope(userId);
    return { tenantId: scope.tenantId, where: this.visibleLetterWhere(scope) };
  }

  /**
   * Full content projection — body HTML (already sanitized at write time) and the
   * action surface for the view page. Reading is a REAL edge check; there is no
   * path that returns content without one.
   */
  async getLetterContent(
    userId: string,
    letterId: string,
  ): Promise<
    CorrLetterDto & {
      bodyHtml: string;
      attachments: AttachmentRefDto[];
      canEdit: boolean;
      canSend: boolean;
      canRefer: boolean;
      canArchive: boolean;
      canMarkRead: boolean;
      referralHistoryVisible: boolean;
    }
  > {
    const scope = await this.scope(userId);
    const detail = await this.getLetterFor(scope, letterId);

    const letter = await this.prisma.letter.findFirst({
      where: { id: letterId, tenantId: scope.tenantId },
      select: { id: true, bodyHtml: true, status: true, signatureId: true },
    });

    if (!letter) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    const attachments: AttachmentRefDto[] = await this.prisma.letterAttachment.findMany({
      // Same authorization predicate as every other read: the caller's visible
      // letter set within their tenant. An attachment of an unseeable letter is
      // invisible here too. Metadata only — storageKey never leaves the server.
      where: {
        letterId,
        letter: { AND: [{ tenantId: scope.tenantId }, this.visibleLetterWhere(scope)] },
      },
      select: { id: true, fileName: true, mimeType: true, size: true },
      orderBy: { createdAt: 'asc' },
    });

    const isSender = detail.viewerEdge === 'SENDER';
    const participant =
      isSender || detail.viewerEdge === 'RECIPIENT' || detail.viewerEdge === 'REFERRAL_TARGET';

    return {
      ...detail,
      bodyHtml: letter.bodyHtml,
      attachments,
      canEdit: isSender && isLetterEditable(letter.status),
      canSend: isSender && isSendableLetterStatus(letter.status),
      canRefer:
        letter.status === 'SENT' &&
        (participant || scope.canManage) &&
        detail.viewerState !== 'ACTED',
      canArchive: letter.status === 'SENT' && (participant || scope.canManage),
      canMarkRead:
        detail.viewerEdge === 'RECIPIENT' &&
        detail.viewerState !== null &&
        detail.viewerState !== 'ACTED',
      // Referral identities are for the sender, the manager, or the users involved;
      // a plain recipient sees that referrals exist, not who they name.
      referralHistoryVisible: isSender || scope.canManage,
    };
  }


  /**
   * Marks VIEWED / READ for the CALLER's own recipient row. Explicit server-side
   * action = real tracking timestamps. Unauthorized access attempts never produce
   * tracking rows (the mark requires the recipient row to exist). Idempotent: a
   * repeated mark keeps the FIRST timestamp and reports success.
   */
  async markLetter(
    userId: string,
    letterId: string,
    mark: 'VIEWED' | 'READ',
  ): Promise<{ id: string; state: string; at: Date }> {
    const scope = await this.scope(userId);

    const letter = await this.prisma.letter.findFirst({
      where: { id: letterId, tenantId: scope.tenantId, status: 'SENT' },
      select: { id: true },
    });

    if (!letter) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    const recipient = await this.prisma.letterRecipient.findFirst({
      where: { letterId, userId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, state: true, deliveredAt: true },
    });

    if (!recipient || !recipient.deliveredAt) {
      // A referral target without a recipient row cannot "read" the letter here.
      throw new NotFoundException('نامه در صندوق شما یافت نشد.');
    }

    const at = new Date();

    if (mark === 'VIEWED' && !canRecipientView(recipient.state as never)) {
      // Already past VIEWED — idempotent success with the existing state.
      return { id: letterId, state: recipient.state, at };
    }

    if (mark === 'READ' && !canRecipientRead(recipient.state as never)) {
      return { id: letterId, state: recipient.state, at };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.letterRecipient.update({
        where: { id: recipient.id },
        data: {
          state: mark,
          ...(mark === 'VIEWED' ? { viewedAt: at } : { readAt: at }),
        },
      });

      // Only record the event ONCE per subject per mark: tracking is a trace of
      // real actions, not a log of repeated renders.
      const already = await tx.letterTrackingEvent.findFirst({
        where: { letterId, type: mark, recipientUserId: scope.userId },
        select: { id: true },
      });

      if (!already) {
        await tx.letterTrackingEvent.create({
          data: {
            letterId,
            type: mark,
            actorId: scope.userId,
            recipientUserId: scope.userId,
          },
        });
      }
    });

    return { id: letterId, state: mark, at };
  }


  /**
   * Creates a referral (ارجاع) on a SENT letter the caller may see.
   *
   * Rules enforced here, in order:
   *  - the caller needs a REAL edge (sender / recipient / referral target / manager);
   *  - the letter must be SENT — nothing is referred before it exists officially;
   *  - the target must be an in-tenant user and NOT the caller themselves
   *    (LetterReferral_users_differ CHECK is the backstop);
   *  - confidentiality is derived from the LETTER's classification and the caller's
   *    confidential-manage permission — the client's `isConfidential` flag can never
   *    manufacture or hide a محرمانه referral;
   *  - `clientKey` (UNIQUE) makes a retried create idempotent: the same key returns
   *    the original referral (409 only for a DIFFERENT key colliding).
   *  - `removeFromInbox` is REAL: the caller's own recipient row is removed in the
   *    same transaction, so their cartable actually empties.
   */
  async createReferral(userId: string, letterId: string, dto: CreateReferralDto): Promise<ReferralDto> {
    const scope = await this.scope(userId);

    if (dto.clientKey) {
      const replay = await this.prisma.letterReferral.findUnique({
        where: { clientKey: dto.clientKey },
        select: { id: true, letterId: true, fromUserId: true },
      });

      if (replay && replay.letterId === letterId && replay.fromUserId === scope.userId) {
        return this.getReferralFor(scope, replay.id);
      }
    }

    const resolved = await this.resolveViewerEdge(scope, letterId);

    if (!resolved) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    if (resolved.letter.status !== 'SENT') {
      throw new ConflictException('فقط نامه ارسال‌شده قابل ارجاع است.');
    }

    if (dto.toUserId === scope.userId) {
      throw new BadRequestException('ارجاع به خود مجاز نیست.');
    }

    // The referral TARGET must be a member of the caller's tenant. Asked through the
    // platform directory port, which answers membership without exposing the account,
    // and preserves the probe-safe wording below.
    const target = await this.users.findTenantMember(scope.tenantId, dto.toUserId);

    if (!target) {
      // Same probe-safe wording as recipient resolution.
      throw new BadRequestException('گیرنده ارجاع در سازمان شما یافت نشد.');
    }

    // Confidentiality is server-derived: CONFIDENTIAL/SECRET letters are always
    // confidential referrals; a NORMAL letter can only be escalated by a caller
    // holding correspondence.confidential.manage.
    const letterConfidential = resolved.letter.classification !== 'NORMAL';
    if (letterConfidential && !scope.canWriteConfidential) {
      throw new ForbiddenException('ارجاع نامه محرمانه مجاز نیست.');
    }
    const isConfidential = letterConfidential;

    const referral = await this.prisma.$transaction(async (tx) => {
      const created = await tx.letterReferral.create({
        data: {
          letterId,
          tenantId: scope.tenantId,
          fromUserId: scope.userId,
          toUserId: dto.toUserId,
          urgency: dto.urgency ?? 'NORMAL',
          level: dto.level,
          instruction: dto.instruction ?? null,
          isConfidential,
          removeFromInbox: dto.removeFromInbox ?? false,
          clientKey: dto.clientKey ?? null,
          status: 'PENDING',
        },
        select: { id: true },
      });

      await tx.letterTrackingEvent.create({
        data: {
          letterId,
          type: 'REFERRED',
          actorId: scope.userId,
          metadata: { referralId: created.id, toUserId: dto.toUserId, level: dto.level },
        },
      });

      if (dto.removeFromInbox && resolved.myRecipient) {
        await tx.letterRecipient.update({
          where: { id: resolved.myRecipient.id },
          data: { removedAt: new Date() },
        });
      }

      // Best-effort notification inside the transaction's commit scope.
      if (this.notifications) {
        try {
          await this.notifications.createForUser({
            userId: dto.toUserId,
            tenantId: scope.tenantId,
            type: 'INFORMATION',
            title: 'ارجاع جدید',
            body: resolved.letter.subject,
            sourceType: 'correspondence-referral',
            sourceId: created.id,
          });
        } catch {
          // A notification failure never fails the referral.
        }
      }

      return created;
    });

    await this.audit?.log({
      requestId: RequestContextService.get()?.requestId ?? `corr-ref-${referral.id}`,
      correlationId: RequestContextService.get()?.correlationId,
      userId: scope.userId,
      action: 'correspondence_letter_referred',
      resource: 'correspondence',
      resourceId: letterId,
      success: true,
      reason: `referralId=${referral.id} to=${dto.toUserId} level=${dto.level}`,
    });

    return this.getReferralFor(scope, referral.id);
  }


  /** Referral projection — only the edges that may see one. */
  async getReferralFor(scope: CorrScope, referralId: string): Promise<ReferralDto> {
    const referral = await this.prisma.letterReferral.findFirst({
      where: {
        id: referralId,
        tenantId: scope.tenantId,
        OR: [{ fromUserId: scope.userId }, { toUserId: scope.userId }],
      },
      select: {
        id: true,
        letterId: true,
        fromUserId: true,
        toUserId: true,
        urgency: true,
        level: true,
        instruction: true,
        isConfidential: true,
        removeFromInbox: true,
        status: true,
        viewedAt: true,
        actedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });

    if (!referral) {
      throw new NotFoundException('ارجاع یافت نشد.');
    }

    // Both parties in ONE directory call. An id the directory no longer knows keeps
    // its historical place in the referral (D2) and renders as «کاربر».
    const profiles = await this.profilesById([referral.fromUserId, referral.toUserId]);

    return {
      id: referral.id,
      letterId: referral.letterId,
      from: profiles.get(referral.fromUserId) ?? unknownUserProfile(referral.fromUserId),
      to: profiles.get(referral.toUserId) ?? unknownUserProfile(referral.toUserId),
      urgency: referral.urgency,
      level: referral.level,
      instruction: referral.instruction,
      isConfidential: referral.isConfidential,
      status: referral.status,
      viewedAt: referral.viewedAt,
      actedAt: referral.actedAt,
      completedAt: referral.completedAt,
      createdAt: referral.createdAt,
    };
  }

  /**
   * The referral HISTORY of one letter (the "سابقه ارجاع" timeline). Visible to the
   * sender and the tenant manager; participants see only their own referral rows.
   * Immutable: there is no edit and no delete anywhere.
   */
  async listReferrals(userId: string, letterId: string): Promise<ReferralDto[]> {
    const scope = await this.scope(userId);

    const resolved = await this.resolveViewerEdge(scope, letterId);
    if (!resolved) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    const isSender = resolved.edge === 'SENDER';
    const fullHistory = isSender || scope.canManage;

    const rows = await this.prisma.letterReferral.findMany({
      where: {
        letterId,
        tenantId: scope.tenantId,
        ...(fullHistory ? {} : { OR: [{ fromUserId: scope.userId }, { toUserId: scope.userId }] }),
      },
      select: {
        id: true,
        letterId: true,
        fromUserId: true,
        toUserId: true,
        urgency: true,
        level: true,
        instruction: true,
        isConfidential: true,
        status: true,
        viewedAt: true,
        actedAt: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      take: MAX_TRACKING_EVENTS,
    });

    // One directory call for the whole timeline, both parties of every referral.
    const profiles = await this.profilesById(
      rows.flatMap((row) => [row.fromUserId, row.toUserId]),
    );

    return rows.map((row) => ({
      id: row.id,
      letterId,
      from: profiles.get(row.fromUserId) ?? unknownUserProfile(row.fromUserId),
      to: profiles.get(row.toUserId) ?? unknownUserProfile(row.toUserId),
      urgency: row.urgency,
      level: row.level,
      instruction: row.instruction,
      isConfidential: row.isConfidential,
      status: row.status,
      viewedAt: row.viewedAt,
      actedAt: row.actedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Advances a referral's status: PENDING → VIEWED (by the target), then VIEWED →
   * ACTED (by the target, completing it). The referrer and managers may READ the
   * history; only the TARGET may transition, and ACTED stamps the caller's own
   * recipient row too (the letter is "done" for them).
   */
  async updateReferralStatus(
    userId: string,
    referralId: string,
    target: 'PENDING' | 'VIEWED' | 'ACTED',
  ): Promise<ReferralDto> {
    const scope = await this.scope(userId);

    const referral = await this.prisma.letterReferral.findFirst({
      where: { id: referralId, tenantId: scope.tenantId },
      select: { id: true, letterId: true, fromUserId: true, toUserId: true, status: true },
    });

    if (!referral) {
      throw new NotFoundException('ارجاع یافت نشد.');
    }

    if (referral.toUserId !== scope.userId) {
      // The referrer and managers may read; only the target transitions.
      throw new ForbiddenException('فقط گیرنده ارجاع می‌تواند وضعیت را تغییر دهد.');
    }

    const legal =
      (referral.status === 'PENDING' && (target === 'VIEWED' || target === 'ACTED')) ||
      (referral.status === 'VIEWED' && target === 'ACTED');

    if (!legal) {
      throw new ConflictException(
        `انتقال وضعیت ارجاع از ${referral.status} به ${target} مجاز نیست.`,
      );
    }

    const at = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.letterReferral.update({
        where: { id: referral.id },
        data:
          target === 'VIEWED'
            ? { status: 'VIEWED', viewedAt: at }
            : { status: 'ACTED', actedAt: at, completedAt: at },
      });

      await tx.letterTrackingEvent.create({
        data: {
          letterId: referral.letterId,
          type: target === 'ACTED' ? 'REFERRAL_ACTED' : 'VIEWED',
          actorId: scope.userId,
          recipientUserId: scope.userId,
          metadata: { referralId: referral.id },
        },
      });

      if (target === 'ACTED') {
        // The letter is done for this subject: stamp their recipient row too, if
        // they hold one (a referral-only target has none and that is fine).
        await tx.letterRecipient.updateMany({
          where: { letterId: referral.letterId, userId: scope.userId },
          data: { state: 'ACTED', actedAt: at },
        });
      }
    });

    return this.getReferralFor(scope, referralId);
  }


  // ==========================================================================
  // Archive (بایگانی شخصی)
  // ==========================================================================

  /** My folder tree (پوشه‌های بایگانی), roots first, children nested one level. */
  async listArchiveFolders(userId: string): Promise<ArchiveFolderDto[]> {
    const scope = await this.scope(userId);

    const rows = await this.prisma.archiveFolder.findMany({
      where: { ownerId: scope.userId, tenantId: scope.tenantId },
      select: {
        id: true,
        name: true,
        parentId: true,
        createdAt: true,
        _count: { select: { entries: true } },
      },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    });

    const byParent = new Map<string | null, ArchiveFolderDto[]>();
    for (const row of rows) {
      const list = byParent.get(row.parentId) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        entryCount: row._count.entries,
        createdAt: row.createdAt,
      });
      byParent.set(row.parentId, list);
    }

    return (byParent.get(null) ?? []).map((root) => ({
      ...root,
      children: byParent.get(root.id) ?? [],
    }));
  }

  /**
   * Creates a folder. Depth is limited to TWO levels below the root (the reference
   * tree's real shape); a duplicate name under the same parent is refused, and two
   * ROOT folders with the same name are refused even though Postgres' NULL semantics
   * would permit them.
   */
  async createArchiveFolder(userId: string, dto: CreateArchiveFolderDto): Promise<ArchiveFolderDto> {
    const scope = await this.scope(userId);

    if (dto.parentId) {
      const parent = await this.prisma.archiveFolder.findFirst({
        where: { id: dto.parentId, ownerId: scope.userId, tenantId: scope.tenantId },
        select: { id: true, parentId: true },
      });

      if (!parent) {
        throw new NotFoundException('پوشه والد یافت نشد.');
      }

      if (parent.parentId !== null) {
        throw new BadRequestException('ساختار پوشه حداکثر دو سطح است.');
      }
    }

    const siblingClash = await this.prisma.archiveFolder.findFirst({
      where: {
        ownerId: scope.userId,
        tenantId: scope.tenantId,
        name: dto.name,
        ...(dto.parentId ? { parentId: dto.parentId } : { parentId: null }),
      },
      select: { id: true },
    });

    if (siblingClash) {
      throw new ConflictException('پوشه‌ای با همین نام در همین سطح وجود دارد.');
    }

    const created = await this.prisma.archiveFolder.create({
      data: {
        tenantId: scope.tenantId,
        ownerId: scope.userId,
        name: dto.name,
        parentId: dto.parentId ?? null,
      },
    });

    return {
      id: created.id,
      name: created.name,
      parentId: created.parentId,
      entryCount: 0,
      createdAt: created.createdAt,
    };
  }


  /** Renames a folder. Ownership and tenant are re-checked; depth is untouched. */
  async renameArchiveFolder(userId: string, folderId: string, name: string): Promise<ArchiveFolderDto> {
    const scope = await this.scope(userId);

    const folder = await this.prisma.archiveFolder.findFirst({
      where: { id: folderId, ownerId: scope.userId, tenantId: scope.tenantId },
      select: { id: true, parentId: true, createdAt: true },
    });

    if (!folder) {
      throw new NotFoundException('پوشه یافت نشد.');
    }

    const siblingClash = await this.prisma.archiveFolder.findFirst({
      where: {
        ownerId: scope.userId,
        tenantId: scope.tenantId,
        name,
        ...(folder.parentId ? { parentId: folder.parentId } : { parentId: null }),
        id: { not: folder.id },
      },
      select: { id: true },
    });

    if (siblingClash) {
      throw new ConflictException('پوشه‌ای با همین نام در همین سطح وجود دارد.');
    }

    await this.prisma.archiveFolder.update({ where: { id: folder.id }, data: { name } });

    return {
      id: folder.id,
      name,
      parentId: folder.parentId,
      entryCount: 0,
      createdAt: folder.createdAt,
    };
  }

  /**
   * Deletes a folder — ONLY when it has no subfolders. Entries inside are unarchived
   * (their rows survive with folderId=NULL), never destroyed: unarchiving is a
   * visible state, not a forgotten history.
   */
  async deleteArchiveFolder(userId: string, folderId: string): Promise<{ deleted: true; id: string }> {
    const scope = await this.scope(userId);

    const childCount = await this.prisma.archiveFolder.count({
      where: { parentId: folderId, ownerId: scope.userId },
    });

    if (childCount > 0) {
      throw new ConflictException('ابتدا زیرپوشه‌ها را حذف کنید.');
    }

    const result = await this.prisma.archiveFolder.deleteMany({
      where: { id: folderId, ownerId: scope.userId, tenantId: scope.tenantId },
    });

    if (result.count === 0) {
      throw new NotFoundException('پوشه یافت نشد.');
    }

    return { deleted: true, id: folderId };
  }


  /**
   * Archives a letter for ME (بایگانی). UNIQUE per (letter, user): re-archiving
   * MOVES the entry to the new folder instead of duplicating it. Requires a real
   * edge on a SENT letter.
   */
  async archiveLetter(
    userId: string,
    letterId: string,
    folderId: string | null,
  ): Promise<ArchiveEntryDto> {
    const scope = await this.scope(userId);

    const resolved = await this.resolveViewerEdge(scope, letterId);
    if (!resolved) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    if (resolved.letter.status !== 'SENT') {
      throw new ConflictException('فقط نامه ارسال‌شده قابل بایگانی است.');
    }

    if (folderId) {
      const folder = await this.prisma.archiveFolder.findFirst({
        where: { id: folderId, ownerId: scope.userId, tenantId: scope.tenantId },
        select: { id: true },
      });

      if (!folder) {
        throw new NotFoundException('پوشه یافت نشد.');
      }
    }

    const at = new Date();

    const entry = await this.prisma.letterArchive.upsert({
      where: { letterId_userId: { letterId, userId: scope.userId } },
      create: { letterId, userId: scope.userId, folderId, archivedAt: at, removedAt: null },
      update: { folderId, archivedAt: at, removedAt: null },
    });

    await this.prisma.letterTrackingEvent.create({
      data: { letterId, type: 'ARCHIVED', actorId: scope.userId, metadata: { folderId } },
    });

    return {
      id: entry.id,
      letterId,
      folderId: entry.folderId,
      archivedAt: entry.archivedAt,
      removedAt: entry.removedAt,
    };
  }

  /**
   * Removes MY archive entry (خروج از بایگانی). The row survives with removedAt —
   * visible state, not forgotten history — so re-archiving later updates it.
   */
  async unarchiveLetter(userId: string, letterId: string): Promise<{ removed: true; id: string }> {
    const scope = await this.scope(userId);

    const entry = await this.prisma.letterArchive.findUnique({
      where: { letterId_userId: { letterId, userId: scope.userId } },
      select: { id: true, removedAt: true },
    });

    if (!entry) {
      throw new NotFoundException('نامه در بایگانی شما یافت نشد.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.letterArchive.update({
        where: { id: entry.id },
        data: { removedAt: entry.removedAt ?? new Date() },
      });

      await tx.letterTrackingEvent.create({
        data: { letterId, type: 'UNARCHIVED', actorId: scope.userId },
      });
    });

    return { removed: true, id: letterId };
  }

  /**
   * MY archive view: entries (optionally per folder), letters allowlisted,
   * unarchived rows excluded. `folderId === null` means "همه پوشه‌ها".
   */
  async listArchive(
    userId: string,
    folderId: string | null | undefined,
    query: CorrespondenceQueryDto,
  ): Promise<CorrListResult<ArchiveEntryDto & { letter: CorrLetterDto }>> {
    const scope = await this.scope(userId);
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_CORRESPONDENCE_LIMIT, 1),
      MAX_CORRESPONDENCE_LIMIT,
    );

    const rows = await this.prisma.letterArchive.findMany({
      where: {
        userId: scope.userId,
        removedAt: null,
        ...(folderId ? { folderId } : {}),
        letter: { tenantId: scope.tenantId },
      },
      select: {
        id: true,
        letterId: true,
        folderId: true,
        archivedAt: true,
        removedAt: true,
        letter: { select: LETTER_BASE_SELECT },
      },
      orderBy: [{ archivedAt: 'desc' as const }, { id: 'desc' as const }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    // Senders hydrated in ONE directory call, like every other page in this service.
    const letters = await this.projectLetterPage(page.map((row) => row.letter));

    const items = page.map((row, index) => ({
      id: row.id,
      letterId: row.letterId,
      folderId: row.folderId,
      archivedAt: row.archivedAt,
      removedAt: row.removedAt,
      letter: letters[index],
    }));

    return { items, hasMore };
  }


  // ==========================================================================
  // Tracking timeline (سابقه)
  // ==========================================================================

  /**
   * The letter's tracking timeline — chronological, deterministic. Visible on the
   * same edge as the letter itself; recipient identity inside events is visible to
   * the sender/manager, and a plain participant sees their own subject's events
   * anonymized-where-necessary (their own rows show their name; other subjects'
   * actor names are withheld).
   */
  async getTracking(userId: string, letterId: string): Promise<TrackingEventDto[]> {
    const scope = await this.scope(userId);

    const resolved = await this.resolveViewerEdge(scope, letterId);
    if (!resolved) {
      throw new NotFoundException('نامه یافت نشد.');
    }

    const fullIdentity = resolved.edge === 'SENDER' || (scope.canManage && resolved.letter.classification === 'NORMAL');

    const rows = await this.prisma.letterTrackingEvent.findMany({
      where: { letterId },
      select: {
        id: true,
        type: true,
        actorId: true,
        recipientUserId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      take: MAX_TRACKING_EVENTS,
    });

    // Actors hydrated in ONE directory call (null actorId = a system event).
    const profiles = await this.profilesById(
      rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)),
    );

    return rows.map((row) => {
      const actorId = row.actorId;
      const profile = actorId ? profiles.get(actorId) ?? unknownUserProfile(actorId) : null;

      return {
        id: row.id,
        type: row.type,
        actor:
          !profile
            ? null
            : fullIdentity || row.actorId === scope.userId
              ? profile
              : // A participant who is not the actor sees that something happened, and
                // WHO only as an avatar/title — never the name. Unchanged from before the
                // extraction; only the source of the profile changed.
                {
                  id: profile.id,
                  firstName: null,
                  lastName: null,
                  avatarUrl: profile.avatarUrl,
                  jobTitle: profile.jobTitle,
                  department: null,
                },
        recipientUserId:
          fullIdentity || row.recipientUserId === scope.userId ? row.recipientUserId : null,
        metadata: row.metadata,
        createdAt: row.createdAt,
      };
    });
  }


  // ==========================================================================
  // Classification administration + bounded search
  // ==========================================================================

  /**
   * Changes a SENT letter's classification. Manager-only
   * (`correspondence.manage`), audited as a security-sensitive mutation, and
   * recorded on the letter's timeline. NEVER permitted on a draft: a draft's
   * classification is the sender's authoring decision (updateDraft), not an
   * administrative override.
   */
  async changeClassification(
    userId: string,
    letterId: string,
    classification: 'NORMAL' | 'CONFIDENTIAL' | 'SECRET',
  ): Promise<CorrLetterDto> {
    const scope = await this.scope(userId);

    if (!scope.canManage) {
      throw new ForbiddenException('تغییر طبقه‌بندی نیازمند دسترسی مدیریت مکاتبات است.');
    }

    const letter = await this.prisma.letter.findFirst({
      where: { id: letterId, tenantId: scope.tenantId, status: 'SENT' },
      select: { id: true, classification: true },
    });

    if (!letter) {
      throw new NotFoundException('نامه یافت نشد یا ارسال نشده است.');
    }

    if (letter.classification === classification) {
      return this.getLetterFor(scope, letterId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.letter.update({
        where: { id: letter.id },
        data: { classification },
      });

      await tx.letterTrackingEvent.create({
        data: {
          letterId,
          type: 'CLASSIFICATION_CHANGED',
          actorId: scope.userId,
          metadata: { from: letter.classification, to: classification },
        },
      });
    });

    await this.audit?.log({
      requestId: RequestContextService.get()?.requestId ?? `corr-cls-${letterId}`,
      correlationId: RequestContextService.get()?.correlationId,
      userId: scope.userId,
      action: 'correspondence_classification_changed',
      resource: 'correspondence',
      resourceId: letterId,
      success: true,
      reason: `from=${letter.classification} to=${classification}`,
    });

    return this.getLetterFor(scope, letterId);
  }


  /**
   * Bounded correspondence search (جستجوی پیشرفته). Authorization is the FILTER,
   * never an afterthought: every candidate row must satisfy `visibleLetterWhere`
   * — the same predicate the lists use — so scope=all can never widen beyond the
   * caller's tenant-manager entitlement. Persian normalization is applied to the
   * free-text query through the shared search module's normalizer (49J).
   *
   * Body plaintext is searched WITHOUT projecting it: the letter body is too large
   * to index in SearchDocument and never leaves the server raw.
   */
  async searchLetters(
    userId: string,
    query: CorrSearchQueryDto,
  ): Promise<CorrListResult<CorrSearchItemDto>> {
    const scope = await this.scope(userId);
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_CORRESPONDENCE_LIMIT, 1),
      MAX_CORRESPONDENCE_LIMIT,
    );

    const filters: Prisma.LetterWhereInput[] = [];

    if (query.q) {
      const needles = normalizePersianQuery(query.q)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);

      if (needles.length > 0) {
        filters.push({
          OR: [
            { subject: { contains: needles[0], mode: 'insensitive' } },
            { letterNumber: { contains: needles[0], mode: 'insensitive' } },
            { category: { contains: needles[0], mode: 'insensitive' } },
          ],
        });
      }
    }

    if (query.letterNumber) {
      filters.push({ letterNumber: { contains: query.letterNumber, mode: 'insensitive' } });
    }
    if (query.subject) {
      filters.push({ subject: { contains: query.subject, mode: 'insensitive' } });
    }
    if (query.senderId) {
      filters.push({ senderId: query.senderId });
    }
    if (query.recipientId) {
      filters.push({ recipients: { some: { userId: query.recipientId } } });
    }
    if (query.status) {
      filters.push({ status: query.status });
    }
    if (query.urgency) {
      filters.push({ urgency: query.urgency });
    }
    if (query.classification) {
      filters.push({ classification: query.classification });
    }
    if (query.category) {
      filters.push({ category: { contains: query.category, mode: 'insensitive' } });
    }
    if (query.dateFrom || query.dateTo) {
      filters.push({
        createdAt: {
          ...(query.dateFrom ? { gte: parseDateBound(query.dateFrom) } : {}),
          ...(query.dateTo ? { lte: parseDateBound(query.dateTo) } : {}),
        },
      });
    }
    if (query.hasAttachments === 'yes') {
      filters.push({ attachments: { some: {} } });
    }
    if (query.hasAttachments === 'no') {
      filters.push({ attachments: { none: {} } });
    }
    if (query.confidential === 'yes') {
      filters.push({ classification: { not: 'NORMAL' } });
    }
    if (query.confidential === 'no') {
      filters.push({ classification: 'NORMAL' });
    }

    const where: Prisma.LetterWhereInput = {
      AND: [this.visibleLetterWhere(scope), ...filters],
    };

    const rows = await this.prisma.letter.findMany({
      where,
      select: {
        ...LETTER_BASE_SELECT,
        _count: { select: { attachments: true } },
      },
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;

    const letters = await this.projectLetterPage(rows.slice(0, limit));

    const items: CorrSearchItemDto[] = rows.slice(0, limit).map((row, index) => ({
      ...letters[index],
      attachmentCount: row._count.attachments,
    }));

    return { items, hasMore };
  }



}
