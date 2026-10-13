import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HrModule } from '../hr.module';
import { LeavePoliciesController } from './leave-policies.controller';
import { LeavePolicyService } from './leave-policy.service';
import {
  LeavePolicySimulationService,
  LEAVE_POLICY_SIMULATION_EVIDENCE_LEVEL,
} from './leave-policy-simulation.service';
import { LeavePolicyRepository } from './leave-policy.repository';
import { LeaveRepository } from '../leave/leave.repository';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import { PureRuleEngineModule } from '../../../rules/pure-rule-engine.module';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RequestContextService } from '../../../common/request-context.service';
import { evaluateLeaveLimit } from './leave-limit-enforcement';
import { SimulateLeavePolicyVersionDto } from '../dto/leave-policy-simulation.dto';
import { getMetadataStorage } from 'class-validator';
import { LEAVE_LIMIT_RULE_SET_ID } from '../domain/leave-policy';
import {
  LEAVE_DAY_WINDOW_COLLECTION,
  LEAVE_REQUEST_WINDOW_COLLECTION,
  leaveDayWindowProjection,
  leaveRequestWindowProjection,
} from './leave-limit-simulation-facts';
import { projectLeaveLimitRuleSetVersion } from './leave-limit-simulation-projection';

/**
 * Phase 54-H (§14, §16, §13, §26, §38.2 gate 9) — the SIMULATION surface's focused spec.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `rule-simulation.spec.ts` already proves the GENERIC engine's simulation contract (that a simulation
 * is the real engine, labelled, and applies nothing). What it cannot prove is the half 54-H adds: that
 * HR's ADAPTER hands that engine a correct, bounded, tenant-scoped question — and that reaching it
 * through real HTTP wiring resolves the actor, the permission and the version the frozen decisions
 * require. The failures this file is written to catch are specific to the crossing:
 *
 *   * a bridge that mints a second rule-set identity, or translates a version, so the engine is asked
 *     about a configuration that exists nowhere;
 *   * a `DAY_COUNT` projection that counts REQUESTS where §16.3 counts CALENDAR DAYS — an off-by-design
 *     error that would silently change every stored maximum's meaning;
 *   * a version lookup that falls back to the published row, so a question about a draft is answered
 *     with an answer about something else;
 *   * a route gated on the READ permission, which §14.6 forbids;
 *   * and any write at all, which §14.1, §23.7 and §26.4 forbid absolutely.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not re-test the limit arithmetic (`leave-limit-enforcement.spec.ts`), the counting rules
 * (`leave-limit-counting.spec.ts`), the resolver (`leave-policy.service.spec.ts`) or the projection's
 * internal ordering (`rule-*` specs). Those own their rules; repeating them here would make this file a
 * second, disagreeing authority on decisions it does not make.
 */
