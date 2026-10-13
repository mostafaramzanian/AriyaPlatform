import { readFileSync } from 'fs';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce/commerce.constants';
import { PaymentHistoryReportController } from './payment-history-report.controller';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the report ROUTES as metadata — the same
 * style as the sibling report controller specs.
 *
 * Checked here because these are the statements that break silently: a route added
 * without `@Roles`, a second permission widening one, or a mutating verb sneaking onto
 * a read-only report. FOUR reads, not five: list, both export formats, one row — the
 * timeline route every sibling carries is deliberately ABSENT, because the payment
 * audit trail is bound to the DOCUMENT and a per-row timeline would lie by grain.
 */
describe('PaymentHistoryReportController — four reads, one remit, no writes, no timeline', () => {
  const proto = PaymentHistoryReportController.prototype as unknown as Record<string, object>;

  const handlers = (): string[] =>
    Object.getOwnPropertyNames(PaymentHistoryReportController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const methodOf = (handler: string): string | undefined =>
    Reflect.getMetadata(METHOD_METADATA, proto[handler]);

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  it('exposes exactly the four report reads — list, both export formats, one row', () => {
    expect(handlers().sort()).toEqual(['exportDocx', 'exportXlsx', 'getOne', 'list'].sort());
    for (const handler of handlers()) {
      expect(methodOf(handler)).toBe(RequestMethod.GET);
    }
  });

  it('gates every handler on exactly `commerce.read` — the existing remit', () => {
    for (const handler of handlers()) {
      expect({ handler, roles: rolesOf(handler) }).toEqual({
        handler,
        roles: [Permissions.COMMERCE_READ],
      });
    }
  });

  it('declares the Commerce module AND purchase feature entitlement — the same chain Commerce’s own payment reads declare', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).toContain('@RequiresModule(COMMERCE_MODULE_ID)');
    expect(source).toContain('@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)');
    expect(source).toContain('ModuleEntitlementGuard');
    expect(source).toContain('JwtAuthGuard');
    expect(COMMERCE_MODULE_ID).toBe('commerce');
    expect(COMMERCE_FEATURE.PURCHASE).toBe('purchase');
  });

  it('carries no mutating decorator and no timeline route — the surface is read-only by construction', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/@(Post|Patch|Put|Delete)\(/);
    expect(source).not.toMatch(/@HttpCode\(/);
    // The absent route is asserted as an ABSENT route string (the header comment
    // documents the ruling, so a `/timeline/i` scan cannot serve here): a sibling-style
    // timeline that appeared would be a document-bound audit read lying by grain.
    expect(source).not.toContain("@Get(':id/timeline')");
  });
});
