import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FINANCIAL_DEFAULT_PAGE_SIZE, FINANCIAL_MAX_PAGE_SIZE } from '../financial.constants';
import {
  CHECK_ISSUE_TYPES,
  CHECK_PURCHASE_TYPES,
  CHECK_REQUEST_STATUSES,
  DOCUMENT_REVIEW_DECISIONS,
  EXECUTIVE_DECISIONS,
  REQUESTER_OPINIONS,
} from './check-request-status';
import { CHECK_DOCUMENT_TYPES } from './check-request';
import type { CheckDocumentType } from './check-request';
import type {
  CheckIssueType,
  CheckPurchaseType,
  DocumentReviewDecision,
  ExecutiveDecision,
  RequesterOpinion,
} from './check-request-status';

/**
 * The ریال shape the allocation columns can hold: `DECIMAL(18,0)` = up to 18 digits,
 * no sign (an amount and a balance are magnitudes the source composed with `parseInt`)
 * and no separator (a formatted string would need a locale to parse back).
 */
const FINANCIAL_RIAL_PATTERN = /^\d{1,18}$/;

/**
 * Phase F1 — FINANCIAL FOUNDATION: the wire contract of the check-request routes —
 * create, read, list, update-while-requester-owned, submit, the three decision acts, the
 * timeline and the attachment metadata surface.
 *
 * WHY THE COLUMN LENGTHS ARE MIRRORED HERE INSTEAD OF BEING LEFT TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Every maximum below is the width of the column the value lands in (`VARCHAR(128)` for
 * an opaque reference, `VARCHAR(64)` for the wire bound on a platform user id,
 * `VARCHAR(2000)` for a comment). Without a DTO bound, a long value reaches Postgres and
 * comes back as a driver error — a 500 for what is a client mistake, with no field name
 * attached. With the bound here it is a 400 naming the field, and the database constraint
 * stays what it is: the last line of defence rather than the only one.
 *
 * WHAT IS DELIBERATELY NOT ON THE WIRE — the brief's §17 list, field by field
 * --------------------------------------------------------------------------
 *  * NO `tenantId` — it comes from `resolveFinancialActor(req)`. The global pipe's
 *    `whitelist` + `forbidNonWhitelisted` turns sending one into a typed refusal naming
 *    the field (the same pattern `bom-change.dto.ts` and `return.dto.ts` use) rather than
 *    a silently ignored field, which is the difference between a multi-tenant module and
 *    a data leak.
 *  * NO `requesterUserId` — it is FORCED from the authenticated actor on create (V6).
 *    The source filled `c_DarkhastKonande` from the current user; a wire field would let
 *    one person raise a request in another's name.
 *  * NO `status`, NO `nextState` — the lifecycle is walked by the routes that own each
 *    transition; a client that could state a status could approve its own request.
 *  * NO `managerDecision` / `managerComment` / `decidedAt` / `decidedByUserId` on any
 *    payload EXCEPT the decision routes' own `comment` — the DECISION is written by the
 *    decision routes only, and the route states which decision it records (the brief's
 *    "manager decision" is an outcome of calling `/approve`, never a body field).
 *  * NO `requestDate` — the server generates it (the source defaults it to today and
 *    offers no editor).
 *  * NO `title` — `c_Title` is `IsCalculated` in the source; the server builds it from
 *    the row's own facts (`buildCheckRequestTitle`), so a wire `title` is refused.
 *  * NO `id`, `createdAt`, `updatedAt` — server-owned.
 *  * NO cheque-instrument field of any kind (number, serial, bank, account, IBAN, Sayad,
 *    due date, signatory): Preflight §10 established them as NOT ESTABLISHED, and the
 *    brief forbids inventing them. There is no column to put one in either.
 */

/**
 * The wire bound on an EXTERNAL reference (order, project).
 *
 * The column is `VARCHAR(128)`. The bound is a LENGTH rule, NOT a format rule: the format
 * of those two identifiers has no authoritative contract yet (the Purchase and Project
 * contracts are Future Contract Requirements, Preflight §18), so a UUID validator would
 * reject a legitimate legacy id while proving nothing.
 */
export const MAX_FINANCIAL_EXTERNAL_REF_LENGTH = 128;

