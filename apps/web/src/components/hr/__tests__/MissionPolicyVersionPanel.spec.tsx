import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MissionPolicyVersionPanel, conditionKindCounts } from '../MissionPolicyVersionPanel';
import { CoreApiError } from '@/lib/core-http';
import {
  archiveMissionPolicyVersion,
  createMissionPolicyVersion,
  fetchMissionPolicyVersions,
  publishMissionPolicyVersion,
  validateMissionPolicyVersion,
  type CreateMissionPolicyVersionInput,
} from '@/lib/hr-mission-api';
import type { MissionRuleConditionNode } from '@/lib/mission-rule-set-version';
import { executableSource } from './source-scan';
import {
  missionPolicyVersion,
  missionRuleActions,
  missionRuleSetVersion,
  nestedMissionRuleCondition,
  page,
} from './hr-fixtures';

/**
 * Phase 55 Step 8D-P: DOMAIN 3 — the Mission rule-set version surface.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH ONE IS WORTH A TEST
 * ----------------------------------------------------
 * The wire contract is frozen by `hr-mission-api.spec.ts`; the value here is the set of claims only THIS
 * component can get wrong:
 *
 *   1. THE SERVER'S `actions` DECIDE THE BUTTONS. Every transition button is asserted to appear exactly
 *      when its flag is set — including a case where the flags CONTRADICT the status, which a client that
 *      derived the matrix from `status` would fail.
 *   2. NOTHING IS DERIVED FROM `status`. The same claim from the other side: the rendered status is the
 *      stored one and no transition set is computed locally.
 *   3. THE AUTHORED DOCUMENT IS THE ENGINE'S DOCUMENT. The create form's posted body is asserted
 *      field-by-field against the request DTO, including the operand SHAPES the operator choice produces
 *      (no operand for `isEmpty`, an array for `in`, a two-element tuple for `dateBetween`) and the
 *      ABSENCE of members no request carries (`supersedes`, `effectiveFrom`, `effectiveTo`).
 *   4. THE STORED DOCUMENT IS RENDERED IN FULL. Every one of the five node kinds and all seven action
 *      types are asserted to reach the DOM, including the nested ones.
 *   5. THE LIST IS RE-READ, NEVER PATCHED. After a successful create and after a successful transition
 *      the read is re-issued — asserted as a second call to the real client function.
 *   6. NO REQUEST IS ISSUED WITHOUT THE GRANT.
 *
 * THE CLIENT IS MOCKED, THE FUNCTIONS ARE REAL. `@/lib/hr-mission-api` is mocked so no network is touched,
 * but every assertion about WHAT was called is made on the production functions, and every assertion about
 * a body is made on the object that was actually handed to `createMissionPolicyVersion`.
 *
 * THE FORM IS DRIVEN BY THE PANEL'S OWN `data-testid`s, READ OFF THE SHIPPED FILE. A spec that invented
 * its own names would assert against controls no operator can reach; these are the names the component
 * actually renders, down to the compound prefixes (`…-condition-leaf-field`).
 */

jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchMissionPolicyVersions: jest.fn(),
  createMissionPolicyVersion: jest.fn(),
  validateMissionPolicyVersion: jest.fn(),
  publishMissionPolicyVersion: jest.fn(),
  archiveMissionPolicyVersion: jest.fn(),
}));

const versionsMock = fetchMissionPolicyVersions as jest.MockedFunction<
  typeof fetchMissionPolicyVersions
>;
const createMock = createMissionPolicyVersion as jest.MockedFunction<
  typeof createMissionPolicyVersion
>;
const validateMock = validateMissionPolicyVersion as jest.MockedFunction<
  typeof validateMissionPolicyVersion
>;
const publishMock = publishMissionPolicyVersion as jest.MockedFunction<
  typeof publishMissionPolicyVersion
>;
const archiveMock = archiveMissionPolicyVersion as jest.MockedFunction<
  typeof archiveMissionPolicyVersion
>;

const PANEL_SOURCE = executableSource('src/components/hr/MissionPolicyVersionPanel.tsx');

/**
 * Waits for the loaded list to settle.
 *
 * The list is the panel's own `data-testid`, so this waits on the surface the operator sees rather than on
 * a class name or a timer — and a panel that stopped rendering its list would fail here instead of making
 * every subsequent assertion read a blank page.
 */
async function waitForRows(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('hr-mission-policy-version-list')).toBeInTheDocument()
  );
}

