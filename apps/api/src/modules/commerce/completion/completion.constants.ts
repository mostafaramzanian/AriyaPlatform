/**
 * PHASE C4-R (GAP-3): the completion slice's closed vocabularies — failures and audit
 * actions — declared beside their writers, exactly as `commercial.constants.ts` declares
 * the commercial slice's.
 *
 * THE FAILURE CODES ARE THE CONTRACT'S CLOSED VOCABULARY. No other public error code may
 * be added without amending `docs/PHASE-C4R-PURCHASE-COMPLETION-POLICY-CONTRACT.md` first:
 * the whole point of naming them is that a client — and the settings screen — can answer
 * each one specifically instead of parsing prose. They are split into two families:
 *
 *   POLICY_* — the CONFIGURATION lifecycle (authoring, validation, publication).
 *   the rest — the COMPLETION act on a purchase document.
 *
 * `findById`-style reads of another tenant's or an unknown policy keep the module's
 * NotFound posture (404) and never leak existence, so no code here describes that case.
 */
export const PURCHASE_COMPLETION_FAILURE = {
  /** Create with a label this tenant already uses (`@@unique([tenantId, versionLabel])`). */
  POLICY_LABEL_TAKEN: 'PURCHASE_COMPLETION_POLICY_LABEL_TAKEN',
  /**
   * The policy row fails the publication checklist (unknown/source statuses, an empty set,
   * a duplicate member) OR a lifecycle transition was asked of a row in the wrong status
   * (edit a non-DRAFT, validate a non-DRAFT, publish a PUBLISHED/ARCHIVED row, …). One code
   * for the family, with the reason in `message`, exactly as `COMMERCIAL_CONFIGURATION_INVALID`
   * answers the commercial checklist.
   */
  POLICY_INVALID: 'PURCHASE_COMPLETION_POLICY_INVALID',
  /**
   * FAIL-CLOSED (brief §18): the tenant has NO published completion policy, so completion is
   * not configured and no document may be completed. The service never falls back to a draft,
   * to a default policy or to "no prerequisites".
   */
  POLICY_NOT_CONFIGURED: 'PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED',
  /**
   * The published policy exists but does not NAME the document's current status — the
   * deterministic "the policy does not permit completing from here" refusal.
   */
  STATUS_NOT_ALLOWED: 'PURCHASE_COMPLETION_STATUS_NOT_ALLOWED',
  /**
   * The document is already `CLOSED`. Its own code rather than `STATUS_NOT_ALLOWED`, because
   * "already completed" is a stable fact about the row (repeat-click, double request) while
   * "not allowed from here" is a policy outcome.
   */
  DOCUMENT_ALREADY_COMPLETED: 'PURCHASE_DOCUMENT_ALREADY_COMPLETED',
  /**
   * The conditional write lost a race: the document left the allowed set between the read
   * and the write (another actor completed it, or a commercial projection moved it). The
   * established 409, never a silent success.
   */
  WRITE_CONFLICT: 'PURCHASE_COMPLETION_WRITE_CONFLICT',
} as const;

export type PurchaseCompletionFailureCode =
  (typeof PURCHASE_COMPLETION_FAILURE)[keyof typeof PURCHASE_COMPLETION_FAILURE];

/**
 * The audit `action` vocabulary of this slice — the strings that go into
 * `CommerceAuditAct.action`, declared here so the trail is queried from one list rather
 * than from greppable literals.
 *
 * TWO SPELLINGS, ON PURPOSE, EACH MATCHING ITS NEIGHBOURS: the POLICY lifecycle uses the
 * commercial configuration's past-tense set (`created`/`validated`/`published`/`archived`)
 * because it is the same kind of act on the same kind of row; the DOCUMENT act uses the
 * purchase slice's route-verb set (`create`/`update`/`submit`) because it is the same route
 * family — the `close` route's own verb. §29 calls the business event "completion"; the
 * trail names the route that performed it, as every other action in this module does.
 */
export const PURCHASE_COMPLETION_AUDIT_ACTION = {
  POLICY_CREATED: 'created',
  POLICY_UPDATED: 'updated',
  POLICY_VALIDATED: 'validated',
  POLICY_PUBLISHED: 'published',
  POLICY_ARCHIVED: 'archived',
  DOCUMENT_CLOSED: 'close',
} as const;
