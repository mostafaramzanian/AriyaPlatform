import { evaluateAncestorStep, type AncestorStepDecision } from './organization-hierarchy';

/**
 * Phase 51-HR-ARCH-1B: the organization ancestor-walk rule, tested WITHOUT a database.
 *
 * `OrganizationService.assertParentIsUsable` still performs the fetch (one bounded query
 * per step) and still raises the 409s; this file pins the decision that used to be
 * interleaved with those fetches. A cycle and an over-deep tree must stay distinguishable,
 * because they are two different messages on the wire.
 */
describe('HR domain — organization hierarchy', () => {
  const decide = (
    currentId: string,
    childId: string,
    steps = 0,
    maxSteps = 100
  ): AncestorStepDecision => evaluateAncestorStep({ childId, steps, maxSteps }, currentId);

  it('descends while the walk has not reached the moved unit', () => {
    expect(decide('unit-b', 'unit-a')).toEqual({ kind: 'descend', steps: 1 });
  });

  it('reports a cycle when the walk reaches the unit being moved', () => {
    // unit-a → unit-b → unit-c → unit-a is the input the DB trigger also refuses.
    expect(decide('unit-a', 'unit-a')).toEqual({ kind: 'found-child' });
  });

  it('carries the step count forward so the caller can keep the walk bounded', () => {
    expect(decide('unit-b', 'unit-a', 7)).toEqual({ kind: 'descend', steps: 8 });
  });

  it('reports `too-deep` once the bound is exceeded', () => {
    expect(decide('unit-b', 'unit-a', 100, 100)).toEqual({ kind: 'too-deep' });
  });

  it('treats the cycle as a cycle on the last permitted step, not as a depth failure', () => {
    // Order matters: the reach-the-child test runs BEFORE the bound is incremented. Swapping
    // the two would answer a genuine cycle with the depth message.
    expect(decide('unit-a', 'unit-a', 100, 100)).toEqual({ kind: 'found-child' });
  });

  it('is pure: the same input yields the same decision and the state object is untouched', () => {
    const state = { childId: 'unit-a', steps: 3, maxSteps: 100 };

    expect(evaluateAncestorStep(state, 'unit-b')).toEqual({ kind: 'descend', steps: 4 });
    expect(state).toEqual({ childId: 'unit-a', steps: 3, maxSteps: 100 });
  });
});
