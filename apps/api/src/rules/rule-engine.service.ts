import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { RuleContext, RuleResult } from './rule.types';
import { RuleRegistryService } from './rule-registry.service';
import { RuleSetVersion } from './rule-spec.interface';
import { EvaluationContext, EvaluationResult, SimulationResult } from './rule-evaluation.interface';
import {
  RuleEvaluationOutcome,
  RuleNotEvaluated,
  RuleSimulationOutcome,
} from './rule-engine.interface';
import { businessEvaluationIssue } from './core/rule-versioning';
import { evaluateRuleSetVersion } from './core/rule-evaluator';
import { simulateRuleSetVersion } from './core/rule-simulation';
import { validateRuleSetVersion } from './core/rule-validator';

/**
 * The platform rule engine's entry point, in two tiers (§6.1, §6.3, §6.4).
 *
 * **The legacy tier** — `evaluate(ruleSetId, context)` — is the synchronous, first-match API the
 * repository already has. It stays exactly as it is, including its exceptions and its `RuleContext`
 * shape, because current in-process rule sets and the existing specs depend on it (§6.3: retiring it
 * is a separate decision, not a side effect of this phase).
 *
 * **The typed tier** — everything that takes a `RuleSetVersion` — is the Phase 54 engine: a
 * versioned, validated, deterministic evaluation that returns *every* rule's record instead of the
 * first match (§6.0), and that never throws for a refusal (§6.4).
 *
 * The two tiers share this class, this registry and this module, and they never share a code path:
 * the typed tier answers with typed outcomes, so an unknown set or an unpublished version reaches the
 * domain path as a readable value, while the legacy tier keeps `NotFoundException` for its own
 * contract (§6.4).
 *
 * What this service deliberately does **not** have: a clock, a repository, a logger or a transaction.
 * Context is assembled by the caller, the instant is an argument, refusals are values, and actions
 * are applied by the application layer inside its own transaction (§6.1, D12).
 */
@Injectable()
export class RuleEngineService {
  constructor(private readonly registry: RuleRegistryService) {}

