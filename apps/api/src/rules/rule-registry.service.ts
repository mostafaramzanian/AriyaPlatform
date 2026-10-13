import { Injectable } from '@nestjs/common';
import { RuleSet } from './rule-set.interface';
import { RuleSetVersion, ruleSetVersionKey } from './rule-spec.interface';
import { RulePublishOutcome, RuleVersionStatusReport } from './rule-validation.interface';
import {
  editableIssue,
  freezeRuleSetVersion,
  isBusinessEvaluableStatus,
  planPublish,
} from './core/rule-versioning';

/**
 * The rule-set registration surface and the **version store** (§6.2, §10, §11).
 *
 * Two stores live here, and they are deliberately separate:
 *
 *  - the legacy `Map<string, RuleSet>` of in-process rule sets with closure predicates, which the
 *    synchronous API evaluates and whose behaviour is pinned by the existing specs (§6.3), and
 *  - the `Map<string, RuleSetVersion>` of typed, validated, versioned definitions (§10.1), keyed by
 *    **rule-set id + version** exactly as §6.2 requires — versioning is added *instead of* loosening
 *    the duplicate-`id` discipline, so a duplicate *id+version* is still an error.
 *
 * A versioned set needs no legacy `RuleSet` entry: the typed engine's definitions are data, and the
 * engine never learns where they came from (§6.1, definition tier).
 *
 * This class is the only component in the engine that *stores* anything, and it stores values only.
 * It performs no I/O of its own — no Prisma, no HTTP, no audit, no clock (§6.1) — so a consuming
 * runtime may hand it versions loaded from its own database, and a test may hand it versions
 * directly. Refusals that belong to the lifecycle (§11) are computed by the pure core and only
 * *applied* here, so the rules of the lifecycle exist once (§38.2.2).
 */
@Injectable()
export class RuleRegistryService {
  private readonly ruleSets = new Map<string, RuleSet>();
  private readonly versions = new Map<string, RuleSetVersion>();

  register(ruleSet: RuleSet): void {
    if (this.ruleSets.has(ruleSet.id)) {
      throw new Error(`RuleSet with id "${ruleSet.id}" is already registered`);
    }
    this.ruleSets.set(ruleSet.id, ruleSet);
  }

  getRuleSet(id: string): RuleSet | undefined {
    return this.ruleSets.get(id);
  }

  listRuleSets(): RuleSet[] {
    return Array.from(this.ruleSets.values());
  }

  /**
   * Stores a version as authored. It is frozen on the way in, so no caller can hold a handle to the
   * stored text and mutate it afterwards (§10.6, D10).
   *
   * @remarks A `PUBLISHED` version may not be registered: it comes from applying a publish plan and
   * from nowhere else, otherwise a publish would bypass the transition it is supposed to be (§10.4).
   */
  registerVersion(version: RuleSetVersion): void {
    if (isBusinessEvaluableStatus(version.status)) {
      throw new Error(
        `RuleSetVersion "${ruleSetVersionKey(version.ruleSetId, version.version)}" may not be registered as ${version.status}: a published version is stored by applying a publish plan (§10.4)`
      );
    }

    this.assertUnusedKey(version);
    this.versions.set(
      ruleSetVersionKey(version.ruleSetId, version.version),
      freezeRuleSetVersion(version)
    );
  }

  /**
   * Replaces a **draft** with a newer text of itself. The old text is gone, which is legal for
   * exactly as long as nothing has been published or decided under it (§10.2).
   *
   * @remarks `VALIDATED` is editable by the frozen transition table, and a publish copies rather
   * than mutates, so an edit after validation is never an edit of something decided. The status
   * rules come from the core's `editableIssue` — this method only refuses.
   */
  updateDraft(version: RuleSetVersion): void {
    const key = ruleSetVersionKey(version.ruleSetId, version.version);
    const stored = this.versions.get(key);
    if (stored === undefined) {
      throw new Error(`RuleSetVersion "${key}" is not registered and cannot be edited`);
    }

    const issue = editableIssue(stored);
    if (issue !== null) {
      throw new Error(`${key} is immutable: ${issue.message}`);
    }

    this.versions.set(key, freezeRuleSetVersion(version));
  }

