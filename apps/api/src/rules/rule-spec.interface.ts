import { RuleAction } from './rule-action.interface';
import { RuleConditionNode, RuleFieldCatalogue } from './rule-condition.interface';
import { RuleCalendarDay, RuleSetStatus } from './rule.types';

/**
 * The versioned unit the typed engine validates, orders, evaluates and explains (§7, §10).
 *
 * Two different things are called "version" in the frozen specification, and both are kept
 * distinct here:
 *
 *  - `RuleSetVersion.version` — the **set version**, which is what §10.1 identifies a version by
 *    (`(rule-set id, version string)`), what a caller selects, what §14 defaults to, and what an
 *    approval instance stores so history is never rewritten (§10.5).
 *  - `RuleSpec.version` — the **rule's own revision label**, reported in `winningRule.version`
 *    (§13) and carried by a decision so a historical explanation can name the rule text it used.
 */

/**
 * One declarative rule: identity, ranking and typed content. There is no closure, no predicate
 * function and no callback here — the frozen model's "no free-form payloads" (§9.3) applies to
 * rules as much as to actions.
 */
export interface RuleSpec {
  /** Stable, unique inside its set; the final ordering key (§12.1) and never regenerated. */
  readonly id: string;
  /** The rule's revision label (see the file doc), bounded in length and required (§10.1). */
  readonly version: string;
  /** Human-readable label. Stored text, rendered at the edge; never used in any comparison. */
  readonly name: string;
  /** Declared integer priority. Higher wins (§12.1). */
  readonly priority: number;
  /** The declared condition tree (§8). */
  readonly condition: RuleConditionNode;
  /** Ordered typed outcomes (§9). At least one is required: a matching rule must decide. */
  readonly actions: readonly RuleAction[];
}

/**
 * An immutable version of a rule set: the field catalogue it was authored against, the rules, and
 * the lifecycle status (§10.3, §11).
 *
 * @remarks The stored object *is* the retained version text (§10.6): it is frozen when published
 * and never mutated, so an old explanation can be reproduced verbatim without trusting today's
 * configuration. Effective dating is configuration, not evaluation time (§11): `effectiveFrom` /
 * `effectiveTo` say which version applies when; the evaluation instant is supplied separately.
 */
export interface RuleSetVersion {
  readonly ruleSetId: string;
  readonly version: string;
  readonly status: RuleSetStatus;
  /** The payload schema this version was authored in (§10.6). See `RULE_ENGINE_SCHEMA_VERSION`. */
  readonly schemaVersion: number;
  /** The facts this version may speak about (§8.3). Owned by the consuming domain. */
  readonly fields: RuleFieldCatalogue;
  /** The rules, in **declared** order. Evaluation never trusts this order (§12.1). */
  readonly rules: readonly RuleSpec[];
  /** The version string this one was derived from, when it was derived (§10.2). */
  readonly supersedes?: string | null;
  /** Inclusive first calendar day this version applies from, when the owner dates it (§11). */
  readonly effectiveFrom?: RuleCalendarDay | null;
  /** Inclusive last calendar day this version applies to, when the owner dates it (§11). */
  readonly effectiveTo?: RuleCalendarDay | null;
}

/**
 * The deterministic identity of a set version: `(rule-set id, version string)` (§10.1).
 *
 * @remarks A single string key is used so the registry and every diagnostic report the same
 * identity, and so no lookup depends on object identity or insertion order.
 */
export function ruleSetVersionKey(ruleSetId: string, version: string): string {
  return `${ruleSetId}@${version}`;
}
