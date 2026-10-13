import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import { PURCHASE_MAX_MONEY_AMOUNT, PURCHASE_MONEY_SCALE } from './purchase-money';
import { PURCHASE_DOCUMENT_STATUSES, PURCHASE_LINE_TYPES } from './purchase-status';
import type { PurchaseDocumentStatus, PurchaseLineType } from './purchase-status';

/**
 * Phase C1 Step L (§8): the wire contract of the purchase routes — create, read, list,
 * update-while-editable and submit.
 *
 * WHY THE COLUMN LENGTHS ARE MIRRORED HERE INSTEAD OF BEING LEFT TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Every maximum below is the width of the column the value lands in
 * (`VARCHAR(32)` for a unit, `VARCHAR(128)` for an opaque reference, `DECIMAL(18,4)`
 * for money). Without a DTO bound, a long value reaches Postgres and comes back as a
 * driver error — a 500 for what is a client mistake, with no field name attached. With
 * the bound here it is a 400 naming the field, and the database constraint stays what
 * it is: the last line of defence rather than the only one.
 *
 * MONEY IS VALIDATED AS A NUMBER AND STORED AS AN EXACT DECIMAL.
 * `@IsNumber({ maxDecimalPlaces: 4 })` refuses a fifth decimal place at the boundary
 * (the alternative is a silently rounded price), and `PURCHASE_MAX_MONEY_AMOUNT` is the
 * same `Decimal(18,4)` ceiling the arithmetic module enforces — one number, two
 * readers. The service converts these numbers to exact decimal strings before they
 * reach Prisma; nothing about that conversion is visible here, which is why the bound
 * has to be stated in both places.
 *
 * WHAT IS DELIBERATELY NOT ON THE WIRE
 * ------------------------------------
 *  * NO `tenantId` — it comes from `resolveCommerceActor(req)`. `whitelist` +
 *    `forbidNonWhitelisted` on the global pipe makes sending one a 400.
 *  * NO `status` on create or update — the lifecycle is walked by the routes that own
 *    each transition (submit today; decide/cancel/complete with their steps), never by
 *    a client writing a status field.
 *  * NO `documentNumber` — server-minted inside the creating transaction, and a client
 *    that could state one could collide with another document's number.
 *  * NO `lineTotal` — DERIVED from quantity × unit price (see below), so a client
 *    cannot state a total that disagrees with the line's own two numbers.
 *  * NO `kind` — the vocabulary is closed at PURCHASE_REQUEST and it is part of the
 *    numbering key. A second kind arrives as a migration plus a route, never as a
 *    client field that silently starts a second counter series.
 */

/** The most lines one document may carry — a bound, not a business rule. */
export const MAX_PURCHASE_LINES = 200;

/** An opaque supplier reference (§5.1) — a string, never a resolved supplier record. */
export const MAX_PURCHASE_SUPPLIER_ID_LENGTH = 128;

/** The unit label's column width: `PCS`, `KG`, `DAY` — not a catalogue reference. */
export const MAX_PURCHASE_UNIT_LENGTH = 32;

/** The tenant's own handle on a line, from whatever system it was copied out of. */
export const MAX_PURCHASE_EXTERNAL_REF_LENGTH = 128;

/** The BOM/catalogue item reference — opaque (§5.2), long enough for a real key. */
export const MAX_PURCHASE_ITEM_REFERENCE_LENGTH = 200;

/**
 * The fractional digits a money field may carry — the storage scale, not a second number.
 *
 * `@IsNumber({ maxDecimalPlaces })` refuses a fifth decimal AT THE EDGE, and the value it
 * refuses is derived from `PURCHASE_MONEY_SCALE` rather than typed as a literal `4`, so
 * the DTO and the arithmetic cannot answer "how precise is a price?" differently.
 */
export const PURCHASE_LINE_MAX_DECIMAL_PLACES = PURCHASE_MONEY_SCALE;