  /**
   * Publishes a validated candidate: the plan is computed by the pure lifecycle (§10.4) and applied
   * only when it was planned — a refusal stores nothing at all, never a partial success (§10.4).
   *
   * @returns The typed outcome, so a caller can render the refusal. This method is the only way a
   * version becomes `PUBLISHED`, and it always archives the version it supersedes in the same act.
   */
  publishVersion(candidate: RuleSetVersion): RulePublishOutcome {
    const outcome = planPublish(this.getPublishedVersion(candidate.ruleSetId) ?? null, candidate);

    if (outcome.planned) {
      this.applyPublishPlan(outcome.plan.publish, outcome.plan.archive);
    }

    return outcome;
  }

  /** A stored version by its deterministic identity `(rule-set id, version)` (§10.1). */
  getVersion(ruleSetId: string, version: string): RuleSetVersion | undefined {
    return this.versions.get(ruleSetVersionKey(ruleSetId, version));
  }

  /**
   * The version new business decisions use (§10.3, §14), or `undefined` when none is published.
   *
   * @remarks At most one version per set can be `PUBLISHED` — applying a publish plan archives its
   * predecessor in the same act — so this selection is total and needs no tie-break.
   */
  getPublishedVersion(ruleSetId: string): RuleSetVersion | undefined {
    for (const version of this.versions.values()) {
      if (version.ruleSetId === ruleSetId && isBusinessEvaluableStatus(version.status)) {
        return version;
      }
    }

    return undefined;
  }

  /** Every stored version of one set, in the order it was registered (deterministic per process). */
  listVersions(ruleSetId: string): RuleSetVersion[] {
    return Array.from(this.versions.values()).filter((version) => version.ruleSetId === ruleSetId);
  }

  /** Status of one stored version, without handing out its text (§10.3). */
  versionStatus(ruleSetId: string, version: string): RuleVersionStatusReport | null {
    const stored = this.getVersion(ruleSetId, version);

    return stored === undefined ? null : { ruleSetId, version, status: stored.status };
  }

  /** Applies a planned publish: both sides, in one synchronous act, nothing else (§10.4). */
  private applyPublishPlan(publish: RuleSetVersion, archive: RuleSetVersion | null): void {
    const published = freezeRuleSetVersion(publish);

    this.versions.set(ruleSetVersionKey(published.ruleSetId, published.version), published);

    if (archive !== null) {
      const archived = freezeRuleSetVersion(archive);
      this.versions.set(ruleSetVersionKey(archived.ruleSetId, archived.version), archived);
    }

    /**
     * The invariant §10.3 rests on: after a publish, exactly the planned version decides. A plan is
     * computed from the stored state, so a violation here is a defect in *this* store, not a data
     * error to report as a value — it is raised loudly instead of silently deciding under a version
     * nobody selected.
     */
    const selected = this.getPublishedVersion(published.ruleSetId);
    if (selected === undefined || selected.version !== published.version) {
      throw new Error(
        `publish of "${ruleSetVersionKey(published.ruleSetId, published.version)}" did not make it the published version (§10.3)`
      );
    }
  }

  /** A version key is an identity, never a slot to overwrite: the duplicate discipline of §6.2. */
  private assertUnusedKey(version: RuleSetVersion): void {
    const key = ruleSetVersionKey(version.ruleSetId, version.version);
    const stored = this.versions.get(key);

    if (stored === undefined) {
      return;
    }

    if (isBusinessEvaluableStatus(stored.status)) {
      throw new Error(
        `RuleSetVersion "${key}" is published and immutable; a change to published policy is a new version (§10.2, §11)`
      );
    }

    if (stored.status === 'ARCHIVED') {
      throw new Error(
        `RuleSetVersion "${key}" is archived and terminal; an archived version is never rewritten (§11)`
      );
    }

    throw new Error(
      `RuleSetVersion "${key}" is already registered as ${stored.status}; edit it through updateDraft or publish it first`
    );
  }
}
