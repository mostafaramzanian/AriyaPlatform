/**
 * Phase PRODUCTION-BOM-ITEM: the BOM ITEM's own vocabulary and pure rules — no NestJS,
 * no Prisma, no repository, no clock, no HTTP.
 *
 * WHY THIS FILE EXISTS AND IS SEPARATE FROM `bom-status.ts`
 * --------------------------------------------------------
 * `bom-status.ts` is the HEADER's lifecycle. The item has no lifecycle of its own (rule 4
 * of the item contract: approval happens on the HEADER, never on an item), so this module
 * holds only what an item genuinely owns: two closed choice-lists that the source stored as
 * `Lookup_StaticValues`, the error codes this slice refuses with, and the ONE coefficient
 * rule V1 confirmed. Everything else the item might seem to own — a duplicate-part-name
 * rule, a total-coefficient formula, a standard-code rule — is deliberately ABSENT, because
 * the source either has no such contract or its contract is BLOCKED on Product Tree Code.
 *
 * `PURCHASE_DOCUMENT_STATUSES` in `purchase/purchase-status.ts` is the precedent for a pure
 * vocabulary module; this file is that shape for the item.
 */

/**
 * The source's `Noe_Ghatae` («نوع قطعه در پروژه») control offered exactly two static
 * values — `ساختی;استاندارد` — and the item-save action refused an empty one
 * (`نوع قطعه در پروژه نمی تواند خالی باشد!` / V13). Two code points, a closed set, and
 * the Persian labels a screen renders. The schema's `BomPartType` enum mirrors this list.
 */
export const BOM_PART_TYPES = ['STRUCTURAL', 'STANDARD'] as const;

export type BomPartType = (typeof BOM_PART_TYPES)[number];

export const BOM_PART_TYPE_LABELS: Record<BomPartType, string> = {
  STRUCTURAL: 'ساختی',
  STANDARD: 'استاندارد',
};

/**
 * The source's `CP_Ghatae` («طرح کنترل دارد؟») control, `دارد;ندارد`. OPTIONAL — the
 * source never validated it (§10.6 does not mark it required, and no supplied script
 * refuses an empty value), so it is a nullable flag and nothing more.
 */
export const BOM_CONTROL_PLANS = ['PRESENT', 'ABSENT'] as const;

export type BomControlPlan = (typeof BOM_CONTROL_PLANS)[number];

export const BOM_CONTROL_PLAN_LABELS: Record<BomControlPlan, string> = {
  PRESENT: 'دارد',
  ABSENT: 'ندارد',
};

/**
 * The TYPED, DETERMINISTIC error codes this slice refuses with.
 *
 * WHY CODES AND NOT MESSAGE STRINGS. `StandardExceptionFilter` passes an exception's
 * object payload through as `error.code`, so a caller (and the Persian UI) can branch on a
 * STABLE identifier instead of matching a sentence somebody may reword. The legacy source
 * refused an empty BOM's submit with the literal `اقلامی ثبت نشده است!`; that SEMANTIC is
 * what V8 preserved, expressed here as a code the domain owns — not as a UI-only string.
 *
 * The codes are a closed record because the UI maps each one to a Persian message: a code
 * added without a label would render as a raw token to a user.
 */
export const PRODUCTION_BOM_ERROR_CODES = {
  /** Submit was refused because the BOM has no items — the legacy V8 rule. */
  ITEMS_REQUIRED: 'BOM_SUBMIT_ITEMS_REQUIRED',
  /** The BOM header is not in an editable state, so its items cannot change. */
  HEADER_NOT_EDITABLE: 'BOM_HEADER_NOT_EDITABLE',
  /** The named item does not exist in this tenant under this BOM. */
  ITEM_NOT_FOUND: 'BOM_ITEM_NOT_FOUND',
  /** A required text field was absent, blank, or whitespace-only after trimming. */
  FIELD_REQUIRED: 'BOM_ITEM_FIELD_REQUIRED',
  /** A consumption coefficient was not an integer `>= 0` (§5 / §14). */
  COEFFICIENT_INVALID: 'BOM_ITEM_COEFFICIENT_INVALID',
  /** A PATCH stated no field, so it would change nothing (the header's own rule). */
  PATCH_EMPTY: 'BOM_ITEM_PATCH_EMPTY',
} as const;

export type ProductionBomErrorCode =
  (typeof PRODUCTION_BOM_ERROR_CODES)[keyof typeof PRODUCTION_BOM_ERROR_CODES];

/**
 * The ONE coefficient rule V1 confirmed (§5 of the item brief).
 *
 * The source stores both required coefficients in a plain TextBox, `parseInt`s them in
 * every arithmetic use, and floors every warning at 0 — so V1 accepts an INTEGRAL value
 * that is `>= 0`, with no decimal scale, NO artificial maximum and NO formula. Anything
 * else (a fraction, a negative, a string) is refused here rather than silently truncated.
 *
 * WHY THIS IS A FUNCTION AND NOT ONLY A DTO VALIDATOR: the service re-asserts it before
 * writing, because a DTO is a WIRE bound while this is the DOMAIN fact. The five derived
 * coefficients have no rule at all — a `max`, a `scale` or a total for them would be an
 * invented contract, and `ZaribMasraf_KoleGhatae` is never computed from them.
 */
export function isValidConsumptionCoefficient(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}