/** What the requester says the item must be, exactly (§5.4). */
export const MAX_PURCHASE_TECHNICAL_DESCRIPTION_LENGTH = 2000;

/**
 * ISO 4217 alphabetic code, uppercase.
 *
 * NOT an allowlist of currencies: the schema holds a three-letter code with no
 * enumeration, because C1 establishes no currency catalogue and inventing one here
 * would be a table nobody asked for. The shape is enforced; the membership is not
 * decided by this module.
 */
const PURCHASE_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * ONE line as a client states it (§5.2).
 *
 * `quantity` is REQUIRED and POSITIVE — a line without a quantity is not a line, and a
 * zero or negative one is not something anyone purchases. `unitPrice` and `tax` are
 * optional because "not priced yet" is a real state: NULL on those columns means
 * "not stated yet", NEVER zero (zero says "free", which is a different statement), so
 * omitting them and sending 0 must stay distinguishable.
 *
 * `tax` IS AN AMOUNT, NOT A RATE. The schema stores amounts because no rate catalogue
 * exists in C1; a client sending `0.09` expecting nine percent would be stating nine
 * hundredths of a currency unit, and the field name is the only place that is written
 * down.
 *
 * The line NUMBER is not a field: position is the author's intent, and it is assigned
 * by the service from array order (1…n) inside the replacing transaction, so two lines
 * can never claim position 3 and a gap in the sequence is not expressible.
 */
export class PurchaseLineInputDto {
  @IsIn(PURCHASE_LINE_TYPES)
  lineType!: PurchaseLineType;

  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @IsPositive()
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PURCHASE_UNIT_LENGTH)
  unit?: string;

  @IsOptional()
  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  unitPrice?: number;

  @IsOptional()
  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  tax?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PURCHASE_EXTERNAL_REF_LENGTH)
  externalRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PURCHASE_ITEM_REFERENCE_LENGTH)
  itemReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PURCHASE_TECHNICAL_DESCRIPTION_LENGTH)
  technicalDescription?: string;
}

/**
 * The CREATE payload (§8's "create").
 *
 * `requesterId` IS A PLATFORM USER ID, AND THE PLATFORM'S CONTRACT FOR ONE IS AN OPAQUE
 * BOUNDED STRING (GAP-8). It is validated exactly as `workflow-configuration.dto.ts`'s
 * `actorUserId` already validates a Core identity — `@IsString()` plus the platform
 * identity wire's 64-character bound — and NEVER as a UUID. UUID v4 remains the format
 * of Commerce-OWNED row ids only; the platform's own seeded administrator is
 * `super-admin-user`, and a DTO that refused it would refuse a real tenant member.
 *
 * THE MEMBERSHIP BOUNDARY IS WHAT PROTECTS THE TENANT. The service asserts the id
 * belongs to the ACTING tenant before it is stored, because nothing inside
 * `commerce_db` can check that (there is no FK across databases, by design). The empty
 * id is refused HERE because the gateway reads a falsy id as "not configured" — an
 * empty string must never reach the repository as if it were a reference.
 *
 * AT LEAST ONE LINE IS REQUIRED. A document with no lines is not a draft somebody can
 * complete — it has nothing to route, nothing to price and nothing a workflow could
 * decide — so it is refused at the boundary rather than stored as a row only its
 * author can see the point of.
 */
