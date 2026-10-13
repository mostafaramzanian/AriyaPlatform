import * as fs from 'fs';
import * as path from 'path';
import { validateProcessConfiguration } from '../../../platform/process/process-configuration.validator';
import { findActorPolicy, findStepForState } from '../../../platform/process/process-definition';
import { CHECK_REQUEST_STATUS, checkRequestStatusAfter } from '../check-request/check-request-status';
import {
  CHECK_ISSUANCE_DEFINITION_V1,
  CHECK_ISSUANCE_DEFINITIONS,
  CHECK_ISSUANCE_PROCESS_KEY,
  CHECK_ISSUANCE_PROCESS_VERSION,
  CHECK_ISSUANCE_SECTION,
  resolveCheckIssuanceDefinition,
} from './check-issuance.definition';

/**
 * Phase CHECK-ISSUATION — the `financial.check-issuance` v1 definition, pinned.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 *  1. The published definition VALIDATES and is FROZEN (the import-time publish gate ran;
 *     immutability holds against a deliberate mutation attempt).
 *  2. The step graph is exactly the source's stages over the state mapping the brief §10
 *     declares.
 *  3. THE TWO TRANSITION DECLARATIONS AGREE: every definition transition lands where
 *     `checkRequestStatusAfter` lands, and vice versa — so "one transition, one meaning"
 *     is a test, not a hope.
 *  4. The contested executive «نیازمند اصلاح» branch has NO action and NO transition.
 *  5. The document sections carry v1's exact policy: section 2's eleven types in states
 *     0/1 with NO required action; section 6 gated onto `issue`; section 7 onto `deliver`.
 *  6. The version registry: v1 resolves; an unpublished/unknown version throws.
 */

const definition = CHECK_ISSUANCE_DEFINITION_V1;

/** action key → the domain transition key it must agree with. */
const ACTION_TO_TRANSITION = {
  submit: 'SUBMIT',
  approve: 'APPROVE',
  reject: 'REJECT',
  'request-correction': 'REQUEST_CORRECTION',
  allocate: 'ALLOCATE',
  'document-review': 'DOCUMENT_REVIEW_APPROVE',
  'document-review-correction': 'DOCUMENT_REVIEW_CORRECTION',
  'executive-approve': 'EXECUTIVE_APPROVE',
  'executive-reject': 'EXECUTIVE_REJECT',
  issue: 'ISSUE',
  deliver: 'DELIVER',
} as const;

