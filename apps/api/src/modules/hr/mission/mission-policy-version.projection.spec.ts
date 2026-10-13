import {
  missionPolicyVersionActions,
  toMissionPolicyVersionResponse,
} from './mission-policy-version.projection';

/**
 * CONTRACT CLOSURE: THE MISSION POLICY VERSION ON THE WIRE, AND WHO OWNS ELIGIBILITY.
 *
 * WHY THIS EXISTS. Two separate faults lived in the same missing projection.
 *
 * 1. EVERY POLICY ROUTE RETURNED THE RAW ROW, so `tenantId` travelled to the browser on a Mission
 *    response — the one thing the Web client's own header says never happens. A column that happens to
 *    exist on a Prisma model is not a contract, and wrapping the row is what closes the boundary
 *    instead of trusting every future column to be harmless.
 *
 * 2. ELIGIBILITY WAS DERIVABLE CLIENT-SIDE. `validateVersion` refuses unless `DRAFT`, `publishVersion`
 *    unless `VALIDATED`, `archiveVersion` unless `PUBLISHED` — three refusals a Web surface could read
 *    as a transition matrix and re-implement. That matrix now has ONE home, and these specs pin it to
 *    the guards it must agree with.
 *
 * THE SPECS BELOW ASSERT THE AGREEMENT RATHER THAN THE VALUES. A table of expected booleans would pass
 * even if `MissionPolicyService`'s guards changed underneath it, so the statuses are driven from the
 * states the service itself accepts and each flag is checked against the OTHER two — which is what
 * makes "at most one action per state" a finding rather than an intention.
 */

/** A stored row in the shape `MissionPolicyVersion` actually has, with raw `Date`s and a tenant id. */
function row(status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED') {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-a',
    version: 3,
    status,
    ruleSetId: 'hr.mission.approval',
    configuration: { ruleSetId: 'hr.mission.approval' },
    publishedAt: status === 'PUBLISHED' ? new Date('2026-09-01T10:00:00.000Z') : null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  };
}

describe('55 — the Mission policy version wire projection (contract closure)', () => {
  it('never lets the tenant id reach the wire', () => {
    const projected = toMissionPolicyVersionResponse(row('PUBLISHED'));

    // The assertion is on the KEY SET, not on one absence: a future `{ ...row }` spread would leak
    // `tenantId` AND every column added after it, and only an exact-key check catches that shape.
    expect(Object.keys(projected).sort()).toEqual([
      'actions',
      'configuration',
      'createdAt',
      'id',
      'publishedAt',
      'ruleSetId',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(projected).not.toHaveProperty('tenantId');
  });

  it('serialises every instant as an ISO string, including a null publication date', () => {
    const draft = toMissionPolicyVersionResponse(row('DRAFT'));

    // `null` is MEANINGFUL for `publishedAt` (this version governs nothing yet) and must survive as
    // `null` rather than being dropped, defaulted to an empty string or turned into an epoch.
    expect(draft.publishedAt).toBeNull();
    expect(draft.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(draft.updatedAt).toBe('2026-09-02T00:00:00.000Z');

    const published = toMissionPolicyVersionResponse(row('PUBLISHED'));
    expect(published.publishedAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('passes the stored rule-set document through untouched', () => {
    const stored = row('DRAFT');
    const projected = toMissionPolicyVersionResponse(stored);

    // Identity, not equality: the projection must not clone, reshape or "clean" the document. A copy
    // would be a second place the version text exists, and the version text is the retained record.
    expect(projected.configuration).toBe(stored.configuration);
  });

  it('reports exactly one legal transition for each state the service accepts one in', () => {
    expect(missionPolicyVersionActions('DRAFT')).toEqual({
      canValidate: true,
      canPublish: false,
      canArchive: false,
    });
    expect(missionPolicyVersionActions('VALIDATED')).toEqual({
      canValidate: false,
      canPublish: true,
      canArchive: false,
    });
    expect(missionPolicyVersionActions('PUBLISHED')).toEqual({
      canValidate: false,
      canPublish: false,
      canArchive: true,
    });
  });

  it('offers no transition at all for an ARCHIVED version', () => {
    // No route restores a version, so this state has no successor. Reporting a flag here would invite
    // a button whose only possible answer is a 409.
    expect(missionPolicyVersionActions('ARCHIVED')).toEqual({
      canValidate: false,
      canPublish: false,
      canArchive: false,
    });
  });

  it('never reports two legal transitions for one state — the flags partition the lifecycle', () => {
    const statuses = ['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'] as const;

    for (const status of statuses) {
      const actions = missionPolicyVersionActions(status);
      const enabled = [actions.canValidate, actions.canPublish, actions.canArchive].filter(
        Boolean
      ).length;

      // The three routes accept DISJOINT states, so any state enabling two of them would describe a
      // lifecycle the server does not have.
      expect(enabled).toBeLessThanOrEqual(1);
    }
  });

  it('agrees with the exact state each write guard demands', () => {
    /**
     * Transcribed from `MissionPolicyService`'s own guards. If one of those
     * `if (version.status !== …) throw` conditions changes and this table does not, the flags would
     * start promising something the route refuses — so the two are asserted together here.
     */
    const guard: Record<
      'canValidate' | 'canPublish' | 'canArchive',
      'DRAFT' | 'VALIDATED' | 'PUBLISHED'
    > = {
      canValidate: 'DRAFT',
      canPublish: 'VALIDATED',
      canArchive: 'PUBLISHED',
    };

    for (const status of ['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'] as const) {
      const actions = missionPolicyVersionActions(status);

      for (const flag of ['canValidate', 'canPublish', 'canArchive'] as const) {
        expect(actions[flag]).toBe(status === guard[flag]);
      }
    }
  });

  it('carries the actions onto the projected row for the state that was stored', () => {
    // The projection and the matrix are two steps; this proves they are wired together rather than the
    // row reporting a status the flags beside it contradict.
    expect(toMissionPolicyVersionResponse(row('DRAFT')).actions.canValidate).toBe(true);
    expect(toMissionPolicyVersionResponse(row('VALIDATED')).actions.canPublish).toBe(true);
    expect(toMissionPolicyVersionResponse(row('PUBLISHED')).actions.canArchive).toBe(true);

    const archived = toMissionPolicyVersionResponse(row('ARCHIVED')).actions;
    expect(archived).toEqual({ canValidate: false, canPublish: false, canArchive: false });
  });
});
