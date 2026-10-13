import { readFileSync } from 'fs';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { CheckRequestReportController } from './check-request-report.controller';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the report ROUTES as metadata —
 * the same style as `check-request.controller.spec.ts`.
 *
 * Checked here because these are the statements that break silently: a route
 * added without `@Roles`, a second permission widening one, or a mutating
 * verb sneaking onto a read-only report. The orchestration itself lives in
 * `check-request-report.service.spec.ts`.
 */
describe('CheckRequestReportController — three reads, one remit, no writes', () => {
  const proto = CheckRequestReportController.prototype as unknown as Record<string, object>;

  const handlers = (): string[] =>
    Object.getOwnPropertyNames(CheckRequestReportController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const methodOf = (handler: string): string | undefined =>
    Reflect.getMetadata(METHOD_METADATA, proto[handler]);

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  it('exposes exactly the five report reads — list, both export formats, one row, one timeline', () => {
    // REPORTING-VISUALIZATION-EXPORT added `export/xlsx` + `export/docx`: two more GETs
    // over the SAME DTO and remit — never a verb, never a second permission.
    expect(handlers().sort()).toEqual(
      ['exportDocx', 'exportXlsx', 'getOne', 'getTimeline', 'list'].sort()
    );
    for (const handler of handlers()) {
      expect(methodOf(handler)).toBe(RequestMethod.GET);
    }
  });

  it('gates every handler on exactly `financial.check.read` — the existing remit', () => {
    for (const handler of handlers()) {
      expect({ handler, roles: rolesOf(handler) }).toEqual({
        handler,
        roles: [Permissions.FINANCIAL_CHECK_READ],
      });
    }
  });

  it('carries no mutating decorator — the surface is read-only by construction', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/@(Post|Patch|Put|Delete)\(/);
    expect(source).not.toMatch(/@HttpCode\(/);
  });
});
