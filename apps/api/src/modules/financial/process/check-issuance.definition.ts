import { Permissions } from '../../../auth/rbac/constants/permissions';
import { freezeProcessDefinition } from '../../../platform/process/process-definition';
import { assertProcessPublishable } from '../../../platform/process/process-configuration.validator';
import type { ProcessDefinition } from '../../../platform/process/process-definition.model';
import { CHECK_DOCUMENT_TYPES } from '../check-request/check-request';
import { CHECK_REQUEST_STATUS } from '../check-request/check-request-status';

/**
 * Phase CHECK-ISSUATION — the `financial.check-issuance` process definition, version 1.
 *
 * WHAT THIS IS: the SOURCE-CONFIRMED shape of «درخواست صدور چک» declared as a typed,
 * validated, published, frozen `ProcessDefinition` on the platform primitives — the
 * wizard renders from it, available-actions derives from it, and each request PINS the
 * version it started under (see `CheckRequest.processKey` / `processVersion`).
 *
 * WHERE EVERY DECISION CAME FROM (brief §40):
 *  * step set, state mapping, action set, document sections → SOURCE (sooderCheck.txt +
 *    kartabl SoderCheck.txt, through Preflight §7/§8/§9, re-verified against the raw
 *    files this phase);
 *  * permissions, actor policy kinds, self-approval refusal → ARCHITECTURE (repo
 *    conventions + brief §11/§12);
 *  * titles, order, visibility, labels, field policies → CONFIGURATION (this file;
 *    changing them is a CONFIG edit, and changing transitions is a NEW VERSION);
 *  * tenant isolation, authorization enforcement, concurrency, atomic transitions, audit
 *    → DOMAIN CODE, deliberately NOT expressible in this model (brief §6);
 *  * the presidency's «نیازمند اصلاح» target → NOT ESTABLISHED / SOURCE-CONFLICT: the
 *    action does not exist here, so no route, service branch or UI control can reach a
 *    guessed transition (brief §20).
 *
 * THE ONE BUTTON THE SOURCE ACTUALLY HAD: the task form's single «تایید و انتقال به
 * مرحله بعد» advances whichever stage is active after the stage's own controls validate.
 * Ariya expresses that as one action per stage decision, each with its own capability —
 * the same control surface, split at the permission boundary instead of at a person's
 * name (the source's `ArjaBe`).
 */

/** The process identity, pinned onto every CheckRequest row at create. */
export const CHECK_ISSUANCE_PROCESS_KEY = 'financial.check-issuance';

/** The version this phase publishes and pins. Bumping = a NEW frozen definition below. */
export const CHECK_ISSUANCE_PROCESS_VERSION = 1;

/**
 * The document-section keys, as named CONSTANTS rather than route literals: the ROUTES
 * say which section they manage, the PROCESS defines what that section means, and the
 * validator proves the two agree (a route key absent from the definition is a 400
 * `SECTION_UNKNOWN` at runtime and a broken test before it ever ships).
 */
export const CHECK_ISSUANCE_SECTION = {
  REQUEST_DOCUMENTS: 'request-documents',
  CHEQUE_IMAGE: 'cheque-image',
  DELIVERY_RECEIPT: 'delivery-receipt',
} as const;

const S = CHECK_REQUEST_STATUS;

