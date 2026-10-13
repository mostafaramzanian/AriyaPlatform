import { Injectable, OnModuleInit } from '@nestjs/common';
import { RuleContext, RuleResult } from '../rule.types';
import { RuleDefinition } from '../rule-definition.interface';
import { RuleRegistryService } from '../rule-registry.service';

/**
 * Example RuleSet for Phase 38B.
 * Deliberately test/example-only; not production business policy.
 */
@Injectable()
export class ExampleRuleSet implements OnModuleInit {
  readonly id = 'core.example';
  readonly name = 'Core Example RuleSet';

  constructor(private readonly registry: RuleRegistryService) {}

  onModuleInit(): void {
    this.registry.register({
      id: this.id,
      name: this.name,
      rules: [requiresReviewRule, autoApproveRule],
    });
  }
}

const requiresReviewRule: RuleDefinition = {
  id: 'core.example.requires-review',
  name: 'Requires Review',
  priority: 100,
  evaluate(context: RuleContext): boolean {
    const amount = Number(context.facts['amount']);
    return Number.isFinite(amount) && amount > 1000;
  },
  result(context: RuleContext): RuleResult {
    return {
      ruleId: 'core.example.requires-review',
      ruleName: 'Requires Review',
      priority: 100,
      decision: 'REQUIRES_REVIEW',
      metadata: { threshold: 1000, amount: context.facts['amount'] },
    };
  },
};

const autoApproveRule: RuleDefinition = {
  id: 'core.example.auto-approve',
  name: 'Auto Approve',
  priority: 10,
  evaluate(): boolean {
    return true;
  },
  result(context: RuleContext): RuleResult {
    return {
      ruleId: 'core.example.auto-approve',
      ruleName: 'Auto Approve',
      priority: 10,
      decision: 'AUTO_APPROVE',
      metadata: { amount: context.facts['amount'] },
    };
  },
};
