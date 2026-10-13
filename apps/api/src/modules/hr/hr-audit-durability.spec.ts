import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase B2.5 — HR AUDIT DURABILITY ADOPTION: proves that every confirmed
 * durable-required HR event uses the transactional outbox path, and that
 * non-durable events remain on the best-effort path.
 *
 * The test operates on source text, not runtime behavior: it scans the service
 * and repository files for the outbox adoption pattern to prevent silent
 * regression. This is NOT a substitute for unit/integration tests — it is a
 * static guard that the wiring remains correct.
 */

const SRC = path.resolve(__dirname);
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('HR Audit Durability Adoption (Phase B2.5)', () => {
  const missionService = read('mission/mission.service.ts');
  const missionRepo = read('mission/mission.repository.ts');
  const missionApprovalService = read('mission/mission-approval.service.ts');
  const missionApprovalRepo = read('mission/mission-approval.repository.ts');
  const leaveApprovalService = read('leave/leave-approval.service.ts');
  const leaveApprovalRepo = read('leave/leave-approval.repository.ts');
  const employmentService = read('employment/employment.service.ts');
  const employmentRepo = read('employment/employment.repository.ts');
  const gateway = read('hr-audit.gateway.ts');
  const relay = read('hr-audit-outbox-relay.service.ts');

  describe('gateway infrastructure', () => {
    it('the gateway exports HrAuditOutboxPayload', () => {
      expect(gateway).toContain('export interface HrAuditOutboxPayload');
    });

    it('the gateway implements buildOutboxPayload', () => {
      expect(gateway).toMatch(/buildOutboxPayload\(/);
      expect(gateway).toContain('HrAuditOutboxPayload');
    });
  });

  describe('durable-required: Mission SUBMIT (3 paths)', () => {
    it('the mission repository has transactional submit methods', () => {
      expect(missionRepo).toMatch(/async\s+submitAndAutoApprove\b/);
      expect(missionRepo).toMatch(/async\s+submitAndAutoReject\b/);
      expect(missionRepo).toMatch(/async\s+markInApprovalDurable\b/);
    });

    it('all three submit repo methods write outbox inside $transaction', () => {
      const txBlocks = missionRepo.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(txBlocks).not.toBeNull();
      // submitAndAutoApprove, submitAndAutoReject, markInApprovalDurable
      expect(txBlocks!.length).toBeGreaterThanOrEqual(3);
    });

    it('the mission service calls buildOutboxPayload for all 3 submission paths', () => {
      const performSection = missionService.slice(
        missionService.indexOf('private async performSubmission('),
      );
      const outboxCalls = performSection.match(/this\.audit\.buildOutboxPayload\(/g) ?? [];
      // auto-approve: 2 (SUBMIT + APPROVE)
      // auto-reject: 2 (SUBMIT + REJECT)
      // enter-approval: 1 (SUBMIT or RESUBMIT)
      expect(outboxCalls.length).toBe(5);
    });

    it('the performSubmission section does NOT use this.audit.record', () => {
      const start = missionService.indexOf('private async performSubmission(');
      // End at the next top-level method (not inside performSubmission)
      const end = missionService.indexOf('\n  async submitReport(');
      const performSection = missionService.slice(start, end > start ? end : undefined);
      expect(performSection).not.toContain('this.audit.record(');
    });
  });

  describe('durable-required: Mission APPROVE / REJECT / CORRECTION (human decision)', () => {
    it('the mission-approval repository accepts an outbox payload in recordDecision', () => {
      expect(missionApprovalRepo).toMatch(
        /async\s+recordDecision\b[\s\S]*?outbox\?:\s*HrAuditOutboxPayload/,
      );
    });

    it('the mission-approval repository writes outbox inside $transaction', () => {
      const txBlocks = missionApprovalRepo.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(txBlocks).not.toBeNull();
      expect(txBlocks!.length).toBeGreaterThanOrEqual(1);
    });

    it('the mission-approval service calls buildOutboxPayload for decide', () => {
      const decideSection = missionApprovalService.slice(
        missionApprovalService.indexOf('async decide('),
      );
      expect(decideSection).toContain('this.audit.buildOutboxPayload(');
      expect(decideSection).not.toContain('this.audit.record(');
    });
  });

  describe('durable-required: Leave APPROVE / REJECT', () => {
    it('the leave-approval repository accepts an outbox payload in recordDecision', () => {
      expect(leaveApprovalRepo).toMatch(
        /async\s+recordDecision\b[\s\S]*?outbox\?:\s*HrAuditOutboxPayload/,
      );
    });

    it('the leave-approval repository writes outbox inside $transaction', () => {
      const txBlocks = leaveApprovalRepo.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(txBlocks).not.toBeNull();
      expect(txBlocks!.length).toBeGreaterThanOrEqual(1);
    });

    it('the leave-approval service calls buildOutboxPayload for decide', () => {
      const decideSection = leaveApprovalService.slice(
        leaveApprovalService.indexOf('async decide('),
        leaveApprovalService.indexOf('async approve('),
      );
      expect(decideSection).toContain('this.audit.buildOutboxPayload(');
    });

    it('leave-approval CANCEL (withdrawal) remains non-durable', () => {
      const cancelSection = leaveApprovalService.slice(
        leaveApprovalService.indexOf('async closeOnWithdrawal('),
      );
      expect(cancelSection).toContain('this.audit.record(');
      expect(cancelSection).not.toContain('buildOutboxPayload');
    });
  });

  describe('durable-required: Employment TRANSFER, Employee TERMINATE, Employee REHIRE', () => {
    it('the employment repository accepts outbox payloads in all three durable methods', () => {
      // closeThenOpenInterval (TRANSFER) accepts a builder function
      expect(employmentRepo).toMatch(
        /async\s+closeThenOpenInterval\b[\s\S]*?buildOutbox\?/,
      );
      // closeIntervalAndTerminate (TERMINATE) accepts an outbox payload
      expect(employmentRepo).toMatch(
        /async\s+closeIntervalAndTerminate\b[\s\S]*?outbox\?/,
      );
      // openIntervalAndReactivate (REHIRE) accepts an outbox payload
      expect(employmentRepo).toMatch(
        /async\s+openIntervalAndReactivate\b[\s\S]*?outbox\?/,
      );
    });

    it('the employment repository writes outbox inside $transaction for all three', () => {
      const txBlocks = employmentRepo.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(txBlocks).not.toBeNull();
      // closeThenOpenInterval, closeIntervalAndTerminate, openIntervalAndReactivate
      expect(txBlocks!.length).toBe(3);
    });

    it('the employment service calls buildOutboxPayload for TRANSFER, TERMINATE, REHIRE', () => {
      expect(employmentService).toContain('this.audit.buildOutboxPayload(');
      const outboxCalls = employmentService.match(/this\.audit\.buildOutboxPayload\(/g) ?? [];
      // TRANSFER uses a builder function (1 call), TERMINATE (1 call), REHIRE (1 call)
      expect(outboxCalls.length).toBe(3);
    });

    it('employment service has NO this.audit.record calls (all 3 events are durable)', () => {
      expect(employmentService).not.toContain('this.audit.record(');
    });
  });

  describe('non-durable events remain on best-effort path', () => {
    it('mission service: non-durable CREATE, UPDATE, CANCEL use this.audit.record', () => {
      // CREATE for mission request
      const createSection = missionService.slice(
        missionService.indexOf('async create('),
        missionService.indexOf('async update('),
      );
      expect(createSection).toContain('this.audit.record(');
      expect(createSection).not.toContain('buildOutboxPayload');

      // UPDATE for mission request
      const updateSection = missionService.slice(
        missionService.indexOf('async update('),
        missionService.indexOf('async cancel('),
      );
      expect(updateSection).toContain('this.audit.record(');
      expect(updateSection).not.toContain('buildOutboxPayload');

      // CANCEL for mission request
      const cancelSection = missionService.slice(
        missionService.indexOf('async cancel('),
        missionService.indexOf('async submit('),
      );
      expect(cancelSection).toContain('this.audit.record(');
      expect(cancelSection).not.toContain('buildOutboxPayload');
    });

    it('mission service: option group/option/approval-def/report use this.audit.record', () => {
      // Option group, option, approval definition, report — all non-durable
      const afterSubmit = missionService.slice(
        missionService.indexOf('async submitReport('),
      );
      expect(afterSubmit).toContain('this.audit.record(');
      expect(afterSubmit).not.toContain('buildOutboxPayload');
    });
  });

  describe('relay service', () => {
    it('uses AUDIT_PORT for delivery, not Core Prisma', () => {
      expect(relay).toContain('AUDIT_PORT');
      expect(relay).toContain('this.auditPort.record(');
      const relayCode = relay
        .split('\n')
        .filter((line: string) => {
          const t = line.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*/');
        })
        .join('\n');
      expect(relayCode).not.toMatch(/CorePrisma|import.*core.*prisma/i);
    });

    it('uses HrPrismaService for outbox access', () => {
      expect(relay).toContain('HrPrismaService');
      expect(relay).toContain('this.prisma.auditOutbox.');
    });

    it('handles failures with reschedule, not silent deletion', () => {
      expect(relay).toContain('reschedule');
      expect(relay).toMatch(/attempts.*\+.*1|nextAttempt/);
    });

    it('deletes only on recorded or duplicate, not on rejection', () => {
      expect(relay).toContain("result.status === 'recorded'");
      expect(relay).toContain("result.status === 'duplicate'");
      expect(relay).toContain('.delete(');
    });

    it('names the injected port auditPort to avoid scanner collision', () => {
      expect(relay).not.toMatch(/this\.audit\.record\(/);
      expect(relay).toContain('this.auditPort');
    });
  });

  describe('classification completeness', () => {
    it('exact HR audit call-site counts: 10 durable + 39 non-durable = 49', () => {
      const services = [
        read('attendance/attendance.service.ts'),
        read('employees/employees.service.ts'),
        read('employment/employment.service.ts'),
        read('leave/leave.service.ts'),
        read('leave/leave-approval.service.ts'),
        read('leave-policy/leave-policy.service.ts'),
        read('mission/mission.service.ts'),
        read('mission/mission-approval.service.ts'),
        read('mission/mission-policy.service.ts'),
        read('organization/organization.service.ts'),
        read('positions/positions.service.ts'),
      ];

      let totalRecord = 0;
      let totalOutbox = 0;
      for (const src of services) {
        totalRecord += (src.match(/this\.audit\.record\(/g) || []).length;
        totalOutbox += (src.match(/this\.audit\.buildOutboxPayload\(/g) || []).length;
      }

      // 39 non-durable (best-effort record)
      expect(totalRecord).toBe(39);
      // 10 durable (outbox payload) — note: mission submit auto-approve path
      // builds 2 payloads (SUBMIT+APPROVE), auto-reject builds 2 (SUBMIT+REJECT),
      // enter-approval builds 1 (SUBMIT/RESUBMIT), so mission.service has 5 calls
      // for 5 event paths. Plus mission-approval has 1, leave-approval has 1,
      // employment has 3. Total outbox calls = 10.
      expect(totalOutbox).toBe(10);

      // Total: all 49 HR production-code audit call sites accounted for
      expect(totalRecord + totalOutbox).toBe(49);
    });
  });
});
