import { RuleDefinition } from './rule-definition.interface';

export interface RuleSet {
  id: string;
  name: string;
  rules: RuleDefinition[];
}