/**
 * Authors ONE rule through the form, using the SHARED fixtures' own vocabularies, so a body asserted below
 * describes a document the server's validator would accept rather than a shape invented in a spec.
 *
 * IT IS MODULE SCOPE, NOT A PER-DESCRIBE HELPER: the create-form specs and the action-editor specs both
 * drive the same form, and two copies of this sequence would drift until one of them stepped through a
 * form that no longer exists.
 */
async function authorOneRuleWith(
  conditionKind: 'all' | 'any' | 'not' | 'field' | 'count',
  configure: () => Promise<void>
): Promise<void> {
  await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
  // The card appears only once the toggle is open; waiting for it keeps every `getByTestId` below from
  // running against a form that has not rendered yet.
  await screen.findByTestId('hr-mission-policy-create');

  await userEvent.type(screen.getByTestId('hr-mission-policy-new-version'), '7');
  await userEvent.type(screen.getByTestId('hr-mission-policy-new-label'), 'خط‌مشی آزمون');

  await userEvent.type(screen.getByTestId('hr-mission-policy-field-draft-0-name'), 'durationMode');

  await userEvent.type(screen.getByTestId('hr-mission-policy-rule-draft-0-name'), 'قاعدهٔ آزمون');

  await userEvent.selectOptions(
    screen.getByTestId('hr-mission-policy-rule-draft-0-condition-kind'),
    conditionKind
  );
  // The kind is chosen BEFORE the caller's own edits: the child boxes exist only once the kind declares
  // them, so a spec that typed into `…-condition-leaf-…` under the default `all` would be reaching
  // for a control the operator is not offered either.
  await configure();

  await userEvent.click(screen.getByTestId('hr-mission-policy-new-submit'));
}

beforeEach(() => {
  jest.clearAllMocks();
  versionsMock.mockResolvedValue(page([missionPolicyVersion()]));
  createMock.mockResolvedValue(missionPolicyVersion());
  validateMock.mockResolvedValue(missionPolicyVersion());
  publishMock.mockResolvedValue(missionPolicyVersion());
  archiveMock.mockResolvedValue(missionPolicyVersion());
});

