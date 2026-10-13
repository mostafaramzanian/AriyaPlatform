import { Test } from '@nestjs/testing';
import { RulesModule } from './rules.module';
import { RuleEngineService } from './rule-engine.service';
import { RuleContext } from './rule.types';

describe('RuleEngineService integration', () => {
  let engine: RuleEngineService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RulesModule],
    }).compile();

    await moduleRef.init();

    engine = moduleRef.get<RuleEngineService>(RuleEngineService);
  });

  it('evaluates the registered example rule set', () => {
    const context: RuleContext = { facts: { amount: 500 } };

    const result = engine.evaluate('core.example', context);

    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe('core.example.auto-approve');
    expect(result[0].decision).toBe('AUTO_APPROVE');
  });

  it('returns review decision when amount exceeds threshold', () => {
    const context: RuleContext = { facts: { amount: 2000 } };

    const result = engine.evaluate('core.example', context);

    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe('core.example.requires-review');
    expect(result[0].decision).toBe('REQUIRES_REVIEW');
  });

  it('carries tenant context without changing global rules', () => {
    const context: RuleContext = { facts: { amount: 2000 }, tenantId: 't-1' };

    const result = engine.evaluate('core.example', context);

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('REQUIRES_REVIEW');
  });
});
