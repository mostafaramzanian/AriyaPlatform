import { readFileSync } from 'fs';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { ProductionBomChangeReportController } from './production-bom-change-report.controller';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the report ROUTES as metadata — the same
 * style as the four sibling report controller specs.
 *
 * Checked here because these are the statements that break silently: a route added
 * without `@Roles`, a second permission widening one, or a mutating verb sneaking onto a
 * read-only report. The orchestration itself lives in
 * `production-bom-change-report.service.spec.ts`.
 */
describe('ProductionBomChangeReportController — five reads, one remit, no writes', () => {
  const proto = ProductionBomChangeReportController.prototype as unknown as Record<string, object>;

  const handlers = (): string[] =>
    Object.getOwnPropertyNames(ProductionBomChangeReportController.prototype).filter(
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

  it('gates every handler on exactly `production.bom.read` — the existing remit', () => {
    for (const handler of handlers()) {
      expect({ handler, roles: rolesOf(handler) }).toEqual({
        handler,
        roles: [Permissions.PRODUCTION_BOM_READ],
      });
    }
  });

  it('carries no mutating decorator — the surface is read-only by construction', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/@(Post|Patch|Put|Delete)\(/);
    expect(source).not.toMatch(/@HttpCode\(/);
  });

  it("declares the SAME entitlement chain as Production's own reads — production/bom", () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    const controller = readFileSync(
      __filename.replace(
        /production-bom-change-report\.controller\.spec\.ts$/,
        'production-bom-change-report.controller.ts'
      ),
      'utf8'
    );
    expect(controller).toContain('@RequiresModule(PRODUCTION_MODULE_ID)');
    expect(controller).toContain('@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)');
    expect(controller).not.toContain('rbac.module');
    expect(source.length).toBeGreaterThan(0);
  });
});
