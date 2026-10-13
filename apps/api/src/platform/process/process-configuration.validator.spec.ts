import type { ProcessDefinition } from './process-definition.model';
import { freezeProcessDefinition } from './process-definition';
import {
  assertProcessPublishable,
  validateProcessConfiguration,
} from './process-configuration.validator';

/**
 * Phase CHECK-ISSUATION — brief §41: the configuration validator's contract.
 *
 * The fixture is a deliberately TINY process (start → review → done/halted) so each
 * test can break exactly one rule. The real `financial.check-issuance` definition has
 * its own suite; this one proves the RULES, not the process.
 */

function validDefinition(): ProcessDefinition {
  return {
    processKey: 'test.process',
    version: 1,
    status: 'published',
    title: 'Test process',
    steps: [
      {
        key: 'start',
        order: 1,
        title: 'Start',
        progressLabel: 'Start',
        states: [0],
        active: true,
        visible: true,
        actions: ['submit'],
        fields: [{ field: 'title', states: [0], editableStates: [0] }],
      },
      {
        key: 'review',
        order: 2,
        title: 'Review',
        progressLabel: 'Review',
        states: [1],
        active: true,
        visible: true,
        actions: ['approve', 'reject'],
        fields: [],
      },
      {
        key: 'done',
        order: 3,
        title: 'Done',
        progressLabel: 'Done',
        states: [2],
        active: true,
        visible: true,
        actions: [],
        fields: [],
      },
      {
        key: 'halted',
        order: 4,
        title: 'Halted',
        progressLabel: 'Halted',
        states: [9],
        active: true,
        visible: true,
        actions: [],
        fields: [],
      },
    ],
    actions: [
      { key: 'submit', label: 'Submit', permission: 'test.record.manage', actorPolicy: 'requester' },
      { key: 'approve', label: 'Approve', permission: 'test.record.approve', actorPolicy: 'approver' },
      { key: 'reject', label: 'Reject', permission: 'test.record.approve', actorPolicy: 'approver' },
    ],
    actorPolicies: [
      { key: 'requester', kind: 'REQUESTER', forbidSelfApproval: false },
      {
        key: 'approver',
        kind: 'PERMISSION',
        permission: 'test.record.approve',
        forbidSelfApproval: true,
      },
    ],
    transitions: [
      { action: 'submit', fromState: 0, toState: 1 },
      { action: 'approve', fromState: 1, toState: 2 },
      { action: 'reject', fromState: 1, toState: 9 },
    ],
    documentSections: [
      {
        section: 1,
        key: 'evidence',
        title: 'Evidence',
        states: [0],
        allowedDocumentTypes: ['TYPE_A'],
        requiredForActions: [],
        permission: 'test.record.manage',
      },
    ],
    terminalStates: [2, 9],
  };
}

const codesOf = (definition: ProcessDefinition): string[] =>
  validateProcessConfiguration(definition).map((item) => item.code);