/**
 * The wire bound on a PLATFORM USER ID (project manager).
 *
 * `@IsString()` + `@MaxLength(64)` + `@MinLength(1)`, and NEVER `ParseUUIDPipe` or
 * `@IsUUID()` — the same rule `production/bom/bom.dto.ts` and
 * `commerce/commercial/commercial.dto.ts` state: mixing the two up is how a legitimate
 * user id gets refused.
 */
export const MAX_FINANCIAL_USER_ID_LENGTH = 64;

/** The manager's comment bound (the column is `VARCHAR(2000)`). */
export const MAX_FINANCIAL_MANAGER_COMMENT_LENGTH = 2000;

/**
 * The create payload — the source's state-0 form, minus every server-owned field.
 *
 * REQUIREDNESS IS SPLIT, DELIBERATELY: `checkIssueType` is the only DTO-required field
 * (V1 — the source refuses an empty type first), while V2/V3/V4/V5 depend on the
 * COMBINATION of type and purchase type and therefore live in the service, in the
 * source's own evaluation order, each carrying the source's sentence as a typed code.
 */
export class CreateCheckRequestDto {
  @IsIn(CHECK_ISSUE_TYPES as unknown as string[], {
    message: 'checkIssueType must be one of PURCHASE, PETTY_CASH, SALARY.',
  })
  checkIssueType!: CheckIssueType;

  @IsOptional()
  @IsIn(CHECK_PURCHASE_TYPES as unknown as string[])
  purchaseType?: CheckPurchaseType;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FINANCIAL_EXTERNAL_REF_LENGTH)
  orderReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FINANCIAL_EXTERNAL_REF_LENGTH)
  projectReference?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_FINANCIAL_USER_ID_LENGTH)
  projectManagerUserId?: string;

  @IsOptional()
  @IsIn(REQUESTER_OPINIONS as unknown as string[])
  requesterOpinion?: RequesterOpinion;
}

/**
 * The update payload — the same fields as create, all optional, applied to a
 * requester-owned row (states 0 and 1).
 *
 * AN EMPTY PATCH IS A 400 (the service refuses it): `updatedAt` only moves on a real
 * write, and an audit row for a mutation that changed nothing would make the trail
 * unable to distinguish a no-op from a real edit.
 *
 * ABSENT IS NOT NULL, AND THE DTO CANNOT EXPRESS "CLEAR": every field here is optional,
 * and a stated field is validated in context. Clearing is the SERVER's business — the
 * source's own conditional clearing (V7) rewrites the row on save regardless of what the
 * client sent, so there is no wire way to state "remove the order reference" beyond
 * changing the `checkIssueType` that clears it, exactly as the source behaved.
 */
export class UpdateCheckRequestDto {
  @IsOptional()
  @IsIn(CHECK_ISSUE_TYPES as unknown as string[])
  checkIssueType?: CheckIssueType;

  @IsOptional()
  @IsIn(CHECK_PURCHASE_TYPES as unknown as string[])
  purchaseType?: CheckPurchaseType;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FINANCIAL_EXTERNAL_REF_LENGTH)
  orderReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FINANCIAL_EXTERNAL_REF_LENGTH)
  projectReference?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_FINANCIAL_USER_ID_LENGTH)
  projectManagerUserId?: string;

  @IsOptional()
  @IsIn(REQUESTER_OPINIONS as unknown as string[])
  requesterOpinion?: RequesterOpinion;
}

/**
 * The register read's filters. `status` accepts ONLY the ordinals F1 implements, and
 * `search` is matched against the TITLE — the one text column a request owns, which is
 * exactly what the BOM register's `search` does.
 */
export class ListCheckRequestsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCIAL_MAX_PAGE_SIZE)
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(CHECK_REQUEST_STATUSES as unknown as number[])
  status?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Resolves the effective page window for a list query, clamped to the ceiling. */
export function resolveFinancialPageWindow(query: ListCheckRequestsQueryDto): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(
    FINANCIAL_MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ?? FINANCIAL_DEFAULT_PAGE_SIZE)
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * The decision payload — the manager's OPTIONAL comment and NOTHING ELSE.
 *
 * THE ROUTE STATES THE DECISION. There is no `decision` / `opinion` field here on
 * purpose: the brief's §17 forbids a client-sent manager decision, and the BOM
 * precedent's `opinion`-must-match-expected check exists only because its DTO carried
 * one. With no field to carry it, a reject route cannot record an APPROVE by body.
 *
 * The comment is OPTIONAL exactly as the source is ("comment not enforced in source",
 * Preflight §8.1) — `c_TozihatModir` was a free-text box with no save-time rule.
 */