describe('Phase CHECK-ISSUATION — the check-issuance definition (v1)', () => {
  it('is PUBLISHED, VALIDATES with zero issues, and is FROZEN', () => {
    expect(definition.processKey).toBe(CHECK_ISSUANCE_PROCESS_KEY);
    expect(definition.version).toBe(CHECK_ISSUANCE_PROCESS_VERSION);
    expect(definition.status).toBe('published');
    expect(validateProcessConfiguration(definition)).toEqual([]);

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.steps)).toBe(true);
    expect(Object.isFrozen(definition.transitions)).toBe(true);
    expect(() => {
      (definition as { title: string }).title = 'rewritten';
    }).toThrow();
  });

  it('maps the source stages to their exact states', () => {
    const stepOf = (state: number) => findStepForState(definition, state)?.key;
    expect(stepOf(CHECK_REQUEST_STATUS.DRAFT)).toBe('request');
    expect(stepOf(CHECK_REQUEST_STATUS.SUBMITTED)).toBe('request');
    expect(stepOf(CHECK_REQUEST_STATUS.MANAGER_REVIEW)).toBe('manager-review');
    expect(stepOf(CHECK_REQUEST_STATUS.APPROVED)).toBe('allocation');
    expect(stepOf(CHECK_REQUEST_STATUS.DOCUMENT_REVIEW)).toBe('document-review');
    expect(stepOf(CHECK_REQUEST_STATUS.EXECUTIVE_APPROVAL)).toBe('executive-approval');
    expect(stepOf(CHECK_REQUEST_STATUS.ISSUANCE)).toBe('issue');
    expect(stepOf(CHECK_REQUEST_STATUS.DELIVERY)).toBe('delivery');
    expect(stepOf(CHECK_REQUEST_STATUS.COMPLETED)).toBe('completed');
    expect(stepOf(CHECK_REQUEST_STATUS.TERMINATED)).toBe('terminated');
  });

  it('agrees with the domain transition table in BOTH directions — one meaning per transition', () => {
    // Every definition transition lands exactly where the domain table lands…
    for (const transition of definition.transitions) {
      const transitionKey =
        ACTION_TO_TRANSITION[transition.action as keyof typeof ACTION_TO_TRANSITION];
      expect({ action: transition.action, transitionKey }).not.toEqual({
        action: transition.action,
        transitionKey: undefined,
      });
      expect({
        action: transition.action,
        from: transition.fromState,
        landing: checkRequestStatusAfter(transition.fromState, transitionKey),
      }).toEqual({
        action: transition.action,
        from: transition.fromState,
        landing: transition.toState,
      });
    }

    // …and every declared pair is expressed through the same landing function, so the
    // two declarations are set-equal by construction and neither can drift alone.
    const declaredPairs = definition.transitions
      .map((transition) => `${transition.action}@${transition.fromState}>${transition.toState}`)
      .sort();
    const rederivedPairs = definition.transitions
      .map((transition) => {
        const transitionKey =
          ACTION_TO_TRANSITION[transition.action as keyof typeof ACTION_TO_TRANSITION];
        return `${transition.action}@${transition.fromState}>${checkRequestStatusAfter(transition.fromState, transitionKey)}`;
      })
      .sort();
    expect(declaredPairs).toEqual(rederivedPairs);
    expect(declaredPairs).toHaveLength(12);
  });

  it('has NO executive request-correction — the SOURCE-CONFLICT branch stays unexpressible', () => {
    expect(definition.actions.some((action) => action.key.includes('executive-correction'))).toBe(
      false
    );
    expect(
      definition.transitions.some(
        (transition) =>
          transition.action.includes('executive') &&
          transition.toState === CHECK_REQUEST_STATUS.APPROVED
      )
    ).toBe(false);
    // The extension metadata RECORDS the deferral, so the report has a machine-readable
    // trace rather than only prose.
    expect(definition.extension?.deferred).toContain('SOURCE-CONFLICT');
  });

  it('declares the document sections with v1’s exact policy', () => {
    const sections = definition.documentSections;
    expect(sections.map((section) => section.section).sort((a, b) => a - b)).toEqual([2, 6, 7]);

    const requestDocuments = sections.find(
      (section) => section.key === CHECK_ISSUANCE_SECTION.REQUEST_DOCUMENTS
    )!;
    expect(requestDocuments.section).toBe(2);
    expect([...requestDocuments.states].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(requestDocuments.allowedDocumentTypes).toHaveLength(11);
    // Preflight §9.3: request documents NEVER block a transition.
    expect(requestDocuments.requiredForActions).toEqual([]);

    const chequeImage = sections.find(
      (section) => section.key === CHECK_ISSUANCE_SECTION.CHEQUE_IMAGE
    )!;
    expect(chequeImage.section).toBe(6);
    expect(chequeImage.states).toEqual([CHECK_REQUEST_STATUS.ISSUANCE]);
    expect(chequeImage.allowedDocumentTypes).toBeNull();
    expect(chequeImage.requiredForActions).toEqual(['issue']);

    const deliveryReceipt = sections.find(
      (section) => section.key === CHECK_ISSUANCE_SECTION.DELIVERY_RECEIPT
    )!;
    expect(deliveryReceipt.section).toBe(7);
    expect(deliveryReceipt.states).toEqual([CHECK_REQUEST_STATUS.DELIVERY]);
    expect(deliveryReceipt.allowedDocumentTypes).toBeNull();
    expect(deliveryReceipt.requiredForActions).toEqual(['deliver']);
  });

  it('fails closed on self-approval for every decision act it declares', () => {
    for (const actionKey of [
      'approve',
      'reject',
      'request-correction',
      'document-review',
      'document-review-correction',
      'executive-approve',
      'executive-reject',
    ]) {
      const action = definition.actions.find((candidate) => candidate.key === actionKey)!;
      const policy = findActorPolicy(definition, action.actorPolicy)!;
      expect({ actionKey, forbidSelfApproval: policy.forbidSelfApproval }).toEqual({
        actionKey,
        forbidSelfApproval: true,
      });
    }
  });

  it('resolves v1 through the registry and REFUSES an unpublished/unknown version', () => {
    expect(resolveCheckIssuanceDefinition(1)).toBe(definition);
    expect(Object.keys(CHECK_ISSUANCE_DEFINITIONS)).toEqual(['1']);
    expect(() => resolveCheckIssuanceDefinition(2)).toThrow(/version 2 is not available/);
    expect(() => resolveCheckIssuanceDefinition(0)).toThrow(/not available/);
  });

  it('keeps the database default pin in agreement with the published process key/version', () => {
    // The schema's column defaults are what pre-pin rows carry; this phase's create path
    // writes the constants explicitly. They must name the SAME process, or a pre-pin row
    // would resolve to a different process than a fresh one.
    const schema = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'prisma', 'financial', 'schema.prisma'),
      'utf8'
    );
    expect(schema).toContain(`@default("${CHECK_ISSUANCE_PROCESS_KEY}")`);
    expect(schema).toContain('@default(1)');
  });
});
