import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrLeavePolicyEntryView } from '../HrLeavePolicyEntryView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import { fetchHrLeaveTypes } from '@/lib/hr-api';
import {
  fetchEffectiveLeavePolicy,
  type HrEffectiveLeavePolicy,
  type HrLeavePolicyVersion,
} from '@/lib/hr-leave-policy-api';

/**
 * Phase 54-I: the ENTRY SURFACE (`/admin/hr/leave-policies`).
 *
 * WHAT THESE SPECS ARE FOR. This page exists because the API has no policy directory (§12): an operator
 * enters by asking the GOVERNANCE QUESTION — which policy governs this leave type on this day — and the
 * answer carries the id the per-policy route needs. So the claims only this page can get wrong are:
 *
 *   * that it asks that question rather than fabricating a directory. The spec asserts the ACTUAL call
 *     and, separately, that no list-shaped read is issued — a page that "listed" policies by asking
 *     `effective` about many types would be inventing an artefact the API deliberately lacks;
 *   * that it NAMES NO DAY unless the operator did. The server treats an absent `asOf` as today, and a
 *     blank `asOf=` would be a malformed date rather than a question, so the difference is asserted on
 *     the payload rather than assumed;
 *   * that the two grants are distinguished: `hr.leave.read` gates the reads and `hr.leave.policy`
 *     gates the LINK into configuration. A read-only operator must still get their answer, and must NOT
 *     be offered a link whose destination would 403;
 *   * that an ungoverned day is rendered as such rather than as an error or a blank (§15.8) — a tenant
 *     with no policy for a leave type is a real, reportable state.
 *
 * THE PERMISSION SIGNAL AND THE CLIENTS ARE STUBBED; THE LABELS ARE NOT. `jest.requireActual` keeps the
 * real client module so a label change is a real failure here, while the transport is stubbed because a
 * spec cannot enrol a user or reach a database.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrLeaveTypes: jest.fn(),
}));

jest.mock('@/lib/hr-leave-policy-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-policy-api'),
  fetchEffectiveLeavePolicy: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const typesMock = fetchHrLeaveTypes as jest.MockedFunction<typeof fetchHrLeaveTypes>;
const effectiveMock = fetchEffectiveLeavePolicy as jest.MockedFunction<
  typeof fetchEffectiveLeavePolicy
>;

/** The two grants this surface distinguishes. */
const READ = 'hr.leave.read';
const POLICY = 'hr.leave.policy';

function grants(permissions: string[]) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading: false,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

