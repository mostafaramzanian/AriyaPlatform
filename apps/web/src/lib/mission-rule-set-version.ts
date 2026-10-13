/**
 * Phase 55: THE WIRE TYPE OF A MISSION POLICY VERSION'S `configuration`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `HrMissionPolicyVersion.configuration` was typed `unknown`, and that was HONEST only while nobody
 * had read the server's own definition. The shape is not a guess and never was: the field IS the
 * Platform Rule Engine's `RuleSetVersion`, declared in `apps/api/src/rules/rule-spec.interface.ts`,
 * validated by `apps/api/src/rules/core/rule-validator.ts`, and STORED VERBATIM by
 * `MissionPolicyRepository.createVersion` (`configuration: data.configuration as never` into a Prisma
 * `Json` column) and RETURNED VERBATIM by every policy route — there is no serializer between the
 * column and the wire, so what the server reads back is exactly what the engine validated.
 *
 * This module therefore TRANSCRIBES that declaration rather than inventing one. Every union below is
 * closed on the server too, which is what makes the transcription possible without a guess:
 *
 *   * actions          — discriminated by `type`, seven members, `RULE_ACTION_TYPES`
 *   * condition nodes  — discriminated by the literal KEY (`all`/`any`/`not`/`field`/`count`), which
 *                        is exactly how `rule-validator.ts` tells them apart
 *   * operators        — closed string unions; the OPERATOR↔TYPE pairing is enforced at publish, so
 *                        an invalid pairing is a `400` from the server and not a client concern
 *
 * WHAT THIS TYPE IS NOT
 * ---------------------
 * It is NOT a client-side validator. Nothing here re-checks what the engine already gates: the server
 * refuses an invalid document at `POST .../validate` and the refusal travels back as a `CoreApiError`.
 * Typing the document makes the CLIENT able to AUTHOR one; it does not make the client an authority on
 * whether one is valid. No `any`, no index signature and no `data: unknown` escape hatch appears
 * anywhere in this file — the server's model has none (§9.3), so a mirror with one would be looser
 * than the thing it mirrors.
 *
 * Every member is `readonly` for the same reason the server's are: a published version is IMMUTABLE
 * retained text (§10.6), so a caller may not mutate a document it is about to ship.
 */

/** The engine's declared scalar fact types (`rule.types.ts`, `RuleFieldType` minus `collection`). */
export type MissionRuleScalarFieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

/** A calendar day, `YYYY-MM-DD`. The engine performs no calendar arithmetic. */
export type MissionRuleCalendarDay = string;

/** The lifecycle status a version carries INSIDE its document, matching the stored row's status. */
export type MissionRuleSetStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';

/** Counting basis of a limit — mandatory wherever a count is meaningful. */
export type MissionRuleCountingBasis = 'REQUEST_COUNT' | 'DAY_COUNT';

/** Why a named approver was resolved the way it was. */
export type MissionRuleApproverResolutionReason = 'PRIMARY' | 'SUBSTITUTE' | 'UNAVAILABLE';

/** Who a declarative notification would address. The engine sends nothing. */
export type MissionRuleNotifyRecipientRole = 'EMPLOYEE' | 'MANAGER' | 'HR_ADMIN';

/** The frozen comparison operator set (`RuleComparisonOperator`). */
export type MissionRuleComparisonOperator =
  | 'equals'
  | 'notEquals'
  | 'in'
  | 'notIn'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'dateBefore'
  | 'dateAfter'
  | 'dateBetween';

/** The operators a `count` aggregate may use — ordering only, exactly as the server allows. */
export type MissionRuleCountOperator =
  'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual';

// ---------------------------------------------------------------------------
// The condition tree
// ---------------------------------------------------------------------------

/**
 * A single leaf operand. Closed, exactly as the server closes it: `isEmpty`/`isNotEmpty` take NO
 * operand, `dateBetween` takes exactly `[from, to]`, and a membership operator takes a non-empty
 * array of the field's declared type. The pairing is enforced server-side at publish.
 */
export type MissionRuleConditionOperand =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[]
  | readonly [MissionRuleCalendarDay, MissionRuleCalendarDay];

/** `{ field, op, value }` — one leaf comparison. */
export interface MissionRuleComparisonCondition {
  readonly field: string;
  readonly op: MissionRuleComparisonOperator;
  readonly value?: MissionRuleConditionOperand;
}

/** `{ count: { over, where?, op, value } }` — an aggregate over a declared collection. */
export interface MissionRuleCountSpec {
  /** The collection's field name in the evaluation context. Never a path expression. */
  readonly over: string;
  /** Optional per-item condition, evaluated against each record of the collection. */
  readonly where?: readonly MissionRuleConditionNode[];
  readonly op: MissionRuleCountOperator;
  readonly value: number;
}

export interface MissionRuleCountCondition {
  readonly count: MissionRuleCountSpec;
}

/** `{ all: [...] }` — AND. Every child must hold. */
export interface MissionRuleAllCondition {
  readonly all: readonly MissionRuleConditionNode[];
}

/** `{ any: [...] }` — OR. At least one child must hold. */
export interface MissionRuleAnyCondition {
  readonly any: readonly MissionRuleConditionNode[];
}

/** `{ not: node }` — NOT. Exactly one child. */
export interface MissionRuleNotCondition {
  readonly not: MissionRuleConditionNode;
}

/** The closed condition tree, discriminated by which literal key is present. */
export type MissionRuleConditionNode =
  | MissionRuleAllCondition
  | MissionRuleAnyCondition
  | MissionRuleNotCondition
  | MissionRuleComparisonCondition
  | MissionRuleCountCondition;