describe('process configuration validator (brief §41)', () => {
  it('accepts a VALID process definition with zero issues', () => {
    expect(validateProcessConfiguration(validDefinition())).toEqual([]);
  });

  it('refuses duplicate step keys and duplicate step orders', () => {
    const duplicateKey = validDefinition();
    (duplicateKey.steps as unknown as { key: string }[])[1].key = 'start';
    expect(codesOf(duplicateKey)).toContain('DUPLICATE_STEP_KEY');

    const duplicateOrder = validDefinition();
    (duplicateOrder.steps as unknown as { order: number }[])[1].order = 1;
    expect(codesOf(duplicateOrder)).toContain('DUPLICATE_STEP_ORDER');
  });

  it('refuses invalid transitions: duplicate pair, unknown action, terminal escape, unknown state', () => {
    const duplicate = validDefinition();
    (duplicate.transitions as { action: string; fromState: number; toState: number }[]).push({
      action: 'approve',
      fromState: 1,
      toState: 2,
    });
    expect(codesOf(duplicate)).toContain('DUPLICATE_TRANSITION');

    const unknownAction = validDefinition();
    (unknownAction.transitions as unknown as { action: string }[])[0].action = 'teleport';
    // The step also stops offering a transition it can perform — both codes are honest.
    expect(codesOf(unknownAction)).toEqual(
      expect.arrayContaining(['UNKNOWN_ACTION', 'STEP_ACTION_WITHOUT_TRANSITION'])
    );

    const terminalEscape = validDefinition();
    (terminalEscape.transitions as { action: string; fromState: number; toState: number }[]).push({
      action: 'approve',
      fromState: 2,
      toState: 1,
    });
    expect(codesOf(terminalEscape)).toContain('TRANSITION_FROM_TERMINAL');

    const unknownState = validDefinition();
    (unknownState.transitions as unknown as { toState: number }[])[0].toState = 77;
    expect(codesOf(unknownState)).toContain('UNKNOWN_STATE');
  });

  it('refuses an unreachable step', () => {
    const definition = validDefinition();
    // The review step becomes unreachable: nothing leads into state 1 any more.
    (definition.transitions as unknown as { fromState: number }[])[0].fromState = 9;
    expect(codesOf(definition)).toContain('UNREACHABLE_STEP');
  });

  it('refuses an invalid actor policy', () => {
    const missingPermission = validDefinition();
    (missingPermission.actorPolicies as unknown as { permission?: string }[])[1].permission =
      undefined;
    expect(codesOf(missingPermission)).toContain('INVALID_ACTOR_POLICY');

    const missingUser = validDefinition();
    (missingUser.actorPolicies as { key: string; kind: 'USER'; userId: string; forbidSelfApproval: boolean }[]).push(
      {
        key: 'named',
        kind: 'USER',
        userId: '   ',
        forbidSelfApproval: false,
      }
    );
    expect(codesOf(missingUser)).toContain('INVALID_ACTOR_POLICY');

    const unknownKind = validDefinition();
    (unknownKind.actorPolicies as unknown as { kind: string }[])[0].kind = 'TIME_TRAVELLER';
    expect(codesOf(unknownKind)).toContain('INVALID_ACTOR_POLICY');
  });

  it('refuses an invalid permission — on an action AND on a document section', () => {
    const badActionPermission = validDefinition();
    (badActionPermission.actions as unknown as { permission: string }[])[0].permission =
      'Not A Capability';
    expect(codesOf(badActionPermission)).toContain('INVALID_PERMISSION');

    const badSectionPermission = validDefinition();
    (badSectionPermission.documentSections as unknown as { permission: string }[])[0].permission =
      '!!';
    expect(codesOf(badSectionPermission)).toContain('INVALID_PERMISSION');
  });

  it('refuses an invalid document policy', () => {
    const emptyVocabulary = validDefinition();
    (
      emptyVocabulary.documentSections as unknown as { allowedDocumentTypes: string[] }[]
    )[0].allowedDocumentTypes = [];
    expect(codesOf(emptyVocabulary)).toContain('INVALID_DOCUMENT_POLICY');

    const unknownRequiredAction = validDefinition();
    (
      unknownRequiredAction.documentSections as unknown as { requiredForActions: string[] }[]
    )[0].requiredForActions = ['ghost'];
    expect(codesOf(unknownRequiredAction)).toContain('INVALID_DOCUMENT_POLICY');

    const noStates = validDefinition();
    (noStates.documentSections as unknown as { states: number[] }[])[0].states = [];
    expect(codesOf(noStates)).toContain('INVALID_DOCUMENT_POLICY');
  });

  it('refuses an invalid field policy — editable outside visibility', () => {
    const definition = validDefinition();
    (definition.steps[0].fields as unknown as { editableStates: number[] }[])[0].editableStates =
      [1];
    expect(codesOf(definition)).toContain('INVALID_FIELD_POLICY');
  });

  it('refuses an undeclared dead end — every terminal state must be declared', () => {
    const definition = validDefinition();
    (definition.terminalStates as number[]) = [2];
    expect(codesOf(definition)).toContain('UNDECLARED_TERMINAL_STATE');
  });

  it('refuses an action its owning step does not offer', () => {
    const definition = validDefinition();
    (definition.transitions as unknown as { action: string; fromState: number; toState: number }[])[0] =
      {
        action: 'approve',
        fromState: 0,
        toState: 1,
      };
    expect(codesOf(definition)).toContain('ACTION_NOT_OFFERED_BY_STEP');
  });

  it('refuses a non-string extension value — extension metadata is scalar-only', () => {
    const definition = validDefinition();
    (definition as { extension?: Record<string, unknown> }).extension = { flag: 1 };
    expect(codesOf(definition)).toContain('INVALID_EXTENSION');
  });

  it('validates the publish gate: draft is refused even when coherent, issues are listed in full', () => {
    const draft = { ...validDefinition(), status: 'draft' as const };
    expect(() => assertProcessPublishable(draft)).toThrow(/NOT_PUBLISHED/);

    const broken = validDefinition();
    (broken.steps as unknown as { key: string }[])[1].key = 'start';
    expect(() => assertProcessPublishable(broken)).toThrow(/DUPLICATE_STEP_KEY/);

    expect(() => assertProcessPublishable(validDefinition())).not.toThrow();
  });

  it('keeps a published definition IMMUTABLE through freezeProcessDefinition', () => {
    const definition = freezeProcessDefinition(validDefinition());
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.steps)).toBe(true);
    expect(Object.isFrozen(definition.steps[0])).toBe(true);
    expect(Object.isFrozen(definition.transitions[0])).toBe(true);

    // Mutating a frozen object throws in strict mode (TS modules are strict) — the
    // attempt below must not change what the wizard or the transitions report.
    expect(() => {
      (definition as { title: string }).title = 'rewritten';
    }).toThrow();
    expect(definition.title).toBe('Test process');
  });
});