const definitionV1: ProcessDefinition = {
  processKey: CHECK_ISSUANCE_PROCESS_KEY,
  version: CHECK_ISSUANCE_PROCESS_VERSION,
  status: 'published',
  title: 'درخواست صدور چک',
  steps: [
    {
      key: 'request',
      order: 1,
      title: 'درخواست صدور چک',
      progressLabel: 'ثبت درخواست',
      states: [S.DRAFT, S.SUBMITTED],
      active: true,
      visible: true,
      actions: ['submit'],
      fields: [
        { field: 'checkIssueType', states: [S.DRAFT, S.SUBMITTED], editableStates: [S.DRAFT, S.SUBMITTED] },
        { field: 'purchaseType', states: [S.DRAFT, S.SUBMITTED], editableStates: [S.DRAFT, S.SUBMITTED] },
        { field: 'orderReference', states: [S.DRAFT, S.SUBMITTED], editableStates: [S.DRAFT, S.SUBMITTED] },
        { field: 'projectReference', states: [S.DRAFT, S.SUBMITTED], editableStates: [S.DRAFT, S.SUBMITTED] },
        {
          field: 'projectManagerUserId',
          states: [S.DRAFT, S.SUBMITTED],
          editableStates: [S.DRAFT, S.SUBMITTED],
        },
        { field: 'requesterOpinion', states: [S.DRAFT, S.SUBMITTED], editableStates: [S.DRAFT, S.SUBMITTED] },
      ],
    },
    {
      key: 'manager-review',
      order: 2,
      title: 'تایید مدیر',
      progressLabel: 'تایید مدیر',
      states: [S.MANAGER_REVIEW],
      active: true,
      visible: true,
      actions: ['approve', 'reject', 'request-correction'],
      fields: [{ field: 'managerComment', states: [S.MANAGER_REVIEW], editableStates: [S.MANAGER_REVIEW] }],
    },
    {
      key: 'allocation',
      order: 3,
      title: 'صدور فرم تخصیص',
      progressLabel: 'تخصیص',
      states: [S.APPROVED],
      active: true,
      visible: true,
      actions: ['allocate'],
      fields: [
        { field: 'allocationPlace', states: [S.APPROVED], editableStates: [S.APPROVED] },
        { field: 'balance', states: [S.APPROVED], editableStates: [S.APPROVED] },
        { field: 'checkDate', states: [S.APPROVED], editableStates: [S.APPROVED] },
        { field: 'checkDescription', states: [S.APPROVED], editableStates: [S.APPROVED] },
        { field: 'checkAmount', states: [S.APPROVED], editableStates: [S.APPROVED] },
        { field: 'payableTo', states: [S.APPROVED], editableStates: [S.APPROVED] },
      ],
    },
    {
      key: 'document-review',
      order: 4,
      title: 'بررسی اسناد',
      progressLabel: 'بررسی اسناد',
      states: [S.DOCUMENT_REVIEW],
      active: true,
      visible: true,
      actions: ['document-review', 'document-review-correction'],
      fields: [
        { field: 'documentReviewComment', states: [S.DOCUMENT_REVIEW], editableStates: [S.DOCUMENT_REVIEW] },
      ],
    },
    {
      key: 'executive-approval',
      order: 5,
      title: 'تایید ریاست',
      progressLabel: 'تایید ریاست',
      states: [S.EXECUTIVE_APPROVAL],
      active: true,
      visible: true,
      actions: ['executive-approve', 'executive-reject'],
      fields: [
        { field: 'executiveComment', states: [S.EXECUTIVE_APPROVAL], editableStates: [S.EXECUTIVE_APPROVAL] },
      ],
    },
    {
      key: 'issue',
      order: 6,
      title: 'صدور چک',
      progressLabel: 'صدور چک',
      states: [S.ISSUANCE],
      active: true,
      visible: true,
      actions: ['issue'],
      fields: [{ field: 'issuedCheckConfirmed', states: [S.ISSUANCE], editableStates: [S.ISSUANCE] }],
    },
    {
      key: 'delivery',
      order: 7,
      title: 'تحویل چک',
      progressLabel: 'تحویل',
      states: [S.DELIVERY],
      active: true,
      visible: true,
      actions: ['deliver'],
      fields: [{ field: 'deliveryCompleted', states: [S.DELIVERY], editableStates: [S.DELIVERY] }],
    },
    {
      key: 'completed',
      order: 8,
      title: 'پایان گردش',
      progressLabel: 'پایان',
      states: [S.COMPLETED],
      active: true,
      visible: true,
      actions: [],
      fields: [],
    },
    {
      key: 'terminated',
      order: 9,
      title: 'خاتمه یافته',
      progressLabel: 'خاتمه',
      states: [S.TERMINATED],
      active: true,
      visible: true,
      actions: [],
      fields: [],
    },
  ],
  actions: [
    {
      key: 'submit',
      label: 'ثبت و انتقال به مرحله بعد',
      permission: Permissions.FINANCIAL_CHECK_MANAGE,
      actorPolicy: 'requester',
    },
    {
      key: 'approve',
      label: 'بله',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      actorPolicy: 'approver',
    },
    {
      key: 'reject',
      label: 'خیر',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      actorPolicy: 'approver',
    },
    {
      key: 'request-correction',
      label: 'نیازمند اصلاح است',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      actorPolicy: 'approver',
    },
    {
      key: 'allocate',
      label: 'ثبت فرم تخصیص',
      permission: Permissions.FINANCIAL_CHECK_ALLOCATE,
      actorPolicy: 'allocator',
    },
    {
      key: 'document-review',
      label: 'تایید',
      permission: Permissions.FINANCIAL_CHECK_REVIEW,
      actorPolicy: 'reviewer',
    },
    {
      key: 'document-review-correction',
      label: 'اصلاح',
      permission: Permissions.FINANCIAL_CHECK_REVIEW,
      actorPolicy: 'reviewer',
    },
    {
      key: 'executive-approve',
      label: 'تایید',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      actorPolicy: 'executive',
    },
    {
      key: 'executive-reject',
      label: 'رد',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      actorPolicy: 'executive',
    },
    {
      key: 'issue',
      label: 'تایید چک صادر شده',
      permission: Permissions.FINANCIAL_CHECK_ISSUE,
      actorPolicy: 'issuer',
    },
    {
      key: 'deliver',
      label: 'خاتمه صدور چک',
      permission: Permissions.FINANCIAL_CHECK_DELIVER,
      actorPolicy: 'deliverer',
    },
  ],
  actorPolicies: [
    // The authorship remit: the row's own requester. The service still resolves WHO that
    // is from the row + actor (a wire field cannot claim it) — the policy states the
    // RULE, the domain code executes it.
    { key: 'requester', kind: 'REQUESTER', forbidSelfApproval: false },
    // Both approval stages fail closed on self-approval (Preflight U5: NOT ESTABLISHED
    // in source, so the restriction applies rather than a guessed allowance).
    {
      key: 'approver',
      kind: 'PERMISSION',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      forbidSelfApproval: true,
    },
    {
      key: 'executive',
      kind: 'PERMISSION',
      permission: Permissions.FINANCIAL_CHECK_APPROVE,
      forbidSelfApproval: true,
    },
    // The stage remits: capability only, EXCEPT document review — a review that accepts
    // the evidence is a decision act, so it fails closed on self-review like the two
    // approval stages. Allocation / issuance / delivery are recording acts the source
    // attaches no self-rule to, so none is invented — capability + state + tenant are
    // the enforcement.
    {
      key: 'allocator',
      kind: 'PERMISSION',
      permission: Permissions.FINANCIAL_CHECK_ALLOCATE,
      forbidSelfApproval: false,
    },
    {
      key: 'reviewer',
      kind: 'PERMISSION',
      permission: Permissions.FINANCIAL_CHECK_REVIEW,
      forbidSelfApproval: true,
    },
    {
      key: 'issuer',
      kind: 'PERMISSION',
      permission: Permissions.FINANCIAL_CHECK_ISSUE,
      forbidSelfApproval: false,
    },
    {
      key: 'deliverer',
      kind: 'PERMISSION',
      permission: Permissions.FINANCIAL_CHECK_DELIVER,
      forbidSelfApproval: false,
    },
  ],
  transitions: [
    { action: 'submit', fromState: S.DRAFT, toState: S.MANAGER_REVIEW },
    { action: 'submit', fromState: S.SUBMITTED, toState: S.MANAGER_REVIEW },
    { action: 'approve', fromState: S.MANAGER_REVIEW, toState: S.APPROVED },
    { action: 'reject', fromState: S.MANAGER_REVIEW, toState: S.TERMINATED },
    { action: 'request-correction', fromState: S.MANAGER_REVIEW, toState: S.SUBMITTED },
    { action: 'allocate', fromState: S.APPROVED, toState: S.DOCUMENT_REVIEW },
    { action: 'document-review', fromState: S.DOCUMENT_REVIEW, toState: S.EXECUTIVE_APPROVAL },
    { action: 'document-review-correction', fromState: S.DOCUMENT_REVIEW, toState: S.SUBMITTED },
    { action: 'executive-approve', fromState: S.EXECUTIVE_APPROVAL, toState: S.ISSUANCE },
    { action: 'executive-reject', fromState: S.EXECUTIVE_APPROVAL, toState: S.TERMINATED },
    // NO executive request-correction transition: DEFERRED / SOURCE-CONFLICT (brief §20).
    { action: 'issue', fromState: S.ISSUANCE, toState: S.DELIVERY },
    { action: 'deliver', fromState: S.DELIVERY, toState: S.COMPLETED },
  ],
  documentSections: [
    // Section 2 — request documents («پیوست ها» filtered by Section = 02). The eleven
    // source types, verbatim; NOT required for any transition (Preflight §9.3: the source
    // warns, it never blocks).
    {
      section: 2,
      key: 'request-documents',
      title: 'اسناد درخواست',
      states: [S.DRAFT, S.SUBMITTED],
      allowedDocumentTypes: CHECK_DOCUMENT_TYPES,
      requiredForActions: [],
      permission: Permissions.FINANCIAL_CHECK_MANAGE,
    },
    // Section 6 — the cheque image grid («تصویر چک صادر شده»), gated ONTO `issue` exactly
    // as the task script refuses with «تصویر چک صادر شده بارگذاری نشده است!». No type
    // vocabulary: the source's grid never asked for «نوع سند» (null, not []).
    {
      section: 6,
      key: 'cheque-image',
      title: 'تصویر چک',
      states: [S.ISSUANCE],
      allowedDocumentTypes: null,
      requiredForActions: ['issue'],
      permission: Permissions.FINANCIAL_CHECK_ISSUE,
    },
    // Section 7 — the delivery-receipt grid, gated ONTO `deliver`
    // («تصویر رسید تحویل بارگذاری نشده است!»).
    {
      section: 7,
      key: 'delivery-receipt',
      title: 'رسید تحویل',
      states: [S.DELIVERY],
      allowedDocumentTypes: null,
      requiredForActions: ['deliver'],
      permission: Permissions.FINANCIAL_CHECK_DELIVER,
    },
  ],
  terminalStates: [S.COMPLETED, S.TERMINATED],
  extension: {
    evidence: 'sooderCheck.txt + kartabl SoderCheck.txt (Preflight §7/§8/§9)',
    deferred: 'executive-request-correction = SOURCE-CONFLICT (script StateNext=6 vs display state 3)',
  },
};

