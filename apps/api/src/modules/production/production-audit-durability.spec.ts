import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase B2.4 — PRODUCTION AUDIT DURABILITY ADOPTION: proves that every
 * confirmed durable-required Production event uses the transactional outbox
 * path, and that non-durable events remain on the best-effort path.
 *
 * The test operates on source text, not runtime behavior: it scans the service
 * and repository files for the outbox adoption pattern to prevent silent
 * regression. This is NOT a substitute for unit/integration tests — it is a
 * static guard that the wiring remains correct.
 */

const SRC = path.resolve(__dirname);
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

/**
 * Phase B2.2 classification under test: durable-required Production families
 * (routing/authorization transitions) versus the best-effort `record()` ones.
 */
describe('Production Audit Durability Adoption (Phase B2.4)', () => {
  const bomService = read('bom/bom.service.ts');
  const bomRepo = read('bom/bom.repository.ts');
  const bomItemService = read('bom/bom-item.service.ts');
  const changeService = read('bom-change/bom-change.service.ts');
  const changeRepo = read('bom-change/bom-change.repository.ts');
  const gateway = read('production-audit.gateway.ts');
  const relay = read('production-audit-outbox-relay.service.ts');

  describe('durable-required mutations use the transactional outbox path', () => {
    it('the BOM repository accepts an outbox payload in submit and decide', () => {
      for (const method of ['submit', 'decide']) {
        const pattern = new RegExp(
          `async\\s+${method}\\b[^)]*outbox\\??:\\s*ProductionAuditOutboxPayload`,
        );
        expect(bomRepo).toMatch(pattern);
      }
    });

    it('the BOM Change repository accepts an outbox payload in submit and decide', () => {
      for (const method of ['submit', 'decide']) {
        const pattern = new RegExp(
          `async\\s+${method}\\b[^)]*outbox\\??:\\s*ProductionAuditOutboxPayload`,
        );
        expect(changeRepo).toMatch(pattern);
      }
    });

    it('the BOM service calls buildOutboxPayload for submit and decide', () => {
      // submit section — between `async submit(` and the next `async` method or `private`
      const submitSection = bomService.slice(
        bomService.indexOf('async submit('),
        bomService.indexOf('async decide('),
      );
      expect(submitSection).toContain('this.audit.buildOutboxPayload(');
      expect(submitSection).toContain('PRODUCTION_BOM_AUDIT_ACTION.SUBMIT');
      // The old audit.record should NOT be used for submit
      expect(submitSection).not.toContain('this.audit.record(');

      // decide section — between `async decide(` and the next `private` method after it
      const decideStart = bomService.indexOf('async decide(');
      const decideSection = bomService.slice(
        decideStart,
        bomService.indexOf('private ', decideStart),
      );
      expect(decideSection).toContain('this.audit.buildOutboxPayload(');
      // The old audit.record should NOT be used for decide
      expect(decideSection).not.toContain('this.audit.record(');
    });

    it('the BOM Change service calls buildOutboxPayload for submit and decide', () => {
      const submitSection = changeService.slice(
        changeService.indexOf('async submit('),
        changeService.indexOf('async decide('),
      );
      expect(submitSection).toContain('this.audit.buildOutboxPayload(');
      expect(submitSection).toContain('PRODUCTION_BOM_CHANGE_AUDIT_ACTION.SUBMIT');
      expect(submitSection).not.toContain('this.audit.record(');

      const decideSection = changeService.slice(
        changeService.indexOf('async decide('),
        changeService.indexOf('async getTimeline('),
      );
      expect(decideSection).toContain('this.audit.buildOutboxPayload(');
      expect(decideSection).not.toContain('this.audit.record(');
    });

    it('the BOM repository writes outbox rows inside $transaction', () => {
      const transactionBlocks = bomRepo.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(transactionBlocks).not.toBeNull();
      // Two: submit and decide
      expect(transactionBlocks!.length).toBe(2);
    });

    it('the BOM Change repository writes outbox rows inside $transaction', () => {
      const transactionBlocks = changeRepo.match(
        /\$transaction\(async\s*\(tx\)[\s\S]*?auditOutbox\.create/g,
      );
      expect(transactionBlocks).not.toBeNull();
      // Two: submit and decide
      expect(transactionBlocks!.length).toBe(2);
    });
  });

  describe('non-durable mutations remain on the best-effort path', () => {
    it('BOM create uses this.audit.record, not buildOutboxPayload', () => {
      const createSection = bomService.slice(
        bomService.indexOf('async create('),
        bomService.indexOf('async list('),
      );
      expect(createSection).toContain('this.audit.record(');
      expect(createSection).not.toContain('buildOutboxPayload');
    });

    it('BOM update uses this.audit.record, not buildOutboxPayload', () => {
      const updateSection = bomService.slice(
        bomService.indexOf('async update('),
        bomService.indexOf('async submit('),
      );
      expect(updateSection).toContain('this.audit.record(');
      expect(updateSection).not.toContain('buildOutboxPayload');
    });

    it('BOM Item operations use this.audit.record, not buildOutboxPayload', () => {
      expect(bomItemService).toContain('this.audit.record(');
      expect(bomItemService).not.toContain('buildOutboxPayload');
    });

    it('BOM Change non-durable operations use this.audit.record, not buildOutboxPayload', () => {
      // create section
      const createSection = changeService.slice(
        changeService.indexOf('async create('),
        changeService.indexOf('async update('),
      );
      expect(createSection).toContain('this.audit.record(');
      expect(createSection).not.toContain('buildOutboxPayload');

      // update section
      const updateSection = changeService.slice(
        changeService.indexOf('async update('),
        changeService.indexOf('async addItem('),
      );
      expect(updateSection).toContain('this.audit.record(');
      expect(updateSection).not.toContain('buildOutboxPayload');
    });

    it('exact non-durable event count: 10 this.audit.record calls remain', () => {
      // Count remaining `this.audit.record(` calls across all Production services.
      const bomRecords = (bomService.match(/this\.audit\.record\(/g) || []).length;
      const bomItemRecords = (bomItemService.match(/this\.audit\.record\(/g) || []).length;
      const changeRecords = (changeService.match(/this\.audit\.record\(/g) || []).length;

      // BOM: create + update = 2
      expect(bomRecords).toBe(2);
      // BOM Item: create + update + delete = 3
      expect(bomItemRecords).toBe(3);
      // BOM Change: create + update + add_item + update_item + remove_item = 5
      expect(changeRecords).toBe(5);

      // Total: 10 non-durable events remain on best-effort path
      expect(bomRecords + bomItemRecords + changeRecords).toBe(10);
    });

    it('exact durable event count: 2 buildOutboxPayload calls in each service', () => {
      const bomOutbox = (bomService.match(/this\.audit\.buildOutboxPayload\(/g) || []).length;
      const changeOutbox = (changeService.match(/this\.audit\.buildOutboxPayload\(/g) || []).length;

      // BOM: submit + decide = 2
      expect(bomOutbox).toBe(2);
      // BOM Change: submit + decide = 2
      expect(changeOutbox).toBe(2);
    });
  });

  describe('gateway has buildOutboxPayload', () => {
    it('the gateway exports ProductionAuditOutboxPayload', () => {
      expect(gateway).toContain('export interface ProductionAuditOutboxPayload');
    });

    it('the gateway implements buildOutboxPayload', () => {
      expect(gateway).toMatch(/buildOutboxPayload\(/);
      expect(gateway).toContain('ProductionAuditOutboxPayload');
    });
  });

  describe('relay service', () => {
    it('uses AUDIT_PORT for delivery, not Core Prisma', () => {
      expect(relay).toContain('AUDIT_PORT');
      expect(relay).toContain('this.auditPort.record(');
      // Strip comments before checking for Core references — the relay's JSDoc
      // mentions `core_db."AuditLog"` as the DESTINATION, which is expected prose.
      const relayCode = relay
        .split('\n')
        .filter((line: string) => {
          const t = line.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*/');
        })
        .join('\n');
      expect(relayCode).not.toMatch(/CorePrisma|import.*core.*prisma/i);
    });

    it('uses ProductionPrismaService for outbox access', () => {
      expect(relay).toContain('ProductionPrismaService');
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
      // The relay must NOT use `this.audit.record(` — that pattern is reserved for the
      // gateway scanner in the isolation tests. The relay uses `this.auditPort.record(`.
      expect(relay).not.toMatch(/this\.audit\.record\(/);
      expect(relay).toContain('this.auditPort');
    });
  });

  describe('classification is complete', () => {
    it('the combined call-site total is exactly 14: 4 durable + 10 non-durable', () => {
      const bomRecords = (bomService.match(/this\.audit\.record\(/g) || []).length;
      const bomOutbox = (bomService.match(/this\.audit\.buildOutboxPayload\(/g) || []).length;
      const bomItemRecords = (bomItemService.match(/this\.audit\.record\(/g) || []).length;
      const changeRecords = (changeService.match(/this\.audit\.record\(/g) || []).length;
      const changeOutbox = (changeService.match(/this\.audit\.buildOutboxPayload\(/g) || []).length;

      // Total: 14 production-code audit call sites
      expect(bomRecords + bomOutbox + bomItemRecords + changeRecords + changeOutbox).toBe(14);
    });
  });
});
