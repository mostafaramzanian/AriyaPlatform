import { Test } from '@nestjs/testing';
import { NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { RuleEngineService } from './rule-engine.service';
import { RuleRegistryService } from './rule-registry.service';
import { RuleContext, RuleResult } from './rule.types';
import { RuleDefinition } from './rule-definition.interface';

const createRule = (
  id: string,
  name: string,
  priority: number,
  matches: boolean,
  decision: string,
): RuleDefinition => ({
  id,
  name,
  priority,
  evaluate: () => matches,
  result: (): RuleResult => ({
    ruleId: id,
    ruleName: name,
    priority,
    decision,
  }),
});

describe('RuleEngineService', () => {
  let engine: RuleEngineService;
  let registry: RuleRegistryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RuleEngineService, RuleRegistryService],
    }).compile();

    engine = moduleRef.get<RuleEngineService>(RuleEngineService);
    registry = moduleRef.get<RuleRegistryService>(RuleRegistryService);
  });

  const context = (facts: Record<string, unknown>): RuleContext => ({ facts });

  it('returns an empty result when no rules match', () => {
    registry.register({
      id: 'test.none',
      name: 'No Match',
      rules: [createRule('r1', 'Never', 10, false, 'NO')],
    });

    const result = engine.evaluate('test.none', context({}));

    expect(result).toEqual([]);
  });

  it('returns the result of a matching rule', () => {
    registry.register({
      id: 'test.single',
      name: 'Single Match',
      rules: [createRule('r1', 'Always', 10, true, 'YES')],
    });

    const result = engine.evaluate('test.single', context({}));

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('YES');
  });

  it('selects the highest priority matching rule', () => {
    registry.register({
      id: 'test.priority',
      name: 'Priority',
      rules: [
        createRule('low', 'Low', 10, true, 'LOW'),
        createRule('high', 'High', 100, true, 'HIGH'),
      ],
    });

    const result = engine.evaluate('test.priority', context({}));

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('HIGH');
  });

  it('stops after the first match', () => {
    registry.register({
      id: 'test.first',
      name: 'First Match',
      rules: [
        createRule('first', 'First', 100, true, 'FIRST'),
        createRule('second', 'Second', 100, true, 'SECOND'),
      ],
    });

    const result = engine.evaluate('test.first', context({}));

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('FIRST');
  });

  it('skips non-matching rules', () => {
    registry.register({
      id: 'test.skip',
      name: 'Skip',
      rules: [
        createRule('skip', 'Skip', 100, false, 'SKIP'),
        createRule('match', 'Match', 10, true, 'MATCH'),
      ],
    });

    const result = engine.evaluate('test.skip', context({}));

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('MATCH');
  });

  it('throws NotFoundException for an unknown rule set', () => {
    expect(() => engine.evaluate('test.unknown', context({}))).toThrow(
      NotFoundException,
    );
  });

  it('throws InternalServerErrorException when rule evaluation fails', () => {
    registry.register({
      id: 'test.error',
      name: 'Error',
      rules: [
        {
          id: 'bad',
          name: 'Bad',
          priority: 10,
          evaluate: () => {
            throw new Error('boom');
          },
          result: () => ({ ruleId: 'bad', ruleName: 'Bad', priority: 10, decision: 'BAD' }),
        },
      ],
    });

    expect(() => engine.evaluate('test.error', context({}))).toThrow(
      InternalServerErrorException,
    );
  });

  it('isolates multiple rule sets', () => {
    registry.register({
      id: 'test.a',
      name: 'A',
      rules: [createRule('a', 'A', 10, true, 'A')],
    });
    registry.register({
      id: 'test.b',
      name: 'B',
      rules: [createRule('b', 'B', 10, true, 'B')],
    });

    expect(engine.evaluate('test.a', context({}))[0].decision).toBe('A');
    expect(engine.evaluate('test.b', context({}))[0].decision).toBe('B');
  });

  it('carries tenantId in context without affecting rule selection', () => {
    registry.register({
      id: 'test.tenant',
      name: 'Tenant',
      rules: [
        {
          id: 'reads-tenant',
          name: 'Reads Tenant',
          priority: 10,
          evaluate: (ctx) => ctx.tenantId === 't-1',
          result: (): RuleResult => ({
            ruleId: 'reads-tenant',
            ruleName: 'Reads Tenant',
            priority: 10,
            decision: 'TENANT_MATCH',
          }),
        },
      ],
    });

    const result = engine.evaluate('test.tenant', { facts: {}, tenantId: 't-1' });

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('TENANT_MATCH');
  });
});
