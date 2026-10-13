/**
 * Phase C1 Step P: the commercial slice's constants — failures, audit actions
 * and rule-set identities, declared beside their writers per the N/O convention
 * (§8 of docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md).
 *
 * The failure strings are the contract's CLOSED vocabulary: "No other public
 * error code is added without amending this contract first" (§8). Cross-tenant
 * access keeps the existing NotFound posture and never leaks existence.
 */

export const COMMERCIAL_FAILURE = {
  COMMERCIAL_GROUP_NOT_FOUND: 'COMMERCIAL_GROUP_NOT_FOUND',
  COMMERCIAL_GROUP_CODE_TAKEN: 'COMMERCIAL_GROUP_CODE_TAKEN',
  COMMERCIAL_LIAISON_NOT_CONFIGURED: 'COMMERCIAL_LIAISON_NOT_CONFIGURED',
  COMMERCIAL_LIAISON_NOT_TENANT_MEMBER: 'COMMERCIAL_LIAISON_NOT_TENANT_MEMBER',
  COMMERCIAL_ASSIGNMENT_NOT_FOUND: 'COMMERCIAL_ASSIGNMENT_NOT_FOUND',
  COMMERCIAL_ASSIGNMENT_IMPOSSIBLE: 'COMMERCIAL_ASSIGNMENT_IMPOSSIBLE',
  COMMERCIAL_DUPLICATE_ASSIGNMENT: 'COMMERCIAL_DUPLICATE_ASSIGNMENT',
  COMMERCIAL_INVALID_REASSIGNMENT: 'COMMERCIAL_INVALID_REASSIGNMENT',
  COMMERCIAL_APPROVAL_NOT_FOUND: 'COMMERCIAL_APPROVAL_NOT_FOUND',
  COMMERCIAL_APPROVAL_NOT_PENDING: 'COMMERCIAL_APPROVAL_NOT_PENDING',
  COMMERCIAL_APPROVAL_ACTOR_MISMATCH: 'COMMERCIAL_APPROVAL_ACTOR_MISMATCH',
  COMMERCIAL_CONFIGURATION_NOT_PUBLISHED: 'COMMERCIAL_CONFIGURATION_NOT_PUBLISHED',
  COMMERCIAL_CONFIGURATION_AMBIGUOUS: 'COMMERCIAL_CONFIGURATION_AMBIGUOUS',
  COMMERCIAL_CONFIGURATION_INVALID: 'COMMERCIAL_CONFIGURATION_INVALID',
  COMMERCIAL_RULE_INVALID: 'COMMERCIAL_RULE_INVALID',
  COMMERCIAL_NO_ROUTE: 'COMMERCIAL_NO_ROUTE',
  COMMERCIAL_AMBIGUOUS_MATCH: 'COMMERCIAL_AMBIGUOUS_MATCH',
  COMMERCIAL_RESOLVER_UNSUPPORTED: 'COMMERCIAL_RESOLVER_UNSUPPORTED',
} as const;

export type CommercialFailureCode = (typeof COMMERCIAL_FAILURE)[keyof typeof COMMERCIAL_FAILURE];

/**
 * The audit `action` vocabulary of the commercial slice — the strings that go
 * into `CommerceAuditAct.action`. Declared here so the trail is queried from
 * one list rather than from greppable literals.
 */
export const COMMERCIAL_AUDIT_ACTION = {
  GROUP_CREATED: 'created',
  GROUP_UPDATED: 'updated',
  LIAISON_CHANGED: 'liaison_changed',
  CONFIGURATION_CREATED: 'created',
  CONFIGURATION_VALIDATED: 'validated',
  CONFIGURATION_PUBLISHED: 'published',
  CONFIGURATION_ARCHIVED: 'archived',
  ASSIGNED: 'assigned',
  REASSIGNED: 'reassigned',
  UNASSIGNED: 'unassigned',
  APPROVAL_DECIDED: 'decided',
} as const;

/**
 * The two explicit commercial rule-set identities (§5). Each is pinned by
 * construction — the set is built as a VALUE from the pinned configuration
 * version, never looked up as "latest".
 */
export const COMMERCIAL_ASSIGNMENT_RULE_SET_ID = 'commerce.commercial.assignment' as const;
export const COMMERCIAL_APPROVAL_RULE_SET_ID =
  'commerce.commercial.approval-applicability' as const;

/** The prefix every commercial assignment rule id carries. */
export const COMMERCIAL_ASSIGNMENT_RULE_ID_PREFIX = 'commercial-assign:' as const;
