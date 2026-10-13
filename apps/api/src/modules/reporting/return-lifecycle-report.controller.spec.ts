import { readFileSync } from 'fs';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce/commerce.constants';
import { ReturnLifecycleReportController } from './return-lifecycle-report.controller';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the report ROUTES as metadata — the same
 * style as the sibling report controller specs.
 *
 * FIVE reads, not four: list, both export formats, one row AND the timeline —
 * because the return audit trail is bound to the RETURN (`resourceId = return
 * document id`), so a per-row timeline answers exactly this row's history. A route
 * added without `@Roles`, a second permission widening one, or a mutating verb
 * sneaking onto a read-only report fails here first.
 */
describe('ReturnLifecycleReportController — five reads, one remit, no writes', () => {
  const proto = ReturnLifecycleReportController.prototype as unknown as Record<string, object>;

  const handlers = (): string[] =>
    Object.getOwnPropertyNames(ReturnLifecycleReportController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const methodOf = (handler: string): string | undefined =>
    Reflect.getMetadata(METHOD_METADATA, proto[handler]);

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  it('exposes exactly the five report reads — list, both export formats, one row, one timeline', () => {
    expect(handlers().sort()).toEqual(
      ['exportDocx', 'exportXlsx', 'getOne', 'getTimeline', 'list'].sort()
    );
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

  it('declares the Commerce module AND purchase feature entitlement — the same chain Commerce’s own return reads declare', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).toContain('@RequiresModule(COMMERCE_MODULE_ID)');
    expect(source).toContain('@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)');
    expect(source).toContain('ModuleEntitlementGuard');
    expect(source).toContain('JwtAuthGuard');
    expect(COMMERCE_MODULE_ID).toBe('commerce');
    expect(COMMERCE_FEATURE.PURCHASE).toBe('purchase');
  });

  it('carries no mutating decorator — the surface is read-only by construction', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/@(Post|Patch|Put|Delete)\(/);
    expect(source).not.toMatch(/@HttpCode\(/);
    // The timeline IS present — asserted as a PRESENT route string, so a `/timeline/i`
    // scan cannot serve here: the route is `commerce.return_document` bound to the
    // return id, the exact grain the contract proves.
    expect(source).toContain("@Get(':id/timeline')");
  });
});
