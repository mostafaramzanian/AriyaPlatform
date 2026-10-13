import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import { join } from 'path';

import { LeavePolicySimulationPanel } from '../LeavePolicySimulationPanel';
import {
  HR_LEAVE_LIMIT_RULE_SET_ID,
  hrLeaveLimitCountingBasisLabel,
  hrLeavePolicyVersionStatusLabel,
  simulateLeavePolicyVersion,
  type HrLeavePolicySimulationResult,
  type HrLeavePolicyVersion,
} from '@/lib/hr-leave-policy-api';

/**
 * Phase 54-I: the SIMULATION PANEL.
 *
 * WHAT THESE SPECS ARE FOR. The panel re-reads a contract that is already pinned – the API's own
 * `leave-limit-simulation.spec.ts` holds the server side, down to the evidence level being
 * server-derived – so the interesting claims are the ones only THIS component can get wrong:
 *
 *   * that it sends EXACTLY the fields §14 defines, and never a field the server owns. The evidence
 *     level is the sharp one: 54-I closed a defect where a client could NAME its own level, so a spec
 *     asserts the request carries no `level`/`evidenceLevel`, measured on the ACTUAL payload;
 *   * that an omitted version is OMITTED rather than sent blank, because the server branches on
 *     presence to tell "the currently effective configuration" from "this exact version". A client
 *     that sent `versionId: undefined` would collapse two different questions into one;
 *   * that the banner is the RESPONSE'S string, never a literal the client owns – and that when a
 *     response arrives without one, the panel says so instead of printing the frozen text anyway;
 *   * that a WITHHELD field is rendered as withheld, not as absent-by-nature. The projection is a
 *     server decision (§27.2), so `null` means "not disclosed at this level" and a UI that showed
 *     nothing would assert the engine had no ordering basis when it had one;
 *   * that the panel cannot mutate: it imports no write client, and the shipped source contains none.
 *
 * THE CLIENT IS MOCKED, AND THAT IS THE POINT. These are presentation claims, so the transport is
 * stubbed and the real assertions are about the payload and the DOM. `hr-leave-policy-api.spec.ts`
 * covers the transport itself against a stubbed `fetch`, so between them the real client's behaviour is
 * pinned without either spec duplicating the other.
 */

jest.mock('@/lib/hr-leave-policy-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-policy-api'),
  simulateLeavePolicyVersion: jest.fn(),
}));

const simulateMock = simulateLeavePolicyVersion as jest.MockedFunction<
  typeof simulateLeavePolicyVersion
>;

/** The version ids the two builders use, so a spec can assert which one travelled. */
const VERSION_PUBLISHED = 'ver-published';
const VERSION_DRAFT = 'ver-draft';

function version(overrides: Partial<HrLeavePolicyVersion> = {}): HrLeavePolicyVersion {
  return {
    id: VERSION_PUBLISHED,
    tenantId: 'tenant-54i',
    policyId: 'policy-1',
    versionLabel: 'v1',
    status: 'PUBLISHED',
    jalaliYear: 1405,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    payload: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    publishedByEmployeeId: null,
    ...overrides,
  };
}

/**
 * A result shaped as the server sends it: the frozen banner, the projected explanation, and the
 * grounds. The ADVANCED fields are deliberately null/empty, because at this surface's level that is
 * what the server sends — the panel's job is to render that honestly rather than to infer.
 */
