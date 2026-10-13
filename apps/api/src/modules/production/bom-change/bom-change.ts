/**
 * Phase PRODUCTION-BOM-CHANGE: the BOM CHANGE REQUEST's own vocabulary and pure rules — no
 * NestJS, no Prisma, no repository, no clock, no HTTP.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE FROM `bom-status.ts`
 * -----------------------------------------------------------------
 * `bom/bom-status.ts` owns the BOM HEADER's lifecycle, and the change request WALKS THE
 * SAME ONE. The source's `c_status` integers for «ثبت درخواست تغییر BOM» are `0 / 1 / 50 /
 * 100`, the approval task moves the document through `2` while the manager decides, and the
 * «نیاز به اصلاح» branch writes `0` again — i.e. the SAME four facts `DRAFT`, `SUBMITTED`,
 * `APPROVED`, `REJECTED` with the SAME correction-to-draft rule that `BomStatus` already
 * names (see the schema's `BomChangeRequest.status` note).
 *
 * Re-declaring that vocabulary here would be the same lifecycle written twice, free to
 * drift the moment one of them gained a state. So this file does NOT re-declare it: it
 * RE-EXPORTS the header's transitions under the names a change-request caller reads
 * naturally, and adds ONLY what this aggregate genuinely owns —
 *
 *   * the two-value change TYPE the source's radio offered, with its Persian labels;
 *   * the typed error codes this slice refuses with;
 *   * the ONE delta rule the source actually performs (S2), and the type it binds to.
 *
 * `bom/bom-item.ts` is the precedent for a pure vocabulary module of this shape.
 */

import { isBomHeaderEditable, bomStatusAfter, BOM_STATUSES } from '../bom/bom-status';
import type { BomStatus } from '../bom/bom-status';

/**
 * The four-state lifecycle the header already owns, re-exported so the change request's DTO
 * can bind `?status=` against the SAME tuple it names in the schema. Re-declaring a second
 * array here would let a fifth state be added to `BomStatus` while this module kept
 * accepting only the original four — a filter that silently refuses a real row.
 */
export { BOM_STATUSES };

/**
 * The SOURCE'S OWN TWO CHANGE KINDS, as a closed set.
 *
 * `c_NoeaTaghir` was a `RadioButtons` control whose `Lookup_StaticValues` was exactly
 * `تغییر موجودی;غیر فعال سازی` — two values, no third, no free text. The schema's
 * `BomChangeType` enum mirrors this list member for member, and the codes below are the
 * wire/domain spelling of the two Persian labels the source displayed.
 *
 * WHY `DEACTIVATE` IS MODELLED AT ALL, GIVEN THAT NOTHING ACTS ON IT
 * ------------------------------------------------------------------
 * The source PROVES the value exists (the radio, and the detail row's `NoeaTaghir` column),
 * so a request that selects it is a real business fact that must be recordable, displayable
 * and approvable. The source does NOT prove what approval would then change on the BOM
 * item — no script writes an inactive flag, no state column is touched, nothing is deleted
 * — so this module records the INTENT and deliberately exposes NO `apply` behaviour for it.
 * A `deactivate()` helper with no contract behind it would be exactly the invented
 * behaviour the brief forbids.
 */
export const BOM_CHANGE_TYPES = ['QUANTITY_CHANGE', 'DEACTIVATE'] as const;

export type BomChangeType = (typeof BOM_CHANGE_TYPES)[number];

/**
 * The two labels, verbatim from the source's radio.
 *
 * They are the RENDERING of the code points, never a stored value: the database stores
 * `QUANTITY_CHANGE` / `DEACTIVATE`, and a screen renders «تغییر موجودی» / «غیر فعال سازی».
 * Keeping the Persian here — rather than in the web bundle only — is what lets the API
 * describe its own vocabulary without a second, drifting copy of the two words.
 */
