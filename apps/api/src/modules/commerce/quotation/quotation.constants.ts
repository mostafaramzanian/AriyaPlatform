/**
 * PHASE GAP-6 (price quotation): the quotation slice's closed vocabularies —
 * failure codes, audit actions, decisions and wire bounds — declared beside
 * their writers, exactly as `completion.constants.ts` and `commercial.constants.ts`
 * declare theirs.
 *
 * THE FAILURE CODES ARE A CLOSED VOCABULARY, the same discipline C4-R established:
 * a client answers each code specifically instead of parsing prose. Everything a
 * quotation act may refuse has a name here; a 404 for an unknown/foreign row keeps
 * the module's NotFound posture and needs no code.
 */
export const QUOTATION_FAILURE = {
  /**
   * The parent document is `CLOSED` or `CANCELLED` — the purchase is no longer in
   * circulation, so no NEW price evidence may be recorded against it and no pending
   * quotation of it may be decided. Its own code rather than a generic 409, because
   * "this purchase is finished/cancelled" is a stable fact about the document.
   */
  DOCUMENT_NOT_OPEN: 'QUOTATION_DOCUMENT_NOT_OPEN',
  /**
   * The document already has a PENDING quotation. Exactly ONE quotation awaits a
   * decision at a time, so the confirm/return loop cannot race two live prices:
   * decide the pending one (or let it be superseded by a decision) first.
   */
  PENDING_EXISTS: 'QUOTATION_PENDING_EXISTS',
  /** The quotation was already decided (or its decision raced this request). */
  ALREADY_DECIDED: 'QUOTATION_ALREADY_DECIDED',
  /** A RETURNED decision must state the reason — the correction loop's feedback. */
  RETURN_REASON_REQUIRED: 'QUOTATION_RETURN_REASON_REQUIRED',
  /**
   * SEPARATION OF DUTIES: the user who RECORDED this quotation version may not
   * decide it. Price evidence must be confirmed by somebody other than its author —
   * the requester/group side of the loop — so a procurement recorder can never
   * approve their own price. This is a safe narrowing, not an approver-role
   * invention: any other holder of `commerce.commercial.manage` may decide.
   */
  SELF_DECISION: 'QUOTATION_SELF_DECISION',
  /**
   * Two creates raced on the same next version inside one document; the
   * `(tenantId, purchaseDocumentId, version)` unique index refused the second and
   * the repository translated it here — a driver error is never a business answer.
   */
  VERSION_CONFLICT: 'QUOTATION_VERSION_CONFLICT',
  /** The conditional decision write matched nothing: the quotation left PENDING
   *  between the read and the write (a concurrent decision won). */
  WRITE_CONFLICT: 'QUOTATION_WRITE_CONFLICT',
  /** A stated `supplierId` names no supplier of this tenant — the service's
   *  tenant-scoped existence check against the directory refused it. */
  SUPPLIER_UNKNOWN: 'QUOTATION_SUPPLIER_UNKNOWN',
  /**
   * The create body stated BOTH itemised lines and a stated `totalAmount`. The
   * two entry modes are mutually exclusive — itemised lines derive the total;
   * a stated total is the scan-only mode's evidence — and refusing the mix
   * beats silently preferring one of two disagreeing totals.
   */
  TOTAL_MODE_CONFLICT: 'QUOTATION_TOTAL_MODE_CONFLICT',
  /** An upload arrived without a `file` part (Multer saw none, or an empty body). */
  FILE_REQUIRED: 'QUOTATION_FILE_REQUIRED',
  /** The file exceeds `COMMERCE_MAX_ATTACHMENT_BYTES` (the service's own re-check). */
  FILE_TOO_LARGE: 'QUOTATION_FILE_TOO_LARGE',
  /**
   * The MIME type is outside the allowlist — a LOCAL COPY of the financial 49F/50
   * list, deliberately not imported across the bounded-context boundary.
   */
  FILE_TYPE_NOT_ALLOWED: 'QUOTATION_FILE_TYPE_NOT_ALLOWED',
  /**
   * The object write failed; nothing partial is left behind (the row write never
   * ran — object first, row second, cleanup on a failed row).
   */
  STORAGE_UPLOAD_FAILED: 'QUOTATION_STORAGE_UPLOAD_FAILED',
  /**
   * A SCAN-ONLY quotation (a stated total, no itemised lines) was confirmed
   * without its scanned document: the price evidence for that mode IS the scan,
   * so a confirm without it would accept a number nobody can evidence.
   * Itemised quotations are unaffected — their evidence is the lines.
   */
  SCAN_ATTACHMENT_REQUIRED: 'QUOTATION_SCAN_ATTACHMENT_REQUIRED',
  /**
   * The quotation carries no server-resolvable attachment object: either nothing
   * was ever uploaded, or the stored reference is a client-stated external
   * reference this deployment cannot resolve (downloads answer only for objects
   * this module's upload act wrote).
   */
  ATTACHMENT_NOT_RESOLVABLE: 'QUOTATION_ATTACHMENT_NOT_RESOLVABLE',
} as const;