function version(overrides: Partial<HrLeavePolicyVersion> = {}): HrLeavePolicyVersion {
  return {
    id: 'ver-1',
    tenantId: 'tenant-54i',
    policyId: 'policy-1',
    versionLabel: 'v3',
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

function effective(overrides: Partial<HrEffectiveLeavePolicy> = {}): HrEffectiveLeavePolicy {
  return {
    asOf: '2026-05-01',
    policy: { id: 'policy-1', tenantId: 'tenant-54i', code: 'LP-1', name: 'سیاست مرخصی سالانه' },
    version: version(),
    limits: [],
    undecidableLimits: [],
    historical: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  typesMock.mockResolvedValue({
    items: [
      { id: 'type-annual', tenantId: 'tenant-54i', name: 'سالانه', status: 'ACTIVE' },
    ] as never,
    total: 1,
    page: 1,
    pageSize: 100,
  });
  effectiveMock.mockResolvedValue(effective());
});

describe('the leave-policy entry surface (§12, §15.4, §27)', () => {
  describe('permission behaviour (§25)', () => {
    it('asks the server for the governing policy when the operator may read', async () => {
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      expect(await screen.findByTestId('hr-policy-resolve-submit')).toBeInTheDocument();
      // The catalogue read is the register's own grant; the governance read is the resolution's.
      expect(typesMock).toHaveBeenCalledTimes(1);
    });

    it('shows the FORBIDDEN state and reads nothing without hr.leave.read', async () => {
      grants([]);
      render(<HrLeavePolicyEntryView />);

      // Asserted on the ACCESSIBLE surface, since `CoreStates` exposes roles and text, not testids.
      expect(await screen.findByText(/hr\.leave\.read نیاز دارید/)).toBeInTheDocument();
      // No request that could only 403 is issued: the absence is the claim.
      expect(typesMock).not.toHaveBeenCalled();
    });

    it('answers a READ-ONLY operator, but offers no link into configuration', async () => {
      const user = userEvent.setup();
      grants([READ]);
      render(<HrLeavePolicyEntryView />);

      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));

      // The answer is theirs to see...
      expect(await screen.findByTestId('hr-policy-effective')).toBeInTheDocument();
      // ...but the CONFIGURATION destination is not offered, because it would 403.
      expect(screen.queryByTestId('hr-policy-open')).not.toBeInTheDocument();
      expect(screen.getByTestId('hr-policy-open-denied')).toHaveTextContent('hr.leave.policy');
    });

    it('offers the link into configuration to an operator who holds hr.leave.policy', async () => {
      const user = userEvent.setup();
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));

      const link = await screen.findByTestId('hr-policy-open');
      // The id the RESOLUTION returned is the destination — nothing is hardcoded.
      expect(link).toHaveAttribute('href', '/admin/hr/leave-policies/policy-1');
    });
  });

  describe('the question it asks', () => {
    it('omits asOf when the operator named no day, rather than sending it blank', async () => {
      const user = userEvent.setup();
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));

      await waitFor(() => expect(effectiveMock).toHaveBeenCalledTimes(1));
      // Absent means "today" to the server; `asOf=` would be a malformed date, not a question.
      const query = effectiveMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(query)).not.toContain('asOf');
    });

    it('sends the day when the operator named one', async () => {
      const user = userEvent.setup();
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      await user.type(screen.getByTestId('hr-policy-as-of'), '2026-05-01');
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));

      await waitFor(() => expect(effectiveMock).toHaveBeenCalledTimes(1));
      expect(effectiveMock.mock.calls[0]?.[0]?.asOf).toBe('2026-05-01');
    });

    it('resolves NOTHING on mount — the question is asked deliberately, not per keystroke', async () => {
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      await screen.findByTestId('hr-policy-leave-type');
      // The catalogue is read to populate the selector; the RESOLUTION must wait for the operator.
      expect(effectiveMock).not.toHaveBeenCalled();
    });

    it('never sends a tenant, a policy id or an evidence level', async () => {
      const user = userEvent.setup();
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));
      await waitFor(() => expect(effectiveMock).toHaveBeenCalledTimes(1));

      const query = effectiveMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      for (const forbidden of ['tenantId', 'policyId', 'level', 'evidenceLevel', 'role']) {
        expect(query).not.toHaveProperty(forbidden);
      }
    });
  });

  describe('the states it renders (§14.7, §15.8)', () => {
    /**
     * THESE COMPONENTS CARRY NO `data-testid`, AND THAT IS THE POINT. `CoreStates` renders through ROLES
     * and TEXT — `CoreLoading` is `role="status"` with a screen-reader label, `CoreError` and
     * `CoreForbidden` are Alerts, `CoreEmpty` is a dashed box with a sentence. So each assertion here is
     * on the ACCESSIBLE surface, which is also what a screen-reader user receives; inventing a testid for
     * the spec's convenience would test something the application does not expose.
     */
    it('renders an UNGOVERNED day as a fact, not as an error and not as a blank', async () => {
      const user = userEvent.setup();
      grants([READ, POLICY]);
      // §15.8: a tenant may have stated NO policy for a leave type on a day. That is a real answer.
      effectiveMock.mockResolvedValue(
        effective({ policy: null, version: null, limits: [], undecidableLimits: [] })
      );

      render(<HrLeavePolicyEntryView />);
      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));

      expect(await screen.findByText(/سیاستی ثبت نشده است/)).toBeInTheDocument();
      // It is emphatically NOT an error, and there is no configuration destination to offer.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hr-policy-open')).not.toBeInTheDocument();
    });

    it('renders the empty state before any question is asked', async () => {
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      expect(await screen.findByText(/یک نوع مرخصی و در صورت نیاز یک روز/)).toBeInTheDocument();
    });

    it('renders the LOADING state, announced rather than only drawn', () => {
      grants([READ, POLICY]);
      typesMock.mockImplementation(() => new Promise(() => {}));
      render(<HrLeavePolicyEntryView />);

      // `role="status"` is what makes the wait perceptible without sight of the pulse animation.
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('renders a 403 on the catalogue read as FORBIDDEN, with no retry that could not succeed', async () => {
      grants([READ, POLICY]);
      typesMock.mockRejectedValue(new CoreApiError('forbidden', 403));
      render(<HrLeavePolicyEntryView />);

      // A missing grant is not fixed by trying again, so the retry the error state would offer is
      // withheld and the plain refusal shown instead.
      expect(await screen.findByText(/دسترسی ندارید/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
    });

    it('renders a transport failure as an error state that CAN be retried', async () => {
      grants([READ, POLICY]);
      typesMock.mockRejectedValue(new Error('کاتالوگ در دسترس نیست.'));
      render(<HrLeavePolicyEntryView />);

      expect(await screen.findByText('کاتالوگ در دسترس نیست.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    });

    it('reports a failed RESOLUTION in place, as an alert that is announced', async () => {
      const user = userEvent.setup();
      grants([READ, POLICY]);
      render(<HrLeavePolicyEntryView />);

      await user.selectOptions(await screen.findByTestId('hr-policy-leave-type'), 'type-annual');
      effectiveMock.mockRejectedValue(new Error('بررسی ممکن نشد.'));
      await user.click(screen.getByTestId('hr-policy-resolve-submit'));

      const failure = await screen.findByTestId('hr-policy-resolve-error');
      expect(failure).toHaveTextContent('بررسی ممکن نشد.');
      expect(failure).toHaveAttribute('role', 'alert');
    });
  });
});
