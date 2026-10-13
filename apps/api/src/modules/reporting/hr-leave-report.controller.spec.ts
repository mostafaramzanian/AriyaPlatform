import { readFileSync } from 'fs';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { HrLeaveReportController } from './hr-leave-report.controller';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the report ROUTES as metadata — the same style
 * as the sibling report controller specs.
 *
 * Checked here because these are the statements that break silently: a route added
 * without `@Roles`, a second permission widening one, or a mutating verb sneaking onto
 * a read-only report. The orchestration itself lives in `hr-leave-report.service.spec.ts`.
 */
describe('HrLeaveReportController — five reads, one remit, no writes', () => {
  const proto = HrLeaveReportController.prototype as unknown as Record<string, object>;

  const handlers = (): string[] =>
    Object.getOwnPropertyNames(HrLeaveReportController.prototype).filter(
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

  it('gates every handler on exactly `hr.leave.read` — the existing remit', () => {
    for (const handler of handlers()) {
      expect({ handler, roles: rolesOf(handler) }).toEqual({
        handler,
        roles: [Permissions.HR_LEAVE_READ],
      });
    }
  });

  it('declares the HR module AND leave feature entitlement — the same chain HR’s own leave reads declare', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).toContain('@RequiresModule(HR_MODULE_ID)');
    expect(source).toContain('@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)');
    expect(source).toContain('ModuleEntitlementGuard');
    expect(source).toContain('JwtAuthGuard');
  });

  it('carries no mutating decorator — the surface is read-only by construction', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/@(Post|Patch|Put|Delete)\(/);
    expect(source).not.toMatch(/@HttpCode\(/);
  });
});
