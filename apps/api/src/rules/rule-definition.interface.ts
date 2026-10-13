import { RuleContext, RuleResult } from './rule.types';

export interface RuleDefinition {
  id: string;
  name: string;
  priority: number;
  evaluate(context: RuleContext): boolean;
  result(context: RuleContext): RuleResult;
}