describe('Phase 54-H — the leave-limit simulation surface (§14)', () => {
  describe('the collection projections (§16.3, §16.7, D7)', () => {
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
    const request = (id: string, from: string, to: string, status: 'APPROVED' | 'PENDING') => ({
      id,
      startDate: day(from),
      endDate: day(to),
      status,
    });

    it('REQUEST_COUNT projects ONE record per qualifying request', () => {
      const projection = leaveRequestWindowProjection({
        countingBasis: 'REQUEST_COUNT',
        leaveTypeId: 'lt-1',
        consumedStates: ['APPROVED'],
        requests: [
          request('r1', '2026-03-01', '2026-03-03', 'APPROVED'),
          request('r2', '2026-03-05', '2026-03-05', 'APPROVED'),
        ],
      });

      // TWO REQUESTS, NOT FOUR DAYS — the distinction D7 and §16.1 exist to preserve.
      expect(projection).toHaveLength(2);
      expect(projection[0]).toEqual({ leaveTypeId: 'lt-1', status: 'APPROVED' });
    });

    it('DAY_COUNT projects ONE record per CALENDAR DAY, inclusive of both endpoints', () => {
      const projection = leaveDayWindowProjection({
        countingBasis: 'DAY_COUNT',
        leaveTypeId: 'lt-1',
        consumedStates: ['APPROVED'],
        requests: [
          // 3 days: the 1st, 2nd AND 3rd — a single-day request is 1, not 0 (§16.3).
          request('r1', '2026-03-01', '2026-03-03', 'APPROVED'),
          // A one-day request contributes exactly one.
          request('r2', '2026-03-05', '2026-03-05', 'APPROVED'),
        ],
      });

      expect(projection).toHaveLength(4);
      expect(projection.map((entry) => entry.day)).toEqual([
        '2026-03-01',
        '2026-03-02',
        '2026-03-03',
        '2026-03-05',
      ]);
    });

    it('DAY_COUNT does NOT merge overlapping requests — §16.3 sums each counted request', () => {
      const projection = leaveDayWindowProjection({
        countingBasis: 'DAY_COUNT',
        leaveTypeId: 'lt-1',
        consumedStates: ['APPROVED'],
        requests: [
          request('r1', '2026-03-01', '2026-03-02', 'APPROVED'),
          request('r2', '2026-03-02', '2026-03-03', 'APPROVED'),
        ],
      });

      // 2 + 2 = 4, with the 2nd counted TWICE. De-duplicating would give 3 and silently weaken the
      // limit; merging would let one request's days hide another's.
      expect(projection).toHaveLength(4);
      expect(projection.filter((entry) => entry.day === '2026-03-02')).toHaveLength(2);
    });

    it('filters by the limit OWN consumed states, so an unstated state never counts', () => {
      const requests = [
        request('r1', '2026-03-01', '2026-03-01', 'APPROVED'),
        request('r2', '2026-03-02', '2026-03-02', 'PENDING'),
      ];

      // §16.4: the authored set decides. Counting PENDING here would grant an entitlement the author's
      // own set denies — the "silent substitution" the counting module's header refuses.
      expect(
        leaveRequestWindowProjection({
          countingBasis: 'REQUEST_COUNT',
          leaveTypeId: 'lt-1',
          consumedStates: ['APPROVED'],
          requests,
        })
      ).toHaveLength(1);

      expect(
        leaveRequestWindowProjection({
          countingBasis: 'REQUEST_COUNT',
          leaveTypeId: 'lt-1',
          consumedStates: ['APPROVED', 'PENDING'],
          requests,
        })
      ).toHaveLength(2);
    });

    it('populates ONLY the collection its basis counts over', () => {
      // The basis selects the collection, so a rule's `count.over` always resolves to a DECLARED fact
      // rather than to a missing one (§8.4 refuses an undeclared or absent collection).
      expect(
        leaveDayWindowProjection({
          countingBasis: 'REQUEST_COUNT',
          leaveTypeId: 'lt-1',
          consumedStates: ['APPROVED'],
          requests: [request('r1', '2026-03-01', '2026-03-03', 'APPROVED')],
        })
      ).toEqual([]);

      expect(
        leaveRequestWindowProjection({
          countingBasis: 'DAY_COUNT',
          leaveTypeId: 'lt-1',
          consumedStates: ['APPROVED'],
          requests: [request('r1', '2026-03-01', '2026-03-03', 'APPROVED')],
        })
      ).toEqual([]);
    });
  });

  describe('the RuleSetVersion projection (§14, §10.1-§10.3, A1-A3)', () => {
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

    const limit = (
      overrides: Partial<
        Parameters<typeof projectLeaveLimitRuleSetVersion>[0]['limits'][number]
      > = {}
    ) => ({
      id: 'limit-1',
      leaveTypeId: 'lt-1',
      employmentType: null,
      maximum: 3,
      countingBasis: 'REQUEST_COUNT' as const,
      windowStart: day('2026-01-01'),
      windowEnd: day('2026-12-29'),
      consumedStates: ['APPROVED'],
      ...overrides,
    });

    const project = (overrides: Record<string, unknown> = {}) =>
      projectLeaveLimitRuleSetVersion({
        versionLabel: 'v-1',
        status: 'DRAFT',
        effectiveFrom: day('2026-01-01'),
        effectiveTo: null,
        limits: [limit()],
        ...overrides,
      });

    it('reports the ONE logical rule-set identity, so a caller cannot mint a second (A1)', () => {
      expect(project().ruleSetId).toBe(LEAVE_LIMIT_RULE_SET_ID);
      expect(project().ruleSetId).toBe('hr.leave.limit');
    });

    it('maps the stored label through UNCHANGED — no translation and no fallback (A3)', () => {
      expect(project({ versionLabel: 'v-42' }).version).toBe('v-42');
    });

    it('copies the stored lifecycle state, so §10.3 applies to the four HR states as they are', () => {
      for (const status of ['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'] as const) {
        expect(project({ status }).status).toBe(status);
      }
    });

    it('declares exactly the two approved collections and no others (§8.3, D-54-H-F)', () => {
      const collections = project()
        .fields.filter((entry) => entry.type === 'collection')
        .map((entry) => entry.name)
        .sort();

      expect(collections).toEqual([LEAVE_DAY_WINDOW_COLLECTION, LEAVE_REQUEST_WINDOW_COLLECTION]);
    });

    it('declares the approved item fields and refuses to invent any (§14, D-54-H-G)', () => {
      const entries = project().fields;
      const requestCollection = entries.find(
        (entry) => entry.name === LEAVE_REQUEST_WINDOW_COLLECTION
      );
      const dayCollection = entries.find((entry) => entry.name === LEAVE_DAY_WINDOW_COLLECTION);

      expect(requestCollection).toMatchObject({
        itemFields: [
          { name: 'leaveTypeId', type: 'string' },
          { name: 'status', type: 'enum' },
        ],
      });
      expect(dayCollection).toMatchObject({
        itemFields: [
          { name: 'leaveTypeId', type: 'string' },
          { name: 'status', type: 'enum' },
          { name: 'day', type: 'date' },
        ],
      });

      // NO SCALAR `consumesStates` FACT — the resolved 54-H decision. A bare array is not a
      // `RuleFactValue` at all, and the set already travels in each rule's `where` operand.
      expect(entries.map((entry) => entry.name)).not.toContain('consumesStates');
    });

    it('turns each stored limit into ONE rule refusing on `count > maximum` (§16.7)', () => {
      const projected = project();

      expect(projected.rules).toHaveLength(1);
      expect(projected.rules[0].condition).toEqual({
        count: {
          over: LEAVE_REQUEST_WINDOW_COLLECTION,
          where: [
            { field: 'leaveTypeId', op: 'equals', value: 'lt-1' },
            { field: 'status', op: 'in', value: ['APPROVED'] },
          ],
          op: 'greaterThan',
          value: 3,
        },
      });

      // `maximum` is an INCLUDED ceiling, so the refusal is strictly-greater — the same comparison
      // Phase 54-G's `evaluateLeaveLimit` makes.
      expect(projected.rules[0].actions).toEqual([
        {
          type: 'LIMIT_REFUSAL',
          limitRef: 'limit-1',
          countingBasis: 'REQUEST_COUNT',
          maximum: 3,
          windowStart: '2026-01-01',
          windowEnd: '2026-12-29',
        },
      ]);
    });

    it('routes DAY_COUNT to the day collection, so the basis is structural (D7)', () => {
      const projected = project({ limits: [limit({ countingBasis: 'DAY_COUNT' })] });

      expect(projected.rules[0].condition).toMatchObject({
        count: { over: LEAVE_DAY_WINDOW_COLLECTION, value: 3 },
      });
    });

    it('is FROZEN at every level, so a caller cannot simulate an invented configuration (§10.6)', () => {
      const projected = project();

      expect(Object.isFrozen(projected)).toBe(true);
      expect(Object.isFrozen(projected.rules)).toBe(true);
      expect(Object.isFrozen(projected.rules[0])).toBe(true);
    });
  });

  describe('the service, against the REAL engine (§14.1, §14.2, §23.7)', () => {
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

    const ACTOR = {
      tenantId: 'tenant-a',
      userId: 'user-1',
      requestId: 'req-1',
      ip: null,
      userAgent: null,
    };

    const storedVersion = (status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED') => ({
      id: 'version-1',
      tenantId: 'tenant-a',
      policyId: 'policy-1',
      versionLabel: 'v-1',
      status,
      jalaliYear: 1405,
      effectiveFrom: day('2026-01-01'),
      effectiveTo: null,
      payload: {},
      publishedAt: null,
      publishedByEmployeeId: null,
    });

    const storedLimit = (
      overrides: Partial<{
        id: string;
        countingBasis: 'REQUEST_COUNT' | 'DAY_COUNT';
        maximum: number;
        consumedStates: readonly string[];
      }> = {}
    ) => ({
      id: 'limit-1',
      tenantId: 'tenant-a',
      policyId: 'policy-1',
      policyVersionId: 'version-1',
      leaveTypeId: 'lt-1',
      employmentType: null,
      maximum: 3,
      countingBasis: 'REQUEST_COUNT' as const,
      period: 'YEAR' as const,
      jalaliYear: 1405,
      windowStart: day('2026-01-01'),
      windowEnd: day('2026-12-29'),
      consumesStates: ['APPROVED'],
      effectiveFrom: day('2026-01-01'),
      effectiveTo: null,
      ...overrides,
    });

    /** The real engine, and stubbed DATA only — the service's wiring stays under test. */
    const buildService = async (input: {
      version: ReturnType<typeof storedVersion>;
      limits: readonly ReturnType<typeof storedLimit>[];
      requests?: readonly { id: string; startDate: Date; endDate: Date; status: string }[];
    }) => {
      const policies = {
        findLimitsForPolicyVersion: jest.fn().mockResolvedValue(input.limits),
        findVersion: jest.fn().mockResolvedValue(input.version),
        findPolicy: jest.fn().mockResolvedValue({ id: 'policy-1' }),
      };
      const leave = {
        findCountableRequests: jest.fn().mockResolvedValue(input.requests ?? []),
      };
      const policyService = {
        resolveEffective: jest.fn().mockResolvedValue({ version: input.version, limits: [] }),
      };

      const moduleRef = await Test.createTestingModule({ imports: [PureRuleEngineModule] })
        .useMocker(() => undefined)
        .compile();

      const engine = moduleRef.get(RuleEngineService);

      return {
        service: new LeavePolicySimulationService(
          policies as never,
          policyService as never,
          leave as never,
          engine
        ),
        policies,
        leave,
        policyService,
      };
    };

    const simulate = (
      service: LeavePolicySimulationService,
      version: ReturnType<typeof storedVersion>,
      overrides: Record<string, unknown> = {}
    ) =>
      service.simulate(
        ACTOR,
        version as never,
        {
          ruleSetId: LEAVE_LIMIT_RULE_SET_ID,
          leaveTypeId: 'lt-1',
          evaluationInstant: '2026-06-01T00:00:00.000Z',
          ...overrides,
        } as never
      );

    it('uses the REAL engine and labels the answer as a simulation (§14.2, §14.5)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit()],
      });

      const result = await simulate(service, storedVersion('DRAFT'));

      expect(result.simulation.mode).toBe('SIMULATION');
      expect(result.simulation.banner).toBe('SIMULATION — NO DATA CHANGED');
      expect(result.simulation.validation.valid).toBe(true);
      expect(result.ruleSetId).toBe(LEAVE_LIMIT_RULE_SET_ID);
    });

    it('simulates ALL FOUR lifecycle states, none of them registered (Choice 1B, A2)', async () => {
      // The states that `simulateVersion` would REFUSE (everything but PUBLISHED) are exactly the ones
      // this surface exists for, so each is asserted to evaluate.
      for (const status of ['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'] as const) {
        const { service } = await buildService({
          version: storedVersion(status),
          limits: [storedLimit()],
        });

        const result = await simulate(service, storedVersion(status));

        expect(result.status).toBe(status);
        expect(result.simulation.validation.valid).toBe(true);
      }
    });

    it('marks ONLY ARCHIVED as historical, because a draft was never in force (Choice 1B)', async () => {
      for (const status of ['DRAFT', 'VALIDATED', 'PUBLISHED'] as const) {
        const { service } = await buildService({
          version: storedVersion(status),
          limits: [storedLimit()],
        });

        expect((await simulate(service, storedVersion(status))).historical).toBe(false);
      }

      const { service } = await buildService({
        version: storedVersion('ARCHIVED'),
        limits: [storedLimit()],
      });

      expect((await simulate(service, storedVersion('ARCHIVED'))).historical).toBe(true);
    });

    it('REFUSES a rule set this surface does not own, rather than resolving it (§14)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit()],
      });

      await expect(
        simulate(service, storedVersion('DRAFT'), { ruleSetId: 'core.example' })
      ).rejects.toThrow(NotFoundException);
    });

    it('reports the refusal with §16.7 grounds, reusing RuleLimitRefusalAction', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 1 })],
        requests: [
          {
            id: 'r1',
            startDate: day('2026-03-01'),
            endDate: day('2026-03-01'),
            status: 'APPROVED',
          },
          {
            id: 'r2',
            startDate: day('2026-03-02'),
            endDate: day('2026-03-02'),
            status: 'APPROVED',
          },
        ],
      });

      const result = await simulate(service, storedVersion('DRAFT'));

      expect(result.simulation.decision).toEqual({
        type: 'LIMIT_REFUSAL',
        limitRef: 'limit-1',
        countingBasis: 'REQUEST_COUNT',
        maximum: 1,
        windowStart: '2026-01-01',
        windowEnd: '2026-12-29',
      });

      expect(result.limits).toEqual([
        {
          limitRef: 'limit-1',
          leaveTypeId: 'lt-1',
          employmentType: null,
          countingBasis: 'REQUEST_COUNT',
          maximum: 1,
          windowStart: '2026-01-01',
          windowEnd: '2026-12-29',
          observed: 2,
          exceeded: true,
        },
      ]);
    });

    it('permits when the count is AT the maximum — `maximum` is an included ceiling (§16)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 2 })],
        requests: [
          {
            id: 'r1',
            startDate: day('2026-03-01'),
            endDate: day('2026-03-01'),
            status: 'APPROVED',
          },
          {
            id: 'r2',
            startDate: day('2026-03-02'),
            endDate: day('2026-03-02'),
            status: 'APPROVED',
          },
        ],
      });

      const result = await simulate(service, storedVersion('DRAFT'));

      // 2 > 2 is FALSE, so the refusal must NOT fire: Phase 54-G's boundary, preserved exactly.
      expect(result.limits[0].observed).toBe(2);
      expect(result.limits[0].exceeded).toBe(false);
      expect(result.simulation.decision).toBe('NONE');
    });

    it('counts DAY_COUNT in days, so the SAME rows give a DIFFERENT answer (D7)', async () => {
      const requests = [
        { id: 'r1', startDate: day('2026-03-01'), endDate: day('2026-03-03'), status: 'APPROVED' },
      ];

      const counted = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 3, countingBasis: 'DAY_COUNT' })],
        requests,
      });
      const requested = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 3, countingBasis: 'REQUEST_COUNT' })],
        requests,
      });

      // ONE request covering THREE days. DAY_COUNT observes 3 (permitted — 3 is not > 3) while
      // REQUEST_COUNT observes 1. D7: the same number must not mean two things, and here the same ROWS
      // do not even produce the same number.
      const byDay = await simulate(counted.service, storedVersion('DRAFT'));
      const byRequest = await simulate(requested.service, storedVersion('DRAFT'));

      expect(byDay.limits[0].observed).toBe(3);
      expect(byRequest.limits[0].observed).toBe(1);
    });

    it('preserves a caller-supplied evaluationInstant, and defaults only when absent (D12)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit()],
      });

      const explicit = await simulate(service, storedVersion('DRAFT'));
      expect(explicit.evaluationInstant).toBe('2026-06-01T00:00:00.000Z');
      expect(explicit.simulation.evaluationInstant).toBe('2026-06-01T00:00:00.000Z');

      const defaulted = await service.simulate(
        ACTOR,
        storedVersion('DRAFT') as never,
        {
          ruleSetId: LEAVE_LIMIT_RULE_SET_ID,
          leaveTypeId: 'lt-1',
        } as never
      );

      // The ENGINE still receives an explicit instant — the default happens at the boundary, never inside.
      expect(typeof defaulted.simulation.evaluationInstant).toBe('string');
      expect(defaulted.simulation.evaluationInstant.length).toBeGreaterThan(0);
    });

    it('is DETERMINISTIC: the same state and body reproduce the same result (§36.4)', async () => {
      const build = () =>
        buildService({
          version: storedVersion('DRAFT'),
          limits: [storedLimit({ maximum: 1 })],
          requests: [
            {
              id: 'r1',
              startDate: day('2026-03-01'),
              endDate: day('2026-03-01'),
              status: 'APPROVED',
            },
            {
              id: 'r2',
              startDate: day('2026-03-02'),
              endDate: day('2026-03-02'),
              status: 'APPROVED',
            },
          ],
        });

      const first = await build();
      const second = await build();

      const a = await simulate(first.service, storedVersion('DRAFT'));
      const b = await simulate(second.service, storedVersion('DRAFT'));

      expect(a.simulation.decision).toEqual(b.simulation.decision);
      expect(a.simulation.observedCounts).toEqual(b.simulation.observedCounts);
      expect(a.limits).toEqual(b.limits);
      expect(a.simulation.explanationText).toBe(b.simulation.explanationText);
    });

    it('writes NOTHING: neither injected dependency exposes a mutation (§14.1, §23.7)', async () => {
      const { service, policies, leave, policyService } = await buildService({
        version: storedVersion('PUBLISHED'),
        limits: [storedLimit()],
      });

      await simulate(service, storedVersion('PUBLISHED'));

      // The read-only guarantee is asserted as an ABSENCE OF CAPABILITY: none of the stubs exposes a
      // write, so a service that attempted one would fail loudly rather than silently succeed.
      const WRITE_METHODS = [
        'createRequest',
        'updateRequest',
        'applyVersionTransition',
        'publishVersion',
        'createVersion',
        'createPolicy',
        'replaceVersionLimits',
        'updateDraftVersion',
      ];

      for (const method of WRITE_METHODS) {
        expect(policies).not.toHaveProperty(method);
        expect(leave).not.toHaveProperty(method);
        expect(policyService).not.toHaveProperty(method);
      }

      // EVERY call actually made is a READ, named exhaustively — so a new call appearing in the service
      // fails this assertion rather than passing unnoticed.
      const called = (stub: Record<string, jest.Mock>) =>
        Object.keys(stub)
          .filter((key) => stub[key].mock.calls.length > 0)
          .sort();

      expect(called(policies)).toEqual(['findLimitsForPolicyVersion']);
      expect(called(leave)).toEqual(['findCountableRequests']);
      expect(called(policyService)).toEqual([]);
    });

    it('builds the explanation SERVER-SIDE at this surface own level (§13.2, §27.2, §27.6)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 1 })],
        requests: [
          {
            id: 'r1',
            startDate: day('2026-03-01'),
            endDate: day('2026-03-01'),
            status: 'APPROVED',
          },
          {
            id: 'r2',
            startDate: day('2026-03-02'),
            endDate: day('2026-03-02'),
            status: 'APPROVED',
          },
        ],
      });

      const result = await simulate(service, storedVersion('DRAFT'));

      // The round's content is unchanged: the decision and its grounds still arrive.
      expect(result.explanation.ruleSetId).toBe(LEAVE_LIMIT_RULE_SET_ID);
      expect(result.explanation.reasonCodes).toContain('ACTION_LIMIT_REFUSAL');
      expect(result.explanation.decisionType).toBe('LIMIT_REFUSAL');

      // And the level is the surface's, not the caller's.
      expect(result.explanation.detailLevel).toBe(LEAVE_POLICY_SIMULATION_EVIDENCE_LEVEL);
      expect(result.explanation.detailLevel).toBe('HR_ADMIN');
    });

    it('WITHHOLDS the advanced projection, because this route is not Level 3 (§27.2, §31)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 1 })],
        requests: [
          {
            id: 'r1',
            startDate: day('2026-03-01'),
            endDate: day('2026-03-01'),
            status: 'APPROVED',
          },
          {
            id: 'r2',
            startDate: day('2026-03-02'),
            endDate: day('2026-03-02'),
            status: 'APPROVED',
          },
        ],
      });

      const { explanation } = await simulate(service, storedVersion('DRAFT'));

      /**
       * THIS IS THE ASSERTION THE SECURITY CORRECTION EXISTS FOR. Every field below is present in a
       * `PLATFORM_ADMIN` projection and must be ABSENT or empty at `HR_ADMIN` — and §27.2 requires the
       * absence to be a PROJECTION the server made, not a value a renderer chose to hide.
       */
      expect(explanation.orderingBasis).toBeNull();
      expect(explanation.failedLeaves).toEqual([]);

      // `matchHistory: 'MATCHED_ONLY'` — the unmatched rules' internals never travel.
      expect(explanation.matchHistory.every((entry) => entry.matched)).toBe(true);
      expect(
        explanation.matchHistory.every(
          (entry) => entry.failedLeaves.length === 0 && entry.failedLeaves !== undefined
        )
      ).toBe(true);
    });

    it('IGNORES an attempt to name a level: the input contract has no such field (§33.8)', async () => {
      const { service } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit({ maximum: 1 })],
      });

      /**
       * The body is passed with `level` anyway, exactly as a hostile caller would. TypeScript is
       * bypassed deliberately here, because the guarantee being tested is a RUNTIME one: the field no
       * longer exists on the DTO, so `whitelist` + `forbidNonWhitelisted` makes sending it a 400 before
       * the handler runs — and even if it reached the service, nothing reads it.
       */
      const result = await service.simulate(
        ACTOR,
        storedVersion('DRAFT') as never,
        {
          ruleSetId: LEAVE_LIMIT_RULE_SET_ID,
          leaveTypeId: 'lt-1',
          evaluationInstant: '2026-06-01T00:00:00.000Z',
          level: 'PLATFORM_ADMIN',
        } as never
      );

      expect(result.explanation.detailLevel).toBe('HR_ADMIN');
      expect(result.explanation.orderingBasis).toBeNull();
    });

    it('reads with the ACTOR tenant first, so another tenant cannot enter a projection (§24)', async () => {
      const { service, policies, leave } = await buildService({
        version: storedVersion('DRAFT'),
        limits: [storedLimit()],
      });

      await simulate(service, storedVersion('DRAFT'));

      expect(policies.findLimitsForPolicyVersion).toHaveBeenCalledWith('tenant-a', 'version-1');
      expect(leave.findCountableRequests).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({ leaveTypeId: 'lt-1' })
      );
    });

    it('agrees with the RUNTIME (54-G) on the same facts — semantic parity (§38.2 gate 9)', async () => {
      const requests = [
        { id: 'r1', startDate: day('2026-03-01'), endDate: day('2026-03-03'), status: 'APPROVED' },
        { id: 'r2', startDate: day('2026-03-05'), endDate: day('2026-03-05'), status: 'PENDING' },
      ];
      const limit = storedLimit({ maximum: 3, countingBasis: 'DAY_COUNT' });

      /**
       * THE RUNTIME'S OWN DECISION, computed from the same stored rows through Phase 54-G's evaluator —
       * NOT through the simulation. Comparing the two is what makes "runtime parity" an assertion rather
       * than a claim: the simulation must not be a second, more forgiving evaluator.
       */
      const runtime = evaluateLeaveLimit({
        limit: {
          id: limit.id,
          leaveTypeId: limit.leaveTypeId,
          employmentType: null,
          maximum: limit.maximum,
          countingBasis: limit.countingBasis,
          consumedStates: limit.consumesStates as never,
          windowStart: limit.windowStart,
          windowEnd: limit.windowEnd,
        },
        requests: requests.map((row) => ({
          id: row.id,
          startDate: row.startDate,
          endDate: row.endDate,
          status: row.status as never,
        })),
        employmentType: null,
      });

      const { service } = await buildService({
        version: storedVersion('PUBLISHED'),
        limits: [limit],
        requests,
      });

      const simulation = await simulate(service, storedVersion('PUBLISHED'));

      // The same verdict, the same count, the same maximum — the runtime's own grounds, restated by the
      // simulation rather than re-derived.
      expect(runtime.refusable).toBe(true);
      if (!runtime.refusable) return;

      expect(simulation.limits[0].observed).toBe(runtime.count);
      expect(simulation.limits[0].maximum).toBe(runtime.maximum);
      expect(simulation.limits[0].exceeded).toBe(runtime.exceeded);
      expect(simulation.limits[0].countingBasis).toBe(runtime.countingBasis);

      // 3 days (Mar 1–3) only: the PENDING request is excluded by the limit's own consumed states, so
      // `3 > 3` is false and NEITHER path refuses.
      expect(runtime.count).toBe(3);
      expect(runtime.exceeded).toBe(false);
      expect(simulation.simulation.decision).toBe('NONE');
    });
  });

  describe('the RUNTIME wiring (§14, §24, §25, §38.2 gate 9)', () => {
    let controller: LeavePoliciesController;
    let simulation: { resolveAndSimulate: jest.Mock };

    const setContext = (tenantId: string | null, userId: string) =>
      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
        userId,
        tenantId,
      });

    beforeEach(() => setContext(null, 'unseeded'));
    beforeEach(() => jest.clearAllMocks());

    beforeAll(async () => {
      simulation = { resolveAndSimulate: jest.fn() };

      const moduleRef = await Test.createTestingModule({ imports: [HrModule] })
        .overrideProvider(LeavePolicySimulationService)
        .useValue(simulation)
        .overrideProvider(LeavePolicyService)
        .useValue({})
        .overrideProvider(LeavePolicyRepository)
        .useValue({})
        .overrideProvider(LeaveRepository)
        .useValue({})
        .overrideGuard(JwtAuthGuard)
        .useValue({ canActivate: () => true })
        .compile();

      controller = moduleRef.get(LeavePoliciesController);
    });

    it('is BOUND in the module, so §14 route is actually mounted', () => {
      // A controller file that exists but is not listed in `HrModule.controllers` is dead code, and the
      // first spec that proved this mattered is the reason this assertion exists.
      const handlers = Object.getOwnPropertyNames(LeavePoliciesController.prototype);
      expect(handlers).toContain('simulate');
    });

    it('declares the §14 route as POST :policyId/simulate with a 200 (§14)', () => {
      const meta = (key: string) =>
        Reflect.getMetadata(key, LeavePoliciesController.prototype.simulate);
      const descriptor = Object.getOwnPropertyDescriptor(
        LeavePoliciesController.prototype,
        'simulate'
      );

      expect(Reflect.getMetadata(PATH_METADATA, descriptor?.value)).toBe(':policyId/simulate');
      expect(Reflect.getMetadata(METHOD_METADATA, descriptor?.value)).toBe(RequestMethod.POST);
      expect(meta('__httpCode__')).toBe(200);
    });

    it('gates the route on hr.leave.policy and NOT on the read or approve permission (2A)', () => {
      const roles = Reflect.getMetadata(
        'roles',
        LeavePoliciesController.prototype.simulate
      ) as string[];

      expect(roles).toEqual(['hr.leave.policy']);
      expect(roles).not.toContain('hr.leave.read');
      expect(roles).not.toContain('hr.leave.approve');
    });

    it('declares NO evidence-level field, so `level` is a rejected unknown property (§33.8)', () => {
      /**
       * THE CLIENT-CONTROLLED-LEVEL VULNERABILITY, ASSERTED AT THE SHAPE. `ValidationPipe` runs
       * `whitelist` + `forbidNonWhitelisted` globally, so a body property the DTO does not declare is a
       * 400 — which is why the guarantee is asserted on the DECLARED SHAPE rather than by posting a
       * payload: if the field is absent from the class, no request can set it, whatever it sends.
       *
       * THE DECLARED FIELDS COME FROM THE VALIDATOR METADATA, not from `Object.keys(new Dto())`. A
       * TypeScript class whose fields are annotated with `!:` (definite assignment — the shape every DTO
       * in this module uses, because the value arrives from the parsed body rather than a constructor)
       * emits NO runtime property, so an instance is empty and a `Object.keys` assertion would pass
       * vacuously for every field — including the ones that must exist. `class-validator` registers one
       * metadata entry per DECORATED property, which is exactly the surface `ValidationPipe` enforces
       * and therefore the only honest place to read the declared shape from.
       *
       * The whole level vocabulary is checked, not just `PLATFORM_ADMIN`, because a caller that could
       * name ANY level would still be choosing its own disclosure — and §27.2 puts that choice on the
       * server.
       */
      const declared = [
        ...new Set(
          getMetadataStorage()
            .getTargetValidationMetadatas(SimulateLeavePolicyVersionDto, '', false, false)
            .map((meta) => meta.propertyName)
        ),
      ];

      // The metadata read must FIND something, or every assertion below would pass on an empty set.
      expect(declared.length).toBeGreaterThan(0);
      expect(declared).not.toContain('level');
      expect(declared).not.toContain('evidenceLevel');
      expect(declared).not.toContain('permission');
      expect(declared).not.toContain('role');
      expect(declared).not.toContain('tenantId');

      // …while the fields §14 DOES authorise are present, so this is a narrowing rather than a stub.
      for (const field of ['ruleSetId', 'versionId', 'evaluationInstant', 'context', 'subject']) {
        expect(declared).toContain(field);
      }
    });

    it('reaches the service with a SERVER-DERIVED actor, never a caller-supplied tenant', async () => {
      setContext('tenant-abc', 'user-1');
      simulation.resolveAndSimulate.mockResolvedValue({});

      const req = { user: { sub: 'user-1' } } as never;
      const policyId = '11111111-1111-4111-8111-111111111111';

      await controller.simulate(req, policyId, {
        ruleSetId: 'hr.leave.limit',
        context: { leaveTypeId: 'lt-1' },
      } as never);

      expect(simulation.resolveAndSimulate).toHaveBeenCalledTimes(1);
      const [actor, forwardedPolicyId, input] = simulation.resolveAndSimulate.mock.calls[0];

      expect(actor.tenantId).toBe('tenant-abc');
      expect(actor.userId).toBe('user-1');
      expect(forwardedPolicyId).toBe(policyId);
      // The DTO HAS NO TENANT, so nothing the caller sent could have supplied one.
      expect(input).not.toHaveProperty('tenantId');
      expect(input.ruleSetId).toBe('hr.leave.limit');
    });

    it('REFUSES when the request was not resolved to a tenant (§24.1, fail-closed)', async () => {
      setContext(null, 'user-1');
      simulation.resolveAndSimulate.mockReset();

      const req = { user: { sub: 'user-1' } } as never;

      await expect(
        controller.simulate(req, '11111111-1111-4111-8111-111111111111', {
          ruleSetId: 'hr.leave.limit',
          context: { leaveTypeId: 'lt-1' },
        } as never)
      ).rejects.toThrow(ForbiddenException);

      expect(simulation.resolveAndSimulate).not.toHaveBeenCalled();
    });

    it('forwards an explicit versionId, and omits it when the caller named none (Choice 1B)', async () => {
      setContext('tenant-abc', 'user-1');
      simulation.resolveAndSimulate.mockResolvedValue({});

      const req = { user: { sub: 'user-1' } } as never;

      await controller.simulate(req, '11111111-1111-4111-8111-111111111111', {
        ruleSetId: 'hr.leave.limit',
        versionId: '22222222-2222-4222-8222-222222222222',
        context: { leaveTypeId: 'lt-1' },
      } as never);

      expect(simulation.resolveAndSimulate.mock.calls[0][2].versionId).toBe(
        '22222222-2222-4222-8222-222222222222'
      );

      simulation.resolveAndSimulate.mockClear();

      await controller.simulate(req, '11111111-1111-4111-8111-111111111111', {
        ruleSetId: 'hr.leave.limit',
        context: { leaveTypeId: 'lt-1' },
      } as never);

      // ABSENT, not `undefined`: the service branches on presence, and an explicit `undefined` key would
      // make "the caller named no version" indistinguishable from a key the mapper added.
      expect(simulation.resolveAndSimulate.mock.calls[0][2]).not.toHaveProperty('versionId');
    });
  });
});