describe('the grant, and the read it covers', () => {
  it('issues NO request when the actor cannot write', async () => {
    render(<MissionPolicyVersionPanel canWrite={false} />);

    expect(await screen.findByTestId('hr-mission-policy-versions-forbidden')).toBeInTheDocument();
    expect(versionsMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reads the versions through the real client when the grant is held', async () => {
    render(<MissionPolicyVersionPanel canWrite />);

    await waitForRows();
    expect(versionsMock).toHaveBeenCalledTimes(1);
  });

  it('states an empty list as the absence of configuration, not as a failure', async () => {
    versionsMock.mockResolvedValue(page([]));

    render(<MissionPolicyVersionPanel canWrite />);

    await waitFor(() => expect(versionsMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/هیچ نسخه‌ای/)).toBeInTheDocument();
  });
});

describe('the server’s flags decide the buttons', () => {
  it('renders the transition the SERVER set, and only that one', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          status: 'DRAFT',
          actions: { canValidate: true, canPublish: false, canArchive: false },
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    expect(screen.getByTestId('hr-mission-policy-version-canValidate-1')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-policy-version-canPublish-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-policy-version-canArchive-1')).not.toBeInTheDocument();
  });

  it('honours the flags even when they CONTRADICT the stored status', async () => {
    // A `DRAFT` row the server says cannot be validated: a client that inferred the matrix from `status`
    // would render Validate here and be wrong about its own server.
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          status: 'DRAFT',
          actions: { canValidate: false, canPublish: false, canArchive: true },
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    expect(screen.getByTestId('hr-mission-policy-version-canArchive-1')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-policy-version-canValidate-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-policy-version-canPublish-1')).not.toBeInTheDocument();
    // ...and the status it carries is STILL the stored one. Nothing was rewritten to agree with the flags.
    expect(screen.getByTestId('hr-mission-policy-version-status-1')).toHaveTextContent('پیش‌نویس');
  });

  it('says a version with no legal transition has none, rather than saying nothing', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          status: 'ARCHIVED',
          actions: { canValidate: false, canPublish: false, canArchive: false },
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    expect(screen.getByTestId('hr-mission-policy-version-actions-1')).toHaveTextContent(
      'گذار بعدی برای این نسخه مجاز نیست.'
    );
    expect(screen.queryByTestId('hr-mission-policy-version-canValidate-1')).not.toBeInTheDocument();
  });

  it('never reads status to decide a transition — no status matrix exists in the source', () => {
    // The panel's DOCUMENTED discipline, asserted as an absence: it does not branch on `status` at all.
    expect(PANEL_SOURCE).not.toMatch(/status\s*===\s*['"]DRAFT['"]/);
    expect(PANEL_SOURCE).not.toMatch(/status\s*===\s*['"]VALIDATED['"]/);
    expect(PANEL_SOURCE).not.toMatch(/status\s*===\s*['"]PUBLISHED['"]/);
    // The flag binding IS the predicate, by name.
    expect(PANEL_SOURCE).toContain('version.actions[entry.flag]');
  });
});

describe('each transition calls exactly ITS OWN client function, then re-reads', () => {
  it('calls validate for a row the server marks canValidate', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-version-canValidate-1'));

    await waitFor(() => expect(validateMock).toHaveBeenCalledTimes(1));
    // The ROW's own id, and not the other two functions.
    expect(validateMock.mock.calls[0][0]).toBe('pv-1');
    expect(publishMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
    // The list is RE-READ: the row's new state is the SERVER's answer.
    await waitFor(() => expect(versionsMock).toHaveBeenCalledTimes(2));
  });

  it('calls publish for a row the server marks canPublish', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          status: 'VALIDATED',
          actions: { canValidate: false, canPublish: true, canArchive: false },
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-version-canPublish-1'));

    await waitFor(() => expect(publishMock).toHaveBeenCalledWith('pv-1'));
    expect(validateMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
    await waitFor(() => expect(versionsMock).toHaveBeenCalledTimes(2));
  });

  it('calls archive for a row the server marks canArchive', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          status: 'PUBLISHED',
          actions: { canValidate: false, canPublish: false, canArchive: true },
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-version-canArchive-1'));

    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('pv-1'));
    expect(validateMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    await waitFor(() => expect(versionsMock).toHaveBeenCalledTimes(2));
  });

  /** `CoreApiError` takes a message and a status; the panel reads the MESSAGE it was given. */
  it('reports a refused transition with the API’s own message, and re-reads nothing extra', async () => {
    validateMock.mockRejectedValue(new CoreApiError('گذار مجاز نیست', 409));

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-version-canValidate-1'));

    expect(await screen.findByText('گذار مجاز نیست')).toBeInTheDocument();
    // A REFUSED write changes nothing, so the list must not be re-read as though it had.
    await waitFor(() => expect(validateMock).toHaveBeenCalledTimes(1));
    expect(versionsMock).toHaveBeenCalledTimes(1);
  });
});

describe('the authored document is the package’s own form and body', () => {
  /**
   * Authors ONE rule through the form, then submits it.
   *
   * EVERY FIELD THIS FORM CANNOT SUBMIT BLANK IS FILLED HERE, so a spec below can vary the ONE thing it is
   * about — an operand shape, a node kind, an action type — and still post a document. The values come from
   * the SHARED fixtures' vocabularies (`durationMode`, `locationType`, `engagementType`), which is what makes
   * the asserted bodies documents the server's validator would accept rather than shapes invented here.
   */
  async function authorOneRuleWith(
    conditionKind: 'all' | 'any' | 'not' | 'field' | 'count',
    configure: () => Promise<void>
  ): Promise<void> {
    if (screen.queryByTestId('hr-mission-policy-rule-draft-0') === null) {
      await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    }

    await userEvent.type(screen.getByTestId('hr-mission-policy-new-version'), '7');
    await userEvent.type(screen.getByTestId('hr-mission-policy-new-label'), 'خط‌مشی آزمون');
    await userEvent.type(
      screen.getByTestId('hr-mission-policy-field-draft-0-name'),
      'durationMode'
    );

    await userEvent.type(screen.getByTestId('hr-mission-policy-rule-draft-0-name'), 'قاعدهٔ آزمون');
    await userEvent.selectOptions(
      screen.getByTestId('hr-mission-policy-rule-draft-0-condition-kind'),
      conditionKind
    );

    await configure();

    await userEvent.click(screen.getByTestId('hr-mission-policy-new-submit'));
  }

  /**
   * Selects an action's TYPE, which is the ONLY way its parameter boxes exist.
   *
   * The boxes are rendered as a FUNCTION of the chosen type — `AUTO_APPROVE` declares no parameter at all
   * — so a spec that typed into `…-approver-ref` without choosing the type first would be asserting about
   * a box the operator is not offered. That is the point of routing every parameter edit through here.
   */
  async function openActionParameters(
    ruleIndex: number,
    actionIndex: number,
    type: string
  ): Promise<void> {
    const testId = `hr-mission-policy-rule-draft-${ruleIndex}-action-${actionIndex}-type`;
    await userEvent.selectOptions(await screen.findByTestId(testId), type);
  }

  it('posts the four DTO fields, a valid document, and NO stored-only member', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await authorOneRuleWith('field', async () => {
      // The fact's TYPE is chosen, not assumed: `string` is the form's default and an `enum` is the one
      // pairing that carries values — so this spec exercises the DECLARATION as well as the rule.
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-field-draft-0-type'),
        'enum'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-field-draft-0-enum-values'),
        'HOURLY, DAILY'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-field'),
        'durationMode'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-op'),
        'equals'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-value'),
        'DAILY'
      );
      await openActionParameters(0, 0, 'REQUIRED_APPROVAL_STEP');
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-approver-ref'),
        'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40'
      );
    });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    const input: CreateMissionPolicyVersionInput = createMock.mock.calls[0][0];

    // (a) the DTO's own four fields
    expect(input.version).toBe(7);
    expect(input.label).toBe('خط‌مشی آزمون');
    expect(input.ruleSetId).toBe('hr.mission.approval');

    // (b) the document is the Rule Engine's own shape, at the one schema version this engine implements
    expect(input.configuration.schemaVersion).toBe(1);
    expect(input.configuration.ruleSetId).toBe('hr.mission.approval');
    // `configuration.version` is a STRING (the set version), unlike the DTO's numeric `version`.
    expect(input.configuration.version).toBe('7');
    // The row is created as a DRAFT by the server; the document mirrors that constant rather than offering
    // a choice the request has no field for.
    expect(input.configuration.status).toBe('DRAFT');

    // (c) the declared facts — the `enum` type with its values SPLIT from the one comma-separated box
    expect(input.configuration.fields).toEqual([
      { name: 'durationMode', type: 'enum', enumValues: ['HOURLY', 'DAILY'] },
    ]);

    // (d) the rule, with the OPERATOR-SHAPED condition and the ordered actions
    expect(input.configuration.rules).toHaveLength(1);
    const rule = input.configuration.rules[0];
    expect(rule.id).toBe('mission-rule-1');
    // `rules[].version` echoes the row version, because the request carries no separate rule revision.
    expect(rule.version).toBe('7');
    expect(rule.priority).toBe(10);
    expect(rule.condition).toEqual({ field: 'durationMode', op: 'equals', value: 'DAILY' });
    expect(rule.actions).toEqual([
      {
        type: 'REQUIRED_APPROVAL_STEP',
        stepOrder: 1,
        approverRuleRef: 'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40',
      },
    ]);

    // (e) the DTO's own four fields, and no fifth
    expect(Object.keys(input).sort()).toEqual(['configuration', 'label', 'ruleSetId', 'version']);

    // (f) NOTHING the request cannot carry — these are STORED document members only
    expect(input.configuration).not.toHaveProperty('supersedes');
    expect(input.configuration).not.toHaveProperty('effectiveFrom');
    expect(input.configuration).not.toHaveProperty('effectiveTo');
  });

  it('builds a `dateBetween` operand as the two-element tuple the model declares', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await authorOneRuleWith('field', async () => {
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-field'),
        'missionStartDay'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-op'),
        'dateBetween'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-value'),
        '2026-01-01, 2026-12-31'
      );
      // The ACTION is completed too, because the rule is not submittable without one and the operand is
      // what this spec is about — a blank action would make it a spec about the action form instead.
      await openActionParameters(0, 0, 'REQUIRED_APPROVAL_STEP');
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-approver-ref'),
        'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40'
      );
    });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    // The tuple is `readonly [from, to]`; the order is the operator's, taken verbatim from the one box.
    expect(createMock.mock.calls[0][0].configuration.rules[0].condition).toEqual({
      field: 'missionStartDay',
      op: 'dateBetween',
      value: ['2026-01-01', '2026-12-31'],
    });
  });

  it('refuses to submit a `dateBetween` with one date, and says so in the form', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await authorOneRuleWith('field', async () => {
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-field'),
        'missionStartDay'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-op'),
        'dateBetween'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-value'),
        '2026-01-01'
      );
    });

    // THE ROW IS NOT SENT: the form's own check names the missing second date...
    expect(await screen.findByTestId('hr-mission-policy-rule-draft-0-problem')).toHaveTextContent(
      'dateBetween'
    );
    // ...and the request does not go out at all, because a one-entry tuple is a document the server refuses.
    //
    // THE CLAIM IS MADE AFTER THE SUBMIT HAS SETTLED. Read straight after an un-awaited click it would
    // pass while that click's own promise was still pending — i.e. it could not fail even if the form DID
    // post. Waiting for the settled state first is what makes the absence meaningful.
    await waitFor(() => {
      expect(screen.getByTestId('hr-mission-policy-rule-draft-0-problem')).toBeInTheDocument();
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('offers the allowed-values box ONLY for an `enum` fact, which is the one pairing accepted', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    await screen.findByTestId('hr-mission-policy-create');

    // `string` is the default, and the box is absent — an operator cannot type values the validator
    // would then refuse for a non-`enum` fact.
    expect(
      screen.queryByTestId('hr-mission-policy-field-draft-0-enum-values')
    ).not.toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByTestId('hr-mission-policy-field-draft-0-type'),
      'enum'
    );

    expect(screen.getByTestId('hr-mission-policy-field-draft-0-enum-values')).toBeInTheDocument();
  });

  it('splits an enum fact’s values into the array the declaration requires', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await authorOneRuleWith('field', async () => {
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-field-draft-0-type'),
        'enum'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-field-draft-0-enum-values'),
        'HOURLY, DAILY'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-field'),
        'durationMode'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-value'),
        'DAILY'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-approver-ref'),
        'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40'
      );
    });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0].configuration.fields).toEqual([
      { name: 'durationMode', type: 'enum', enumValues: ['HOURLY', 'DAILY'] },
    ]);
  });
});

