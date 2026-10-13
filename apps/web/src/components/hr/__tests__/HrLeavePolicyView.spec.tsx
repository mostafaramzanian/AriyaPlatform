import { render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HrLeavePolicyView } from '../HrLeavePolicyView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  fetchLeavePolicy,
  fetchLeavePolicyVersion,
  fetchPublishedLeavePolicyVersion,
  hrLeaveLimitCountingBasisLabel,
  hrLeavePolicyVersionStatusLabel,
  hrLeavePolicyVersionStatusMeaning,
  simulateLeavePolicyVersion,
  type HrLeaveLimit,
  type HrLeavePolicy,
  type HrLeavePolicyVersion,
} from '@/lib/hr-leave-policy-api';

/**
 * Phase 54-I: the PER-POLICY surface (`/admin/hr/leave-policies/[policyId]`).
 *
 * WHAT THESE SPECS ARE FOR. This page composes two reads and the simulation panel, so the claims only
 * it can get wrong are compositional ones:
 *
 *   * that it requires BOTH grants, for different reasons — `hr.leave.read` for the reads, and
 *     `hr.leave.policy` for the configuration authority the surface exists to exercise. A read-only
 *     operator must be refused rather than shown a form whose every submission would 403;
 *   * that the two reads run in PARALLEL rather than as a waterfall (§34), and that a policy with no
 *     PUBLISHED version still renders — a policy being drafted is a normal state, not a page error;
 *   * that the FOCUSED version (the one the governance question resolved) and the PUBLISHED version are
 *     both shown and DE-DUPLICATED when they are the same row, so the selector cannot imply two
 *     choices where there is one;
 *   * that the per-policy surface offers NO lifecycle control, because authoring/publish UI is a
 *     separate decision this phase deliberately did not take.
 *
 * THE CLIENTS ARE STUBBED; THE LABELS AND THE PANEL ARE NOT. `jest.requireActual` keeps the real client
 * and mounts the REAL simulation panel, so the composition under test is the shipped one.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-leave-policy-api', () => ({
  ...jest.requireActual('@/lib/hr-leave-policy-api'),
  fetchLeavePolicy: jest.fn(),
  fetchLeavePolicyVersion: jest.fn(),
  fetchPublishedLeavePolicyVersion: jest.fn(),
  simulateLeavePolicyVersion: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const policyMock = fetchLeavePolicy as jest.MockedFunction<typeof fetchLeavePolicy>;
const versionMock = fetchLeavePolicyVersion as jest.MockedFunction<typeof fetchLeavePolicyVersion>;
const publishedMock = fetchPublishedLeavePolicyVersion as jest.MockedFunction<
  typeof fetchPublishedLeavePolicyVersion
>;
const simulateMock = simulateLeavePolicyVersion as jest.MockedFunction<
  typeof simulateLeavePolicyVersion
>;

const READ = 'hr.leave.read';
const POLICY = 'hr.leave.policy';

const POLICY_ID = 'policy-1';
const PUBLISHED_ID = 'ver-published';
const DRAFT_ID = 'ver-draft';

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

function policy(overrides: Partial<HrLeavePolicy> = {}): HrLeavePolicy {
  return {
    id: POLICY_ID,
    tenantId: 'tenant-54i',
    code: 'LP-1',
    name: 'سیاست مرخصی سالانه',
    ...overrides,
  };
}

function version(overrides: Partial<HrLeavePolicyVersion> = {}): HrLeavePolicyVersion {
  return {
    id: PUBLISHED_ID,
    tenantId: 'tenant-54i',
    policyId: POLICY_ID,
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

function limit(overrides: Partial<HrLeaveLimit> = {}): HrLeaveLimit {
  return {
    id: 'limit-1',
    tenantId: 'tenant-54i',
    policyId: POLICY_ID,
    policyVersionId: PUBLISHED_ID,
    leaveTypeId: 'type-annual',
    employmentType: null,
    maximum: 20,
    countingBasis: 'DAY_COUNT',
    period: 'YEAR',
    jalaliYear: 1405,
    windowStart: '2026-01-01',
    windowEnd: '2026-12-31',
    consumesStates: ['APPROVED'],
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    ...overrides,
  };
}

function renderView(props: Partial<Parameters<typeof HrLeavePolicyView>[0]> = {}) {
  return render(
    <HrLeavePolicyView
      policyId={POLICY_ID}
      leaveTypeId="type-annual"
      focusVersionId={null}
      {...props}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  policyMock.mockResolvedValue(policy());
  publishedMock.mockResolvedValue(version());
  versionMock.mockResolvedValue({ version: version(), limits: [limit()] });
});

describe('the per-policy surface (§27, §30)', () => {
  describe('permission behaviour (§25)', () => {
    it('requires hr.leave.read AND hr.leave.policy, refusing a read-only operator', async () => {
      grants([READ]);
      renderView();

      // The configuration authority is what this surface exercises, so a read-only operator is told
      // plainly rather than shown a form whose submissions would all fail.
      expect(await screen.findByText(/hr\.leave\.policy نیاز دارید/)).toBeInTheDocument();
      // And nothing is read that the refusal makes pointless.
      expect(policyMock).not.toHaveBeenCalled();
    });

    it('refuses without even the read grant', async () => {
      grants([]);
      renderView();

      expect(await screen.findByText(/hr\.leave\.read نیاز دارید/)).toBeInTheDocument();
      expect(policyMock).not.toHaveBeenCalled();
    });

    it('renders the surface when both grants are held', async () => {
      grants([READ, POLICY]);
      renderView();

      expect(await screen.findByTestId('hr-policy-detail')).toHaveTextContent('سیاست مرخصی سالانه');
    });
  });

  describe('the reads it performs', () => {
    it('reads the policy and the published version IN PARALLEL, not as a waterfall (§34)', async () => {
      grants([READ, POLICY]);
      renderView();

      await waitFor(() => expect(policyMock).toHaveBeenCalledWith(POLICY_ID));
      // Both are issued without waiting for each other; neither read gates the other's START.
      expect(publishedMock).toHaveBeenCalledWith(POLICY_ID);
    });

    it('renders a policy with NO published version instead of failing the page', async () => {
      grants([READ, POLICY]);
      // A policy still being drafted has no published version. That is a state, not an error.
      publishedMock.mockRejectedValue(new CoreApiError('not found', 404));

      renderView();

      expect(await screen.findByTestId('hr-policy-detail')).toBeInTheDocument();
      expect(screen.queryByTestId('hr-policy-published-version')).not.toBeInTheDocument();
    });

    it('renders FORBIDDEN when the policy itself is not in this tenant (404)', async () => {
      grants([READ, POLICY]);
      // Cross-tenant access is a 404 by design, so the surface must not confirm the id exists (§24.6).
      policyMock.mockRejectedValue(new CoreApiError('not found', 404));

      renderView();

      expect(await screen.findByText(/در سازمان شما یافت نشد/)).toBeInTheDocument();
    });

    it('renders an error state when the policy read fails for another reason', async () => {
      grants([READ, POLICY]);
      policyMock.mockRejectedValue(new Error('خواندن سیاست ممکن نشد.'));

      renderView();

      expect(await screen.findByText('خواندن سیاست ممکن نشد.')).toBeInTheDocument();
    });

    it('reads NO version for the FOCUS, so a page reached without one makes no version request', async () => {
      grants([READ, POLICY]);
      renderView({ focusVersionId: null });

      await screen.findByTestId('hr-policy-detail');

      /*
        THE PUBLISHED VERSION'S LIMITS ARE READ THROUGH `fetchLeavePolicyVersion` — that is the only read
        that returns limits, and the focused-version branch uses it too. So the claim is not "the client
        is never called": it is that it is called ONLY for the version IN FORCE, never for a focus the
        page was not given. A page that invented a version id to read would fail here.
      */
      const requestedIds = versionMock.mock.calls.map((call) => call[1]);
      expect(requestedIds).toEqual([PUBLISHED_ID]);
      expect(screen.queryByTestId('hr-policy-focus-version')).not.toBeInTheDocument();
    });

    it('reads the NAMED version when one was resolved, and shows it as the version under review', async () => {
      grants([READ, POLICY]);
      versionMock.mockResolvedValue({
        version: version({ id: DRAFT_ID, versionLabel: 'v4-draft', status: 'DRAFT' }),
        limits: [],
      });

      renderView({ focusVersionId: DRAFT_ID });

      await waitFor(() => expect(versionMock).toHaveBeenCalledWith(POLICY_ID, DRAFT_ID));
      expect(await screen.findByTestId('hr-policy-focus-version')).toHaveTextContent('v4-draft');
    });
  });

  describe('the version states it renders (§30.4)', () => {
    it('marks a DRAFT as a configuration state, with its consequence stated', async () => {
      grants([READ, POLICY]);
      versionMock.mockResolvedValue({
        version: version({ id: DRAFT_ID, versionLabel: 'v4-draft', status: 'DRAFT' }),
        limits: [],
      });

      renderView({ focusVersionId: DRAFT_ID });

      expect(await screen.findByTestId('hr-policy-focus-status-DRAFT')).toBeInTheDocument();
      // The meaning travels with the label: a bare state name does not tell an operator what it does.
      expect(screen.getByTestId('hr-policy-focus-meaning')).not.toBeEmptyDOMElement();
    });

    it('marks an ARCHIVED version as historical rather than as in force', async () => {
      grants([READ, POLICY]);
      // No published version, so the archived one is the only version in view.
      publishedMock.mockRejectedValue(new CoreApiError('not found', 404));
      versionMock.mockResolvedValue({
        version: version({ id: 'ver-old', versionLabel: 'v1', status: 'ARCHIVED' }),
        limits: [],
      });

      renderView({ focusVersionId: 'ver-old' });

      expect(await screen.findByTestId('hr-policy-focus-status-ARCHIVED')).toBeInTheDocument();
      // The consequence is stated in the label's own words, so the spec quotes the shared meaning
      // rather than a hand-written approximation that could drift from it (§30.4).
      expect(screen.getByTestId('hr-policy-focus-meaning')).toHaveTextContent(
        hrLeavePolicyVersionStatusMeaning('ARCHIVED')
      );
    });

    it('shows the PUBLISHED version as the one governing new decisions', async () => {
      grants([READ, POLICY]);
      renderView();

      expect(await screen.findByTestId('hr-policy-published-status')).toHaveTextContent(
        hrLeavePolicyVersionStatusLabel('PUBLISHED')
      );
    });
  });

  describe('the simulation panel it composes (§14)', () => {
    it('mounts the REAL simulation panel, pre-filled with the leave type it was reached through', async () => {
      grants([READ, POLICY]);
      renderView();

      const panel = await screen.findByTestId('hr-policy-simulation');
      // The common case must need no typing: the leave type is the one the question was about.
      expect(within(panel).getByTestId('hr-sim-leave-type')).toHaveValue('type-annual');
      // And the panel states its own read-only nature in place (§32.2).
      expect(within(panel).getByTestId('hr-policy-simulation-help')).toHaveTextContent(
        'هیچ داده‌ای را تغییر نمی‌دهد'
      );
    });

    it('offers the CURRENT effective configuration as the default choice, with no version named', async () => {
      grants([READ, POLICY]);
      renderView();

      const select = await screen.findByTestId('hr-sim-version');
      // The empty choice means "the currently effective published version" — the server's own branch.
      expect(screen.getByRole('option', { name: 'نسخه منتشرشده فعلی' })).toBeInTheDocument();
      expect(select).toHaveValue('');
    });

    it('offers the resolved version and the published one, DE-DUPLICATED when they are the same row', async () => {
      grants([READ, POLICY]);
      // The same version answered the question and is in force: one choice, not two.
      versionMock.mockResolvedValue({ version: version(), limits: [limit()] });

      renderView({ focusVersionId: PUBLISHED_ID });

      await screen.findByTestId('hr-policy-detail');
      const select = await screen.findByTestId('hr-sim-version');
      // The default plus exactly ONE version option — a duplicate would imply two distinct choices.
      expect(within(select).getAllByRole('option')).toHaveLength(2);
    });

    it('offers BOTH versions when the resolved one is not the published one', async () => {
      grants([READ, POLICY]);
      versionMock.mockResolvedValue({
        version: version({ id: DRAFT_ID, versionLabel: 'v4-draft', status: 'DRAFT' }),
        limits: [],
      });

      renderView({ focusVersionId: DRAFT_ID });

      await screen.findByTestId('hr-policy-focus-version');
      const select = await screen.findByTestId('hr-sim-version');
      // The default, the draft, and the published version.
      expect(within(select).getAllByRole('option')).toHaveLength(3);
    });

    it('renders each limit with its basis beside the maximum (§32.3)', async () => {
      grants([READ, POLICY]);
      renderView();

      const row = await screen.findByTestId('hr-policy-published-limits-row-limit-1');
      expect(row).toHaveTextContent('20');
      // The unit travels WITH the maximum, quoted from the shared label so it cannot drift (§32.3).
      expect(row).toHaveTextContent(hrLeaveLimitCountingBasisLabel('DAY_COUNT'));
    });
  });

  describe('the lifecycle controls it deliberately does NOT offer (54-I scope)', () => {
    /**
     * THE API SUPPORTS AUTHORING, VALIDATION, PUBLISH, ARCHIVE — AND THIS PHASE DOES NOT EXPOSE THEM.
     *
     * That is a scoping decision, not an oversight: who may move a version through its lifecycle, and
     * what an operator is told when they do, is a product decision with its own audit surface (§25.6,
     * §30.5). 54-I was authorized for integration and simulation, so the absence is asserted here to
     * keep it deliberate rather than to let a future edit add half of it by accident.
     */
    it('offers no publish, archive, validate or create control', async () => {
      grants([READ, POLICY]);
      renderView();

      await screen.findByTestId('hr-policy-detail');

      for (const label of ['انتشار', 'بایگانی', 'اعتبارسنجی', 'ایجاد نسخه', 'ذخیره']) {
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
      }
    });

    it('calls NO lifecycle client, read from the shipped source', () => {
      const source = readFileSync(
        join(process.cwd(), 'src/components/hr/HrLeavePolicyView.tsx'),
        'utf8'
      );

      for (const forbidden of [
        'publishLeavePolicyVersion',
        'archiveLeavePolicyVersion',
        'createLeavePolicyVersion',
        'validateLeavePolicyVersion',
        'updateLeavePolicyVersion',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    });
  });

  describe('tenant isolation (§24)', () => {
    /**
     * THE CLIENT NEVER NAMES A TENANT. Every read here is addressed by POLICY ID ALONE, and the tenant
     * comes from the actor the server resolves. So there is no client-side tenant to forge: a caller
     * holding a foreign policy id is answered by the SERVER's own 404, which this surface renders as
     * "not found in your organisation" without confirming whether the id exists elsewhere (§24.6).
     */
    it('addresses every read by policy id alone — no tenant travels on the wire', async () => {
      grants([READ, POLICY]);
      renderView();

      await waitFor(() => expect(policyMock).toHaveBeenCalledTimes(1));

      // Exactly one argument each: the id. A tenant parameter would be a client-chosen scope.
      expect(policyMock.mock.calls[0]).toEqual([POLICY_ID]);
      expect(publishedMock.mock.calls[0]).toEqual([POLICY_ID]);
      expect(versionMock).toHaveBeenCalledWith(POLICY_ID, expect.any(String));
    });

    it('reports a foreign policy id as not found, without disclosing that it exists elsewhere', async () => {
      grants([READ, POLICY]);
      // The server answers cross-tenant access with the SAME 404 as a genuinely missing id.
      policyMock.mockRejectedValue(new CoreApiError('not found', 404));

      renderView();

      const notice = await screen.findByText(/در سازمان شما یافت نشد/);
      // The wording must not distinguish "does not exist" from "belongs to someone else".
      expect(notice).not.toHaveTextContent(/tenant|سازمان دیگری/);
    });

    it('never sends a client-chosen tenant when simulating', async () => {
      grants([READ, POLICY]);
      simulateMock.mockResolvedValue(undefined as never);

      renderView();
      await screen.findByTestId('hr-policy-simulation');

      // Nothing about this surface's reads or writes carries a tenant the browser selected.
      for (const call of [...policyMock.mock.calls, ...publishedMock.mock.calls]) {
        expect(call).not.toContain('tenant-54i');
      }
    });
  });
});