export type QuotationFailureCode = (typeof QUOTATION_FAILURE)[keyof typeof QUOTATION_FAILURE];

/**
 * The two acts this slice audits, in the slice vocabulary style the commercial
 * configuration lifecycle established (past tense, one row per write; reads audit
 * nothing, §I8). Resource is `COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION` — the row
 * the act addressed, per the gateway's resource doctrine.
 */
export const QUOTATION_AUDIT_ACTION = {
  CREATED: 'created',
  DECIDED: 'decided',
  /**
   * GAP-6 follow-up (attachment upload): the scanned document was attached to a
   * PENDING version. `replaced` in the payload states whether an earlier object
   * was superseded (and its object deleted best-effort) — one row per act.
   */
  ATTACHMENT_UPLOADED: 'attachmentUploaded',
} as const;

/**
 * GAP-6 follow-up (attachment upload): the object-storage seam, opened for this
 * ONE act and no other. The byte ceiling and MIME allowlist are LOCAL COPIES of
 * the financial 49F list for the same reason that list itself is a copy
 * (check-attachment.service.ts): reaching across a bounded-context boundary to
 * share a constant would couple two contexts that must not know each other.
 * Multer enforces the ceiling at the transport edge; the service re-checks it
 * against this same constant — two bounds, one contract.
 */
export const COMMERCE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * MIME allowlist, not a denylist: anything not named here is refused. SVG is
 * deliberately excluded — an executable document that can carry script and
 * would be served from our own origin through a signed URL.
 */
export const QUOTATION_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * The object-key namespace this module's upload act writes (`commerce/<tenant>/…`).
 * It is ALSO the download route's resolver test: `attachmentRef` may hold a
 * client-stated reference from the create DTO (an org's own storage handle), and
 * only a key under this prefix is resolvable through `IStorageProvider`. The
 * prefix never reaches the wire — the view projects `hasAttachment` /
 * `attachmentDownloadable`, never the key itself.
 */
export const QUOTATION_ATTACHMENT_KEY_PREFIX = 'commerce/';

/**
 * The wire decision vocabulary of `POST …/price-quotations/:id/decision`: what the
 * requester/group DOES with a pending quotation. CONFIRM accepts the price/terms;
 * RETURN sends it back for correction (a comment is required) and the loop
 * continues on the NEXT version row — never by rewriting this one.
 */
export const QUOTATION_DECISIONS = ['CONFIRM', 'RETURN'] as const;

export type QuotationDecision = (typeof QUOTATION_DECISIONS)[number];

/**
 * The column widths this slice mirrors onto the wire, for the reason every DTO
 * in this module states them: a too-long value reaching Postgres is a 500 for
 * what is a client mistake. `attachmentRef` is TEXT in the database (no length
 * contract exists for object-storage references yet) and is nevertheless bounded
 * here so a body cannot become an unbounded write target.
 */
export const MAX_QUOTATION_SUPPLIER_LABEL_LENGTH = 255;
export const MAX_QUOTATION_REFERENCE_LENGTH = 128;
export const MAX_QUOTATION_ATTACHMENT_REF_LENGTH = 2048;
export const MAX_QUOTATION_NOTES_LENGTH = 2000;
export const MAX_QUOTATION_DECISION_COMMENT_LENGTH = 1000;
export const MAX_QUOTATION_LINE_DESCRIPTION_LENGTH = 512;
/** The itemisation ceiling: a quotation prices one seller's offer, not a catalogue. */
export const MAX_QUOTATION_LINES = 200;