export const BOM_CHANGE_TYPE_LABELS: Record<BomChangeType, string> = {
  QUANTITY_CHANGE: 'تغییر موجودی',
  DEACTIVATE: 'غیر فعال سازی',
};

export function bomChangeTypeLabel(type: BomChangeType): string {
  return BOM_CHANGE_TYPE_LABELS[type];
}


/**
 * The TYPED, DETERMINISTIC error codes this slice refuses with.
 *
 * WHY CODES AND NOT MESSAGE STRINGS — the same reason `PRODUCTION_BOM_ERROR_CODES` gives:
 * `StandardExceptionFilter` passes an exception's object payload through as `error.code`, so
 * a caller (and the Persian UI) branches on a STABLE identifier instead of matching a
 * sentence somebody may reword. Three of the codes below preserve a legacy refusal:
 *
 *   `BOM_CHANGE_REQUEST_ITEMS_REQUIRED` — «اقلامی جهت تغییر ثبت نشده است!» (S4)
 *   `BOM_CHANGE_ITEM_DUPLICATE`         — «شما قبلا جزئیات این قطعه را تغییر و ثبت نموده
 *                                          اید» (S3)
 *   `BOM_CHANGE_ITEM_DELTA_REQUIRED`    — «حداقل یکی از فیلدهای افزایش ضریب مصرف … باید
 *                                          مقداردهی گردد» (S2)
 *
 * The names are PREFIXED on purpose: `PRODUCTION_BOM_ERROR_CODES` already owns the `BOM_*`
 * namespace for the header and its items, and two different refusals sharing one code would
 * make the UI's map ambiguous.
 */
export const PRODUCTION_BOM_CHANGE_ERROR_CODES = {
  /** Submit was refused because the request holds no detail rows — the legacy S4 rule. */
  ITEMS_REQUIRED: 'BOM_CHANGE_REQUEST_ITEMS_REQUIRED',
  /** The request is not in an editable state, so it (and its details) cannot change. */
  NOT_EDITABLE: 'BOM_CHANGE_REQUEST_NOT_EDITABLE',
  /** The named change request does not exist in this tenant. */
  NOT_FOUND: 'BOM_CHANGE_REQUEST_NOT_FOUND',
  /** The target BOM does not exist in this tenant. */
  BOM_NOT_FOUND: 'BOM_CHANGE_REQUEST_BOM_NOT_FOUND',
  /** The named BOM item does not exist under the request's BOM in this tenant. */
  ITEM_NOT_FOUND: 'BOM_CHANGE_ITEM_NOT_FOUND',
  /** The BOM item is already detailed in this request — the legacy S3 rule. */
  ITEM_DUPLICATE: 'BOM_CHANGE_ITEM_DUPLICATE',
  /** A `QUANTITY_CHANGE` stated neither delta — the legacy S2 rule. */
  DELTA_REQUIRED: 'BOM_CHANGE_ITEM_DELTA_REQUIRED',
  /** A stated delta was not an integer. */
  DELTA_INVALID: 'BOM_CHANGE_ITEM_DELTA_INVALID',
  /** The change type was absent or not one of the two the source offered. */
  CHANGE_TYPE_INVALID: 'BOM_CHANGE_ITEM_TYPE_INVALID',
  /** A required text field was absent, blank, or whitespace-only after trimming. */
  FIELD_REQUIRED: 'BOM_CHANGE_REQUEST_FIELD_REQUIRED',
  /** A PATCH stated no field, so it would change nothing. */
  PATCH_EMPTY: 'BOM_CHANGE_REQUEST_PATCH_EMPTY',
} as const;

export type ProductionBomChangeErrorCode =
  (typeof PRODUCTION_BOM_CHANGE_ERROR_CODES)[keyof typeof PRODUCTION_BOM_CHANGE_ERROR_CODES];