describe('the create form opens, closes, and refuses an incomplete row', () => {
  it('shows the form only once it is asked for, and hides it again', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    // The form is NOT open on load: an operator reading versions is not authoring one.
    expect(screen.queryByTestId('hr-mission-policy-create')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    expect(await screen.findByTestId('hr-mission-policy-create')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('hr-mission-policy-new-cancel'));
    expect(screen.queryByTestId('hr-mission-policy-create')).not.toBeInTheDocument();
  });

  it('posts NOTHING while a required box is blank, and says which one', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    await screen.findByTestId('hr-mission-policy-create');

    await userEvent.click(screen.getByTestId('hr-mission-policy-new-submit'));

    // The version box is blank: the form refuses to submit and NAMES the box, rather than posting a
    // document with a `NaN` version that the server would have to reject.
    expect(await screen.findByTestId('hr-mission-policy-new-problem')).toBeInTheDocument();
    // ...and the absence of a request is asserted once the form has SETTLED, so the claim is about the
    // refused submit rather than about a click whose promise had not run yet.
    await waitFor(() => {
      expect(screen.getByTestId('hr-mission-policy-new-problem')).toBeInTheDocument();
      expect(createMock).not.toHaveBeenCalled();
    });
  });
});

describe('the condition editor offers the ENGINE’s node kinds, not an invented list', () => {
  it('offers all five kinds, spelled with the engine’s own tokens', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    const select = await screen.findByTestId('hr-mission-policy-rule-draft-0-condition-kind');

    // The five members of `MissionRuleConditionNode`, and no sixth: the union is closed on the server too.
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'all',
      'any',
      'not',
      'field',
      'count',
    ]);
  });

  it('renders `not` as EXACTLY one child, with no add control, because the model takes one', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    await userEvent.selectOptions(
      await screen.findByTestId('hr-mission-policy-rule-draft-0-condition-kind'),
      'not'
    );

    expect(
      screen.getByTestId('hr-mission-policy-rule-draft-0-condition-not-field')
    ).toBeInTheDocument();
    // `all`/`any` own the add button; a `not` node that offered one would let an operator author a
    // document the union has no member for. Neither list prefix — the `not` child's or `all`'s own —
    // has an add control here.
    expect(
      screen.queryByTestId('hr-mission-policy-rule-draft-0-condition-not-add')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('hr-mission-policy-rule-draft-0-condition-member-add')
    ).not.toBeInTheDocument();
  });

  it('offers a LIST with add/remove for `all`, whose members are a collection', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    await screen.findByTestId('hr-mission-policy-rule-draft-0-condition-kind');

    // The default kind is `all`, and it owns the add control the `not` node must not have.
    expect(
      screen.getByTestId('hr-mission-policy-rule-draft-0-condition-member-add')
    ).toBeInTheDocument();
  });
});