/**
 * The publish gate + the version registry.
 *
 * `assertProcessPublishable` runs at IMPORT TIME: a definition that cannot be published
 * must stop the process from existing — at module graph construction (boot) and in every
 * test that touches this file — rather than wait for the first request to misbehave.
 * `freezeProcessDefinition` then makes the published version deep-immutable: a change is
 * version 2, and requests pinned to version 1 keep reading this object forever (§5/§35).
 */
assertProcessPublishable(definitionV1);
export const CHECK_ISSUANCE_DEFINITION_V1: ProcessDefinition = freezeProcessDefinition(definitionV1);

/** Every published version of the process, keyed by version. v1 only, this phase. */
export const CHECK_ISSUANCE_DEFINITIONS: Readonly<Record<number, ProcessDefinition>> =
  Object.freeze({
    [CHECK_ISSUANCE_PROCESS_VERSION]: CHECK_ISSUANCE_DEFINITION_V1,
  });

/**
 * Resolves the PINNED version for a request row, or throws. A row pinning a version
 * this build does not carry is a deployment defect (the row was created by code newer
 * than this build), and failing loudly beats silently re-running the process under a
 * different version — pinning exists precisely so that cannot happen.
 */
export function resolveCheckIssuanceDefinition(version: number): ProcessDefinition {
  const definition = CHECK_ISSUANCE_DEFINITIONS[version];
  if (!definition || definition.status !== 'published') {
    throw new Error(
      `Check-issuance process version ${version} is not available as a published definition ` +
        `(have: ${Object.keys(CHECK_ISSUANCE_DEFINITIONS).join(', ')}).`
    );
  }
  return definition;
}


