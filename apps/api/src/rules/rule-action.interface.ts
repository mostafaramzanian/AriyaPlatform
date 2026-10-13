import {
  RuleActionType,
  RuleApproverResolutionReason,
  RuleCalendarDay,
  RuleCountingBasis,
} from './rule.types';

/**
 * The frozen action model of the Platform Rule Engine (§9).
 *
 * An action is a **typed outcome an application layer applies**. The engine produces decisions;
 * it never writes a row, calls a repository, sends a message or writes audit (D12). Everything
 * below is therefore serializable data with a closed shape: there is no index signature and no
 * `data: any` escape hatch (§9.3), and an unknown action type is a validation error at publish
 * time, never a runtime no-op (§9.6).
 */

/** Who a declarative notification would address. A closed vocabulary; the engine sends nothing. */
export type RuleNotifyRecipientRole = 'EMPLOYEE' | 'MANAGER' | 'HR_ADMIN';

/** The frozen action types, in the order the specification lists them (§9). */
export const RULE_ACTION_TYPES: readonly RuleActionType[] = Object.freeze([
  'REQUIRED_APPROVAL_STEP',
  'AUTO_APPROVE',
  'AUTO_REJECT',
  'LIMIT_REFUSAL',
  'STEP_ACTIVATION',
  'APPROVER_RESOLUTION',
  'NOTIFY',
]);

/** §9 — an approval step is required, at a configured position, resolved by a configured rule. */
export interface RuleRequiredApprovalStepAction {
  readonly type: 'REQUIRED_APPROVAL_STEP';
  /** 1-based position in the flow (§17: a step instance carries `order`). */
  readonly stepOrder: number;
  /** Opaque reference to the configured approver rule; never a person and never a path. */
  readonly approverRuleRef: string;
}

/** §9 — the request is approved without a step. */
export interface RuleAutoApproveAction {
  readonly type: 'AUTO_APPROVE';
}

/**
 * §9 — the request is rejected without a step.
 *
 * @remarks A rule states a **code**, not a sentence: `reasonCode` is a machine code that the UI
 * renders through its own catalogue. A human's verbatim rejection reason is domain data supplied
 * by that person (§13.5) and is never authored inside a rule.
 */
export interface RuleAutoRejectAction {
  readonly type: 'AUTO_REJECT';
  readonly reasonCode: string;
}

/**
 * §9, §16.7 — a limit was met. The action carries its declared grounds: which limit, on which
 * counting basis, with which maximum, over which resolved window. The *observed* count is a
 * runtime fact, so it is reported in the evaluation's `observedCounts` rather than authored here.
 */
export interface RuleLimitRefusalAction {
  readonly type: 'LIMIT_REFUSAL';
  /** Opaque reference to the configured limit. */
  readonly limitRef: string;
  /** Mandatory counting basis — a bare maximum is never interpretable without it (§16.1, D7). */
  readonly countingBasis: RuleCountingBasis;
  /** Declared maximum, integer > 0 (validated). */
  readonly maximum: number;
  /** Inclusive first calendar day of the limit window, resolved by the domain layer (§16.2). */
  readonly windowStart: RuleCalendarDay;
  /** Inclusive last calendar day of the limit window, resolved by the domain layer (§16.2). */
  readonly windowEnd: RuleCalendarDay;
}

/** §9, §17 — a configured step becomes ACTIVE. At most one step is active at a time (§18). */
export interface RuleStepActivationAction {
  readonly type: 'STEP_ACTIVATION';
  readonly stepOrder: number;
}

/**
 * §9, §17.3 — the approver of a step, and *why* that person. The reason is part of the decision
 * so "why did this go to them?" is answerable from history instead of the current configuration.
 */
export interface RuleApproverResolutionAction {
  readonly type: 'APPROVER_RESOLUTION';
  readonly approverRuleRef: string;
  readonly resolutionReason: RuleApproverResolutionReason;
}

/**
 * §9.4 — declares (at most) *that* a notification would be produced for a decision. This phase
 * builds no notification engine: the action names a template and a recipient role, nothing more.
 */
export interface RuleNotifyAction {
  readonly type: 'NOTIFY';
  readonly templateRef: string;
  readonly recipientRole: RuleNotifyRecipientRole;
}

/** The closed action union. Discriminated by `type`. */
export type RuleAction =
  | RuleRequiredApprovalStepAction
  | RuleAutoApproveAction
  | RuleAutoRejectAction
  | RuleLimitRefusalAction
  | RuleStepActivationAction
  | RuleApproverResolutionAction
  | RuleNotifyAction;

/** True when `value` is one of the seven frozen action types (§9.6). */
export function isRuleActionType(value: unknown): value is RuleActionType {
  return typeof value === 'string' && (RULE_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * The deterministic decision signature of a rule: its action types, in declared order, joined.
 *
 * @remarks §12.3 refuses two rules of equal authority whose decisions are **incompatible**, i.e.
 * whose action types differ for the same decision point. Comparing the declared action types (and
 * not their parameters) makes that comparison total, domain-free and stable.
 */
export function ruleDecisionSignature(actions: readonly RuleAction[]): string {
  return actions.map((action) => action.type).join('>');
}