describe('the fact catalogue offers the engine’s scalar types', () => {
  // The suggestion is the FROZEN action-type list, so the form states it in order and offers no eighth.
  it('offers ONLY the scalar fact types — `collection` is a node kind, not a scalar', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    const select = await screen.findByTestId('hr-mission-policy-field-draft-0-type');

    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'string',
      'number',
      'boolean',
      'date',
      'enum',
    ]);
    expect(select).not.toHaveTextContent('collection');
  });
});

describe('the action editor is a function of the action TYPE', () => {
  it('offers all seven frozen types, with no eighth', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    const select = await screen.findByTestId('hr-mission-policy-rule-draft-0-action-0-type');

    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'REQUIRED_APPROVAL_STEP',
      'AUTO_APPROVE',
      'AUTO_REJECT',
      'LIMIT_REFUSAL',
      'STEP_ACTIVATION',
      'APPROVER_RESOLUTION',
      'NOTIFY',
    ]);
  });

  it('renders NO parameter box for `AUTO_APPROVE`, which declares none', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await userEvent.click(screen.getByTestId('hr-mission-policy-create-open'));
    await screen.findByTestId('hr-mission-policy-rule-draft-0-action-0-type');

    await userEvent.selectOptions(
      screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-type'),
      'AUTO_APPROVE'
    );

    const prefix = 'hr-mission-policy-rule-draft-0-action-0';
    expect(screen.queryByTestId(`${prefix}-step-order`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${prefix}-approver-ref`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${prefix}-reason-code`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${prefix}-limit-ref`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${prefix}-template-ref`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${prefix}-recipient-role`)).not.toBeInTheDocument();
  });

  it('builds only `LIMIT_REFUSAL`’s own five parameters, and from its OWN boxes', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await authorOneRuleWith('field', async () => {
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-field'),
        'durationMode'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-value'),
        'DAILY'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-type'),
        'AUTO_APPROVE'
      );
      // `AUTO_APPROVE` declares nothing, so none of these boxes exists while it is chosen...
      expect(
        screen.queryByTestId('hr-mission-policy-rule-draft-0-action-0-limit-ref')
      ).not.toBeInTheDocument();

      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-type'),
        'LIMIT_REFUSAL'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-limit-ref'),
        'mission-days-per-year'
      );
      await userEvent.clear(screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-maximum'));
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-maximum'),
        '30'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-counting-basis'),
        'DAY_COUNT'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-window-start'),
        '2026-01-01'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-window-end'),
        '2026-12-31'
      );
    });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    // The parameters are built from the boxes of THIS type: a `stepOrder` the draft still carries from the
    // default `REQUIRED_APPROVAL_STEP` must not leak into a `LIMIT_REFUSAL`.
    expect(createMock.mock.calls[0][0].configuration.rules[0].actions).toEqual([
      {
        type: 'LIMIT_REFUSAL',
        limitRef: 'mission-days-per-year',
        countingBasis: 'DAY_COUNT',
        maximum: 30,
        windowStart: '2026-01-01',
        windowEnd: '2026-12-31',
      },
    ]);
  });

  it('builds a `NOTIFY` action as its own two parameters, and nothing else', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    await authorOneRuleWith('field', async () => {
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-field'),
        'durationMode'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-condition-leaf-value'),
        'DAILY'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-type'),
        'NOTIFY'
      );
      await userEvent.type(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-template-ref'),
        'mission-approval-requested'
      );
      await userEvent.selectOptions(
        screen.getByTestId('hr-mission-policy-rule-draft-0-action-0-recipient-role'),
        'MANAGER'
      );
    });

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0].configuration.rules[0].actions).toEqual([
      { type: 'NOTIFY', templateRef: 'mission-approval-requested', recipientRole: 'MANAGER' },
    ]);
  });
});
describe('the STORED document is rendered in full, on demand', () => {
  it('renders nothing until the document is asked for, then the whole document', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();

    expect(screen.queryByTestId('hr-mission-policy-document')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('hr-mission-policy-version-document-toggle-1'));

    const document = await screen.findByTestId('hr-mission-policy-document');
    // The STORED document, not a summary: its own identity members are present.
    expect(within(document).getByText('hr.mission.approval')).toBeInTheDocument();
    expect(within(document).getByText('mission-requires-approval')).toBeInTheDocument();

    // ...and the toggle closes it again.
    await userEvent.click(screen.getByTestId('hr-mission-policy-version-document-toggle-1'));
    expect(screen.queryByTestId('hr-mission-policy-document')).not.toBeInTheDocument();
  });

  it('renders every declared fact with its type, and an enum’s own values', async () => {
    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();
    await userEvent.click(screen.getByTestId('hr-mission-policy-version-document-toggle-1'));
    await screen.findByTestId('hr-mission-policy-document');

    // The fixture declares exactly the three facts the Mission engine is given.
    expect(screen.getByTestId('hr-mission-policy-field-0')).toHaveTextContent('durationMode');
    expect(screen.getByTestId('hr-mission-policy-field-1')).toHaveTextContent('locationType');
    expect(screen.getByTestId('hr-mission-policy-field-2')).toHaveTextContent('engagementType');
    expect(screen.getByTestId('hr-mission-policy-field-type-0')).toHaveTextContent('enum');
    // `enumValues` is printed because it is part of the accepted document.
    expect(screen.getByTestId('hr-mission-policy-field-enum-values-0')).toHaveTextContent(
      'HOURLY | DAILY'
    );
  });

  it('renders EVERY action of the rule, by type, with each one’s OWN parameters', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          configuration: missionRuleSetVersion({
            rules: [
              {
                id: 'mission-requires-approval',
                version: '1',
                name: 'همهٔ هفت اقدام',
                priority: 10,
                condition: { field: 'durationMode', op: 'equals', value: 'DAILY' },
                actions: missionRuleActions(),
              },
            ],
          }),
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();
    await userEvent.click(screen.getByTestId('hr-mission-policy-version-document-toggle-1'));
    await screen.findByTestId('hr-mission-policy-document');

    const actions = screen.getByTestId('hr-mission-policy-rule-actions-0');
    // ALL SEVEN frozen types reach the DOM, in declared order — none is dropped by a missing branch.
    expect(within(actions).getAllByRole('listitem').length).toBe(7);
    for (const type of [
      'REQUIRED_APPROVAL_STEP',
      'AUTO_APPROVE',
      'AUTO_REJECT',
      'LIMIT_REFUSAL',
      'STEP_ACTIVATION',
      'APPROVER_RESOLUTION',
      'NOTIFY',
    ]) {
      expect(within(actions).getByText(type)).toBeInTheDocument();
    }

    // ...and each row carries ITS OWN parameters rather than a common superset.
    const row = (index: number) => screen.getByTestId(`hr-mission-policy-action-${index}`);
    expect(row(0)).toHaveTextContent(
      'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40'
    );
    expect(row(2)).toHaveTextContent('MISSION_LIMIT_EXCEEDED');
    expect(row(3)).toHaveTextContent('mission-days-per-year');
    expect(row(3)).toHaveTextContent('2026-12-31');
    expect(row(5)).toHaveTextContent('PRIMARY');
    expect(row(6)).toHaveTextContent('mission-approval-requested');
    // `AUTO_APPROVE` declares no parameter, and the row SAYS so rather than rendering an empty frame.
    expect(row(1)).toHaveTextContent('بدون پارامتر');
  });

  it('renders a NESTED condition tree without dropping the kinds a top-level look would miss', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          configuration: missionRuleSetVersion({
            rules: [
              {
                id: 'mission-nested',
                version: '1',
                name: 'شرط تودرتو',
                priority: 10,
                condition: nestedMissionRuleCondition(),
                actions: missionRuleActions(),
              },
            ],
          }),
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();
    await userEvent.click(screen.getByTestId('hr-mission-policy-version-document-toggle-1'));
    await screen.findByTestId('hr-mission-policy-document');

    // The root is a `not`, whose child is an `any`, whose second child is an `all` holding a `count`
    // with a `where` clause. A renderer that read only the root would have shown one row.
    expect(screen.getAllByText(/گره نقیض/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/گره هرکدام/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/گره همه/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/شمارش روی یک مجموعه/).length).toBeGreaterThan(0);
    // The deepest clause printed: the `where` inside the `count`, one level further down.
    expect(screen.getAllByText('IN_CITY').length).toBeGreaterThan(0);
  });

  it('renders a stored COLLECTION fact faithfully, `maxSize` and item fields included', async () => {
    versionsMock.mockResolvedValue(
      page([
        missionPolicyVersion({
          configuration: missionRuleSetVersion({
            fields: [
              {
                name: 'missionDays',
                type: 'collection',
                maxSize: 60,
                itemFields: [
                  { name: 'day', type: 'date' },
                  { name: 'locationType', type: 'enum', enumValues: ['IN_CITY', 'OUT_OF_CITY'] },
                ],
              },
            ],
          }),
        }),
      ])
    );

    render(<MissionPolicyVersionPanel canWrite />);
    await waitForRows();
    await userEvent.click(screen.getByTestId('hr-mission-policy-version-document-toggle-1'));
    await screen.findByTestId('hr-mission-policy-document');

    // The form does not AUTHOR a collection, but a stored one is rendered rather than refused. The
    // declared facts ARE the panel's own nested cards, and the `collection` one states its own `maxSize`.
    //
    // THE LOOKUP IS BY THE FACT'S OWN NAME, NOT BY INDEX. `itemFields` recurse through the SAME
    // `MissionPolicyFieldRow` and therefore reuse the SAME `${index}` namespace — so `field-0` matches both
    // the top-level collection and its first item field, and `field-1` matches both the collection's second
    // item field and whatever follows the catalogue. Whatever indexing the panel chose, the NAME is the
    // thing the document declares, so a lookup by text is the claim this spec is actually making.
    const catalogue = screen.getByTestId('hr-mission-policy-fields');
    const collectionFact = within(catalogue)
      .getByText('missionDays')
      .closest('[data-testid^="hr-mission-policy-field-"]') as HTMLElement;
    expect(collectionFact).toHaveTextContent('حداکثر اندازه');
    expect(collectionFact).toHaveTextContent('60');
    // The item fields are a NESTED list INSIDE the collection node, so they are reached from it.
    const itemFields = within(collectionFact).getByTestId('hr-mission-policy-field-item-fields-0');
    expect(itemFields).toHaveTextContent('day');
    expect(itemFields).toHaveTextContent('date');
    // The nested `enum` item prints its OWN values, read off the stored declaration — never re-derived.
    expect(itemFields).toHaveTextContent('IN_CITY | OUT_OF_CITY');
  });
});

describe('the census counts the WHOLE tree by key, and evaluates nothing', () => {
  it('finds every kind in a nested tree, including the ones only reachable by recursion', () => {
    const counts = conditionKindCounts(nestedMissionRuleCondition());

    // root `not` → `any` → `all` → `count`, plus the leaves.
    expect(counts.not).toBe(1);
    expect(counts.any).toBe(1);
    expect(counts.all).toBe(1);
    expect(counts.count).toBe(1);
    // Three leaves: one under `any`, one under `all`, one inside `count.where`.
    expect(counts.field).toBe(3);
  });

  it('counts a `count` node’s `where` clause, which is an OPTIONAL nested child list', () => {
    const withWhere: MissionRuleConditionNode = {
      count: {
        over: 'missionDays',
        where: [{ field: 'locationType', op: 'equals', value: 'IN_CITY' }],
        op: 'greaterThan',
        value: 2,
      },
    };
    const withoutWhere: MissionRuleConditionNode = {
      count: { over: 'missionDays', op: 'greaterThan', value: 2 },
    };

    expect(conditionKindCounts(withWhere).field).toBe(1);
    // An ABSENT `where` is not an empty `where`: nothing is descended into and nothing is invented.
    expect(conditionKindCounts(withoutWhere).field).toBe(0);
    expect(conditionKindCounts(withoutWhere).count).toBe(1);
  });

  it('counts a FLAT tree exactly, so a shallow walk could reproduce it', () => {
    const counts = conditionKindCounts({
      all: [
        { field: 'durationMode', op: 'equals', value: 'DAILY' },
        { field: 'locationType', op: 'in', value: ['IN_CITY'] },
      ],
    });

    expect(counts).toEqual({ all: 1, any: 0, not: 0, field: 2, count: 0 });
  });
});

describe('the shipped source, with comments stripped', () => {
  it('issues NO request of its own — every call goes through the frozen client', () => {
    // A `fetch` here would be a SECOND transport, bypassing the client's headers, tenant and error shape.
    expect(PANEL_SOURCE).not.toContain('fetch(');
    expect(PANEL_SOURCE).not.toContain('axios');
    expect(PANEL_SOURCE).not.toContain('XMLHttpRequest');
  });

  it('never names the tenant, because the tenant is the API’s own', () => {
    // `tenantId` is resolved from the request context on the server; a body carrying one would be a lie.
    expect(PANEL_SOURCE).not.toContain('tenantId');
  });

  it('never offers an UPDATE route, because the backend has none', () => {
    // `mission.controller.ts` exposes GET, POST and the three transitions for a policy version and NO
    // `PATCH` — so an edit control would open a form whose save button could not exist.
    expect(PANEL_SOURCE).not.toMatch(/patchMissionPolicyVersion|updateMissionPolicyVersion/);
  });

  it('keeps the engine’s tokens verbatim rather than translating them away', () => {
    // The closed vocabularies are stated as the ENGINE spells them, so a reader can match the document
    // against the server's own union without a mapping table in between.
    for (const token of [
      'REQUIRED_APPROVAL_STEP',
      'AUTO_APPROVE',
      'AUTO_REJECT',
      'LIMIT_REFUSAL',
      'STEP_ACTIVATION',
      'APPROVER_RESOLUTION',
      'NOTIFY',
    ]) {
      expect(PANEL_SOURCE).toContain(token);
    }
    for (const operator of ['dateBetween', 'isNotEmpty', 'notIn', 'greaterThanOrEqual']) {
      expect(PANEL_SOURCE).toContain(operator);
    }
  });
});