function result(
  overrides: Partial<HrLeavePolicySimulationResult> = {}
): HrLeavePolicySimulationResult {
  return {
    ruleSetId: HR_LEAVE_LIMIT_RULE_SET_ID,
    policyId: 'policy-1',
    policyVersionId: VERSION_PUBLISHED,
    versionLabel: 'v1',
    status: 'PUBLISHED',
    historical: false,
    evaluationInstant: '2026-05-01T00:00:00.000Z',
    simulation: {
      ruleSetId: HR_LEAVE_LIMIT_RULE_SET_ID,
      ruleSetVersion: 'v1',
      evaluationInstant: '2026-05-01T00:00:00.000Z',
      status: 'PUBLISHED',
      decision: 'LIMIT_REFUSAL',
      winningRule: null,
      decisionActions: [],
      matchHistory: [],
      orderingBasis: null,
      observedCounts: [],
      missingFields: [],
      explanationText: 'rule.limit.request-count',
      conflicts: [],
      validation: { valid: true, issues: [], conflicts: [] },
      mode: 'SIMULATION',
      banner: 'SIMULATION — NO DATA CHANGED',
      wouldApply: [],
    },
    limits: [],
    explanation: {
      ruleSetId: HR_LEAVE_LIMIT_RULE_SET_ID,
      ruleSetVersion: 'v1',
      evaluationInstant: '2026-05-01T00:00:00.000Z',
      detailLevel: 'HR_ADMIN',
      status: 'PUBLISHED',
      decisionType: 'LIMIT_REFUSAL',
      decisionActions: [],
      winningRuleId: null,
      winningRuleVersion: null,
      orderingBasis: null,
      matchHistory: [],
      grounds: [],
      failedLeaves: [],
      missingFields: [],
      observedCounts: [],
      reasonCodes: [],
      conflicts: [],
      explanationText: 'rule.limit.request-count',
    },
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof LeavePolicySimulationPanel>[0]> = {}) {
  return render(
    <LeavePolicySimulationPanel
      policyId="policy-1"
      versions={[version()]}
      defaultLeaveTypeId="type-annual"
      {...props}
    />
  );
}

describe('the simulation panel (§14, §27.2, §32)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    simulateMock.mockResolvedValue(result());
  });

  describe('the request it sends', () => {
    it('sends the rule-set constant and the context members the operator stated', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByTestId('hr-sim-submit'));

      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));

      const [policyId, body] = simulateMock.mock.calls[0];
      expect(policyId).toBe('policy-1');
      expect(body.ruleSetId).toBe('hr.leave.limit');
      expect(body.context).toEqual({ leaveTypeId: 'type-annual' });
    });

    it('NEVER sends an evidence level, a role, a permission or a tenant the client chose (§27.2)', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByTestId('hr-sim-submit'));
      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));

      const body = simulateMock.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
      // Asserted on the ACTUAL payload: this is the claim 54-I closed, so it is measured, not read.
      expect(body).not.toHaveProperty('level');
      expect(body).not.toHaveProperty('evidenceLevel');
      expect(body).not.toHaveProperty('role');
      expect(body).not.toHaveProperty('permission');
      expect(body).not.toHaveProperty('tenantId');
      expect(body).not.toHaveProperty('bypass');
      expect(body).not.toHaveProperty('force');
    });

    it('OMITS versionId rather than sending it undefined, so the server can tell the two apart', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByTestId('hr-sim-submit'));
      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));

      // The server branches on PRESENCE (§14, Choice 1B). An absent key and a key set to `undefined`
      // survive JSON differently in general, so the component must not rely on that coincidence.
      expect(Object.keys(simulateMock.mock.calls[0][1])).not.toContain('versionId');
    });

    it('sends versionId when the operator explicitly chose one', async () => {
      const user = userEvent.setup();
      renderPanel({ versions: [version({ id: VERSION_DRAFT, status: 'DRAFT' })] });

      await user.selectOptions(screen.getByTestId('hr-sim-version'), VERSION_DRAFT);
      await user.click(screen.getByTestId('hr-sim-submit'));

      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));
      expect(simulateMock.mock.calls[0][1].versionId).toBe(VERSION_DRAFT);
    });

    it('omits the subject entirely when no employee was named', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByTestId('hr-sim-submit'));
      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));

      const body = simulateMock.mock.calls[0][1];
      expect(body).not.toHaveProperty('subject');
    });

    it('forwards the optional members that WERE stated', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.type(screen.getByTestId('hr-sim-employment-type'), 'FULL_TIME');
      await user.type(screen.getByTestId('hr-sim-employee'), 'emp-9');
      await user.click(screen.getByTestId('hr-sim-submit'));

      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));

      const body = simulateMock.mock.calls[0][1];
      expect(body.context).toEqual({ leaveTypeId: 'type-annual', employmentType: 'FULL_TIME' });
      expect(body.subject).toEqual({ employeeId: 'emp-9' });
    });

    it('submits NOTHING while a request is already in flight (no duplicate submission)', async () => {
      const user = userEvent.setup();
      let release: (value: HrLeavePolicySimulationResult) => void = () => {};
      simulateMock.mockImplementation(
        () =>
          new Promise<HrLeavePolicySimulationResult>((resolve) => {
            release = resolve;
          })
      );

      renderPanel();

      const button = screen.getByTestId('hr-sim-submit');
      await user.click(button);
      await waitFor(() => expect(button).toBeDisabled());

      // A disabled attribute alone is not a guarantee against an already-queued event, so the click
      // is attempted again and the CALL COUNT is what is asserted.
      await user.click(button);
      expect(simulateMock).toHaveBeenCalledTimes(1);

      release(result());
      await waitFor(() => expect(button).not.toBeDisabled());
    });
  });

  describe('the result it renders', () => {
    it('renders the banner the SERVER sent, character for character (§14.5)', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByTestId('hr-sim-submit'));

      const banner = await screen.findByTestId('hr-sim-banner');
      expect(banner).toHaveTextContent('SIMULATION — NO DATA CHANGED');
      expect(banner).toHaveAttribute('data-banner-from-server', 'YES');
    });

    it('does NOT invent the banner when a response arrives without one (§14.5)', async () => {
      const user = userEvent.setup();
      // A response whose guarantee is absent must not be labelled as though it had made one.
      simulateMock.mockResolvedValue(
        result({
          simulation: { ...result().simulation, banner: '' },
        })
      );

      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      const banner = await screen.findByTestId('hr-sim-banner');
      expect(banner).toHaveAttribute('data-banner-from-server', 'NO');
      expect(banner).not.toHaveTextContent('SIMULATION — NO DATA CHANGED');
    });

    it('renders the mode and the version identity from the response', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      expect(await screen.findByTestId('hr-sim-mode')).toHaveTextContent('SIMULATION');
      expect(screen.getByTestId('hr-sim-version-label')).toHaveTextContent('v1');
      // The state arrives as a code and is rendered through the shared label, so a screen cannot
      // invent its own vocabulary for the four lifecycle states (§27.7).
      expect(screen.getByTestId('hr-sim-status-PUBLISHED')).toHaveTextContent(
        hrLeavePolicyVersionStatusLabel('PUBLISHED')
      );
    });

    it('renders a WITHHELD field as withheld rather than as absent-by-nature (§27.2)', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      // The ordering basis is null at this surface's level, so the panel states the narrowing rather
      // than printing nothing — an empty cell would assert the engine had no basis.
      expect(await screen.findByTestId('hr-sim-ordering-basis-withheld')).toBeInTheDocument();
      expect(screen.queryByTestId('hr-sim-ordering-basis')).not.toBeInTheDocument();
    });

    it('renders the observed counts the server returned, and computes none itself', async () => {
      const user = userEvent.setup();
      simulateMock.mockResolvedValue(
        result({
          explanation: {
            ...result().explanation,
            observedCounts: [{ over: 'leaveRequestsInWindow', count: 3 }],
          },
        })
      );

      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      const list = await screen.findByTestId('hr-sim-observed-counts');
      expect(within(list).getByTestId('hr-sim-count-leaveRequestsInWindow')).toHaveTextContent('3');
    });

    it('renders a limit refusal with its grounds and the server observed count (§16.7)', async () => {
      const user = userEvent.setup();
      simulateMock.mockResolvedValue(
        result({
          limits: [
            {
              limitRef: 'limit-annual-3d',
              leaveTypeId: 'type-annual',
              employmentType: null,
              countingBasis: 'DAY_COUNT',
              maximum: 3,
              windowStart: '2026-01-01',
              windowEnd: '2026-12-31',
              observed: 4,
              exceeded: true,
            },
          ],
        })
      );

      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      const refusals = await screen.findByTestId('hr-sim-refusals');
      // The basis travels WITH the maximum, because "3" is unreadable without knowing its unit (§32.3).
      expect(refusals).toHaveTextContent(hrLeaveLimitCountingBasisLabel('DAY_COUNT'));
      expect(
        within(refusals).getByTestId('hr-sim-refusal-observed-limit-annual-3d')
      ).toHaveTextContent('4');
    });

    it('marks an ARCHIVED simulation as historical and never as governing (§14.5)', async () => {
      const user = userEvent.setup();
      simulateMock.mockResolvedValue(
        result({ status: 'ARCHIVED', historical: true, versionLabel: 'v0' })
      );

      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      expect(await screen.findByTestId('hr-sim-historical')).toBeInTheDocument();
      expect(screen.getByTestId('hr-sim-historical-note')).toHaveTextContent(
        'نشان نمی‌دهد چه چیزی بر تصمیم‌های جدید حاکم است'
      );
    });

    it('renders a validation failure as the refusal it is, not as a silent result (§14.6)', async () => {
      const user = userEvent.setup();
      simulateMock.mockResolvedValue(
        result({
          simulation: {
            ...result().simulation,
            validation: { valid: false, issues: [], conflicts: [] },
          },
        })
      );

      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      expect(await screen.findByTestId('hr-sim-validation-invalid')).toBeInTheDocument();
      expect(screen.queryByTestId('hr-sim-validation-valid')).not.toBeInTheDocument();
    });

    it('surfaces a transport failure as an alert rather than as a blank panel', async () => {
      const user = userEvent.setup();
      simulateMock.mockRejectedValue(new Error('شبیه‌سازی در دسترس نیست.'));

      renderPanel();
      await user.click(screen.getByTestId('hr-sim-submit'));

      expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent(
        'شبیه‌سازی در دسترس نیست.'
      );
      expect(screen.queryByTestId('hr-sim-result')).not.toBeInTheDocument();
    });
  });

  describe('the read-only guarantee (§14.1, §26.4)', () => {
    /**
     * PROVEN BY ABSENCE OF CAPABILITY, THEN BY ABSENCE OF CALLS.
     *
     * A component cannot mutate if it holds no way to: the panel imports exactly one client function
     * and it is the simulation read. So the first assertion is on the SHIPPED SOURCE — a future edit
     * that reached for a write client would fail here rather than in production.
     */
    it('imports no write client at all, read from the shipped source', () => {
      const source = readFileSync(
        join(process.cwd(), 'src/components/hr/LeavePolicySimulationPanel.tsx'),
        'utf8'
      );

      for (const forbidden of [
        'publishLeavePolicyVersion',
        'archiveLeavePolicyVersion',
        'createLeavePolicyVersion',
        'validateLeavePolicyVersion',
        'updateLeavePolicyVersion',
        'createHrLeaveRequest',
        'cancelHrLeaveRequest',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    });

    it('calls ONLY the simulation read — no mutation endpoint is reachable', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByTestId('hr-sim-submit'));
      await waitFor(() => expect(simulateMock).toHaveBeenCalledTimes(1));

      // Exactly one call, and it was the simulation. The absence of any other client call is the
      // claim; the count makes it falsifiable rather than merely stated.
      expect(simulateMock).toHaveBeenCalledTimes(1);
    });

    it('offers no control that submits an approval, a rejection, or a policy change', () => {
      renderPanel();

      // No button label may read as a business decision (§14.5): simulation is informational.
      for (const label of ['تأیید', 'رد', 'اعمال', 'انتشار', 'بایگانی']) {
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
      }
    });

    it('exposes NO evidence-level selector, so the client cannot choose its own disclosure', () => {
      renderPanel();

      // §27.2's fix was to make the level server-owned. A selector would reintroduce the defect.
      expect(screen.queryByTestId('hr-sim-level')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hr-sim-evidence-level')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/سطح شواهد|سطح دسترسی/)).not.toBeInTheDocument();
    });
  });
});