  evaluate(ruleSetId: string, context: RuleContext): RuleResult[] {
    const ruleSet = this.registry.getRuleSet(ruleSetId);
    if (!ruleSet) {
      throw new NotFoundException(`RuleSet "${ruleSetId}" not found`);
    }

    const sortedRules = [...ruleSet.rules].sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return 0;
    });

    for (const rule of sortedRules) {
      try {
        if (rule.evaluate(context)) {
          return [rule.result(context)];
        }
      } catch (error) {
        throw new InternalServerErrorException(
          `Rule "${rule.id}" evaluation failed in RuleSet "${ruleSetId}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return [];
  }

  /**
   * Evaluates **one named version** of a set (§10.1, §14).
   *
   * @param ruleSetId The rule set, e.g. `hr.leave.approval`.
   * @param version The set version, e.g. `2`. A caller that must not be affected by a later publish
   * passes the version it was opened with, which is exactly how an in-flight approval keeps the
   * policy it started under (§10.5): historical evaluations name their version, they never resolve
   * "latest" again.
   * @returns A decision, or the typed reason this version could not decide.
   */
  evaluateVersion(
    ruleSetId: string,
    version: string,
    context: EvaluationContext
  ): RuleEvaluationOutcome {
    const ruleSetVersion = this.registry.getVersion(ruleSetId, version);

    if (ruleSetVersion === undefined) {
      return {
        evaluated: false,
        reason: 'RULE_SET_VERSION_UNKNOWN',
        ruleSetId,
        ruleSetVersion: version,
      };
    }

    return this.outcomeOf(ruleSetVersion, context);
  }

  /**
   * Evaluates the version new decisions use (§10.3, §14).
   *
   * @returns A decision, or `RULE_SET_VERSION_NOT_EVALUABLE` — which is the correct answer on day one
   * of a rule set, when nothing has been published yet (§15.8). A caller never sees "no policy" as
   * "the request was approved".
   */
  evaluateLatest(ruleSetId: string, context: EvaluationContext): RuleEvaluationOutcome {
    const published = this.registry.getPublishedVersion(ruleSetId);

    if (published === undefined) {
      return {
        evaluated: false,
        reason: 'RULE_SET_VERSION_NOT_EVALUABLE',
        ruleSetId,
        ruleSetVersion: null,
        issue: businessEvaluationIssue(null) ?? {
          code: 'RULE_SET_VERSION_NOT_PUBLISHABLE',
          path: 'status',
          message: 'no version is published for this rule set (§10.3)',
        },
        validation: null,
      };
    }

    return this.outcomeOf(published, context);
  }

  /**
   * The deterministic core of §6.3: a version and a context in, a result out.
   *
   * @remarks `evaluateSync` is synchronous **by contract**, not by accident: no `await`, no I/O, no
   * clock read (§6.3, D12). The instant is a member of the context rather than an argument of this
   * method, because the context is the caller's assembled value — the signature
   * `evaluateSync(ruleVersion, context, evaluationInstant)` of §6.3 is this method, with the instant
   * carried by `context` so a caller cannot pass one instant to the engine and another to its
   * explanation. It is a thin, stable door onto the pure core, and it takes the version **as a
   * value**: nothing here reads the store, so a caller may evaluate a version it never registered
   * (a simulation of a draft, §14) — and nothing here can be affected by a later publish.
   */
  evaluateSync(ruleSetVersion: RuleSetVersion, context: EvaluationContext): EvaluationResult {
    return evaluateRuleSetVersion({ ruleSetVersion, context });
  }

  /**
   * Simulates a named version: the real engine over a supplied context, applying nothing (§14).
   *
   * @returns A simulation, or the typed reason there was nothing to simulate. `RuleSimulationOutcome`
   * is `RuleEvaluationOutcome`'s simulation, so nothing in a response can be mistaken for a real
   * decision (§14.5).
   */
  simulateVersion(
    ruleSetId: string,
    version: string,
    context: EvaluationContext
  ): RuleSimulationOutcome {
    const ruleSetVersion = this.registry.getVersion(ruleSetId, version);

    if (ruleSetVersion === undefined) {
      return {
        evaluated: false,
        reason: 'RULE_SET_VERSION_UNKNOWN',
        ruleSetId,
        ruleSetVersion: version,
      };
    }

    if (!this.mayDecide(ruleSetVersion)) {
      return this.notEvaluable(ruleSetVersion);
    }

    return { evaluated: true, result: simulateRuleSetVersion({ ruleSetVersion, context }) };
  }

  /**
   * Simulates a version supplied as a value — a draft being authored, typically (§14, §32).
   *
   * @remarks Simulation is where a DRAFT is legitimately evaluated, and it is still the *real* engine
   * (identical validation, ordering and match history, §14.2); the answer carries `mode` and the
   * banner so it cannot be read as an applied decision (§14.5). Nothing is stored, so simulating a
   * draft cannot make it published.
   */
  simulateSync(ruleSetVersion: RuleSetVersion, context: EvaluationContext): SimulationResult {
    return simulateRuleSetVersion({ ruleSetVersion, context });
  }

  /** One stored version, evaluated when it may decide — otherwise refused with its own reason. */
  private outcomeOf(
    ruleSetVersion: RuleSetVersion,
    context: EvaluationContext
  ): RuleEvaluationOutcome {
    if (!this.mayDecide(ruleSetVersion)) {
      return this.notEvaluable(ruleSetVersion);
    }

    return { evaluated: true, result: this.evaluateSync(ruleSetVersion, context) };
  }

  /** A business decision is taken under a published version and no other (§10.3). */
  private mayDecide(ruleSetVersion: RuleSetVersion): boolean {
    return businessEvaluationIssue(ruleSetVersion) === null;
  }

  /**
   * A refusal is specific: the frozen lifecycle issue (§11) plus the version's own validation report,
   * so "this may not decide" is answerable without re-asking the store or re-validating.
   */
  private notEvaluable(ruleSetVersion: RuleSetVersion): RuleNotEvaluated {
    return {
      evaluated: false,
      reason: 'RULE_SET_VERSION_NOT_EVALUABLE',
      ruleSetId: ruleSetVersion.ruleSetId,
      ruleSetVersion: ruleSetVersion.version,
      issue: businessEvaluationIssue(ruleSetVersion) ?? {
        code: 'RULE_SET_VERSION_NOT_PUBLISHABLE',
        path: 'status',
        message: `a ${ruleSetVersion.status} version is not the version new decisions use (§10.3)`,
      },
      validation: validateRuleSetVersion(ruleSetVersion),
    };
  }
}