export class CreatePurchaseDocumentDto {
  /** The requester's platform user id — opaque, 1..64 chars, membership-checked. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requesterId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PURCHASE_SUPPLIER_ID_LENGTH)
  supplierId?: string;

  @IsOptional()
  @Matches(PURCHASE_CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code, e.g. IRR',
  })
  currency?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_LINES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineInputDto)
  lines!: PurchaseLineInputDto[];
}

/**
 * The UPDATE payload — accepted only while the document is editable (§8's "update
 * while editable"; §5.11's DRAFT).
 *
 * `undefined` AND `null` MEAN DIFFERENT THINGS, and both are legal:
 *  * `undefined` — the field is not part of this edit; the stored value is untouched.
 *  * `null` — the field is being CLEARED (`supplierId: null` states "no supplier",
 *    which §5.1 distinguishes from an empty string).
 * `@IsOptional()` accepts both, so the distinction survives validation and the service
 * applies it; a DTO that defaulted a missing field to `null` would silently erase a
 * supplier on every unrelated edit.
 *
 * `lines`, WHEN PRESENT, REPLACES THE DOCUMENT'S LINES WHOLESALE. That is deliberate
 * and it is only safe here: a DRAFT has been routed to nobody, so no line carries
 * routing history that a replacement could erase. Once SUBMITTED the same route
 * refuses the change outright, which is the point at which lines become evidence
 * (§5.3). Sending fewer lines than before is not a deletion path — the old rows are
 * replaced server-side inside one transaction, and "return for correction" remains a
 * workflow outcome rather than a DELETE.
 */
export class UpdatePurchaseDocumentDto {
  /** The requester's platform user id — opaque, 1..64 chars, membership-checked on write. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requesterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PURCHASE_SUPPLIER_ID_LENGTH)
  supplierId?: string | null;

  @IsOptional()
  @Matches(PURCHASE_CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code, e.g. IRR',
  })
  currency?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_LINES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineInputDto)
  lines?: PurchaseLineInputDto[];
}

/**
 * The LIST filter (§8's "list").
 *
 * Every predicate is OPTIONAL and every one of them narrows WITHIN the acting tenant —
 * the tenant predicate is added by the repository and is not a field here, so there is
 * no shape of this query that widens the scope.
 *
 * `requesterId` is the "my requests" view, declared as an opaque id rather than as a
 * flag, because "mine" is a question the caller answers with an id the service can
 * verify is a member of the tenant — a `mine: true` flag would make the identity
 * implicit in the session and unverifiable in a log.
 */
export class ListPurchaseDocumentsQueryDto extends CommercePageQueryDto {
  @IsOptional()
  @IsIn(PURCHASE_DOCUMENT_STATUSES)
  status?: PurchaseDocumentStatus;

  /**
   * The "my requests" filter — a platform user id, validated as the opaque bounded
   * string the platform identity wire defines (GAP-8), never as a UUID.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requesterId?: string;
}

/**
 * PHASE C7 (GAP-7): the query of `GET /purchase-documents/:id/timeline`.
 *
 * WHY ITS OWN CLASS INSTEAD OF EXTENDING `CommercePageQueryDto`: the shared base also
 * carries `search`, and a timeline has nothing to search — a whitelisted `?search=…`
 * would be accepted and silently ignored, which is exactly the kind of dishonest
 * parameter this module's DTOs refuse. So this class re-states ONLY the two pagination
 * bounds, with the same validators and the same `COMMERCE_MAX_PAGE_SIZE` ceiling the
 * shared envelope uses (one ceiling, two spellings of the same contract).
 *
 * WHAT IS DELIBERATELY NOT HERE — AND CANNOT BE ADDED:
 *  * NO `tenantId`, NO `resource`, NO `resourceId`: the timeline's scope is bound
 *    server-side from the actor and the route's `:id`. The global pipe's `whitelist` +
 *    `forbidNonWhitelisted` turns an attempt to send any of them into a 422 rather than
 *    a silently ignored field, so a client cannot retarget the audit query.
 *  * NO `action`, NO date range: P-AUDIT-READ would accept both, but no confirmed UI
 *    need justifies widening this surface yet — a filter is added when it is used, not
 *    speculatively. (§10: expose additional filters only if useful and justified.)
 *  * The page ceiling mirrors `AUDIT_READ_MAX_PAGE_SIZE` (100) and the default the
 *    platform applies (20) matches `COMMERCE_DEFAULT_PAGE_SIZE`; when the caller states
 *    nothing, the PLATFORM's defaults are what answer, and the response echoes them.
 */
export class PurchaseTimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMERCE_MAX_PAGE_SIZE)
  pageSize?: number;
}