export class DecideCheckRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_FINANCIAL_MANAGER_COMMENT_LENGTH)
  comment?: string;
}

/**
 * The query of `GET /financial/check-requests/:id/timeline` — `page` and `pageSize` only,
 * exactly like `BomTimelineQueryDto`.
 *
 * The timeline's SCOPE is not a request input and cannot become one: `tenantId` comes
 * from `resolveFinancialActor`, `resource` is the closed vocabulary constant
 * `financial.check-request`, and `resourceId` is the `:id` the route already parsed as a
 * UUID v4 and then resolved tenant-scoped.
 */
export class CheckRequestTimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCIAL_MAX_PAGE_SIZE)
  pageSize?: number;
}

/** Resolves the timeline's page window against the MODULE's own page-size pair. */
export function resolveFinancialTimelineWindow(query: CheckRequestTimelineQueryDto): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    FINANCIAL_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? FINANCIAL_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}

/**
 * The attachment metadata patch — the source's `NoeaSanad` + `Tozihat` columns of ONE
 * already-uploaded document.
 *
 * THE FILE ITSELF IS NOT REPLACEABLE: the source's grid edited metadata in place and
 * "replaced" a document by deleting and uploading again, so a bytes-replacing PATCH would
 * be an invented capability. To change the file, delete and upload — the same two acts
 * the source offered.
 */
export class UpdateCheckAttachmentDto {
  @IsOptional()
  @IsIn(CHECK_DOCUMENT_TYPES as unknown as string[])
  documentType?: CheckDocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

/**
 * The allocation payload (stage 3 «صدور فرم تخصیص») — the source's six fields under
 * their source names, and NOTHING else.
 *
 * MONEY IS A DIGIT STRING, deliberately: the column is `DECIMAL(18,0)` and the source
 * treated both amounts as integers (`parseInt`), so the wire carries exactly what the
 * column can hold. An 18-digit ریال amount exceeds IEEE-754 safety, which is why this
 * is a string rather than a number — a JSON number would silently round.
 *
 * NOT ON THE WIRE, same rule as every F1 DTO: no `status`, no `takhsis` marker (the
 * transition IS the confirmation), no actor/tenant fields.
 */
export class AllocateCheckRequestDto {
  /** `MahaleTakhsis` — required («محل تخصیص نمی تواند خالی باشد.»). */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  allocationPlace!: string;

  /** `MandeMojoodi` — optional (the source compared only when parseable). */
  @IsOptional()
  @Matches(FINANCIAL_RIAL_PATTERN)
  balance?: string;

  /** `TarikhCheck` — optional ISO date (`YYYY-MM-DD`), the column's own precision. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkDate?: string;

  /** `SharhCheck` — optional free text. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  checkDescription?: string;

  /** `MablagheCheck` — required («مبلغ چک نمی تواند خالی باشد.»). */
  @Matches(FINANCIAL_RIAL_PATTERN)
  checkAmount!: string;

  /** `DarVaghe` — optional free text. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  payableTo?: string;
}

/**
 * The document-review payload (stage 4). The DECISION IS ON THE WIRE here because the
 * source's control offered exactly two values in ONE form (`تایید;اصلاح`) — unlike the
 * manager's three routes, the review stage has no route-per-outcome split in the brief's
 * route list. The service still maps the decision to its transition; the DTO cannot
 * state anything else.
 */
export class DecideDocumentReviewDto {
  @IsIn(DOCUMENT_REVIEW_DECISIONS as unknown as string[])
  decision!: DocumentReviewDecision;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/**
 * The presidency payload (stage 5) — `تایید` / `رد` only. «نیازمند اصلاح» has no enum
 * member (DEFERRED / SOURCE-CONFLICT), so no body value can reach a guessed transition.
 */
export class DecideExecutiveApprovalDto {
  @IsIn(EXECUTIVE_DECISIONS as unknown as string[])
  decision!: ExecutiveDecision;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/** Stage 6 confirmation — the source's `TaedCheckSaderShode` checkbox, as a boolean. */
export class ConfirmCheckIssueDto {
  @IsBoolean()
  confirmed!: boolean;
}

/** Stage 7 completion — the source's `KhatemeSodoorCheck` checkbox, as a boolean. */
export class ConfirmCheckDeliveryDto {
  @IsBoolean()
  completed!: boolean;
}
