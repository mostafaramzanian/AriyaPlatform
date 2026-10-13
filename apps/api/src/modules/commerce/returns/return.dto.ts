import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_PURCHASE_LINES, PURCHASE_LINE_MAX_DECIMAL_PLACES } from '../purchase/purchase.dto';
import { PURCHASE_MAX_MONEY_AMOUNT } from '../purchase/purchase-money';

/**
 * Phase C1 Step S (contract §7, §10): the wire boundary of the SIX return
 * routes — and, deliberately, nothing else. Every refusal §10 names at the
 * DTO is one test in `return.dto.spec.ts`.
 *
 * WHAT MAY NEVER APPEAR IN ANY OF THESE PAYLOADS (400 under the global pipe's
 * `whitelist` + `forbidNonWhitelisted`, asserted below): `tenantId` (the actor
 * resolves it — §4-G), `requesterId` / `requestedByUserId` / `actorId` /
 * `receiverId` / `id` (requester and every `actorUserId` are server-derived
 * from `resolveCommerceActor` — §4-B/§16), `state` / `status` (return state is
 * a projection of the transition history — S-D2, there is nothing to state),
 * `purchaseDocumentId` (the route already names the document), `createdAt`,
 * `transitions`, `reversesReturnLineId` (C1-S has NO correction model — S-D4:
 * no reverse-return link exists to state), any `replacementPurchaseId` (only
 * the FLAG exists — §4-B, no repurchase document may be linked), any
 * stock/warehouse/RMA field (out of scope — §5), and `currency` (a return
 * states no money: Q owns money, and the refund's amount is Q's exact
 * negation of the target row, never a number this slice could carry).
 *
 * THE REASON RULE (§4-B): bounded FREE TEXT, never an enum — there is no
 * reason catalogue in C1 and inventing one would close a vocabulary the
 * specification left open. `1…500` characters: `@MaxLength(500)` is the
 * ceiling, and `@Matches(/\S/)` is "empty after trim is 400" — a string of
 * spaces states nothing, so it is refused rather than stored as a reason
 * nobody can read. On the OPTIONAL reason (the three decision commands and
 * the refund), `@IsOptional()` skips the rule only when the field is ABSENT —
 * an empty body is complete by design, but a stated-but-empty reason is the
 * 400 §10 records.
 *
 * QUANTITY is validated with PurchaseLine's OWN rules (the R contract's §4
 * precedent): the same `@IsNumber({ maxDecimalPlaces })` bound, positive
 * (`@Min(0.0001)`: returning zero is not a return), at most what
 * `Decimal(18, 4)` can hold — one precision model, never a second one, and no
 * float ever reaches the invariant. The response side carries the stored
 * decimal as the exact STRING, so the wire speaks `Decimal(18, 4)` text.
 *
 * NO `PATCH`, NO `PUT`, NO `DELETE` DTO EXISTS (S-D4): the only write this
 * slice accepts is appending a return document (and its four lifecycle
 * commands), so this file declares exactly the payloads those six routes take
 * — nothing more, no correction payload, no cancellation payload.
 */

/**
 * One returned quantity as a client states it: WHICH purchase line of THIS
 * document goes back, against WHICH receipt line it originally arrived, and
 * HOW MUCH — strictly positive, at most four decimals, at most the column's
 * maximum.
 *
 * The document id and the tenant are deliberately absent: the document is the
 * route, and both references must belong to it — proven server-side against
 * scoped reads (404 for an id the document does not own, 409
 * `line_reference_mismatch` when the two references contradict each other),
 * never assumed from a UUID that happens to exist somewhere in the tenant.
 */
export class ReturnLineInputDto {
  @IsUUID('4')
  purchaseLineId!: string;

  @IsUUID('4')
  receiptLineId!: string;

  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  quantity!: number;
}

/**
 * Append one return document (`POST …/returns`, route 2).
 *
 * `reason` is REQUIRED and non-empty after trim (§15 preserves it; §4-B
 * settles its shape). `replacementRequired` is a REQUIRED STATED FACT — no
 * optional, no default: `false` is a decision the caller makes, not an
 * omission the server guesses (§4-B). `lines` is REQUIRED and non-empty — a
 * return that returns nothing is not a return — and bounded by the purchase
 * document's own line ceiling, because one operation cannot touch more lines
 * than a document can hold. The SAME receipt line may appear more than once:
 * two entries are two returned quantities inside one operation, and both
 * count toward the invariant exactly as two separate lines would.
 */
export class CreateReturnDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'reason must not be empty' })
  reason!: string;

  @IsBoolean()
  replacementRequired!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineInputDto)
  lines!: ReturnLineInputDto[];
}

/**
 * The optional reason of a DECISION — approve (route 3) and reject (route 4)
 * share one payload because they are one fact: an optional stated why. The
 * empty body is complete by design (§7), and the reason, when given, rides the
 * transition row AND the one audit trail — never a `decision` column (§4-B:
 * decision and resolution ARE the transition history).
 */
export class ReturnDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'reason must not be empty' })
  reason?: string;
}

/**
 * Receive-back (route 5) states NOTHING — an empty body is complete by
 * design (§7). The service never reads this payload: the command's whole
 * input is the path.
 *
 * WHY THE CLASS IS NOT LITERALLY EMPTY (implementation mechanism, §7 rules
 * unchanged). Under this repository's global pipe
 * (`whitelist` + `forbidNonWhitelisted` + `forbidUnknownValues`,
 * `main.ts`), class-validator short-circuits a class that carries NO
 * validation metadata to a single `unknownValue` error — so a literally
 * empty DTO would 400 EVERY receive-back call, including the correct empty
 * body, and whitelist enforcement (the mechanism §7 cites for the forbidden
 * field list) would never run on this route at all. The two observable rules
 * the contract pins here are therefore realised exactly by giving the class
 * exactly one anchor property with UNSATISFIABLE validators:
 *
 *   - ABSENT (the contract's `{}`): `@IsOptional` skips the rules → PASS.
 *   - PRESENT at any non-null value: `@MinLength(1)` and `@MaxLength(0)`
 *     cannot both hold → 400. No value, not even `""`, can pass.
 *   - ANY OTHER field (`tenantId`, `state`, `currency`, …): metadata now
 *     exists, so `whitelist` + `forbidNonWhitelisted` run and answer 400 on
 *     that field, exactly as on the other three payloads.
 *
 * The anchor is NOT a contract field: it is named outside §7's vocabulary,
 * it is never read by the service or the controller, and no value of it is
 * ever accepted — it exists solely so the pipe's own machinery can govern
 * this route the way §7 says it does. Adding a field a client could USE
 * (a reason, a note, a state) would be the alternate DTO field the contract
 * forbids; a field no value of which is statable changes no behaviour.
 */
export class ReceiveBackReturnDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(0)
  _acceptsNoField?: never;
}

/**
 * Refund (route 6): the Q-side compensation target and an optional reason.
 *
 * `paymentId` is NOT a new model — it is exactly the target Q's own
 * compensation API requires (`POST …/payments/:paymentId/compensate`),
 * surfaced here because Q's contract is the ONLY compensation mechanism a
 * refund may use (§4-E). The amount is never stated: Q computes the exact
 * negation of that row, which is why no field of this DTO can carry money.
 * The reason, when given, rides into Q's compensation reason AND this
 * return's transition row AND the one audit trail — one stated fact, three
 * recorded homes that all quote it, and no second column for it.
 */
export class RefundReturnDto {
  @IsUUID('4')
  paymentId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'reason must not be empty' })
  reason?: string;
}