/**
 * The ONE rule the source performs over the two deltas (S2), and the type it binds to.
 *
 * WHY A SEPARATE PREDICATE FROM `isValidConsumptionCoefficient`
 * ------------------------------------------------------------
 * `bom/bom-item.ts`'s `isValidConsumptionCoefficient` requires `>= 0`, because the item's
 * two coefficients are CONSUMPTION COEFFICIENTS whose controls were floored at zero. A
 * DELTA is a different fact: its field name is «افزایش/کاهش» (increase/decrease), the
 * source's own `cc < 1` / `bb < 1` guards sit inside a COMMENTED-OUT block, and the
 * aggregate-level check it does keep is a non-blocking `total < 0` WARNING whose
 * `//error = true` is commented out (S7/S8). Loosening the coefficient validator would
 * silently change the ITEM's rule; a negative bound added here would invent one. So:
 *
 *   * INTEGRAL — the source `parseInt`s every delta before using it, and the item's own
 *     coefficients are `Int` in `production_db`; a fraction is refused rather than
 *     truncated behind the caller's back.
 *   * SIGNED — a decrease is the whole point of the field, and nothing in the source
 *     forbids it.
 *   * NO MAXIMUM, NO MINIMUM, NO PRECISION RULE — invented bounds are exactly what the
 *     brief's "numeric checks commented out in the source are not active rules" forbids.
 *
 * `Number.isSafeInteger` is the guard rather than `Number.isInteger` alone: a value beyond
 * `2^53` would round silently and be stored as a different number than the caller meant.
 */
export function isValidCoefficientDelta(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value);
}

/**
 * The rule for a `QUANTITY_CHANGE` (S2, verbatim from the source's `check == 0` branch).
 *
 * AT LEAST ONE of the two deltas must be STATED. `null` and `undefined` both mean "not
 * stated"; `0` IS stated and is a legal answer — the source's `cc != ""` test is about the
 * CONTROL being empty, not about the number being non-zero, so `0` passes it.
 *
 * The rule is deliberately NOT applied to `DEACTIVATE`: the source disables both delta
 * controls unless the type is «تغییر موجودی» and performs no check at all for the other
 * branch, so requiring — or forbidding — a delta there would be an invented rule.
 */
export function isQuantityChangePayloadComplete(input: {
  drawingCoefficientDelta: number | null | undefined;
  spareCoefficientDelta: number | null | undefined;
}): boolean {
  return (
    (input.drawingCoefficientDelta ?? null) !== null ||
    (input.spareCoefficientDelta ?? null) !== null
  );
}

/**
 * Whether a change request may still be edited: its details added, changed, removed, and
 * its own draft fields patched (S10 — every mutating control in the source carries
 * `c_status == "0"`).
 *
 * THIS IS THE HEADER'S PREDICATE, RE-EXPORTED UNDER THIS AGGREGATE'S NAME — deliberately.
 * "May this document change?" has ONE answer in Production, and it is the same answer for
 * both documents because they walk the same lifecycle. A second implementation would be a
 * second opinion about what `DRAFT` means, and the first divergence between the two would
 * be a change request that froze while its BOM did not.
 */
export const isBomChangeRequestEditable = isBomHeaderEditable;

/**
 * The status a change-request transition lands on, or `null` when the current status does
 * not permit it — the header's own guarded transition table, re-exported for the same
 * reason. The EXPLICIT map in `bom-status.ts` remains the single place the graph is stated:
 * `SUBMIT` only from `DRAFT`, the three decisions only from `SUBMITTED`, and
 * `REQUEST_CORRECTION` landing on the EDITABLE state rather than on a fifth one.
 */
export const bomChangeRequestStatusAfter = bomStatusAfter;

/**
 * The status vocabulary, re-exported so a caller of this module does not have to reach into
 * `bom-status` to name it. It is an ALIAS, not a second union: a distinct type with the same
 * members would compile while letting the two drift.
 */
export type BomChangeRequestStatus = BomStatus;