// ---------------------------------------------------------------------------
// The field catalogue — the facts a version may speak about
// ---------------------------------------------------------------------------

/** A declared scalar fact. `enumValues` is present exactly when `type` is `enum`. */
export interface MissionRuleFieldDeclaration {
  readonly name: string;
  readonly type: MissionRuleScalarFieldType;
  readonly enumValues?: readonly string[];
}

/** A declared collection fact, usable only by the `count` node. One level deep and bounded. */
export interface MissionRuleCollectionFieldDeclaration {
  readonly name: string;
  readonly type: 'collection';
  /** Hard maximum of records the application layer may supply. */
  readonly maxSize: number;
  readonly itemFields: readonly MissionRuleFieldDeclaration[];
}

export type MissionRuleFieldCatalogueEntry =
  MissionRuleFieldDeclaration | MissionRuleCollectionFieldDeclaration;

export type MissionRuleFieldCatalogue = readonly MissionRuleFieldCatalogueEntry[];

// ---------------------------------------------------------------------------
// Actions — the seven frozen types, discriminated by `type`
// ---------------------------------------------------------------------------

/** An approval step is required, at a configured position, resolved by a configured rule. */
export interface MissionRuleRequiredApprovalStepAction {
  readonly type: 'REQUIRED_APPROVAL_STEP';
  /** 1-based position in the flow. */
  readonly stepOrder: number;
  /**
   * Opaque reference to the configured approver rule; never a person and never a path.
   *
   * The Mission domain reads this as `mission-approval-definition:<uuid>` and refuses anything else,
   * so a document that names a Mission approval definition here is what makes
   * `REQUIRED_APPROVAL` reachable.
   */
  readonly approverRuleRef: string;
}

/** The request is approved without a step. */
export interface MissionRuleAutoApproveAction {
  readonly type: 'AUTO_APPROVE';
}

/** The request is rejected without a step. `reasonCode` is a machine code, not a sentence. */
export interface MissionRuleAutoRejectAction {
  readonly type: 'AUTO_REJECT';
  readonly reasonCode: string;
}

/** A limit was met. The OBSERVED count is a runtime fact and is never authored here. */
export interface MissionRuleLimitRefusalAction {
  readonly type: 'LIMIT_REFUSAL';
  readonly limitRef: string;
  readonly countingBasis: MissionRuleCountingBasis;
  readonly maximum: number;
  readonly windowStart: MissionRuleCalendarDay;
  readonly windowEnd: MissionRuleCalendarDay;
}

/** A configured step becomes ACTIVE. At most one step is active at a time. */
export interface MissionRuleStepActivationAction {
  readonly type: 'STEP_ACTIVATION';
  readonly stepOrder: number;
}

/** The approver of a step, and WHY that person — so history answers it without today's config. */
export interface MissionRuleApproverResolutionAction {
  readonly type: 'APPROVER_RESOLUTION';
  readonly approverRuleRef: string;
  readonly resolutionReason: MissionRuleApproverResolutionReason;
}

/** Declares (at most) THAT a notification would be produced. No notification engine exists. */
export interface MissionRuleNotifyAction {
  readonly type: 'NOTIFY';
  readonly templateRef: string;
  readonly recipientRole: MissionRuleNotifyRecipientRole;
}

/** The closed action union. Discriminated by `type`. */
export type MissionRuleAction =
  | MissionRuleRequiredApprovalStepAction
  | MissionRuleAutoApproveAction
  | MissionRuleAutoRejectAction
  | MissionRuleLimitRefusalAction
  | MissionRuleStepActivationAction
  | MissionRuleApproverResolutionAction
  | MissionRuleNotifyAction;

// ---------------------------------------------------------------------------
// The version document itself
// ---------------------------------------------------------------------------

/** One declarative rule: identity, ranking and typed content. No closure, no predicate function. */
export interface MissionRuleSpec {
  /** Stable, unique inside its set; the final ordering key and never regenerated. */
  readonly id: string;
  /** The rule's own revision label — NOT the set version. See `MissionRuleSetVersion.version`. */
  readonly version: string;
  /** Human-readable label. Stored text, rendered at the edge; never used in any comparison. */
  readonly name: string;
  /** Declared integer priority. Higher wins. */
  readonly priority: number;
  readonly condition: MissionRuleConditionNode;
  /** Ordered typed outcomes. At least one is required: a matching rule must decide. */
  readonly actions: readonly MissionRuleAction[];
}

/**
 * The version document — the wire shape of `configuration`, and the exact object the server's
 * validator accepts and the engine evaluates.
 *
 * @remarks The stored object IS the retained version text (§10.6). `version` here is the SET version
 * string (`(ruleSetId, version)` is the identity); a rule's own revision is `MissionRuleSpec.version`.
 * `schemaVersion` must be `1` — the only schema version this engine implements — and a document
 * claiming another is refused by the server rather than guessed at.
 */
export interface MissionRuleSetVersion {
  readonly ruleSetId: string;
  readonly version: string;
  readonly status: MissionRuleSetStatus;
  /** The payload schema this version was authored in. Only `1` is supported by this engine. */
  readonly schemaVersion: number;
  /** The facts this version may speak about. */
  readonly fields: MissionRuleFieldCatalogue;
  /** The rules, in declared order. Evaluation never trusts this order. */
  readonly rules: readonly MissionRuleSpec[];
  /** The version string this one was derived from, when it was derived. */
  readonly supersedes?: string | null;
  /** Inclusive first calendar day this version applies from, when the owner dates it. */
  readonly effectiveFrom?: MissionRuleCalendarDay | null;
  /** Inclusive last calendar day this version applies to, when the owner dates it. */
  readonly effectiveTo?: MissionRuleCalendarDay | null;
}
