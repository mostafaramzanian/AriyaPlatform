/**
 * The supplier directory slice's closed vocabularies — failure codes, audit
 * actions and wire bounds — declared beside their writers, exactly as the
 * quotation and completion slices declare theirs.
 *
 * THE FAILURE CODES ARE A CLOSED VOCABULARY: a client answers each code
 * specifically instead of parsing prose. Everything a supplier act may refuse
 * beyond the module's standard 404 (unknown/foreign row) has a name here.
 */
export const SUPPLIER_FAILURE = {
  /**
   * An EXACT-identity duplicate: same tenant, same entity type, same name and
   * same national code (both null counts as "both unstated"). Exact equality
   * only — the business requirements refuse silent fuzzy matching of similar
   * names, so "similar" suppliers are allowed and this code never fires on
   * them.
   */
  DUPLICATE_IDENTITY: 'SUPPLIER_DUPLICATE_IDENTITY',
  /**
   * Another supplier in this tenant already holds this national code — the
   * `(tenantId, nationalCode)` unique index refused the write and the
   * repository translated it here, so a race cannot land two rows either.
   */
  NATIONAL_CODE_EXISTS: 'SUPPLIER_NATIONAL_CODE_EXISTS',
  /** A LEGAL entity must state its registered company name (service rule). */
  COMPANY_NAME_REQUIRED: 'SUPPLIER_COMPANY_NAME_REQUIRED',
  /**
   * A new reference (purchase document or quotation `supplierId`) names an
   * INACTIVE supplier. Retirement must not silently accept new work; a
   * deliberate re-activation (PATCH status → ACTIVE) is the supported path.
   */
  INACTIVE_REFERENCE: 'SUPPLIER_INACTIVE_REFERENCE',
  /** The update named no field — nothing to change, nothing written. */
  UPDATE_EMPTY: 'SUPPLIER_UPDATE_EMPTY',
} as const;

export type SupplierFailureCode = (typeof SUPPLIER_FAILURE)[keyof typeof SUPPLIER_FAILURE];

/**
 * The two acts this slice audits (past tense, one row per write; reads audit
 * nothing — the module's §I8 rule). Resource is
 * `COMMERCE_AUDIT_RESOURCE.SUPPLIER`: the row the act addressed.
 */
export const SUPPLIER_AUDIT_ACTION = {
  CREATED: 'supplier.created',
  UPDATED: 'supplier.updated',
} as const;

/** The closed entity-type and status vocabularies, mirrored from the schema. */
export const SUPPLIER_ENTITY_TYPES = ['INDIVIDUAL', 'LEGAL'] as const;
export const SUPPLIER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type SupplierEntityTypeValue = (typeof SUPPLIER_ENTITY_TYPES)[number];
export type SupplierStatusValue = (typeof SUPPLIER_STATUSES)[number];

/** Wire bounds — the exact column widths the migration creates. */
export const MAX_SUPPLIER_NAME_LENGTH = 255;
export const MAX_SUPPLIER_COMPANY_NAME_LENGTH = 255;
export const MAX_SUPPLIER_BANK_NAME_LENGTH = 128;
export const MAX_SUPPLIER_ADDRESS_LENGTH = 1000;
export const MAX_SUPPLIER_PHONE_LENGTH = 32;
export const MAX_SUPPLIER_EMAIL_LENGTH = 255;
export const MAX_SUPPLIER_NOTES_LENGTH = 2000;

/**
 * Identity-format rules. The national code is 10 digits (format-only — the
 * checksum is deliberately NOT enforced because the requirements state none
 * and a wrong checksum rule would refuse real suppliers). The SHEBA accepts
 * the `IR` prefix optionally (case-insensitive) and the service normalises it
 * to UPPERCASE `IR…` before storage; the card number is 16 digits.
 */
export const NATIONAL_CODE_PATTERN = /^\d{10}$/;
export const SHEBA_PATTERN = /^(IR)?\d{24}$/i;
export const CARD_NUMBER_PATTERN = /^\d{16}$/;
/** Loose phone rule: starts with a digit or `+`, 5–32 chars of digits/space/dash. */
export const PHONE_PATTERN = /^[+\d][\d\s-]{4,31}$/;
