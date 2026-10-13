import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase B2.1 — AUDIT DURABILITY ADOPTION: proves that every compliance-critical
 * Financial lifecycle mutation writes the audit event through the durable outbox
 * path (atomically within the repository transaction), and that non-critical
 * mutations intentionally remain on the best-effort path.
 *
 * The test operates on source text, not runtime behavior: it scans the service
 * files for the outbox adoption pattern to prevent silent regression. This is NOT
 * a substitute for the unit/integration tests in `audit-outbox-relay.spec.ts` —
 * it is a static guard that the wiring remains correct.
 */

const SRC = path.resolve(__dirname);
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

/**
 * Compliance-critical Financial lifecycle actions.
 *
 * These are state transitions in the Check Issuance lifecycle where:
 *   - an authorization decision is recorded (approve/reject)
 *   - a financial commitment is made (allocate/issue/deliver)
 *   - a routing decision changes the request's owner (submit)
 *
 * Losing the audit event for any of these means losing evidence of who
 * approved, allocated, issued, or delivered — which is a compliance gap.
 */
const COMPLIANCE_CRITICAL_ACTIONS = [
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'REQUEST_CORRECTION',
  'ALLOCATE',
  'DOCUMENT_REVIEW',
  'DOCUMENT_REVIEW_CORRECTION',
  'EXECUTIVE_APPROVE',
  'EXECUTIVE_REJECT',
  'ISSUE',
  'DELIVER',
] as const;

/**
 * Non-critical Financial actions that intentionally remain on the best-effort
 * `record()` path.
 *
 * CREATE and UPDATE are draft-level operations — the request has not entered
 * the approval workflow and no authorization decision is being recorded.
 * Attachment operations are supplementary metadata.
 */
const NON_CRITICAL_ACTIONS = [
  'CREATE',
  'UPDATE',
  'ATTACHMENT_UPLOAD',
  'ATTACHMENT_UPDATE',
  'ATTACHMENT_DELETE',
] as const;

describe('Financial Audit Durability Adoption (Phase B2.1)', () => {
  const serviceSource = read('check-request/check-request.service.ts');
  const repositorySource = read('check-request/check-request.repository.ts');
  const attachmentSource = read('check-request/check-attachment.service.ts');

  describe('compliance-critical mutations use the durable outbox path', () => {
    it('the repository accepts AuditOutboxPayload in every stage method', () => {
      // Every compliance-critical repository method should accept an `outbox?` parameter.
      const methods = [
        'submit',
        'decide',
        'allocate',
        'recordDocumentReview',
        'recordExecutiveApproval',
        'confirmIssue',
        'completeDelivery',
      ];

      for (const method of methods) {
        // Look for `outbox?: AuditOutboxPayload` or `outbox?:` in the method signature.
        const pattern = new RegExp(
          `async\\s+${method}\\b[^)]*outbox\\??:\\s*AuditOutboxPayload`,
        );
        expect(repositorySource).toMatch(pattern);
      }
    });

    it('the service builds an outbox payload for every compliance-critical action', () => {
      for (const action of COMPLIANCE_CRITICAL_ACTIONS) {
        // The service should call buildOutboxPayload with CHECK_REQUEST_AUDIT_ACTION.<action>
        expect(serviceSource).toContain(
          `CHECK_REQUEST_AUDIT_ACTION.${action}`,
        );
      }
    });

    it('the service calls buildOutboxPayload for all compliance-critical lifecycle methods', () => {
      // Count the number of `buildOutboxPayload` calls in the service.
      const calls = (serviceSource.match(/this\.audit\.buildOutboxPayload\(/g) || []).length;
      // There should be at least 7 calls: submit, decide (covers approve/reject/correction),
      // allocate, reviewDocuments, executiveDecision, issue, deliver.
      expect(calls).toBeGreaterThanOrEqual(7);
    });

    it('the repository writes outbox rows inside $transaction', () => {
      // The outbox writes should appear inside transaction blocks.
      // Use a dotAll regex because the transaction block spans many lines with `}`.
      const transactionBlocks = repositorySource.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(transactionBlocks).not.toBeNull();
      // At least 3 patterns: submit, decide, runStageTransition.
      expect(transactionBlocks!.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('non-critical mutations remain on the best-effort path', () => {
    it('CREATE uses this.audit.record, not buildOutboxPayload', () => {
      // The create method should still use record() directly.
      expect(serviceSource).toContain('CHECK_REQUEST_AUDIT_ACTION.CREATE');
      // Find the create section and verify it uses record().
      const createSection = serviceSource.slice(
        serviceSource.indexOf('async create('),
        serviceSource.indexOf('async list('),
      );
      expect(createSection).toContain('this.audit.record(actor');
      expect(createSection).not.toContain('buildOutboxPayload');
    });

    it('UPDATE uses this.audit.record, not buildOutboxPayload', () => {
      const updateSection = serviceSource.slice(
        serviceSource.indexOf('async update('),
        serviceSource.indexOf('async submit('),
      );
      expect(updateSection).toContain('this.audit.record(actor');
      expect(updateSection).not.toContain('buildOutboxPayload');
    });

    it('attachment operations use this.audit.record, not buildOutboxPayload', () => {
      expect(attachmentSource).toContain('this.audit.record(actor');
      expect(attachmentSource).not.toContain('buildOutboxPayload');
    });
  });

  describe('classification is complete', () => {
    it('every CHECK_REQUEST_AUDIT_ACTION is classified as critical or non-critical', () => {
      const allActions: readonly string[] = [
        ...COMPLIANCE_CRITICAL_ACTIONS,
        ...NON_CRITICAL_ACTIONS,
      ];

      // Extract only the keys from CHECK_REQUEST_AUDIT_ACTION, not from other constants.
      const actionDef = read('check-request/check-request.ts');
      const auditActionBlock = actionDef.slice(
        actionDef.indexOf('CHECK_REQUEST_AUDIT_ACTION = {'),
        actionDef.indexOf('} as const;', actionDef.indexOf('CHECK_REQUEST_AUDIT_ACTION = {'))
          + '} as const;'.length,
      );
      const definedActions = auditActionBlock.match(/^\s+(\w+):\s+'/gm);
      expect(definedActions).not.toBeNull();
      for (const match of definedActions!) {
        const actionName = match.trim().split(':')[0];
        expect(allActions).toContain(actionName);
      }
    });
  });
});
