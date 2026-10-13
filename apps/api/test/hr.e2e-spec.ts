import { Test } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { ValidationError } from 'class-validator';
import { HrModule } from '../src/modules/hr/hr.module';
import { HrPrismaService } from '../src/modules/hr/database/hr-prisma.service';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaModule } from '../src/database/prisma.module';
import { RbacModule } from '../src/auth/rbac/rbac.module';
import { TenantModule } from '../src/tenant/tenant.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/rbac/guards/roles.guard';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { RequestContextMiddleware } from '../src/common/middleware/request-context.middleware';
import { RoleName } from '../src/generated/core-client';
import { Prisma } from '@prisma/client';

/**
 * Phase 51-HR-2 — Human Resources E2E against the REAL databases and the REAL
 * authorization stack.
 *
 * WHAT IS REAL HERE, AND WHY IT HAS TO BE
 * --------------------------------------
 *  * `hr_db` through `HR_DATABASE_URL` — the module's own client (`HrPrismaService`),
 *    not a stub. Every assertion about tenancy, interval overlap, the organization
 *    forest and the composite foreign keys is therefore an assertion about PostgreSQL.
 *  * `core_db` through the platform `PrismaService` — identities, tenants, seeded
 *    roles and the ONE audit trail.
 *  * The REAL `RolesGuard` + `PermissionService`. The only stubbed guard is
 *    `JwtAuthGuard`, replaced by a test guard that supplies identity in a header (the
 *    same technique as `correspondence.e2e-spec.ts`), so `@Roles(Permissions.HR_*)` is
 *    genuinely enforced against the grants seeded by
 *    `20260916100100_seed_hr_permission_grants`.
 *  * The REAL `TenantContextInterceptor`, which resolves the tenant from the
 *    authenticated principal in the database — the same path production uses, so "the
 *    actor's tenant" is not something this spec can choose for itself.
 *
 * THE TENANTS ARE DELIBERATELY NOT UUID-SHAPED
 * -------------------------------------------
 * `tenantAId` is `hr-a-<timestamp>`. That is the shape the platform itself uses:
 * `core_db."Tenant"."id"` is TEXT and the seeded tenant is the opaque `tenant-test-1`
 * (the canonical value lives in `test/fixtures/seed-environment.ts`). Phase
 * 51-HR-2's real-activation pass found HR declaring those columns as uuid, which made
 * every HR route fail (22P02) for exactly the tenants whose ids are not uuid-shaped;
 * `20260916120000_hr_tenant_identifier_text` fixed it. This spec pins the fix — if that
 * column type ever regresses, every test below fails, not just one.
 *
 * ACTORS, EACH PROVING A DIFFERENT EDGE
 * -------------------------------------
 *   adminA      — ADMIN in tenant A (holds the six hr.* grants). The writer.
 *   viewerA     — VISITOR in tenant A: authenticated, NO hr.* permission (403).
 *   tenantless  — a real user with no tenant: HR must fail closed (403), never fall
 *                 back to an unscoped read.
 *   adminB      — ADMIN in a SECOND tenant: structural invisibility.
 *
 * PHASE 51-HR-3 EXTENDS THIS SAME SPEC RATHER THAN STARTING A SECOND ONE
 * ---------------------------------------------------------------------
 * The attendance register is guarded by the SAME `RolesGuard`, resolved by the SAME
 * `resolveHrActor` and written to the SAME `hr_db`, so a separate suite would re-derive
 * the whole harness for no new coverage. Sections 9–11 below therefore continue the one
 * ordered run, reusing the actors and the tenant-A fixtures, and add the checks that are
 * specific to §13: the day is DERIVED, one `DEVICE` row per day, a correction is an
 * append that cannot reach the evidence, the Jalali `dateKey` is server-produced (§9);
 * PostgreSQL's OWN refusals — the composite key, the three CHECKs and `ON DELETE RESTRICT`
 * — FIRE for a writer that bypasses the service entirely (§10, through the ordinary Prisma
 * client rather than raw SQL, so the shapes asserted are the ones production sees); and the
 * trail records those ACTS, and nothing but them (§11).
 *
 * PHASE 51-HR-3A EXTENDS IT ONCE MORE, IN THE SAME ORDERED RUN
 * ----------------------------------------------------------
 * §12 adds leave — the tenant's OWN type catalogue and the request register — on the same actors,
 * the same tenant-A fixtures and the same two real databases. What is specific to it: two tenants
 * may hold the SAME catalogue code, because `LeaveType_tenantId_code_key` is unique PER TENANT
 * (a global index would turn one organization's vocabulary into another's exclusion); a request's
 * bounds round-trip as DAYS rather than as instants, so a stored `2026-09-18` cannot read as the
 * 17th to one reader; ONE transition exists (PENDING -> CANCELLED) and a withdrawn request is
 * therefore TERMINAL, which is why a second withdrawal and every restatement of it are refused;
 * and a retired type is refused for a NEW request while every request already recorded under it
 * keeps rendering its name. PostgreSQL's own refusals — BOTH composite foreign keys, the three
 * CHECKs, the catalogue's own two and its per-tenant uniqueness, and `ON DELETE RESTRICT` on both
 * sides — are measured through the ordinary client, the way §10 measures attendance's. §12.7 then
 * shows that the trail records ACTS (and that no `hr.leave.approve` exists to record: approval has
 * no route, no permission, no enum member and no column).
 */
class HrTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string | undefined;
    if (!userId) {
      throw new UnauthorizedException();
    }
    (req as unknown as { user: { sub: string; userId: string } }).user = { sub: userId, userId };
    return true;
  }
}

describe('HR E2E (organization, positions, personnel records, effective-dated employment, RBAC, tenant isolation)', () => {
  let app: INestApplication;
  /** CORE client — identity, tenants, roles, audit. */
  let prisma: PrismaService;
  /** The module's OWN client — every HR table. */
  let hrDb: HrPrismaService;

  const now = Date.now();
  const tenantAId = `hr-a-${now}`;
  const tenantBId = `hr-b-${now}`;

  let adminAId: string;
  let viewerAId: string;
  let noTenantAdminId: string;
  let adminBId: string;
  let coreUserAId: string;
  let coreUserBId: string;

  const createdUserIds: string[] = [];
  const createdAuditResourceIds: string[] = [];

  const makeUser = async (data: Record<string, unknown>) => {
    const user = await prisma.user.create({
      data: {
        email: `hr-${Math.random().toString(36).slice(2)}-${now}@example.com`,
        passwordHash: 'not-a-real-hash',
        ...data,
      } as Prisma.UserCreateInput,
    });
    createdUserIds.push(user.id);
    return user;
  };

  /** Grants a previously seeded role, so `RolesGuard` reads real `RolePermission` rows. */
  const grantRole = async (userId: string, roleName: RoleName) => {
    const role = await prisma.role.findFirst({ where: { name: roleName } });
    if (!role) throw new Error(`seeded role ${roleName} not found`);
    await prisma.userRole.create({ data: { userId, roleId: role.id } });
  };

  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const post = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).post(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const patch = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).patch(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  const del = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).delete(path);
    return userId ? req.set('x-user-id', userId) : req;
  };

  // Fixtures shared by the ordered cases below.
  let rootUnitA;
  let childUnitA;
  let unitB;
  let positionA;
  let positionA2;
  let positionB;
  let directorPositionId: string;
  let managerEmployee;
  let employeeOne;
  /** An employee of the SECOND tenant, created in §5 and read only cross-tenant in §7. */
  let employeeB;
  /** §9: the punch and, beside it, the correction that can never rewrite it. */
  let attendanceA;
  let attendanceManual;
  /**
   * §10: a person and a register row written by the ORDINARY Prisma client — no route, no
   * service, no audit — used to measure PostgreSQL's own refusals, and then (§11) to show that
   * the audit trail records ACTS rather than database writes.
   */
  let registerOnlyEmployee;
  let registerOnlyAttendance;
  /**
   * §12: leave. `leaveTypeA` and `leaveTypeB` deliberately carry the SAME code in TWO tenants —
   * the tenant-safe uniqueness the catalogue stands on — and the three requests below cover the
   * three shapes this phase owns: one that is RESTATED, one that is WITHDRAWN, and one whose
   * TYPE is later retired while the request keeps rendering its name.
   */
  let leaveTypeA;
  let leaveTypeB;
  /** A third entry, retired in §12 so "in use now" and "still addressable" can be told apart. */
  let retiredTypeA;
  let leaveRequestA;
  let leaveRequestSingle;
  let leaveRequestRetiredType;
  /** The tenant-B request, written by tenant B's administrator and read only cross-tenant below. */
  let leaveRequestB;
  /**
   * §12.6: a person and a request written by the ORDINARY Prisma client — no route, no service, no
   * audit — beside a TERMINATED person, used to measure PostgreSQL's own refusals and then (§12.7)
   * to show that the trail records ACTS rather than database writes.
   */
  let leaveDbEmployee;
  let leaveDbRequest;
  let terminatedEmployee;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // `TenantModule` supplies the `TenantResolver` port that the REAL
      // `TenantContextInterceptor` has depended on since 51-HR-ARCH-3A (it used to inject
      // `PrismaService` directly). It is imported rather than stubbed so the spec keeps
      // proving that the tenant HR acts on is resolved by PRODUCTION code — the same
      // interceptor `AppModule` and `CoreAppModule` register globally.
      imports: [HrModule, PrismaModule, RbacModule, TenantModule],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: HrTestGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();

    // The REAL production middleware (`AppModule` applies exactly this class to `*`). It is
    // not decoration here: it is what gives every request its OWN `requestId`, which
    // `resolveHrActor` forwards to `AuditService` — and `auditLog.requestId` is UNIQUE.
    // Without it, every audited write in this spec would reuse `resolveHrActor`'s constant
    // fallback (`'hr-request'`) and only the first audit row could ever persist, which
    // would make §13's "the audit call reaches real persistence" untestable through HTTP.
    const requestContext = new RequestContextMiddleware();
    app.use((req, res, next) => requestContext.use(req, res, next));

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors: ValidationError[]) =>
          new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: errors.map((error) => error.property),
          }),
      })
    );
    await app.init();

    prisma = app.get(PrismaService);
    hrDb = app.get(HrPrismaService);

    // Tenants whose ids are NOT uuid-shaped — exactly like the platform's own seed
    // (`tenant-test-1`, the shared fixture's `SEED_BOOTSTRAP_TENANT_ID`). See the
    // header: this is the condition 51-HR-2 had to fix.
    await prisma.tenant.create({ data: { id: tenantAId, code: `hr-a-${now}` } });
    await prisma.tenant.create({ data: { id: tenantBId, code: `hr-b-${now}` } });

    adminAId = (await makeUser({ tenantId: tenantAId, firstName: 'مدیر', lastName: 'الف' })).id;
    viewerAId = (await makeUser({ tenantId: tenantAId, firstName: 'بیننده', lastName: 'الف' })).id;
    // The user is created for coverage; the id capture was never read.
    await makeUser({ firstName: 'بدون‌سازمان', lastName: 'آزمون' });
    // Holds the HR grants but belongs to NO tenant: the only actor that can reach
    // `resolveHrActor`'s fail-closed branch (RolesGuard passes, the actor does not).
    noTenantAdminId = (await makeUser({ firstName: 'بی‌سازمان', lastName: 'مدیر' })).id;
    adminBId = (await makeUser({ tenantId: tenantBId, firstName: 'مدیر', lastName: 'ب' })).id;
    coreUserAId = (await makeUser({ tenantId: tenantAId, firstName: 'کارمند', lastName: 'الف' }))
      .id;
    coreUserBId = (await makeUser({ tenantId: tenantBId, firstName: 'کارمند', lastName: 'ب' })).id;

    await grantRole(adminAId, 'ADMIN');
    await grantRole(viewerAId, 'VISITOR');
    await grantRole(adminBId, 'ADMIN');
    await grantRole(noTenantAdminId, 'ADMIN');
  });

  afterAll(async () => {
    if (hrDb) {
      // LEAVE FIRST, for the same reason as attendance and more besides:
      // `LeaveRequest_tenant_employee_fkey` AND `LeaveRequest_tenant_leave_type_fkey` are both
      // `ON DELETE RESTRICT`, so a request outlives the employee it names and the type it was
      // recorded under — and the teardown deletes in dependency order rather than pretending any
      // of it cascades.
      await hrDb.leaveRequest.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await hrDb.leaveType.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      // ATTENDANCE NEXT. `Attendance_tenant_employee_fkey` is `ON DELETE RESTRICT`, so a
      // register row outlives its employee BY DESIGN (§10) — and the teardown has to
      // respect that ordering rather than pretend the delete cascades.
      await hrDb.attendance.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await hrDb.employmentRecord.deleteMany({
        where: { tenantId: { in: [tenantAId, tenantBId] } },
      });
      await hrDb.employee.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await hrDb.position.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await hrDb.organizationUnit.deleteMany({
        where: { tenantId: { in: [tenantAId, tenantBId] } },
      });
    }
    if (prisma) {
      if (createdAuditResourceIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { resourceId: { in: createdAuditResourceIds } },
        });
      }
      if (createdUserIds.length > 0) {
        await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    }
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Authorization: 401, 403, and the fail-closed actor
  // ---------------------------------------------------------------------------

  it('answers 401 for an unauthenticated caller on every HR route', async () => {
    for (const path of [
      '/hr/employees',
      '/hr/organization',
      '/hr/positions',
      '/hr/attendance',
      // Phase 51-HR-3A: the leave register and the tenant's own catalogue are two more
      // namespaces, and neither is exempt from the global guard stack.
      '/hr/leave-requests',
      '/hr/leave-types',
    ]) {
      expect((await get(path)).status).toBe(401);
    }
    expect((await post('/hr/employees')).status).toBe(401);
    expect((await post('/hr/attendance/clock-in')).status).toBe(401);
    expect((await post('/hr/leave-requests')).status).toBe(401);
    expect((await post('/hr/leave-types')).status).toBe(401);
  });

  it('answers 403 for an authenticated caller WITHOUT the hr.* permission', async () => {
    expect((await get('/hr/employees', viewerAId)).status).toBe(403);
    expect((await get('/hr/organization', viewerAId)).status).toBe(403);
    expect((await get('/hr/positions', viewerAId)).status).toBe(403);
    expect((await get('/hr/attendance', viewerAId)).status).toBe(403);
    // `hr.leave.read` and `hr.leave.manage` are two MORE strings the visitor does not hold:
    // the leave surface is not covered by the attendance grants, or by anything else.
    expect((await get('/hr/leave-requests', viewerAId)).status).toBe(403);
    expect((await get('/hr/leave-types', viewerAId)).status).toBe(403);

    const deniedWrite = await post('/hr/employees', viewerAId).send({
      employeeCode: `NOPE-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2026-01-01',
      organizationUnitId: '00000000-0000-4000-8000-000000000000',
      positionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(deniedWrite.status).toBe(403);

    // The 403 is authorization, not a validation accident: nothing was written.
    expect(await hrDb.employee.count({ where: { tenantId: tenantAId } })).toBe(0);
    // …and the leave WRITE path is refused the same way: a type is a mutation too, and the
    // refusal happens before the body is looked at.
    const deniedLeaveWrite = await post('/hr/leave-types', viewerAId).send({
      code: `NOPE-${now}`,
      name: 'نامعتبر',
    });
    expect(deniedLeaveWrite.status).toBe(403);
    expect(await hrDb.leaveType.count()).toBe(0);
    expect(await hrDb.leaveRequest.count()).toBe(0);
  });

  it('fails CLOSED when the caller has the grants but no resolvable tenant', async () => {
    expect((await get('/hr/employees', noTenantAdminId)).status).toBe(403);
    expect((await get('/hr/organization', noTenantAdminId)).status).toBe(403);
    expect((await get('/hr/positions', noTenantAdminId)).status).toBe(403);
    expect((await get('/hr/attendance', noTenantAdminId)).status).toBe(403);
    expect((await get('/hr/leave-requests', noTenantAdminId)).status).toBe(403);
    expect((await get('/hr/leave-types', noTenantAdminId)).status).toBe(403);

    // The WRITE path fails closed too, and — crucially — it is refused BEFORE any employee
    // lookup: the actor cannot even name a subject, because naming one would require a
    // tenant to scope it by. Nothing is written, in either database.
    const untenantedPunch = await post('/hr/attendance/clock-in', noTenantAdminId).send({
      employeeId: '00000000-0000-4000-8000-000000000000',
    });
    expect(untenantedPunch.status).toBe(403);
    expect(await hrDb.attendance.count()).toBe(0);

    // The same for leave, where the subject would have to be resolved through a tenant-scoped
    // read: no tenant means no employee to name and no type to choose, so the refusal precedes
    // both lookups.
    const untenantedRequest = await post('/hr/leave-requests', noTenantAdminId).send({
      employeeId: '00000000-0000-4000-8000-000000000000',
      leaveTypeId: '00000000-0000-4000-8000-000000000000',
      startDate: '2026-02-10',
      endDate: '2026-02-11',
      reason: 'بیسازمان',
    });
    expect(untenantedRequest.status).toBe(403);
    expect(await hrDb.leaveRequest.count()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Organization: the real hierarchy, cycle refusal, tenancy
  // ---------------------------------------------------------------------------

  it('creates a root and a child unit, and reports both in the tree, the summary and a filtered list', async () => {
    const root = await post('/hr/organization/units', adminAId).send({
      code: `FIN-${now}`,
      name: 'امور مالی',
    });
    expect(root.status).toBe(201);
    // The non-uuid tenant id round-trips through PostgreSQL — the 51-HR-2 fix.
    expect(root.body.tenantId).toBe(tenantAId);
    rootUnitA = root.body;
    createdAuditResourceIds.push(rootUnitA.id);

    const child = await post('/hr/organization/units', adminAId).send({
      code: `FIN-PAY-${now}`,
      name: 'حقوق و دستمزد',
      parentId: rootUnitA.id,
    });
    expect(child.status).toBe(201);
    childUnitA = child.body;
    createdAuditResourceIds.push(childUnitA.id);

    const tree = await get('/hr/organization', adminAId);
    expect(tree.status).toBe(200);
    expect(tree.body.total).toBe(2);
    const rootNode = tree.body.roots.find((node) => node.id === rootUnitA.id);
    expect(rootNode).toBeDefined();
    expect(rootNode.children.map((node) => node.id)).toEqual([childUnitA.id]);

    const summary = await get('/hr/organization/summary', adminAId);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      units: 2,
      activeUnits: 2,
      positions: 0,
      employees: 0,
    });

    const units = await get('/hr/organization/units?search=PAY', adminAId);
    expect(units.status).toBe(200);
    expect(units.body.items.map((unit) => unit.code)).toEqual([`FIN-PAY-${now}`]);
  });

  it('refuses a self-parent and a cycle re-parent with 409, and a cross-tenant parent with 404', async () => {
    const selfParent = await patch(`/hr/organization/units/${rootUnitA.id}`, adminAId).send({
      parentId: rootUnitA.id,
    });
    expect(selfParent.status).toBe(409);

    // Move the ROOT under its own child: A -> B -> A. Each edge alone looks legal.
    const cycle = await patch(`/hr/organization/units/${rootUnitA.id}`, adminAId).send({
      parentId: childUnitA.id,
    });
    expect(cycle.status).toBe(409);

    const createdB = await post('/hr/organization/units', adminBId).send({
      code: `B-UNIT-${now}`,
      name: 'واحد ب',
    });
    expect(createdB.status).toBe(201);
    unitB = createdB.body;
    createdAuditResourceIds.push(unitB.id);

    // A unit of ANOTHER tenant is invisible: 404, never 403 (no existence leak).
    const crossTenantParent = await post('/hr/organization/units', adminAId).send({
      code: `FIN-X-${now}`,
      name: 'نامعتبر',
      parentId: unitB.id,
    });
    expect(crossTenantParent.status).toBe(404);

    expect((await get(`/hr/organization/units/${unitB.id}`, adminAId)).status).toBe(404);
  });

  it('answers 409 — not 500 — for a duplicate unit code, and only within its own tenant', async () => {
    // 51-HR-2: `OrganizationUnit_tenantId_code_key` is the arbiter of uniqueness, and its
    // violation used to escape as a raw Prisma `P2002`. This runtime registers no global
    // exception filter, so the client received **500 `DATABASE_ERROR`** for what is plainly
    // a conflict — the wrong status, and the wrong instruction: a 5xx asks a caller to retry
    // the one request that can never succeed. Measured before the fix, against this same
    // live API: `POST /hr/organization/units` with an existing code → 500.
    const duplicate = await post('/hr/organization/units', adminAId).send({
      code: `FIN-${now}`,
      name: 'امور مالی (تکراری)',
    });
    expect(duplicate.status).toBe(409);
    // The refusal names the problem instead of reporting an internal error.
    expect(String(duplicate.body.message)).toContain('already exists');
    // …and nothing was written: one row with that code, not two.
    expect(
      await hrDb.organizationUnit.count({ where: { tenantId: tenantAId, code: `FIN-${now}` } })
    ).toBe(1);
    expect((await get('/hr/organization', adminAId)).body.total).toBe(2);

    // The conflict is PER TENANT, exactly as the composite unique index declares: the same
    // code in another tenant's catalogue is a different unit in a different organisation.
    // A GLOBAL unique would have made this call a 409 and stopped two tenants from sharing
    // the obvious code `FIN` — which is the tenancy bug the schema deliberately avoids.
    const sameCodeInB = await post('/hr/organization/units', adminBId).send({
      code: `FIN-${now}`,
      name: 'امور مالی واحد ب',
    });
    expect(sameCodeInB.status).toBe(201);
    expect(sameCodeInB.body.tenantId).toBe(tenantBId);
    createdAuditResourceIds.push(sameCodeInB.body.id);
  });

  it('has NO delete route for a unit: a retired unit stays addressable', async () => {
    expect((await del(`/hr/organization/units/${childUnitA.id}`, adminAId)).status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 3. Positions: the catalogue
  // ---------------------------------------------------------------------------

  it('creates positions in a unit of the SAME tenant and cannot reference a foreign unit', async () => {
    const first = await post('/hr/positions', adminAId).send({
      code: `POS-ACC-${now}`,
      title: 'کارشناس ارشد حسابداری',
      organizationUnitId: childUnitA.id,
    });
    expect(first.status).toBe(201);
    expect(first.body.organizationUnitId).toBe(childUnitA.id);
    expect(first.body.tenantId).toBe(tenantAId);
    positionA = first.body;
    createdAuditResourceIds.push(positionA.id);

    // The DETAIL read is what resolves the unit, so a screen does not need a second call.
    const readBack = await get(`/hr/positions/${positionA.id}`, adminAId);
    expect(readBack.status).toBe(200);
    expect(readBack.body.organizationUnit).toMatchObject({
      id: childUnitA.id,
      code: `FIN-PAY-${now}`,
      name: 'حقوق و دستمزد',
    });

    const second = await post('/hr/positions', adminAId).send({
      code: `POS-CLRK-${now}`,
      title: 'کارپرداز',
      organizationUnitId: childUnitA.id,
    });
    expect(second.status).toBe(201);
    positionA2 = second.body;
    createdAuditResourceIds.push(positionA2.id);

    const foreign = await post('/hr/positions', adminAId).send({
      code: `POS-X-${now}`,
      title: 'نامعتبر',
      organizationUnitId: unitB.id,
    });
    expect(foreign.status).toBe(404);

    const inB = await post('/hr/positions', adminBId).send({
      code: `B-POS-${now}`,
      title: 'سمت ب',
      organizationUnitId: unitB.id,
    });
    expect(inB.status).toBe(201);
    positionB = inB.body;
    createdAuditResourceIds.push(positionB.id);
  });

  it('lists positions with real filters and a deterministic order, and a move keeps history intact', async () => {
    const all = await get('/hr/positions', adminAId);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items.map((p) => p.code).sort()).toEqual(
      [`POS-ACC-${now}`, `POS-CLRK-${now}`].sort()
    );

    const byUnit = await get(`/hr/positions?organizationUnitId=${childUnitA.id}`, adminAId);
    expect(byUnit.body.total).toBe(2);

    // A Persian title is a real search term, and it must be URL-ENCODED: superagent (and
    // every HTTP client) rejects raw non-ASCII bytes in a request path.
    const bySearch = await get(`/hr/positions?search=${encodeURIComponent('حسابداری')}`, adminAId);
    expect(bySearch.body.total).toBe(1);
    expect(bySearch.body.items[0].id).toBe(positionA.id);

    // A move re-labels the slot: employment history keeps pointing at the same position id.
    const moved = await patch(`/hr/positions/${positionA2.id}`, adminAId).send({
      organizationUnitId: rootUnitA.id,
      title: 'کارپرداز ارشد',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.organizationUnitId).toBe(rootUnitA.id);

    const retired = await patch(`/hr/positions/${positionA2.id}/status`, adminAId).send({
      status: 'INACTIVE',
    });
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe('INACTIVE');
    expect((await del(`/hr/positions/${positionA2.id}`, adminAId)).status).toBe(404);
  });

  it('answers 409 — not 500 — for a duplicate position code, while a repeated TITLE stays legal', async () => {
    // The same defect as the organization units above, on the other unique index:
    // `Position_tenantId_code_key`. `POST /hr/positions` with an existing code answered
    // **500** before the fix, because a raw Prisma `P2002` has no translator in this
    // runtime. A duplicate code is a conflict the caller can resolve.
    const duplicate = await post('/hr/positions', adminAId).send({
      code: `POS-ACC-${now}`,
      title: 'سمت تکراری',
      organizationUnitId: childUnitA.id,
    });
    expect(duplicate.status).toBe(409);
    expect(String(duplicate.body.message)).toContain('already exists');
    expect(
      await hrDb.position.count({ where: { tenantId: tenantAId, code: `POS-ACC-${now}` } })
    ).toBe(1);

    // ONLY the code is unique. This third slot carries the SAME title as `positionA` in the
    // SAME unit and is accepted, because "کارشناس ارشد حسابداری" is a perfectly ordinary
    // title for more than one slot — a unique on `title` would turn that into a collision
    // and make a legitimate catalogue impossible to express.
    const sameTitle = await post('/hr/positions', adminAId).send({
      code: `POS-ACC-B-${now}`,
      title: 'کارشناس ارشد حسابداری',
      organizationUnitId: childUnitA.id,
    });
    expect(sameTitle.status).toBe(201);
    expect(sameTitle.body.organizationUnitId).toBe(childUnitA.id);
    createdAuditResourceIds.push(sameTitle.body.id);
  });

  // ---------------------------------------------------------------------------
  // 4. Personnel records: create WITH the first interval, list, filter, update
  // ---------------------------------------------------------------------------

  it('creates a record with its first employment interval, normalising the code', async () => {
    const manager = await post('/hr/employees', adminAId).send({
      employeeCode: `MG-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2020-01-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
    });
    expect(manager.status).toBe(201);
    managerEmployee = manager.body;
    createdAuditResourceIds.push(managerEmployee.id);

    const created = await post('/hr/employees', adminAId).send({
      // Lowercase on purpose: the NORMALISED code is what the unique index stores.
      employeeCode: `e-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-04-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
      managerEmployeeId: managerEmployee.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.employeeCode).toBe(`E-${now}`);
    expect(created.body.status).toBe('ACTIVE');
    employeeOne = created.body;
    createdAuditResourceIds.push(employeeOne.id);

    // The interval exists in hr_db: an Employee IS the subject of its intervals.
    expect(await hrDb.employmentRecord.count({ where: { employeeId: employeeOne.id } })).toBe(1);

    // The same code in its other case collides on the UNIQUE index as a 409, not a 500.
    const duplicate = await post('/hr/employees', adminAId).send({
      employeeCode: `E-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-04-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
    });
    expect(duplicate.status).toBe(409);
  });

  it('lists records with the CURRENT assignment resolved, and filters on real domain fields', async () => {
    const all = await get('/hr/employees', adminAId);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    // Deterministic ordering: (employeeCode, id), so a page never reshuffles.
    expect(all.body.items.map((row) => row.employeeCode)).toEqual([`E-${now}`, `MG-${now}`]);

    const row = all.body.items[0];
    // No Core login is linked yet — a normal state, not an error (§16).
    expect(row.identity).toBeNull();
    expect(row.currentAssignment.organizationUnit.id).toBe(childUnitA.id);
    expect(row.currentAssignment.position.id).toBe(positionA.id);
    expect(row.currentAssignment.managerEmployeeId).toBe(managerEmployee.id);
    // History is the DETAIL read only; the list must not ship every interval of every row.
    expect(row).not.toHaveProperty('employmentHistory');

    expect((await get(`/hr/employees?search=MG-${now}`, adminAId)).body.total).toBe(1);
    expect((await get('/hr/employees?status=TERMINATED', adminAId)).body.total).toBe(0);
    expect((await get('/hr/employees?status=ACTIVE', adminAId)).body.total).toBe(2);
    expect(
      (await get(`/hr/employees?organizationUnitId=${childUnitA.id}`, adminAId)).body.total
    ).toBe(2);
    expect((await get(`/hr/employees?positionId=${positionA.id}`, adminAId)).body.total).toBe(2);

    // Pagination is a real window over that same deterministic order.
    const pageTwo = await get('/hr/employees?pageSize=1&page=2', adminAId);
    expect(pageTwo.body.total).toBe(2);
    expect(pageTwo.body.items).toHaveLength(1);
    expect(pageTwo.body.items[0].employeeCode).toBe(`MG-${now}`);

    // An absurd page size is refused by the DTO instead of silently truncating.
    expect((await get('/hr/employees?pageSize=100000', adminAId)).status).toBe(422);
  });

  it('updates a record, links identity through the ONE boundary, and refuses a foreign login', async () => {
    const inactive = await patch(`/hr/employees/${employeeOne.id}`, adminAId).send({
      status: 'INACTIVE',
    });
    expect(inactive.status).toBe(200);
    expect(inactive.body.status).toBe('INACTIVE');

    const active = await patch(`/hr/employees/${employeeOne.id}`, adminAId).send({
      status: 'ACTIVE',
    });
    expect(active.body.status).toBe('ACTIVE');

    // TERMINATED is not a status an administrator may type: /terminate produces it.
    expect(
      (await patch(`/hr/employees/${employeeOne.id}`, adminAId).send({ status: 'TERMINATED' }))
        .status
    ).toBe(422);

    // Linking a login OF MY TENANT succeeds and the detail read projects it by name.
    const linked = await patch(`/hr/employees/${employeeOne.id}`, adminAId).send({
      userId: coreUserAId,
    });
    expect(linked.status).toBe(200);

    const detail = await get(`/hr/employees/${employeeOne.id}`, adminAId);
    expect(detail.status).toBe(200);
    expect(detail.body.identity).toMatchObject({ id: coreUserAId, firstName: 'کارمند' });
    expect(Array.isArray(detail.body.employmentHistory)).toBe(true);
    expect(detail.body.employmentHistory).toHaveLength(1);

    // A login of ANOTHER tenant is refused with a generic 400 — never a 404 or a 403,
    // either of which would confirm whether the id exists somewhere else.
    const foreignLink = await patch(`/hr/employees/${employeeOne.id}`, adminAId).send({
      userId: coreUserBId,
    });
    expect(foreignLink.status).toBe(400);

    // `tenantId` is not expressible in any HR contract: the global pipe rejects the field.
    const spoofed = await patch(`/hr/employees/${employeeOne.id}`, adminAId).send({
      tenantId: tenantBId,
    });
    expect([400, 422]).toContain(spoofed.status);
  });

  // ---------------------------------------------------------------------------
  // 5. Employment lifecycle: transfer, terminate, rehire — history is APPENDED
  // ---------------------------------------------------------------------------

  it('records a transfer as a NEW interval and closes the previous one the day before', async () => {
    const director = await post('/hr/positions', adminAId).send({
      code: `POS-DIR-${now}`,
      title: 'مدیر امور مالی',
      organizationUnitId: rootUnitA.id,
    });
    expect(director.status).toBe(201);
    directorPositionId = director.body.id;
    createdAuditResourceIds.push(directorPositionId);

    const transfer = await post(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'FULL_TIME',
      startDate: '2025-06-01',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
    });
    expect(transfer.status).toBe(201);
    expect(transfer.body).toMatchObject({
      employeeId: employeeOne.id,
      tenantId: tenantAId,
      startDate: '2025-06-01',
      endDate: null,
      status: 'ACTIVE',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
      // The manager link belonged to the interval that just closed: an interval that names
      // no manager must not silently inherit the previous one.
      managerEmployeeId: null,
    });
    createdAuditResourceIds.push(transfer.body.id);

    const history = await get(`/hr/employees/${employeeOne.id}/employment-records`, adminAId);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(2);

    // Newest first: the open interval, then the one that was closed by the transfer.
    const [openNow, previous] = history.body;
    expect(openNow.id).toBe(transfer.body.id);
    expect(openNow.endDate).toBeNull();
    expect(openNow.status).toBe('ACTIVE');

    // NO HISTORICAL OVERWRITE. The closed interval still names the unit, the position and
    // the manager it actually had, and its end is the day BEFORE the new interval began.
    expect(previous).toMatchObject({
      startDate: '2024-04-01',
      endDate: '2025-05-31',
      status: 'ENDED',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
      managerEmployeeId: managerEmployee.id,
    });

    // The DETAIL read derives the current assignment from the open interval…
    const detail = await get(`/hr/employees/${employeeOne.id}`, adminAId);
    expect(detail.body.currentAssignment).toMatchObject({
      id: transfer.body.id,
      organizationUnit: { id: rootUnitA.id, code: `FIN-${now}` },
      position: { id: directorPositionId, code: `POS-DIR-${now}` },
    });
    expect(detail.body.employmentHistory).toHaveLength(2);

    // …and the LIST read agrees, while still withholding the per-row history.
    const row = (await get(`/hr/employees?search=${employeeOne.employeeCode}`, adminAId)).body
      .items[0];
    expect(row).toBeDefined();
    expect(row.currentAssignment.organizationUnit.id).toBe(rootUnitA.id);
    expect(row.currentAssignment.position.id).toBe(directorPositionId);
    expect(row).not.toHaveProperty('employmentHistory');
  });

  it('refuses a backdated interval, a self-manager, a manager cycle and a foreign reference', async () => {
    // 1. A new interval must start STRICTLY AFTER the open one began (2025-06-01). Same
    //    day is refused: the old interval would have nowhere to exist.
    const backdated = await post(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'PART_TIME',
      startDate: '2025-06-01',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
    });
    expect(backdated.status).toBe(409);

    // 2. Nobody manages themselves: the cycle walk starts AT the candidate manager.
    const selfManager = await post(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'PART_TIME',
      startDate: '2026-03-01',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
      managerEmployeeId: employeeOne.id,
    });
    expect(selfManager.status).toBe(409);

    // 3. A TWO-EDGE cycle, which no single check could see. First make the manager report
    //    to the employee (manager → employee is legal on its own)…
    const managerMoved = await post(
      `/hr/employees/${managerEmployee.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'FULL_TIME',
      startDate: '2025-07-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
      managerEmployeeId: employeeOne.id,
    });
    expect(managerMoved.status).toBe(201);
    createdAuditResourceIds.push(managerMoved.body.id);

    // …then employee → manager would close the loop, and IS refused.
    const cycle = await post(`/hr/employees/${employeeOne.id}/employment-records`, adminAId).send({
      employmentType: 'PART_TIME',
      startDate: '2025-08-01',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
      managerEmployeeId: managerEmployee.id,
    });
    expect(cycle.status).toBe(409);

    // 4. A SECOND tenant's employee is not a candidate manager, and its unit is not a
    //    reference. Both are 404 — absent — never 403, which would confirm that something
    //    exists there. This is also where tenant B gets its personnel record.
    const inB = await post('/hr/employees', adminBId).send({
      employeeCode: `B-EMP-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-01-01',
      organizationUnitId: unitB.id,
      positionId: positionB.id,
    });
    expect(inB.status).toBe(201);
    employeeB = inB.body;
    createdAuditResourceIds.push(employeeB.id);

    const foreignManager = await post(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'PART_TIME',
      startDate: '2026-03-01',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
      managerEmployeeId: employeeB.id,
    });
    expect(foreignManager.status).toBe(404);

    const foreignReference = await post(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'PART_TIME',
      startDate: '2026-03-01',
      organizationUnitId: unitB.id,
      positionId: positionB.id,
    });
    expect(foreignReference.status).toBe(404);

    // NOT ONE of the six refusals wrote an interval. Each is a bounded pre-check that runs
    // before `openInterval`'s transaction, so a refused transfer leaves no partial history.
    expect(await hrDb.employmentRecord.count({ where: { employeeId: employeeOne.id } })).toBe(2);
  });

  it('terminates on a chosen date, then rehires by APPENDING, and never erases the gap', async () => {
    // A termination is effective on a date the ORGANIZATION chose — never `now()`.
    const terminated = await post(`/hr/employees/${employeeOne.id}/terminate`, adminAId).send({
      endDate: '2025-12-31',
      reason: 'پایان قرارداد',
    });
    expect(terminated.status).toBe(200);
    expect(terminated.body.employee.status).toBe('TERMINATED');
    expect(terminated.body.closedRecord).toMatchObject({
      id: expect.any(String),
      endDate: '2025-12-31',
      status: 'ENDED',
    });

    // Nothing was deleted and nothing was rewritten: the first interval is untouched, and
    // no interval is left open.
    const afterTerminate = await get(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    );
    expect(afterTerminate.body).toHaveLength(2);
    expect(afterTerminate.body.some((record) => record.endDate === null)).toBe(false);
    expect(afterTerminate.body[1].endDate).toBe('2025-05-31');

    // A second termination is a 409, not a silent no-op: there is no open interval to end.
    const doubleTerminate = await post(`/hr/employees/${employeeOne.id}/terminate`, adminAId).send({
      endDate: '2026-01-01',
    });
    expect(doubleTerminate.status).toBe(409);

    // …and a TRANSFER of a terminated person is refused rather than quietly reopening them.
    const transferWhileTerminated = await post(
      `/hr/employees/${employeeOne.id}/employment-records`,
      adminAId
    ).send({
      employmentType: 'FULL_TIME',
      startDate: '2026-01-15',
      organizationUnitId: rootUnitA.id,
      positionId: directorPositionId,
    });
    expect(transferWhileTerminated.status).toBe(409);

    // REHIRE APPENDS. It does NOT reopen the closed interval, so January remains visibly a
    // gap between the two engagements — which is exactly what an append-only history is for.
    const rehire = await post(`/hr/employees/${employeeOne.id}/rehire`, adminAId).send({
      employmentType: 'CONTRACT',
      startDate: '2026-02-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
    });
    expect(rehire.status).toBe(201);
    expect(rehire.body.employee.status).toBe('ACTIVE');
    expect(rehire.body.record).toMatchObject({
      startDate: '2026-02-01',
      endDate: null,
      status: 'ACTIVE',
      employmentType: 'CONTRACT',
    });
    createdAuditResourceIds.push(rehire.body.record.id);

    const detail = await get(`/hr/employees/${employeeOne.id}`, adminAId);
    expect(detail.body.status).toBe('ACTIVE');
    expect(detail.body.employmentHistory).toHaveLength(3);
    // Newest first: the rehire, the terminated interval, then the original engagement.
    expect(detail.body.employmentHistory.map((record) => record.startDate)).toEqual([
      '2026-02-01',
      '2025-06-01',
      '2024-04-01',
    ]);
    expect(detail.body.employmentHistory.map((record) => record.endDate)).toEqual([
      null,
      '2025-12-31',
      '2025-05-31',
    ]);
    // The current assignment follows the NEW interval, not the one that had to be closed.
    expect(detail.body.currentAssignment).toMatchObject({
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
      employmentType: 'CONTRACT',
    });

    // Rehiring somebody who is already ACTIVE is a different act with a different
    // endpoint, so it is refused instead of opening a second parallel engagement.
    const doubleRehire = await post(`/hr/employees/${employeeOne.id}/rehire`, adminAId).send({
      employmentType: 'CONTRACT',
      startDate: '2026-04-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
    });
    expect(doubleRehire.status).toBe(409);
  });

  // ---------------------------------------------------------------------------
  // 6. §13 — the semantic audit calls reach REAL persistence in `core_db`
  // ---------------------------------------------------------------------------
  //
  // HR-1 already CALLED `AuditService` with the right semantics. This section proves the
  // calls arrive: the rows are read back from `core_db."AuditLog"` through the platform
  // client, after being produced by real HTTP requests against real databases. Nothing
  // here is a local buffer or a spy.

  it('persists an HR audit row for every mutation, with the real actor, resource and request id', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { resourceId: { in: createdAuditResourceIds } },
      orderBy: [{ createdAt: 'asc' }],
    });
    const forResource = (resourceType: string, action: string, resourceId: string) =>
      rows.filter(
        (row) =>
          row.resourceType === resourceType &&
          row.action === action &&
          row.resourceId === resourceId
      );

    // Every mutation §13 names, carrying its DOMAIN action rather than a generic 'update'.
    expect(forResource('hr.employee', 'create', employeeOne.id)).toHaveLength(1);
    expect(forResource('hr.employee', 'create', managerEmployee.id)).toHaveLength(1);
    expect(forResource('hr.employee', 'update', employeeOne.id).length).toBeGreaterThanOrEqual(3);
    expect(forResource('hr.employee', 'terminate', employeeOne.id)).toHaveLength(1);
    expect(forResource('hr.employee', 'rehire', employeeOne.id)).toHaveLength(1);
    expect(forResource('hr.organization_unit', 'create', rootUnitA.id)).toHaveLength(1);
    expect(forResource('hr.organization_unit', 'create', childUnitA.id)).toHaveLength(1);
    expect(forResource('hr.position', 'create', positionA.id)).toHaveLength(1);
    expect(forResource('hr.position', 'update', positionA2.id)).toHaveLength(1);
    expect(forResource('hr.position', 'deactivate', positionA2.id)).toHaveLength(1);

    // A TRANSFER is audited against the INTERVAL it created — and that id is a REAL row in
    // `hr_db`, in the ACTOR's tenant. The audit trail and the personnel file agree.
    const transfers = rows.filter(
      (row) => row.resourceType === 'hr.employment_record' && row.action === 'transfer'
    );
    expect(transfers).toHaveLength(2);
    for (const row of transfers) {
      const record = await hrDb.employmentRecord.findUnique({ where: { id: row.resourceId } });
      expect(record).not.toBeNull();
      expect(record!.tenantId).toBe(tenantAId);
    }
    // The employee's transfer names BOTH sides: the unit left and the unit joined.
    const employeeTransfer = transfers.find(
      (row) =>
        (row.newValue as { organizationUnitId?: string } | null)?.organizationUnitId ===
        rootUnitA.id
    );
    expect(employeeTransfer).toBeDefined();
    expect(
      (employeeTransfer!.oldValue as { organizationUnitId?: string } | null)?.organizationUnitId
    ).toBe(childUnitA.id);

    // ACTOR AND TENANT. `AuditLog` has NO `tenantId` column — there is ONE audit trail for
    // the platform — so tenancy is established by the ACTOR *and* by the RESOURCE. Both are
    // checked: the actor is a Core identity of tenant A, and every resource it touched is a
    // tenant-A row in `hr_db`.
    const tenantARows = [
      ...forResource('hr.employee', 'create', employeeOne.id),
      ...forResource('hr.employee', 'terminate', employeeOne.id),
      ...forResource('hr.employee', 'rehire', employeeOne.id),
      ...forResource('hr.organization_unit', 'create', rootUnitA.id),
      ...forResource('hr.position', 'create', positionA.id),
      employeeTransfer!,
    ];
    for (const row of tenantARows) {
      expect(row.userId).toBe(adminAId);
    }
    expect(
      await prisma.user.findFirst({ where: { id: adminAId, tenantId: tenantAId } })
    ).not.toBeNull();

    // …and the OTHER tenant's write, in the same run, carries the OTHER tenant's actor:
    // the actor is per-request, not a constant.
    expect(forResource('hr.employee', 'create', employeeB.id)[0].userId).toBe(adminBId);
    expect(
      await prisma.user.findFirst({ where: { id: adminBId, tenantId: tenantBId } })
    ).not.toBeNull();

    // REQUEST IDENTITY. Every row carries the per-request id minted by the REAL production
    // middleware — not `resolveHrActor`'s constant fallback, which would have collided on
    // the UNIQUE index of `auditLog.requestId` after the very first write and silently
    // dropped the rest (AuditService swallows persistence errors by design).
    const requestIds = new Set(rows.map((row) => row.requestId));
    expect(requestIds.size).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.requestId).not.toBe('hr-request');
      expect(row.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(row.success).toBe(true);
    }

    // NO CREDENTIALS AND NO IDENTITY DATA IN THE TRAIL: the payloads carry HR facts and
    // opaque Core ids only — never a password hash, never an email, never a token.
    const payloads = JSON.stringify(
      rows.map((row) => ({ old: row.oldValue, next: row.newValue, reason: row.reason }))
    );
    expect(payloads).not.toMatch(/password/i);
    expect(payloads).not.toContain('not-a-real-hash');
    expect(payloads).not.toContain('@example.com');
    expect(payloads).not.toMatch(/token/i);

    // ONE audit trail: HR owns no audit table of its own, so `HrPrismaService` has no
    // `auditLog` delegate at all.
    expect((hrDb as unknown as Record<string, unknown>).auditLog).toBeUndefined();
  });

  it('never emits a success audit event for a mutation that was REFUSED', async () => {
    // §12: the trail must not claim work that never happened. `rootUnitA` was refused an
    // update twice above — once as a self-parent and once as a cycle — and the service
    // validates BEFORE it writes and audits, so this resource carries a CREATE and no UPDATE.
    const refused = await patch(`/hr/organization/units/${rootUnitA.id}`, adminAId).send({
      parentId: childUnitA.id,
    });
    expect(refused.status).toBe(409);

    const rows = await prisma.auditLog.findMany({ where: { resourceId: rootUnitA.id } });
    expect(rows.filter((row) => row.action === 'update')).toHaveLength(0);
    // …while the ONE write that really happened is still on file, so the assertion above is
    // not "no rows at all, because the query itself is wrong".
    expect(rows.filter((row) => row.action === 'create')).toHaveLength(1);
    // A refused request leaves no row in any other shape either: every row that exists is a
    // completed mutation, so nothing in the trail reports a `success` that did not occur.
    for (const row of rows) {
      expect(row.success).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 7. No DELETE, tenant isolation, and the identity boundary
  // ---------------------------------------------------------------------------

  it('has NO delete route on a personnel record: a file is never deleted through the API', async () => {
    expect((await del(`/hr/employees/${employeeOne.id}`, adminAId)).status).toBe(404);
    // …and the record is still there, with its whole history.
    const detail = await get(`/hr/employees/${employeeOne.id}`, adminAId);
    expect(detail.status).toBe(200);
    expect(detail.body.employmentHistory).toHaveLength(3);
  });

  it('never lets a header, a body field or a query parameter choose the tenant', async () => {
    const expectedA = await hrDb.employee.count({ where: { tenantId: tenantAId } });
    const expectedB = await hrDb.employee.count({ where: { tenantId: tenantBId } });

    // A real tenant header, sent by a real tenant-A administrator. The LIST read ignores it:
    // the tenant comes from the authenticated principal through the interceptor, never from
    // the request.
    const spoofedHeader = await request(app.getHttpServer())
      .get('/hr/employees')
      .set('x-user-id', adminAId)
      .set('x-tenant-id', tenantBId)
      .set('tenant-id', tenantBId);
    expect(spoofedHeader.status).toBe(200);
    expect(spoofedHeader.body.total).toBe(expectedA);
    expect(
      spoofedHeader.body.items.every((row: { tenantId: string }) => row.tenantId === tenantAId)
    ).toBe(true);

    // `tenantId` is not a member of any HR DTO, so the global pipe refuses the field rather
    // than ignoring it — in a query string exactly as in a body.
    expect((await get(`/hr/employees?tenantId=${tenantBId}`, adminAId)).status).toBe(422);
    expect(
      (
        await post('/hr/organization/units', adminAId).send({
          code: `X-${now}`,
          name: 'نامعتبر',
          tenantId: tenantBId,
        })
      ).status
    ).toBe(422);

    // The SAME read as the OTHER tenant's administrator returns only its own row.
    const asB = await get('/hr/employees', adminBId);
    expect(asB.status).toBe(200);
    expect(asB.body.total).toBe(expectedB);
    expect(asB.body.items.map((row: { id: string }) => row.id)).toEqual([employeeB.id]);

    // Cross-tenant reads are 404 — ABSENT — never 403, which would confirm the record
    // exists somewhere else. The four HR resources are covered, not just the personnel file.
    for (const path of [
      `/hr/employees/${employeeOne.id}`,
      `/hr/employees/${employeeOne.id}/employment-records`,
      `/hr/organization/units/${rootUnitA.id}`,
      `/hr/positions/${positionA.id}`,
    ]) {
      expect((await get(path, adminBId)).status).toBe(404);
    }

    // …and WRITES by the other tenant are refused too, with the record left untouched.
    expect(
      (await patch(`/hr/employees/${employeeOne.id}`, adminBId).send({ status: 'INACTIVE' })).status
    ).toBe(404);
    expect(
      (
        await post(`/hr/employees/${employeeOne.id}/terminate`, adminBId).send({
          endDate: '2026-06-01',
        })
      ).status
    ).toBe(404);
    expect(
      (
        await post(`/hr/employees/${employeeB.id}/employment-records`, adminAId).send({
          employmentType: 'FULL_TIME',
          startDate: '2026-05-01',
          organizationUnitId: childUnitA.id,
          positionId: positionA.id,
        })
      ).status
    ).toBe(404);

    const afterAttempts = await get(`/hr/employees/${employeeOne.id}`, adminAId);
    expect(afterAttempts.body.status).toBe('ACTIVE');
    expect(afterAttempts.body.employmentHistory).toHaveLength(3);
  });

  it('keeps ONE identity surface: a foreign login is refused on create exactly as on update', async () => {
    // The UPDATE path is proven above (generic 400). CREATE reaches identity through the
    // SAME gateway, so it must behave identically — including writing nothing at all.
    const foreign = await post('/hr/employees', adminAId).send({
      employeeCode: `LINK-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-01-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
      userId: coreUserBId,
    });
    expect(foreign.status).toBe(400);
    expect(
      await hrDb.employee.count({ where: { tenantId: tenantAId, employeeCode: `LINK-${now}` } })
    ).toBe(0);

    // A login OF MY OWN tenant is accepted through that boundary, and the detail read
    // projects it by name — the allowlisted profile, never an email or a role.
    const linked = await post('/hr/employees', adminAId).send({
      employeeCode: `LINK-OK-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-01-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
      userId: viewerAId,
    });
    expect(linked.status).toBe(201);
    createdAuditResourceIds.push(linked.body.id);
    expect(linked.body.identity).toMatchObject({ id: viewerAId, firstName: 'بیننده' });
    expect(linked.body.identity).not.toHaveProperty('email');
    expect(linked.body.identity).not.toHaveProperty('status');
  });

  // ---------------------------------------------------------------------------
  // 8. §5 — the boundary is STRUCTURAL, verified against the real `hr_db`
  // ---------------------------------------------------------------------------

  it('declares no identity table and no foreign key that reaches Core', async () => {
    const tables = await hrDb.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    `;
    const names = tables.map((table) => table.table_name);

    // HR's own tables are the module's seven domain tables (Prisma's migration bookkeeping
    // aside)…
    expect(names).toEqual(
      expect.arrayContaining([
        'Employee',
        'EmploymentRecord',
        'OrganizationUnit',
        'Position',
        'Attendance',
        'LeaveRequest',
        'LeaveType',
      ])
    );

    // …and NOT ONE identity or security table is duplicated into this database: identity is
    // Core's, and a second copy here is exactly the coupling the boundary forbids.
    for (const forbidden of [
      'User',
      'Tenant',
      'Role',
      'Permission',
      'UserRole',
      'RolePermission',
      'Session',
      'RefreshToken',
      'AuditLog',
    ]) {
      expect(names).not.toContain(forbidden);
    }

    // No cross-database foreign key can exist in PostgreSQL, and a same-database FK to a
    // Core table would be the next-best thing to one. There is neither: EVERY foreign key
    // declared in `hr_db` points at another table of `hr_db`.
    const foreignKeys = await hrDb.$queryRaw<{ source: string; target: string }[]>`
      SELECT c.conrelid::regclass::text AS source, c.confrelid::regclass::text AS target
      FROM pg_constraint c
      WHERE c.contype = 'f'
    `;
    const hrTables = new Set(names);
    const unqualified = (name: string) => name.replace(/"/g, '').split('.').pop()!;

    expect(foreignKeys.length).toBeGreaterThan(0);
    for (const key of foreignKeys) {
      expect(hrTables.has(unqualified(key.source))).toBe(true);
      expect(hrTables.has(unqualified(key.target))).toBe(true);
    }

    // The composite keys are what make a cross-tenant reference UNREPRESENTABLE: each one
    // carries the tenant, so a row cannot point at another tenant's unit, position, employee or
    // leave type. They are asserted by NAME, because dropping one by rename would silently
    // remove the guarantee while every other test still passed.
    const constraintNames = await hrDb.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'f'
    `;
    expect(constraintNames.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'Attendance_tenant_employee_fkey',
        'EmploymentRecord_tenant_employee_fkey',
        'EmploymentRecord_tenant_manager_fkey',
        'EmploymentRecord_tenant_position_fkey',
        'EmploymentRecord_tenant_unit_fkey',
        // Phase 51-HR-3A: BOTH of the leave request's foreign keys carry the tenant, so a
        // request and the type it names are one fact about one tenant.
        'LeaveRequest_tenant_employee_fkey',
        'LeaveRequest_tenant_leave_type_fkey',
        'OrganizationUnit_tenant_parent_fkey',
        'Position_tenant_unit_fkey',
      ])
    );
  });

  // ---------------------------------------------------------------------------
  // 9. §13 — the attendance register against REAL `hr_db`
  // ---------------------------------------------------------------------------
  //
  // WHAT THIS SECTION PROVES, AND WHY IT IS AN HTTP TEST
  // ---------------------------------------------------
  // The register's rules are DATABASE facts, not service opinions: a second clock-in is
  // refused by `Attendance_tenantId_employeeId_workDate_source_key`, a day that closes
  // before it opens by `Attendance_punch_order_check`, and a `MANUAL` row with no reason
  // by `Attendance_manual_reason_check`. So every assertion below is made through the real
  // routes against the real `hr_db`, and the recurring evidence is a row count read back
  // from PostgreSQL rather than a returned object.
  //
  // THE TWO CALENDARS ARE PINNED TO INDEPENDENT VALUES. `2026-09-18` ↔ `1405/06/27` and
  // `2026-09-19` ↔ `1405/06/28` are stated as literals, so a regression in the Jalali
  // derivation — or in the `APP_TIME_ZONE` the day is resolved in — fails this test
  // instead of silently shifting a register by one day.

  it('derives the work day from the instant — Gregorian AND Jalali, in APP_TIME_ZONE', async () => {
    const opened = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T08:00:00+03:30',
    });
    expect(opened.status).toBe(201);
    attendanceA = opened.body;
    // Registered for cleanup exactly like every other audited resource: the register's rows
    // are audited too (§13), so the ONE trail's rows for them are deleted in `afterAll`.
    createdAuditResourceIds.push(attendanceA.id);

    // The non-uuid tenant id round-trips through the register too — the 51-HR-2 fix, on the
    // newest table as well as on the original four.
    expect(attendanceA.tenantId).toBe(tenantAId);
    expect(attendanceA.source).toBe('DEVICE');
    expect(attendanceA.clockIn).toBe('2026-09-18T04:30:00.000Z');
    expect(attendanceA.clockOut).toBeNull();
    expect(attendanceA.reason).toBeNull();
    // BOTH calendars, derived from the SAME instant, in the named zone.
    expect(attendanceA.workDate).toBe('2026-09-18');
    expect(attendanceA.dateKey).toBe('1405/06/27');

    // No verdict is stored and none is invented: present/late/absent and the hour
    // arithmetic are §13's COMPUTED layer (it needs a shift and a calendar this phase does
    // not own), so the register carries facts only.
    for (const derived of ['status', 'lateMinutes', 'overtimeMinutes', 'workedMinutes']) {
      expect(attendanceA).not.toHaveProperty(derived);
    }

    // `work_date` is a REAL `DATE` column holding that civil day — not a timestamp that
    // merely prints like one, which is what makes the range filter index-usable.
    const stored = await hrDb.attendance.findFirst({ where: { id: attendanceA.id } });
    expect(stored!.workDate.toISOString().slice(0, 10)).toBe('2026-09-18');
    expect(stored!.reason).toBeNull();
  });

  it('refuses a client that tries to SUPPLY the day, and derives an instant that falls after midnight', async () => {
    // `workDate`, `dateKey` and `source` are members of no write DTO, so the global pipe
    // answers 422 and nothing is written: a row can never contradict its own timestamp.
    const supplied = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T08:00:00+03:30',
      workDate: '2020-01-01',
      dateKey: '1398/10/11',
      source: 'MANUAL',
    });
    expect(supplied.status).toBe(422);
    expect(
      await hrDb.attendance.count({ where: { tenantId: tenantAId, employeeId: employeeOne.id } })
    ).toBe(1);

    // 2026-09-18T20:30:00Z is 2026-09-19T00:00:00+03:30: the NEXT day, and therefore the
    // next Jalali day as well. The register follows the INSTANT, which is the only way "one
    // row per work day" can be a fact rather than an agreement.
    const afterMidnight = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: managerEmployee.id,
      clockIn: '2026-09-18T20:30:00Z',
    });
    expect(afterMidnight.status).toBe(201);
    createdAuditResourceIds.push(afterMidnight.body.id);
    expect(afterMidnight.body.workDate).toBe('2026-09-19');
    expect(afterMidnight.body.dateKey).toBe('1405/06/28');
  });

  it('refuses a second clock-in for the same employee-day with a 409 that names the correction route', async () => {
    const second = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T09:00:00+03:30',
    });
    expect(second.status).toBe(409);
    // The refusal names the DAY in the calendar the operator reads, and the route that may
    // legitimately change it.
    expect(String(second.body.message)).toContain('1405/06/27');
    expect(String(second.body.message)).toContain('adjustment');

    // ONE row: the register answers "was this person here that day, from when to when" with
    // one window, and a rejected request leaves nothing behind.
    expect(
      await hrDb.attendance.count({ where: { tenantId: tenantAId, employeeId: employeeOne.id } })
    ).toBe(1);
  });

  it('closes the day once, refuses a close before the open, and refuses a second close', async () => {
    const backwards = await post(`/hr/attendance/${attendanceA.id}/clock-out`, adminAId).send({
      clockOut: '2026-09-18T07:00:00+03:30',
    });
    expect(backwards.status).toBe(409);
    // The refusal left the day OPEN — a 409 is a decision, not a partial write.
    expect((await get(`/hr/attendance/${attendanceA.id}`, adminAId)).body.clockOut).toBeNull();

    const closed = await post(`/hr/attendance/${attendanceA.id}/clock-out`, adminAId).send({
      clockOut: '2026-09-18T17:00:00+03:30',
    });
    expect(closed.status).toBe(200);
    expect(closed.body.clockOut).toBe('2026-09-18T13:30:00.000Z');
    expect(closed.body.workDate).toBe('2026-09-18');

    const doubleClose = await post(`/hr/attendance/${attendanceA.id}/clock-out`, adminAId).send({
      clockOut: '2026-09-18T18:00:00+03:30',
    });
    expect(doubleClose.status).toBe(409);
    expect(
      (await hrDb.attendance.findFirst({ where: { id: attendanceA.id } }))!.clockOut!.toISOString()
    ).toBe('2026-09-18T13:30:00.000Z');
  });

  it('records a correction as a SECOND row that cannot touch the punch (§13)', async () => {
    // A correction without a stated reason is refused TWICE: by the DTO (422 — and a reason
    // of pure whitespace counts as none, because it is trimmed before `@MinLength`) and by
    // `Attendance_manual_reason_check` in `hr_db` for a writer that bypasses this service.
    const blankReason = await post('/hr/attendance/adjustments', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T07:00:00+03:30',
      clockOut: '2026-09-18T16:00:00+03:30',
      reason: '   ',
    });
    expect(blankReason.status).toBe(422);

    const missingReason = await post('/hr/attendance/adjustments', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T07:00:00+03:30',
    });
    expect(missingReason.status).toBe(422);

    // A window that runs backwards is an INCOHERENT PAYLOAD: 400, not the 409 that would
    // claim a contradiction with what is already stored.
    const backwards = await post('/hr/attendance/adjustments', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T10:00:00+03:30',
      clockOut: '2026-09-18T09:00:00+03:30',
      reason: 'بازه نادرست',
    });
    expect(backwards.status).toBe(400);

    // Not one of the three refusals wrote anything.
    expect(
      await hrDb.attendance.count({ where: { tenantId: tenantAId, employeeId: employeeOne.id } })
    ).toBe(1);

    const corrected = await post('/hr/attendance/adjustments', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T07:00:00+03:30',
      clockOut: '2026-09-18T16:00:00+03:30',
      reason: 'دستگاه ثبت در ابتدای روز خراب بود',
    });
    expect(corrected.status).toBe(200);
    attendanceManual = corrected.body;
    createdAuditResourceIds.push(attendanceManual.id);

    // A ROW, not an edit: a different id from the punch, a different source, and the day it
    // corrects.
    expect(attendanceManual.id).not.toBe(attendanceA.id);
    expect(attendanceManual.source).toBe('MANUAL');
    expect(attendanceManual.reason).toBe('دستگاه ثبت در ابتدای روز خراب بود');
    expect(attendanceManual.dateKey).toBe('1405/06/27');

    // THE EVIDENCE IS UNTOUCHED — the window the punch recorded, still DEVICE, still no
    // reason. This is the difference between correcting a register and rewriting it.
    const punch = (await get(`/hr/attendance/${attendanceA.id}`, adminAId)).body;
    expect(punch).toMatchObject({
      clockIn: '2026-09-18T04:30:00.000Z',
      clockOut: '2026-09-18T13:30:00.000Z',
      source: 'DEVICE',
      reason: null,
    });

    // The day now holds exactly TWO rows — one per source — which is the shape
    // `(tenant_id, employee_id, work_date, source)` declares.
    const forEmployee = { tenantId: tenantAId, employeeId: employeeOne.id };
    expect(await hrDb.attendance.count({ where: forEmployee })).toBe(2);
    const sources = (
      await hrDb.attendance.findMany({
        where: forEmployee,
        orderBy: { source: 'asc' },
        select: { source: true },
      })
    ).map((row) => row.source);
    expect(sources).toEqual(['DEVICE', 'MANUAL']);

    // A correction is RESTATED, never appended: the SAME row takes the new window, and the
    // audit trail keeps both acts (asserted below).
    const restated = await post('/hr/attendance/adjustments', adminAId).send({
      employeeId: employeeOne.id,
      clockIn: '2026-09-18T07:30:00+03:30',
      clockOut: '2026-09-18T16:30:00+03:30',
      reason: 'اصلاح ساعت ورود پس از بررسی لاگ دستگاه',
    });
    expect(restated.status).toBe(200);
    expect(restated.body.id).toBe(attendanceManual.id);
    expect(restated.body.clockIn).toBe('2026-09-18T04:00:00.000Z');
    expect(await hrDb.attendance.count({ where: forEmployee })).toBe(2);
    attendanceManual = restated.body;

    // A `MANUAL` row states its OWN window, so closing it is refused: only a punch is
    // clocked out, and one field never has two writers.
    const closeTheCorrection = await post(
      `/hr/attendance/${attendanceManual.id}/clock-out`,
      adminAId
    ).send({ clockOut: '2026-09-18T20:00:00+03:30' });
    expect(closeTheCorrection.status).toBe(409);
  });

  it('accepts a punch for an INACTIVE employee, defaults an omitted instant to the server now, and refuses a TERMINATED one', async () => {
    // INACTIVE is an administrative label for a record currently out of use; an inactive
    // person can still be at work, so the register accepts them. Only TERMINATED — an
    // employment that has ENDED — makes a new day a data-entry error rather than a fact.
    const deactivated = await patch(`/hr/employees/${managerEmployee.id}`, adminAId).send({
      status: 'INACTIVE',
    });
    expect(deactivated.status).toBe(200);

    const forInactive = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: managerEmployee.id,
      clockIn: '2026-09-22T08:00:00+03:30',
    });
    expect(forInactive.status).toBe(201);
    createdAuditResourceIds.push(forInactive.body.id);
    // `2026-09-22` is `1405/06/31` — the last day of Shahrivar, which is the boundary a
    // naive 30-day month would get wrong.
    expect(forInactive.body.dateKey).toBe('1405/06/31');

    // THE PUNCH PATH: an omitted `clockIn` means the SERVER's now, because a device reports
    // "this person is here" rather than a timestamp it derived for itself.
    const leaving = await post('/hr/employees', adminAId).send({
      employeeCode: `ATT-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-01-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
    });
    expect(leaving.status).toBe(201);
    createdAuditResourceIds.push(leaving.body.id);

    const punchNow = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: leaving.body.id,
    });
    expect(punchNow.status).toBe(201);
    createdAuditResourceIds.push(punchNow.body.id);
    expect(punchNow.body.source).toBe('DEVICE');
    expect(punchNow.body.clockOut).toBeNull();
    expect(Math.abs(Date.now() - new Date(punchNow.body.clockIn).getTime())).toBeLessThan(60_000);

    // A TERMINATED employment ends the register's claim on NEW days: 409, and nothing is
    // written — while the rows already recorded stay exactly where they are (§10).
    const terminated = await post(`/hr/employees/${leaving.body.id}/terminate`, adminAId).send({
      endDate: '2024-06-30',
    });
    expect(terminated.status).toBe(200);

    const forTerminated = await post('/hr/attendance/clock-in', adminAId).send({
      employeeId: leaving.body.id,
      clockIn: '2027-03-01T08:00:00+03:30',
    });
    expect(forTerminated.status).toBe(409);
    expect(
      await hrDb.attendance.count({ where: { tenantId: tenantAId, employeeId: leaving.body.id } })
    ).toBe(1);
  });

  it('lists the register with real filters: the Jalali day, the Gregorian range, the source and the employee code', async () => {
    const all = await get('/hr/attendance', adminAId);
    expect(all.status).toBe(200);
    // The API's total and the DATABASE's count are the same number: nothing is filtered in
    // memory, and nothing in `hr_db` is invisible to the query.
    const expectedTotal = await hrDb.attendance.count({ where: { tenantId: tenantAId } });
    expect(all.body.total).toBe(expectedTotal);
    expect(expectedTotal).toBeGreaterThanOrEqual(5);
    // Newest day first, and every row renderable without a second query.
    const days = all.body.items.map((row) => row.workDate);
    expect([...days].sort().reverse()).toEqual(days);
    expect(all.body.items[0].employee).toMatchObject({ employeeCode: expect.any(String) });

    // ONE Jalali day, resolved from the `date_key` index — the value URL-encoded, because a
    // slash in a query string is a path separator to a strict client. The expected total is
    // READ FROM `hr_db` rather than written as a literal: §9's punch path defaults `clockIn` to
    // the SERVER's now, so the day this suite is run on holds a row of its own — and when that
    // day IS the fixture day (2026-09-18), a literal `2` would make the suite pass or fail by
    // calendar. The assertion is the stronger one anyway: the API's page and the DATABASE agree.
    const jalaliDay = await get(
      `/hr/attendance?dateKey=${encodeURIComponent('1405/06/27')}`,
      adminAId
    );
    expect(jalaliDay.status).toBe(200);
    expect(jalaliDay.body.items.every((row) => row.dateKey === '1405/06/27')).toBe(true);
    const gregorianDay = new Date('2026-09-18T00:00:00.000Z');
    expect(jalaliDay.body.total).toBe(
      await hrDb.attendance.count({
        where: { tenantId: tenantAId, workDate: { gte: gregorianDay, lte: gregorianDay } },
      })
    );

    // TWO rows, and both of them belong to the SAME day, for the employee that has both: the
    // punch and the correction are two rows, not two days. Scoped by employee, so the claim is
    // about the register's shape rather than about how many punches the run made today.
    const jalaliDayForEmployee = await get(
      `/hr/attendance?dateKey=${encodeURIComponent('1405/06/27')}&employeeId=${employeeOne.id}`,
      adminAId
    );
    expect(jalaliDayForEmployee.body.total).toBe(2);
    expect(jalaliDayForEmployee.body.items.map((row) => row.source).sort()).toEqual([
      'DEVICE',
      'MANUAL',
    ]);

    // The SAME day asked the other way: the Jalali day is converted ONCE into a Gregorian
    // `from = to` range, so the two spellings of "one day" cannot diverge.
    const gregorianRange = await get(
      `/hr/attendance?from=2026-09-18&to=2026-09-18&employeeId=${employeeOne.id}`,
      adminAId
    );
    expect(gregorianRange.body.total).toBe(2);
    expect(gregorianRange.body.items.map((row) => row.id).sort()).toEqual(
      jalaliDayForEmployee.body.items.map((row) => row.id).sort()
    );

    // Two answers to "which days?" is refused rather than silently resolved, and a
    // well-SHAPED but impossible Jalali day is refused by the service (the DTO can only
    // check the shape).
    expect(
      (
        await get(
          `/hr/attendance?dateKey=${encodeURIComponent('1405/06/27')}&from=2026-09-18`,
          adminAId
        )
      ).status
    ).toBe(400);
    expect((await get('/hr/attendance?from=2026-09-19&to=2026-09-18', adminAId)).status).toBe(400);
    expect(
      (await get(`/hr/attendance?dateKey=${encodeURIComponent('1405/13/01')}`, adminAId)).status
    ).toBe(400);

    // The source filter separates the EVIDENCE from the DECISIONS.
    const manualOnly = await get('/hr/attendance?source=MANUAL', adminAId);
    expect(manualOnly.body.items.length).toBeGreaterThan(0);
    expect(manualOnly.body.items.every((row) => row.source === 'MANUAL')).toBe(true);

    // The employee filter, and the free-text search pressing on the employee's CODE through
    // a relation pinned to the same tenant.
    expect((await get(`/hr/attendance?employeeId=${employeeOne.id}`, adminAId)).body.total).toBe(2);
    const byCode = await get(
      `/hr/attendance?search=${encodeURIComponent(employeeOne.employeeCode)}`,
      adminAId
    );
    expect(byCode.body.total).toBe(2);
    expect(
      byCode.body.items.every((row) => row.employee.employeeCode === employeeOne.employeeCode)
    ).toBe(true);

    // A range that matches nothing is an empty page, not an error.
    expect(
      (await get('/hr/attendance?from=2020-01-01&to=2020-01-31', adminAId)).body
    ).toMatchObject({ total: 0, items: [] });
  });

  // ---------------------------------------------------------------------------
  // 10. §13 — the DATABASE's own refusals, exercised through the ordinary client
  // ---------------------------------------------------------------------------
  //
  // WHAT THIS SECTION ADDS TO §8 AND `hr-runtime.e2e-spec.ts`
  // ---------------------------------------------------------
  // Those two ask `pg_constraint` for the NAMES, so they prove the constraints are DECLARED.
  // This section makes them FIRE, because a constraint that is only declared is an
  // assumption — and "the service refuses it" is a courtesy a caller receives only by coming
  // through the service.
  //
  // EVERY WRITE BELOW BYPASSES THE SERVICE. The statements reach `hr_db` through the SAME
  // ordinary Prisma client the module uses (`hrDb.attendance.create`), with no DTO, no
  // controller and no `hr.*` permission in the path — precisely the "future migration, a
  // script, or a manual UPDATE" §13 names. Anything PostgreSQL accepts here it would accept
  // in production.
  //
  // THE TWO REFUSAL SHAPES ARE MEASURED HERE, NOT ASSUMED, AND THEY DIFFER
  // ---------------------------------------------------------------------
  //   * A FOREIGN KEY refusal arrives as `P2003`, with `meta.modelName` and a `meta.field_name`
  //     naming the constraint as `'<name> (index)'`. The PostgreSQL constraint name is IN the
  //     payload, so the assertions below point at the EXACT constraint rather than at "some
  //     kind of database error".
  //   * A CHECK refusal (SQLSTATE 23514) has NO Prisma mapping: it arrives as
  //     `PrismaClientUnknownRequestError` with `code: undefined` and the PostgreSQL message
  //     nested inside `message`. "No code" is therefore NOT "no refusal" — a distinction worth
  //     pinning, because a caller that reads only `code` would treat this as a success. The
  //     constraint name is asserted out of that message, so RENAMING or DROPPING a check fails
  //     this test instead of quietly weakening it.

  /**
   * A refusal CAPTURED rather than thrown, so an accepted write fails the test with a readable
   * message instead of an unhandled rejection, and so the two shapes above stay readable apart.
   */
  const refusalFrom = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return {
        accepted: true,
        code: undefined as string | undefined,
        constraint: undefined as string | undefined,
        message: '',
      };
    } catch (err) {
      const failure = err as {
        code?: string;
        meta?: { modelName?: string; field_name?: string };
        message?: string;
      };
      return {
        accepted: false,
        code: failure.code,
        constraint: failure.meta?.field_name,
        message: String(failure.message ?? ''),
      };
    }
  };

  it('refuses a CROSS-TENANT register row in PostgreSQL itself, on INSERT and on UPDATE', async () => {
    const rowsBefore = await hrDb.attendance.count({ where: { tenantId: tenantAId } });

    // INSERT. `employeeB` is a REAL employee — of tenant B — so nothing about this row is
    // malformed except the one thing the composite key exists to forbid.
    const inserted = await refusalFrom(() =>
      hrDb.attendance.create({
        data: {
          tenantId: tenantAId,
          employeeId: employeeB.id,
          workDate: new Date(Date.UTC(2026, 9, 25)),
          dateKey: '1405/08/03',
          clockIn: new Date('2026-10-25T05:00:00.000Z'),
          clockOut: null,
          source: 'DEVICE',
        },
      })
    );
    expect(inserted.accepted).toBe(false);
    expect(inserted.code).toBe('P2003');
    expect(inserted.constraint).toBe('Attendance_tenant_employee_fkey (index)');
    expect(inserted.message).toContain('Attendance_tenant_employee_fkey');

    // UPDATE, the same key pressed the other way: a writer that tries to RE-POINT an existing
    // row at another tenant's employee — the shape a "fix this person's records" script takes.
    const repointed = await refusalFrom(() =>
      hrDb.attendance.update({
        where: { id: attendanceA.id },
        data: { employeeId: employeeB.id },
      })
    );
    expect(repointed.accepted).toBe(false);
    expect(repointed.code).toBe('P2003');
    expect(repointed.constraint).toBe('Attendance_tenant_employee_fkey (index)');

    // Neither attempt left a trace: nothing in tenant A claims another tenant's employee, and
    // the evidence still names its own.
    expect(await hrDb.attendance.count({ where: { tenantId: tenantAId } })).toBe(rowsBefore);
    expect((await hrDb.attendance.findUnique({ where: { id: attendanceA.id } }))!.employeeId).toBe(
      employeeOne.id
    );
  });

  it('refuses the three day shapes PostgreSQL enforces, for a writer that never passes the service', async () => {
    const forEmployee = { tenantId: tenantAId, employeeId: employeeOne.id };
    const rowsBefore = await hrDb.attendance.count({ where: forEmployee });

    // ONE FIELD BROKEN PER ATTEMPT, on a DIFFERENT day each time, so a bug cannot make one
    // refusal mask the next as a duplicate-key error instead of the check under test.
    const attempts = [
      {
        // A day that closes before it opens — §13's "a day cannot be negative", for writers the
        // service never saw.
        constraint: 'Attendance_punch_order_check',
        data: {
          workDate: new Date(Date.UTC(2026, 9, 5)),
          dateKey: '1405/07/14',
          clockIn: new Date('2026-10-05T08:00:00.000Z'),
          clockOut: new Date('2026-10-05T07:00:00.000Z'),
          source: 'DEVICE' as const,
          reason: null,
        },
      },
      {
        // A correction that states no reason — §13's "actor + sanitized reason + audit event",
        // of which the database owns the reason.
        constraint: 'Attendance_manual_reason_check',
        data: {
          workDate: new Date(Date.UTC(2026, 9, 6)),
          dateKey: '1405/07/15',
          clockIn: new Date('2026-10-06T08:00:00.000Z'),
          clockOut: null,
          source: 'MANUAL' as const,
          reason: null,
        },
      },
      {
        // A hand-written Jalali key in the wrong shape: `date_key` exists so that "group by the
        // Jalali month" is a string prefix, and a key no parser can read is unreadable data.
        constraint: 'Attendance_date_key_check',
        data: {
          workDate: new Date(Date.UTC(2026, 9, 7)),
          dateKey: '1405-07-16',
          clockIn: new Date('2026-10-07T08:00:00.000Z'),
          clockOut: null,
          source: 'DEVICE' as const,
          reason: null,
        },
      },
    ];

    for (const attempt of attempts) {
      const refused = await refusalFrom(() =>
        hrDb.attendance.create({
          data: { tenantId: tenantAId, employeeId: employeeOne.id, ...attempt.data },
        })
      );
      expect(refused.accepted).toBe(false);
      // A CHECK has no Prisma code at all: the refusal is real, and it names itself only inside
      // the driver's message.
      expect(refused.code).toBeUndefined();
      expect(refused.message).toContain('23514');
      expect(refused.message).toContain(attempt.constraint);
    }

    // Three attempts, three refusals, and the register is exactly what it was: a refused write
    // is never a partial one.
    expect(await hrDb.attendance.count({ where: forEmployee })).toBe(rowsBefore);
    expect(rowsBefore).toBe(2);
  });

  it('keeps a register row alive when its employee is deleted — ON DELETE RESTRICT, in the database', async () => {
    // A person with a register row and NOTHING else. The emptiness is deliberate: with a second
    // dependent table in play PostgreSQL reports whichever RESTRICT it reaches first — a fully
    // created employee (one with an employment record, as every API-created one has) answers
    // with `EmploymentRecord_tenant_employee_fkey`, and this test is about the REGISTER's.
    registerOnlyEmployee = await hrDb.employee.create({
      data: { tenantId: tenantAId, employeeCode: `ATT-DB-${now}` },
    });
    registerOnlyAttendance = await hrDb.attendance.create({
      data: {
        tenantId: tenantAId,
        employeeId: registerOnlyEmployee.id,
        workDate: new Date(Date.UTC(2026, 9, 6)),
        dateKey: '1405/07/15',
        clockIn: new Date('2026-10-06T08:00:00.000Z'),
        clockOut: null,
        source: 'DEVICE',
      },
    });
    // …written by the ORDINARY client: no route, no service, no audit. §11 uses that.

    const refused = await refusalFrom(() =>
      hrDb.employee.delete({ where: { id: registerOnlyEmployee.id } })
    );
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe('P2003');
    expect(refused.constraint).toBe('Attendance_tenant_employee_fkey (index)');
    expect(refused.message).toContain('Attendance_tenant_employee_fkey');

    // The person is still there and so is their day: §10's "a terminated employment does not
    // erase history" is a STORAGE fact, not a service promise, and it holds for the writer that
    // never calls the service at all.
    expect(
      await hrDb.employee.findUnique({ where: { id: registerOnlyEmployee.id } })
    ).not.toBeNull();
    expect(
      await hrDb.attendance.count({
        where: { tenantId: tenantAId, employeeId: registerOnlyEmployee.id },
      })
    ).toBe(1);

    // AND THE REFUSAL WAS THE REGISTER, not something else about the person: with the day
    // removed first, the very same delete succeeds. Nothing is left for teardown to trip on.
    await hrDb.attendance.delete({ where: { id: registerOnlyAttendance.id } });
    await hrDb.employee.delete({ where: { id: registerOnlyEmployee.id } });
    expect(await hrDb.employee.findUnique({ where: { id: registerOnlyEmployee.id } })).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 11. §13 — one trail, and it records ACTS on the register
  // ---------------------------------------------------------------------------
  //
  // WHAT THIS SECTION ADDS TO §6
  // ---------------------------
  // §6 proved the trail is REAL: rows reach `core_db."AuditLog"` with the acting identity, the
  // resource and the per-request id. This section makes the same claim for the REGISTER, where it
  // is load-bearing rather than decorative — attendance is evidence, and evidence is worth keeping
  // only if "who stated this, on what day, and why" survives beside it.
  //
  //   * every register act carries its OWN domain action — `create` for a punch, `update` for a
  //     clock-out, `adjust` for a correction — never a generic `update`;
  //   * a correction is audited against the MANUAL row and a punch against the DEVICE row, so an
  //     operator reading the trail can tell the EVIDENCE from the DECISION (§13);
  //   * a RESTATED correction leaves BOTH statements on file, in the order they were made;
  //   * an act the service REFUSED leaves nothing, and a write that never went through the service
  //     leaves nothing either — the trail records what the platform DID, not what the database
  //     received.

  it('audits each attendance act against the row it changed, with its own domain action', async () => {
    const rows = await prisma.auditLog.findMany({
      where: {
        resourceType: 'hr.attendance',
        resourceId: { in: [attendanceA.id, attendanceManual.id] },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    const forAction = (action: string, resourceId: string) =>
      rows.filter((row) => row.action === action && row.resourceId === resourceId);

    // The punch: ONE create. The clock-out: ONE update, naming the field it wrote. The correction:
    // TWO adjusts — the statement and its restatement — against the SAME row.
    expect(forAction('create', attendanceA.id)).toHaveLength(1);
    expect(forAction('update', attendanceA.id)).toHaveLength(1);
    expect(forAction('adjust', attendanceManual.id)).toHaveLength(2);

    // A clock-out is audited as the FIELD it changed, with the open day as the old value.
    const close = forAction('update', attendanceA.id)[0];
    expect(close.changedFields).toEqual(['clockOut']);
    expect(close.oldValue).toMatchObject({ clockOut: null, open: true });
    expect((close.newValue as { clockOut?: string }).clockOut).toBe('2026-09-18T13:30:00.000Z');

    // A correction states WHY, and the trail keeps the operator's own words — both times, in the
    // order they were made.
    const adjustments = forAction('adjust', attendanceManual.id);
    expect(adjustments.map((row) => row.reason)).toEqual([
      'دستگاه ثبت در ابتدای روز خراب بود',
      'اصلاح ساعت ورود پس از بررسی لاگ دستگاه',
    ]);
    expect(adjustments.map((row) => (row.newValue as { clockIn?: string }).clockIn)).toEqual([
      '2026-09-18T03:30:00.000Z',
      '2026-09-18T04:00:00.000Z',
    ]);

    // EVERY audited act names a REAL register row IN THE ACTOR'S TENANT and agrees with it on the
    // day: the trail and the register are two views of one set of facts, not two stores of
    // different ones.
    for (const row of rows) {
      const registerRow = await hrDb.attendance.findUnique({ where: { id: row.resourceId } });
      expect(registerRow).not.toBeNull();
      expect(registerRow!.tenantId).toBe(tenantAId);
      expect((row.newValue as { dateKey?: string }).dateKey).toBe(registerRow!.dateKey);
      expect(row.tenantId).toBe(tenantAId);
      expect(row.userId).toBe(adminAId);
      expect(row.success).toBe(true);
      expect(row.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
    // Each act has its OWN request identity: four acts, four requests, none of them
    // `resolveHrActor`'s constant fallback.
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(rows.length);

    // AND A REFUSED ACT ADDS NOTHING. §9 was refused a clock-out on the MANUAL row because a
    // correction states its own window; the refusal is repeated and the trail is read back
    // SEPARATELY, because the claim is precisely that it is unchanged by the attempt.
    const refusedClose = await post(
      `/hr/attendance/${attendanceManual.id}/clock-out`,
      adminAId
    ).send({ clockOut: '2026-09-18T20:00:00+03:30' });
    expect(refusedClose.status).toBe(409);
    expect(
      (
        await prisma.auditLog.findMany({
          where: { resourceType: 'hr.attendance', resourceId: attendanceManual.id },
        })
      )
        .map((row) => row.action)
        .sort()
    ).toEqual(['adjust', 'adjust']);
  });

  it('records ACTS, not writes: a mutation that never went through the service leaves no trail row', async () => {
    // §10 wrote a person and a register row through the ORDINARY Prisma client — the same client,
    // the same database and the same tables a script or a migration would use. Those rows were
    // REAL data (the RESTRICT refusal above is the proof), and they are ABSENT from the trail,
    // because no route performed them. This is what allows `AuditLog` to be evidence: a writer
    // that bypasses the service cannot pad it, and it cannot certify a change no route made.
    expect(await prisma.auditLog.count({ where: { resourceId: registerOnlyEmployee.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { resourceId: registerOnlyAttendance.id } })).toBe(
      0
    );

    // …and the contrast that makes those two zeros mean something: rows written into the SAME
    // table through the API are on file, with the actor and the tenant that wrote them.
    const viaApi = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.attendance', resourceId: attendanceA.id },
    });
    expect(viaApi.length).toBeGreaterThan(0);
    expect(viaApi.every((row) => row.userId === adminAId && row.tenantId === tenantAId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 12. §13 (leave) — the tenant's OWN catalogue, the request register, and the ONE
  //     transition this phase owns
  // ---------------------------------------------------------------------------
  //
  // WHAT THIS SECTION ADDS TO §9–§11
  // -------------------------------
  // Those sections proved that an HR register can be written, scoped and audited against the REAL
  // databases. Leave re-uses that harness and asks the questions that are specific to it:
  //
  //   * THE CATALOGUE IS THE TENANT'S OWN, and nothing is seeded anywhere (§12.1). Which leave
  //     kinds an organization grants is that organization's policy; a taxonomy invented in a
  //     migration would be worn as a default by every tenant that did not replace it. A code is
  //     unique PER TENANT, so two tenants may each own `ANNUAL` while one tenant may not own two.
  //   * A REQUEST IS A WHOLE-DAY, INCLUSIVE RANGE that states why (§12.2): `startDate = endDate` is
  //     the ordinary single-day case, the bounds round-trip as DAYS, and the state is the one an act
  //     of submitting can produce — never a caller's choice.
  //   * RESTATEMENT IS FOR A PENDING REQUEST ONLY (§12.3), and a body that restates what is already
  //     stored writes NOTHING: no statement, no audit row, no moved `updatedAt`.
  //   * RETIREMENT IS A STATUS, NEVER A DELETE (§12.4): an entry leaves use for anything NEW while
  //     every request already recorded under it keeps rendering its name.
  //   * WITHDRAWAL IS THE ONE TRANSITION (§12.5). It stamps `cancelledAt` together with its reason
  //     and is TERMINAL — a second attempt is a 409 rather than a second instant.
  //   * POSTGRESQL HOLDS THE GUARANTEES, not the service (§12.6): a writer that never passes
  //     `LeaveService` is refused by the two composite keys, the three CHECKs, the catalogue's own
  //     two and by `ON DELETE RESTRICT` on both sides.
  //   * THE TRAIL RECORDS ACTS (§12.7) — and there is no `hr.leave.approve` for it to record.

  // ---------------------------------------------------------------------------
  // 12.1 — the catalogue is the TENANT'S OWN, and nothing is seeded for anybody
  // ---------------------------------------------------------------------------

  it('lets a tenant name its OWN leave kinds — a code is unique PER TENANT, normalised before the check', async () => {
    const annualCode = `annual-${now}`;
    const studyCode = `study-${now}`;

    // NOTHING WAS SEEDED, ANYWHERE. §1 proved the catalogue is empty for the whole database, and
    // this route is the only way an entry comes into existence.
    const created = await post('/hr/leave-types', adminAId).send({
      code: annualCode,
      name: 'مرخصی استحقاقی',
    });
    expect(created.status).toBe(201);
    leaveTypeA = created.body;

    // THE CODE COMES BACK NORMALISED: `annual-…` was STORED as `ANNUAL-…`, the value the unique
    // index and `LeaveType_code_check` both press on. The NAME is the tenant's own words, trimmed
    // and otherwise untouched — re-wording it would be rewriting policy.
    expect(leaveTypeA.code).toBe(annualCode.toUpperCase());
    expect(leaveTypeA.name).toBe('مرخصی استحقاقی');
    expect(leaveTypeA.tenantId).toBe(tenantAId);
    // An entry is BORN in use: the lifecycle state is the catalogue's own, not a caller's, because
    // the create DTO has no `status` at all.
    expect(leaveTypeA.status).toBe('ACTIVE');
    createdAuditResourceIds.push(leaveTypeA.id);

    // …which is why `status` is REFUSED rather than ignored here: `forbidNonWhitelisted` is what
    // makes "an entry created retired" unwritable through the API.
    expect(
      (
        await post('/hr/leave-types', adminAId).send({
          code: `draft-${now}`,
          name: 'نامعتبر',
          status: 'INACTIVE',
        })
      ).status
    ).toBe(422);

    // A DUPLICATE IS A 409 THAT NAMES THE CODE — in EITHER spelling, because the pre-check runs on
    // the NORMALISED value. The lowercase attempt is the one a naive check would miss, and the unique
    // index would then answer it with a 500 for a caller who did nothing wrong.
    const sameSpelling = await post('/hr/leave-types', adminAId).send({
      code: leaveTypeA.code,
      name: 'تکراری',
    });
    expect(sameSpelling.status).toBe(409);
    expect(String(sameSpelling.body.message)).toContain(leaveTypeA.code);
    expect(
      (await post('/hr/leave-types', adminAId).send({ code: annualCode, name: 'تکراری' })).status
    ).toBe(409);

    // THE SAME CODE IN THE OTHER TENANT IS NOT A DUPLICATE: `LeaveType_tenantId_code_key` is unique
    // PER TENANT, so tenant A's vocabulary does not exclude tenant B's. A global index would.
    const asB = await post('/hr/leave-types', adminBId).send({
      code: leaveTypeA.code,
      name: 'Annual leave',
    });
    expect(asB.status).toBe(201);
    leaveTypeB = asB.body;
    expect(leaveTypeB.code).toBe(leaveTypeA.code);
    expect(leaveTypeB.tenantId).toBe(tenantBId);
    createdAuditResourceIds.push(leaveTypeB.id);

    // The third tenant-A entry, retired in §12.4 so "in use now" and "still addressable for its own
    // history" can be told apart.
    const study = await post('/hr/leave-types', adminAId).send({
      code: studyCode,
      name: 'مرخصی تحصیلی',
    });
    expect(study.status).toBe(201);
    retiredTypeA = study.body;
    createdAuditResourceIds.push(retiredTypeA.id);

    // A SPELLING NO NORMALISER WOULD PRODUCE IS REFUSED AT THE BOUNDARY: interior whitespace makes
    // `normalizeEmployeeCode` return the value UNCHANGED (it refuses to guess what was meant), so the
    // alphabet check — not the uppercase step — refuses it, exactly as `LeaveType_code_check` would
    // for a writer that never passes a DTO.
    const shaped = await post('/hr/leave-types', adminAId).send({
      code: `AN NUAL-${now}`,
      name: 'نامعتبر',
    });
    expect(shaped.status).toBe(422);
    expect(shaped.body.details).toContain('code');
    // A name of spaces is not a name — `LeaveType_name_check` says the same thing in `hr_db`.
    expect(
      (await post('/hr/leave-types', adminAId).send({ code: `BLANK-${now}`, name: '   ' })).status
    ).toBe(422);

    // TWO entries in tenant A's catalogue and ONE in tenant B's: every refusal above wrote nothing,
    // and the two tenants' catalogues are counted apart.
    expect(await hrDb.leaveType.count({ where: { tenantId: tenantAId } })).toBe(2);
    expect(await hrDb.leaveType.count({ where: { tenantId: tenantBId } })).toBe(1);

    // The page is the tenant's OWN, ordered by CODE — the catalogue's stable order, so a request
    // form's dropdown does not reshuffle between reads.
    const listA = await get('/hr/leave-types', adminAId);
    expect(listA.status).toBe(200);
    expect(listA.body.total).toBe(2);
    expect(listA.body.items.map((row: { code: string }) => row.code)).toEqual([
      leaveTypeA.code,
      retiredTypeA.code,
    ]);
    const listB = await get('/hr/leave-types', adminBId);
    expect(listB.body.total).toBe(1);
    expect(listB.body.items.map((row: { id: string }) => row.id)).toEqual([leaveTypeB.id]);

    // `status` and `search` are real filters on stored fields, `search` case-insensitively, and a
    // value outside the vocabulary is a 422 rather than a filter that silently matches nothing.
    expect((await get('/hr/leave-types?status=ACTIVE', adminAId)).body.total).toBe(2);
    expect((await get('/hr/leave-types?status=INACTIVE', adminAId)).body.total).toBe(0);
    expect((await get(`/hr/leave-types?search=${studyCode}`, adminAId)).body.total).toBe(1);
    expect(
      (await get(`/hr/leave-types?search=${studyCode.toLowerCase()}`, adminAId)).body.total
    ).toBe(1);
    expect((await get('/hr/leave-types?status=RETIRED', adminAId)).status).toBe(422);
    // `tenantId` is not a member of any leave DTO, so the pipe refuses the field in a QUERY STRING
    // exactly as it does in a body.
    expect((await get(`/hr/leave-types?tenantId=${tenantBId}`, adminAId)).status).toBe(422);

    // Another tenant's entry is ABSENT, never FORBIDDEN: the lookup is tenant-scoped, so a foreign id
    // gets the same 404 a nonexistent one gets — a 403 would confirm the row exists somewhere else.
    expect((await get(`/hr/leave-types/${leaveTypeB.id}`, adminAId)).status).toBe(404);
    expect((await get(`/hr/leave-types/${leaveTypeA.id}`, adminBId)).status).toBe(404);
    expect(
      (await get('/hr/leave-types/00000000-0000-4000-8000-000000000000', adminAId)).status
    ).toBe(404);
    expect((await get('/hr/leave-types/not-a-uuid', adminAId)).status).toBe(400);

    // THERE IS NO DELETE ROUTE on the catalogue: retirement is a STATUS, and a type that has ever
    // been requested cannot be removed at all (§12.6 — `ON DELETE RESTRICT`).
    expect((await del(`/hr/leave-types/${retiredTypeA.id}`, adminAId)).status).toBe(404);
    expect(await hrDb.leaveType.count({ where: { id: retiredTypeA.id } })).toBe(1);

    // EVERY CREATE IS ON THE TRAIL, against its OWN resource: `hr.leave_type` is a separate resource
    // from `hr.leave`, because "somebody changed what kinds of leave this organization grants" is not
    // the same act as "somebody recorded a person's leave".
    const typeAudits = await prisma.auditLog.findMany({
      where: {
        resourceType: 'hr.leave_type',
        resourceId: { in: [leaveTypeA.id, leaveTypeB.id, retiredTypeA.id] },
      },
    });
    expect(typeAudits).toHaveLength(3);
    for (const row of typeAudits) {
      const written = [leaveTypeA, leaveTypeB, retiredTypeA].find(
        (type) => type.id === row.resourceId
      )!;
      expect(row.action).toBe('create');
      expect(row.success).toBe(true);
      expect(row.newValue).toMatchObject({ code: written.code, status: 'ACTIVE' });
      // The tenant and the actor on the trail are the row's OWN tenant and ITS administrator: the
      // two tenants' catalogue acts never share a row.
      expect(row.tenantId).toBe(written.tenantId);
      expect(row.userId).toBe(written.tenantId === tenantAId ? adminAId : adminBId);
    }
  });

  // ---------------------------------------------------------------------------
  // 12.2 — a request is a WHOLE-DAY, INCLUSIVE range that states why
  // ---------------------------------------------------------------------------
  //
  // The ORDER the service resolves things in is the contract (`LeaveService.create`): the employee
  // first (404 for a foreign or unknown id, 409 for a terminated one), then the leave type (404
  // foreign, 409 retired), then the period — which is why a refusal never leaves a row behind, and
  // why the caller is told the FIRST thing that is wrong rather than the last.

  it('records a request as a whole-day inclusive range, and refuses every shape a range cannot be', async () => {
    // THE SUBJECT AND THE TYPE ARE RESOLVED FROM THE TENANT, so neither can name another tenant's
    // row. `employeeB` is a REAL employee — of tenant B — and gets the same 404 an unknown id gets,
    // because a 403 would confirm that the row exists somewhere else.
    const foreignSubject = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeB.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-09-18',
      endDate: '2026-09-18',
      reason: 'کارمند سازمان دیگر',
    });
    expect(foreignSubject.status).toBe(404);
    expect(foreignSubject.body.message).toBe('Employee not found');

    const foreignType = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeB.id,
      startDate: '2026-09-18',
      endDate: '2026-09-18',
      reason: 'نوع مرخصی سازمان دیگر',
    });
    expect(foreignType.status).toBe(404);
    expect(foreignType.body.message).toBe('Leave type not found');

    // An id that is shaped right and names nothing is the same 404: a nonexistent row and another
    // tenant's row are one answer, because the lookup is tenant-scoped.
    expect(
      (
        await post('/hr/leave-requests', adminAId).send({
          employeeId: '00000000-0000-4000-8000-000000000000',
          leaveTypeId: leaveTypeA.id,
          startDate: '2026-09-18',
          endDate: '2026-09-18',
          reason: 'کارمند ناشناس',
        })
      ).body.message
    ).toBe('Employee not found');
    expect(
      (
        await post('/hr/leave-requests', adminAId).send({
          employeeId: employeeOne.id,
          leaveTypeId: '00000000-0000-4000-8000-000000000000',
          startDate: '2026-09-18',
          endDate: '2026-09-18',
          reason: 'نوع ناشناس',
        })
      ).body.message
    ).toBe('Leave type not found');
    // …and a value that is not a uuid never reaches the service: the route's own pipe answers first.
    expect(
      (
        await post('/hr/leave-requests', adminAId).send({
          employeeId: 'not-a-uuid',
          leaveTypeId: leaveTypeA.id,
          startDate: '2026-09-18',
          endDate: '2026-09-18',
          reason: 'شناسه نامعتبر',
        })
      ).status
    ).toBe(422);

    // WHAT THE CALLER MAY NOT STATE. `status` is absent from the create DTO — the initial state is a
    // DOMAIN constant, and a request born APPROVED would be a decision nobody gave — and `tenantId`
    // and `cancelledAt` are absent from every leave DTO. `forbidNonWhitelisted` makes each one a 422
    // that NAMES the field rather than a value the service quietly discards.
    for (const unknown of [
      { status: 'APPROVED' },
      { cancelledAt: '2026-09-18T00:00:00.000Z' },
      { tenantId: tenantBId },
    ]) {
      const attempt = await post('/hr/leave-requests', adminAId).send({
        employeeId: employeeOne.id,
        leaveTypeId: leaveTypeA.id,
        startDate: '2026-09-18',
        endDate: '2026-09-18',
        reason: 'میدان ناشناخته',
        ...unknown,
      });
      expect(attempt.status).toBe(422);
      expect(attempt.body.details).toEqual([Object.keys(unknown)[0]]);
    }

    // EVERY FIELD IS REQUIRED, and every missing one is named. The reason is the one to look at: it
    // is not a blank string, it is a request nobody can act on — and `LeaveRequest_reason_check`
    // refuses the same shape from a writer that never passes a DTO (§12.6).
    for (const field of ['employeeId', 'leaveTypeId', 'startDate', 'endDate', 'reason']) {
      const body: Record<string, unknown> = {
        employeeId: employeeOne.id,
        leaveTypeId: leaveTypeA.id,
        startDate: '2026-09-18',
        endDate: '2026-09-18',
        reason: 'ناقص',
      };
      delete body[field];
      const attempt = await post('/hr/leave-requests', adminAId).send(body);
      expect(attempt.status).toBe(422);
      expect(attempt.body.details).toContain(field);
    }

    // Spaces are not a reason either: `TrimmedReason` trims FIRST, so what the validator sees is the
    // empty string that makes this a 422 rather than a row whose justification is whitespace.
    const blank = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-09-18',
      endDate: '2026-09-18',
      reason: '   ',
    });
    expect(blank.status).toBe(422);
    expect(blank.body.details).toContain('reason');

    // A DAY THAT ONLY LOOKS LIKE ONE. `2026-02-30` matches the DTO pattern, and `Date` does NOT
    // answer `NaN` for it — the ISO parser ROLLS IT OVER to 2 March — so the shape check alone would
    // store a silently WRONG day on somebody's leave record. The service reads the day back and
    // compares, which is the only check that tells an existing day from a rolled-over one.
    const rolledOver = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-02-30',
      endDate: '2026-03-01',
      reason: 'روز ناموجود',
    });
    expect(rolledOver.status).toBe(400);
    expect(rolledOver.body.message).toBe('startDate must be a real YYYY-MM-DD date');

    // …and a well-shaped, EXISTING range that runs backwards is a 400 rather than a database error:
    // `LeaveRequest_period_check` (23514) is the guarantee, and the message a caller receives is the
    // service's — a caller who did nothing wrong is never handed a raw constraint violation.
    const inverted = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-09-22',
      endDate: '2026-09-18',
      reason: 'بازه وارونه',
    });
    expect(inverted.status).toBe(400);
    expect(inverted.body.message).toBe('endDate must not precede startDate.');

    // A REFUSAL IS NEVER A PARTIAL WRITE, and every refusal above has left nothing behind.
    expect(
      await hrDb.leaveRequest.count({ where: { tenantId: { in: [tenantAId, tenantBId] } } })
    ).toBe(0);

    // THE TERMINATED-PERSON GUARD is the service's, and it is measured through the real routes: the
    // person is created, then terminated, and only THEN is leave refused.
    const leaving = await post('/hr/employees', adminAId).send({
      employeeCode: `LEAVE-OUT-${now}`,
      employmentType: 'FULL_TIME',
      startDate: '2024-01-01',
      organizationUnitId: childUnitA.id,
      positionId: positionA.id,
    });
    expect(leaving.status).toBe(201);
    terminatedEmployee = leaving.body;
    createdAuditResourceIds.push(terminatedEmployee.id);

    const ended = await post(`/hr/employees/${terminatedEmployee.id}/terminate`, adminAId).send({
      endDate: '2025-12-31',
      reason: 'پایان همکاری',
    });
    expect(ended.status).toBe(200);
    expect(ended.body.employee.status).toBe('TERMINATED');
    createdAuditResourceIds.push(ended.body.closedRecord.id);

    const forTerminated = await post('/hr/leave-requests', adminAId).send({
      employeeId: terminatedEmployee.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-09-18',
      endDate: '2026-09-18',
      reason: 'برای فرد خاتمه‌یافته',
    });
    expect(forTerminated.status).toBe(409);
    expect(forTerminated.body.message).toBe(
      'Leave cannot be recorded for a terminated employee; rehire the person first.'
    );
    expect(await hrDb.leaveRequest.count({ where: { tenantId: tenantAId } })).toBe(0);

    // THE ORDINARY CREATE. The range is WHOLE-DAY and INCLUSIVE at both ends, and the REASON arrives
    // padded: `TrimmedReason` stores the statement itself and not the whitespace around it — this
    // module never re-words what a person wrote.
    const whole = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-09-18',
      endDate: '2026-09-22',
      reason: '  مرخصی سالانه  ',
    });
    expect(whole.status).toBe(201);
    leaveRequestA = whole.body;
    createdAuditResourceIds.push(leaveRequestA.id);

    // THE BOUNDS ROUND-TRIP AS DAYS, not as instants: a `@db.Date` read back as a timestamp would
    // shift the day for anybody east of UTC, and `2026-09-18T00:00:00.000Z` is not the day an
    // operator in Tehran typed.
    expect(leaveRequestA.startDate).toBe('2026-09-18');
    expect(leaveRequestA.endDate).toBe('2026-09-22');
    expect(leaveRequestA.reason).toBe('مرخصی سالانه');
    // THE STATE IS THE ACT'S, NOT THE CALLER'S: the create DTO has no `status`, and `cancelledAt`
    // has no honest value on a row nobody withdrew, so both come from the module.
    expect(leaveRequestA.status).toBe('PENDING');
    expect(leaveRequestA.cancelledAt).toBeNull();
    // THE LABELS ARE JOINED, so a register row is renderable without a second query: the person is
    // HR's own `employeeCode` (a NAME would come from Core through `HrIdentityGateway`, and this
    // layer never learns about identity) and the type is the tenant's own code and name.
    expect(leaveRequestA.employee).toEqual({
      id: employeeOne.id,
      employeeCode: employeeOne.employeeCode,
    });
    expect(leaveRequestA.leaveType).toEqual({
      id: leaveTypeA.id,
      code: leaveTypeA.code,
      name: leaveTypeA.name,
      status: 'ACTIVE',
    });
    // …and `hr_db` holds the same days: the period is FIVE calendar days of RECORD, and no
    // arithmetic was performed on it — no workdays counted, no holidays subtracted, no
    // `durationDays` stored (§13: that answer belongs to the calendar and the shift).
    const storedA = await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestA.id } });
    expect(storedA!.startDate.toISOString().slice(0, 10)).toBe('2026-09-18');
    expect(storedA!.endDate.toISOString().slice(0, 10)).toBe('2026-09-22');
    expect(storedA!.status).toBe('PENDING');
    expect(storedA!.cancelledAt).toBeNull();

    // A SINGLE DAY IS THE ORDINARY CASE, not a special one: `startDate = endDate`.
    const single = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      reason: 'یک روز',
    });
    expect(single.status).toBe(201);
    leaveRequestSingle = single.body;
    createdAuditResourceIds.push(leaveRequestSingle.id);
    expect([leaveRequestSingle.startDate, leaveRequestSingle.endDate]).toEqual([
      '2026-10-01',
      '2026-10-01',
    ]);

    // A THIRD REQUEST UNDER THE THIRD TYPE, recorded while that type is still ACTIVE — §12.4 retires
    // it and asks what happens to the history it was recorded under.
    const underThirdType = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: retiredTypeA.id,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
      reason: 'مرخصی تحصیلی',
    });
    expect(underThirdType.status).toBe(201);
    leaveRequestRetiredType = underThirdType.body;
    createdAuditResourceIds.push(leaveRequestRetiredType.id);

    // …and TENANT B RECORDS ITS OWN, through its own administrator: the two registers never share a
    // row, and tenant B's request names tenant B's employee under tenant B's type.
    const asB = await post('/hr/leave-requests', adminBId).send({
      employeeId: employeeB.id,
      leaveTypeId: leaveTypeB.id,
      startDate: '2026-09-05',
      endDate: '2026-09-06',
      reason: 'Tenant B leave',
    });
    expect(asB.status).toBe(201);
    leaveRequestB = asB.body;
    createdAuditResourceIds.push(leaveRequestB.id);
    expect(leaveRequestB.tenantId).toBe(tenantBId);

    // THE REGISTER IS THE TENANT'S, and its order is LATEST PERIOD FIRST — a total order
    // (`startDate`, then `createdAt`, then `id`), so two rows sharing a start date still have one
    // stable place and paging can neither repeat nor skip one.
    const listA = await get('/hr/leave-requests', adminAId);
    expect(listA.status).toBe(200);
    expect(listA.body.total).toBe(3);
    expect(listA.body.items.map((row) => row.id)).toEqual([
      leaveRequestSingle.id,
      leaveRequestA.id,
      leaveRequestRetiredType.id,
    ]);
    // …and tenant B's request is simply NOT IN IT: the register is scoped, so the other tenant's row
    // is invisible rather than forbidden.
    const listB = await get('/hr/leave-requests', adminBId);
    expect(listB.body.total).toBe(1);
    expect(listB.body.items.map((row) => row.id)).toEqual([leaveRequestB.id]);

    // The page window is the module's own, and the ORDER survives it: the register is paged by
    // `startDate` descending, so page 2 of 2-row pages is the oldest period and nothing is lost.
    const secondPage = await get('/hr/leave-requests?pageSize=2&page=2', adminAId);
    expect(secondPage.body.total).toBe(3);
    expect(secondPage.body.items.map((row) => row.id)).toEqual([leaveRequestRetiredType.id]);

    // THE FILTERS ARE REAL PREDICATES ON STORED COLUMNS, and every one of them is TENANT-PINNED
    // first: naming another tenant's type is an empty page, never a leak.
    expect(
      (await get(`/hr/leave-requests?employeeId=${employeeOne.id}`, adminAId)).body.total
    ).toBe(3);
    expect((await get(`/hr/leave-requests?employeeId=${employeeB.id}`, adminAId)).body.total).toBe(
      0
    );
    expect(
      (await get(`/hr/leave-requests?leaveTypeId=${leaveTypeA.id}`, adminAId)).body.total
    ).toBe(2);
    expect(
      (await get(`/hr/leave-requests?leaveTypeId=${leaveTypeB.id}`, adminAId)).body.total
    ).toBe(0);
    expect((await get('/hr/leave-requests?status=PENDING', adminAId)).body.total).toBe(3);
    expect((await get('/hr/leave-requests?status=CANCELLED', adminAId)).body.total).toBe(0);

    // THE DATE BOUNDS MEAN INTERSECTION WITH THE REQUEST'S OWN RANGE, NOT CONTAINMENT. `from` keeps
    // requests whose LAST day is on or after it, `to` keeps requests whose FIRST day is on or before
    // it — so a request that merely OVERLAPS the window is in it, which is the question a roster
    // screen asks. A containment filter would hide the long request that swallows the window whole.
    const september = await get('/hr/leave-requests?from=2026-09-01&to=2026-09-30', adminAId);
    expect(september.body.total).toBe(1);
    expect(september.body.items.map((row) => row.id)).toEqual([leaveRequestA.id]);
    const august = await get('/hr/leave-requests?from=2026-08-01&to=2026-08-31', adminAId);
    expect(august.body.items.map((row) => row.id)).toEqual([leaveRequestRetiredType.id]);
    // One bound alone is a real filter too: `from` alone drops everything that ended before it, and
    // `to` alone drops everything that starts after it.
    expect((await get('/hr/leave-requests?from=2026-09-20', adminAId)).body.total).toBe(2);
    expect((await get('/hr/leave-requests?to=2026-09-18', adminAId)).body.total).toBe(2);

    // A FILTER VALUE OUTSIDE THE VOCABULARY IS A 422, not a filter that silently matches nothing…
    expect((await get('/hr/leave-requests?status=RETIRED', adminAId)).status).toBe(422);
    expect((await get('/hr/leave-requests?employeeId=not-a-uuid', adminAId)).status).toBe(422);
    expect((await get('/hr/leave-requests?from=2026/09/18', adminAId)).status).toBe(422);
    // …`tenantId` is not a member of any leave DTO, so the pipe refuses it in a QUERY STRING exactly
    // as it does in a body…
    expect((await get(`/hr/leave-requests?tenantId=${tenantBId}`, adminAId)).status).toBe(422);
    // …and a window that runs backwards is refused rather than answered with an empty page, because
    // "no rows" and "a window nobody could have meant" are different answers.
    const backwards = await get('/hr/leave-requests?from=2026-10-05&to=2026-10-01', adminAId);
    expect(backwards.status).toBe(400);
    expect(backwards.body.message).toBe('to must not precede from.');

    // ONE REQUEST, BY ID: another tenant's is ABSENT rather than FORBIDDEN — the lookup is
    // tenant-scoped, so a foreign id gets the 404 a nonexistent one gets.
    const one = await get(`/hr/leave-requests/${leaveRequestA.id}`, adminAId);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(leaveRequestA.id);
    expect(one.body.employee.employeeCode).toBe(employeeOne.employeeCode);
    expect((await get(`/hr/leave-requests/${leaveRequestB.id}`, adminAId)).status).toBe(404);
    expect((await get(`/hr/leave-requests/${leaveRequestA.id}`, adminBId)).status).toBe(404);
    expect(
      (await get('/hr/leave-requests/00000000-0000-4000-8000-000000000000', adminAId)).status
    ).toBe(404);
    expect((await get('/hr/leave-requests/not-a-uuid', adminAId)).status).toBe(400);

    // EVERY CREATE IS ON THE TRAIL, against the `hr.leave` resource and carrying the days as DAYS.
    // The trail is where "who recorded this, and for which days" is answered, so it stores what the
    // register stores rather than a second rendering of it.
    const createAudits = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.leave', resourceId: leaveRequestA.id },
    });
    expect(createAudits).toHaveLength(1);
    expect(createAudits[0]).toMatchObject({
      action: 'create',
      success: true,
      tenantId: tenantAId,
      userId: adminAId,
      resourceId: leaveRequestA.id,
    });
    expect(createAudits[0].newValue).toMatchObject({
      employeeId: employeeOne.id,
      leaveTypeId: leaveTypeA.id,
      startDate: '2026-09-18',
      endDate: '2026-09-22',
      reason: 'مرخصی سالانه',
      status: 'PENDING',
    });
  });

  // ---------------------------------------------------------------------------
  // 12.3 — restatement is for a PENDING request ONLY, and a restatement that restates nothing
  //        writes NOTHING
  // ---------------------------------------------------------------------------

  it('restates a PENDING request only, and a body that restates what is already stored writes nothing', async () => {
    const before = (await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestA.id } }))!;
    // One row for the create, and no more: the accounting below starts from a known place.
    expect(await prisma.auditLog.count({ where: { resourceId: leaveRequestA.id } })).toBe(1);

    // A NO-OP, STATED EXACTLY. Every field sent is the value already stored, so the service writes
    // NOTHING and answers with the stored row. `updated_at` does not move either, which is the point:
    // a report, an incremental sync or a concurrency check reads that column as "an edit happened",
    // and an edit nobody made is a lie told to all three.
    const unchanged = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
      startDate: '2026-09-18',
      endDate: '2026-09-22',
      reason: leaveRequestA.reason,
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.startDate).toBe('2026-09-18');
    expect(unchanged.body.endDate).toBe('2026-09-22');
    const afterNoop = (await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestA.id } }))!;
    expect(afterNoop.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // …and no audit row describes an act that did not happen.
    expect(await prisma.auditLog.count({ where: { resourceId: leaveRequestA.id } })).toBe(1);

    // ONE END ALONE. The effective pair is resolved from the STORED row before it is validated, so
    // shortening a period does not force the caller to re-state the half that never moved.
    const shortened = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
      endDate: '2026-09-20',
    });
    expect(shortened.status).toBe(200);
    expect(shortened.body).toEqual(
      expect.objectContaining({ startDate: '2026-09-18', endDate: '2026-09-20' })
    );

    // …and the OTHER end, against the end that was just stored: the pair is checked AS A PAIR, so a
    // body that would fall back to an inverted range is a 400 here rather than a 500 from
    // `LeaveRequest_period_check` for a caller who did nothing wrong.
    const moved = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
      startDate: '2026-09-17',
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual(
      expect.objectContaining({ startDate: '2026-09-17', endDate: '2026-09-20' })
    );
    const inverted = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
      startDate: '2026-10-05',
    });
    expect(inverted.status).toBe(400);
    expect(inverted.body.message).toBe('endDate must not precede startDate.');
    expect(
      (await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestA.id } }))!.startDate
        .toISOString()
        .slice(0, 10)
    ).toBe('2026-09-17');

    // A BODY WITH NO FIELD AT ALL IS A 400, not a silent success: it would write an audit event
    // describing an act that did not happen, which is the failure the early return above avoids.
    const empty = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('Nothing to update: send at least one field.');
    // …and two fields the request's own identity rests on are not members of the update DTO at all:
    // a request's SUBJECT is not movable (re-pointing it is a different request, and the two would
    // share one audit trail), and its STATE moves through the withdrawal route, not through a patch.
    expect(
      (
        await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
          employeeId: employeeB.id,
        })
      ).status
    ).toBe(422);
    expect(
      (
        await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
          status: 'CANCELLED',
        })
      ).status
    ).toBe(422);

    // THE REASON MOVES ON ITS OWN, and it arrives padded: what is stored is the statement, not the
    // whitespace around it.
    const reworded = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
      reason: '  متن اصلاح‌شده  ',
    });
    expect(reworded.status).toBe(200);
    expect(reworded.body.reason).toBe('متن اصلاح‌شده');

    // THE TYPE MAY MOVE TOO, and it is resolved as a TYPE: another tenant's entry is absent (404,
    // the answer a nonexistent id gets) and the actor's own is accepted. §12.4 asks what happens to
    // this request afterwards, when the type it now names is retired.
    expect(
      (
        await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
          leaveTypeId: leaveTypeB.id,
        })
      ).status
    ).toBe(404);
    const retyped = await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminAId).send({
      leaveTypeId: retiredTypeA.id,
    });
    expect(retyped.status).toBe(200);
    expect(retyped.body.leaveType.id).toBe(retiredTypeA.id);
    // The response carries the JOINED label, so a screen that restated a request can re-render the
    // row it just changed without a second read.
    expect(retyped.body.leaveType.code).toBe(retiredTypeA.code);

    // THE ROUTE'S OWN BOUNDARY, and the tenant's: a value that is not a uuid never reaches the
    // service, and another tenant's request is ABSENT rather than FORBIDDEN in both directions.
    expect(
      (await patch('/hr/leave-requests/not-a-uuid', adminAId).send({ reason: 'x' })).status
    ).toBe(400);
    expect(
      (await patch(`/hr/leave-requests/${leaveRequestA.id}`, adminBId).send({ reason: 'x' })).status
    ).toBe(404);
    expect(
      (await patch(`/hr/leave-requests/${leaveRequestB.id}`, adminAId).send({ reason: 'x' })).status
    ).toBe(404);
    // Both of this phase's new sub-routes are behind the same guard stack as everything else.
    expect(
      (await patch(`/hr/leave-requests/${leaveRequestA.id}`).send({ reason: 'x' })).status
    ).toBe(401);
    expect(
      (await post(`/hr/leave-requests/${leaveRequestA.id}/cancel`).send({ reason: 'x' })).status
    ).toBe(401);

    // THE TRAIL ACCOUNTS FOR EXACTLY THE ACTS THAT WERE PERFORMED: one create and four restatements
    // — the end moved, the start moved, the reason re-worded, the type changed — and NOT ONE ROW for
    // the no-op, the 400s, the 404s or the rejected fields. `changedFields` names what moved, so the
    // statement and the trail cannot disagree about what happened.
    const trail = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.leave', resourceId: leaveRequestA.id },
    });
    expect(trail.map((row) => row.action).sort()).toEqual([
      'create',
      'update',
      'update',
      'update',
      'update',
    ]);
    expect(
      trail
        .filter((row) => row.action === 'update')
        .map((row) => JSON.stringify(row.changedFields))
        .sort()
    ).toEqual(
      [
        JSON.stringify(['endDate']),
        JSON.stringify(['leaveTypeId']),
        JSON.stringify(['reason']),
        JSON.stringify(['startDate']),
      ].sort()
    );
    expect(
      trail.every((row) => row.userId === adminAId && row.tenantId === tenantAId && row.success)
    ).toBe(true);
    // The type move records BOTH sides of the change, which is what makes the trail readable a year
    // later: which leave kind it was recorded under, and which one it now names.
    const typeMove = trail.find((row) => row.changedFields.includes('leaveTypeId'))!;
    expect(typeMove.oldValue).toMatchObject({ leaveTypeId: leaveTypeA.id });
    expect(typeMove.newValue).toMatchObject({ leaveTypeId: retiredTypeA.id });
  });

  // ---------------------------------------------------------------------------
  // 12.4 — retirement is a STATUS, never a delete
  // ---------------------------------------------------------------------------

  it('retires a catalogue entry by STATUS, and the history recorded under it keeps rendering its name', async () => {
    // A RENAME IS POLICY AND IT MOVES FREELY. The name is the tenant's own words — trimmed, and
    // otherwise untouched — while the CODE does not move with it…
    const renamed = await patch(`/hr/leave-types/${retiredTypeA.id}`, adminAId).send({
      name: 'مرخصی تحصیلی (بازنگری‌شده)',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('مرخصی تحصیلی (بازنگری‌شده)');
    expect(renamed.body.code).toBe(retiredTypeA.code);
    expect(renamed.body.status).toBe('ACTIVE');

    // …because a CODE is an IDENTITY: renaming the key a tenant's own reports and imports cite is a
    // NEW entry, not an edit, which is why `code` is not a member of the update DTO at all.
    expect(
      (await patch(`/hr/leave-types/${retiredTypeA.id}`, adminAId).send({ code: `RENAMED-${now}` }))
        .status
    ).toBe(422);

    // A BODY WITH NEITHER FIELD IS A 400, the same rule the register states, and the lookup is
    // tenant-scoped in the same three directions as every other leave read.
    const empty = await patch(`/hr/leave-types/${retiredTypeA.id}`, adminAId).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('Nothing to update: send name or status.');
    expect(
      (
        await patch('/hr/leave-types/00000000-0000-4000-8000-000000000000', adminAId).send({
          status: 'INACTIVE',
        })
      ).status
    ).toBe(404);
    expect(
      (await patch(`/hr/leave-types/${leaveTypeB.id}`, adminAId).send({ status: 'INACTIVE' }))
        .status
    ).toBe(404);
    expect(
      (await patch(`/hr/leave-types/${retiredTypeA.id}`, adminBId).send({ status: 'INACTIVE' }))
        .status
    ).toBe(404);

    // HOW MANY REQUESTS ARE ON FILE UNDER IT — the count every refusal below must leave untouched.
    const underIt = await hrDb.leaveRequest.count({ where: { leaveTypeId: retiredTypeA.id } });
    expect(underIt).toBe(2);

    // THE RETIREMENT IS A STATUS…
    const retired = await patch(`/hr/leave-types/${retiredTypeA.id}`, adminAId).send({
      status: 'INACTIVE',
    });
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe('INACTIVE');
    // …SO THE ROW IS STILL THERE, and still addressable: every request recorded against it must keep
    // rendering its name, and a 404 here would be a lie about the catalogue…
    expect(await hrDb.leaveType.count({ where: { id: retiredTypeA.id } })).toBe(1);
    const addressable = await get(`/hr/leave-types/${retiredTypeA.id}`, adminAId);
    expect(addressable.status).toBe(200);
    expect(addressable.body.status).toBe('INACTIVE');
    // …while the question the request FORM asks — what may be chosen NOW — no longer includes it.
    expect(
      (await get('/hr/leave-types?status=ACTIVE', adminAId)).body.items.map(
        (row: { code: string }) => row.code
      )
    ).not.toContain(retiredTypeA.code);
    expect(
      (await get('/hr/leave-types?status=INACTIVE', adminAId)).body.items.map(
        (row: { code: string }) => row.code
      )
    ).toEqual([retiredTypeA.code]);

    // A RETIRED ENTRY IS A 409 AND NOT A 404 for a NEW request: what is refused is its USE, not its
    // existence, and the refusal names the code and the state instead of making a caller guess.
    const refused = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: retiredTypeA.id,
      startDate: '2026-11-01',
      endDate: '2026-11-02',
      reason: 'پس از بازنشستگی نوع',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe(
      `Leave type ${retiredTypeA.code} is INACTIVE and cannot be chosen for a request.`
    );
    expect(await hrDb.leaveRequest.count({ where: { leaveTypeId: retiredTypeA.id } })).toBe(
      underIt
    );

    // …AND A REASON ON A ROW RECORDED UNDER IT IS STILL RESTATABLE. Retirement closes the catalogue
    // to NEW and CHANGED choices; it does not freeze somebody's pending request, because the type is
    // not what this body changes — the selectability check runs on a change, not on a read.
    const restatedUnderRetired = await patch(
      `/hr/leave-requests/${leaveRequestRetiredType.id}`,
      adminAId
    ).send({ reason: 'توضیح اصلاح‌شده' });
    expect(restatedUnderRetired.status).toBe(200);
    expect(restatedUnderRetired.body.reason).toBe('توضیح اصلاح‌شده');
    expect(restatedUnderRetired.body.leaveType.id).toBe(retiredTypeA.id);

    // …AND A CHANGE OF TYPE TO THE RETIRED ENTRY IS REFUSED, even from a request that is otherwise
    // free to be restated: the rule is about the CHOICE being made, so `leaveRequestSingle` — still
    // under the ACTIVE type — cannot move to this one.
    const moveToRetired = await patch(`/hr/leave-requests/${leaveRequestSingle.id}`, adminAId).send(
      {
        leaveTypeId: retiredTypeA.id,
      }
    );
    expect(moveToRetired.status).toBe(409);
    expect(moveToRetired.body.message).toBe(
      `Leave type ${retiredTypeA.code} is INACTIVE and cannot be chosen for a request.`
    );
    expect(
      (await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestSingle.id } }))!.leaveTypeId
    ).toBe(leaveTypeA.id);

    // THE HISTORY KEEPS ITS NAME — the CURRENT one, together with the state that explains why the
    // entry is no longer offered — so a screen can say "granted under a kind we no longer use"
    // without a second read, and without the request having to store a copy of the name.
    const history = await get(`/hr/leave-requests/${leaveRequestRetiredType.id}`, adminAId);
    expect(history.status).toBe(200);
    expect(history.body.leaveType).toEqual({
      id: retiredTypeA.id,
      code: retiredTypeA.code,
      name: 'مرخصی تحصیلی (بازنگری‌شده)',
      status: 'INACTIVE',
    });
    // …and nothing left the REGISTER: retirement is a catalogue act, and the register is untouched.
    expect((await get('/hr/leave-requests', adminAId)).body.total).toBe(3);

    // IT CAN COME BACK, WHICH IS WHAT MAKES `INACTIVE` A STATE RATHER THAN AN ENDING…
    const returned = await patch(`/hr/leave-types/${retiredTypeA.id}`, adminAId).send({
      status: 'ACTIVE',
    });
    expect(returned.status).toBe(200);
    expect(returned.body.status).toBe('ACTIVE');
    const afterReturn = await post('/hr/leave-requests', adminAId).send({
      employeeId: employeeOne.id,
      leaveTypeId: retiredTypeA.id,
      startDate: '2026-11-01',
      endDate: '2026-11-02',
      reason: 'پس از بازگشت نوع',
    });
    expect(afterReturn.status).toBe(201);
    createdAuditResourceIds.push(afterReturn.body.id);
    // …and retired again, so the catalogue this section leaves behind is the one its own sentences
    // describe: NOT selectable for anything new.
    expect(
      (await patch(`/hr/leave-types/${retiredTypeA.id}`, adminAId).send({ status: 'INACTIVE' }))
        .body.status
    ).toBe('INACTIVE');
    expect(
      (
        await post('/hr/leave-requests', adminAId).send({
          employeeId: employeeOne.id,
          leaveTypeId: retiredTypeA.id,
          startDate: '2026-12-01',
          endDate: '2026-12-02',
          reason: 'دوباره ممنوع',
        })
      ).status
    ).toBe(409);

    // THE CATALOGUE TRAIL CARRIES THE CATALOGUE ACTS, against `hr.leave_type` — a SEPARATE resource
    // from `hr.leave`, because "somebody changed what kinds of leave this organization grants" is not
    // the same act as "somebody recorded a person's leave".
    const typeTrail = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.leave_type', resourceId: retiredTypeA.id },
    });
    expect(typeTrail.map((row) => row.action).sort()).toEqual([
      'create',
      'update',
      'update',
      'update',
      'update',
    ]);
    // One rename, and three state changes: retire, return, retire.
    expect(typeTrail.filter((row) => row.changedFields.includes('name'))).toHaveLength(1);
    expect(
      typeTrail
        .filter((row) => row.changedFields.includes('status'))
        .map((row) => (row.newValue as { status: string }).status)
        .sort()
    ).toEqual(['ACTIVE', 'INACTIVE', 'INACTIVE']);
    expect(typeTrail.every((row) => row.tenantId === tenantAId && row.userId === adminAId)).toBe(
      true
    );
  });

  // ---------------------------------------------------------------------------
  // 12.5 — withdrawal is the ONE transition this phase owns
  // ---------------------------------------------------------------------------

  it('withdraws a PENDING request, and a second attempt is a 409 rather than a second instant', async () => {
    // THE REASON IS REQUIRED, TRIMMED, AND NOT STORED ON THE ROW. It is required because an act that
    // overrides somebody's own record states why, and it is not stored because a withdrawal is an
    // EVENT: `LeaveRequest` has no `cancellation_reason` column, and the trail is where an act's
    // stated reason belongs.
    expect(
      (await post(`/hr/leave-requests/${leaveRequestSingle.id}/cancel`, adminAId).send({})).status
    ).toBe(422);
    expect(
      (
        await post(`/hr/leave-requests/${leaveRequestSingle.id}/cancel`, adminAId).send({
          reason: '   ',
        })
      ).status
    ).toBe(422);
    // …and the INSTANT is not a field a caller may send: it is the act's own, taken from the server.
    expect(
      (
        await post(`/hr/leave-requests/${leaveRequestSingle.id}/cancel`, adminAId).send({
          reason: 'منصرف شدم',
          cancelledAt: '2026-09-18T00:00:00.000Z',
        })
      ).status
    ).toBe(422);

    // THE WITHDRAWAL ITSELF: `PENDING -> CANCELLED`, both halves of the state change in ONE statement
    // because `LeaveRequest_cancelled_state_check` ties them together in both directions.
    const withdrawn = await post(
      `/hr/leave-requests/${leaveRequestSingle.id}/cancel`,
      adminAId
    ).send({
      reason: '  منصرف شدم  ',
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('CANCELLED');
    expect(withdrawn.body.cancelledAt).toEqual(expect.any(String));
    // …and the REST of the row is untouched: a withdrawal is not a re-wording of the request.
    expect(withdrawn.body.startDate).toBe('2026-10-01');
    expect(withdrawn.body.endDate).toBe('2026-10-01');
    expect(withdrawn.body.reason).toBe('یک روز');
    const stored = (await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestSingle.id } }))!;
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancelledAt).toBeInstanceOf(Date);

    // A SECOND ATTEMPT IS A 409, AND NOT A SECOND INSTANT. `CANCELLED` has an EMPTY transition list
    // rather than no entry at all, so "a withdrawn request cannot be withdrawn again" is a statement
    // the domain makes rather than one it fails to make — and the stamp on the row never moves.
    const again = await post(`/hr/leave-requests/${leaveRequestSingle.id}/cancel`, adminAId).send({
      reason: 'دوباره',
    });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(
      'A CANCELLED request cannot be withdrawn; a withdrawn request is terminal.'
    );
    expect(
      (await hrDb.leaveRequest.findFirst({
        where: { id: leaveRequestSingle.id },
      }))!.cancelledAt!.toISOString()
    ).toBe(stored.cancelledAt!.toISOString());

    // …SO A WITHDRAWN REQUEST IS NOT RESTATED EITHER: a correction to it is a NEW request, which is
    // what keeps the trail of the withdrawal intact instead of overwriting it with an edit.
    const restated = await patch(`/hr/leave-requests/${leaveRequestSingle.id}`, adminAId).send({
      reason: 'اصلاح',
    });
    expect(restated.status).toBe(409);
    expect(restated.body.message).toBe(
      'A CANCELLED request cannot be restated; submit a new request instead.'
    );

    // THERE IS NO DELETE ROUTE ON THE REGISTER EITHER: a request is WITHDRAWN, never removed — and
    // the row still answers, because the withdrawal is a property of the request rather than an
    // absence of one.
    expect((await del(`/hr/leave-requests/${leaveRequestSingle.id}`, adminAId)).status).toBe(404);
    expect(await hrDb.leaveRequest.count({ where: { id: leaveRequestSingle.id } })).toBe(1);
    expect(
      (await get('/hr/leave-requests?status=CANCELLED', adminAId)).body.items.map(
        (row: { id: string }) => row.id
      )
    ).toEqual([leaveRequestSingle.id]);
    // The other three are still open, and the register's total never changed: one request moved state.
    expect((await get('/hr/leave-requests?status=PENDING', adminAId)).body.total).toBe(3);
    expect((await get('/hr/leave-requests', adminAId)).body.total).toBe(4);
    // A filter for a state that is NOT in the vocabulary is a 422 rather than an empty page: the day
    // `APPROVED` arrives, a screen must fail loudly rather than show "no rows".
    expect((await get('/hr/leave-requests?status=APPROVED', adminAId)).status).toBe(422);

    // ANOTHER TENANT'S REQUEST IS ABSENT FOR THE WITHDRAWAL TOO, in both directions, and the route's
    // own pipe answers a value that is not a uuid before the service is reached…
    expect(
      (await post(`/hr/leave-requests/${leaveRequestB.id}/cancel`, adminAId).send({ reason: 'x' }))
        .status
    ).toBe(404);
    expect(
      (await post(`/hr/leave-requests/${leaveRequestA.id}/cancel`, adminBId).send({ reason: 'x' }))
        .status
    ).toBe(404);
    expect(
      (await post('/hr/leave-requests/not-a-uuid/cancel', adminAId).send({ reason: 'x' })).status
    ).toBe(400);
    expect(
      (
        await post('/hr/leave-requests/00000000-0000-4000-8000-000000000000/cancel', adminAId).send(
          {
            reason: 'x',
          }
        )
      ).status
    ).toBe(404);
    // …so tenant B's request is STILL PENDING after tenant A's four attempts, and tenant B's own
    // administrator withdraws it through tenant B's register.
    expect((await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestB.id } }))!.status).toBe(
      'PENDING'
    );
    const withdrawnB = await post(`/hr/leave-requests/${leaveRequestB.id}/cancel`, adminBId).send({
      reason: 'Tenant B withdrew',
    });
    expect(withdrawnB.status).toBe(200);
    expect(withdrawnB.body.status).toBe('CANCELLED');
    // …and each tenant's register shows exactly ITS OWN withdrawal.
    expect((await get('/hr/leave-requests?status=CANCELLED', adminAId)).body.total).toBe(1);
    expect((await get('/hr/leave-requests?status=CANCELLED', adminBId)).body.total).toBe(1);

    // THE TRAIL RECORDS THE WITHDRAWAL AS AN ACT, with BOTH halves of the state change and the stated
    // reason ON THE ACT: `cancelled_at` is on the row, and WHY it happened is here. That is the shape
    // §13 requires of an act that overrides somebody's own record.
    const trail = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.leave', resourceId: leaveRequestSingle.id },
    });
    expect(trail.map((row) => row.action).sort()).toEqual(['cancel', 'create']);
    const cancelRow = trail.find((row) => row.action === 'cancel')!;
    expect(cancelRow.changedFields).toEqual(['status', 'cancelledAt']);
    expect(cancelRow.oldValue).toMatchObject({ status: 'PENDING', cancelledAt: null });
    expect(cancelRow.newValue).toMatchObject({ status: 'CANCELLED' });
    expect(cancelRow.userId).toBe(adminAId);
    expect(cancelRow.tenantId).toBe(tenantAId);
    expect(cancelRow.reason).toBe('منصرف شدم');
    // …and the two reasons stay in their own places: the request keeps the REQUESTER's statement, and
    // the withdrawal's statement exists only on the act.
    expect(
      (await hrDb.leaveRequest.findFirst({ where: { id: leaveRequestSingle.id } }))!.reason
    ).toBe('یک روز');

    // THE SAME SHAPE IN THE OTHER TENANT, WITH ITS OWN ACTOR: neither tenant's withdrawal act can be
    // attributed to the other's administrator.
    const trailB = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.leave', resourceId: leaveRequestB.id },
    });
    expect(trailB.map((row) => row.action).sort()).toEqual(['cancel', 'create']);
    const cancelB = trailB.find((row) => row.action === 'cancel')!;
    expect(cancelB.reason).toBe('Tenant B withdrew');
    expect(cancelB.userId).toBe(adminBId);
    expect(cancelB.tenantId).toBe(tenantBId);
  });

  // ---------------------------------------------------------------------------
  // 12.6 — PostgreSQL holds every guarantee, not the service
  // ---------------------------------------------------------------------------
  //
  // §12.2–§12.5 asked the ROUTES; this section asks POSTGRESQL. `refusalFrom` — stated with §10's two
  // refusal SHAPES — is reused, and EVERY WRITE BELOW BYPASSES THE SERVICE: the ordinary Prisma
  // client, with no DTO, no controller and no `hr.*` permission in the path, which is exactly the
  // "future migration, a script, or a manual UPDATE" §13 names. Anything PostgreSQL accepts here it
  // would accept in production.

  it('holds the leave guarantees in PostgreSQL itself: composite keys, five CHECKs and RESTRICT on both sides', async () => {
    // THE DECLARATIONS ARE ASSERTED BY NAME FIRST, so RENAMING or DROPPING one fails here instead of
    // silently removing a guarantee that every other test would still pass without.
    const indexes = await hrDb.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename IN ('LeaveRequest', 'LeaveType')
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'LeaveType_tenantId_code_key',
        'LeaveType_tenantId_id_key',
        'LeaveType_tenantId_status_code_idx',
        'LeaveRequest_tenantId_id_key',
        'LeaveRequest_tenantId_status_startDate_idx',
        'LeaveRequest_tenantId_employeeId_startDate_idx',
        'LeaveRequest_tenantId_leaveTypeId_startDate_idx',
      ])
    );
    const checks = await hrDb.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c'
    `;
    expect(checks.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'LeaveRequest_period_check',
        'LeaveRequest_reason_check',
        'LeaveRequest_cancelled_state_check',
        'LeaveType_code_check',
        'LeaveType_name_check',
      ])
    );

    // A PERSON AND A REQUEST WRITTEN BY THE ORDINARY CLIENT: no route, no service, no audit. This
    // section uses their ROWS; §12.7 uses that silence.
    leaveDbEmployee = await hrDb.employee.create({
      data: { tenantId: tenantAId, employeeCode: `LEAVE-DB-${now}` },
    });
    leaveDbRequest = await hrDb.leaveRequest.create({
      data: {
        tenantId: tenantAId,
        employeeId: leaveDbEmployee.id,
        leaveTypeId: leaveTypeA.id,
        startDate: new Date(Date.UTC(2026, 8, 1)),
        endDate: new Date(Date.UTC(2026, 8, 3)),
        reason: 'ثبت مستقیم',
        status: 'PENDING',
      },
    });
    const rowsBefore = await hrDb.leaveRequest.count({ where: { tenantId: tenantAId } });

    // ON DELETE RESTRICT, ON BOTH SIDES. A request outlives the TYPE it was recorded under and the
    // PERSON it is about: deleting either one is refused, so history is not erasable by deleting the
    // row it depends on. This is the same discipline §10 established for the register.
    const typeDelete = await refusalFrom(() =>
      hrDb.leaveType.delete({ where: { id: leaveTypeA.id } })
    );
    expect(typeDelete.accepted).toBe(false);
    expect(typeDelete.code).toBe('P2003');
    expect(typeDelete.constraint).toBe('LeaveRequest_tenant_leave_type_fkey (index)');
    expect(typeDelete.message).toContain('LeaveRequest_tenant_leave_type_fkey');

    const employeeDelete = await refusalFrom(() =>
      hrDb.employee.delete({ where: { id: leaveDbEmployee.id } })
    );
    expect(employeeDelete.accepted).toBe(false);
    expect(employeeDelete.code).toBe('P2003');
    expect(employeeDelete.constraint).toBe('LeaveRequest_tenant_employee_fkey (index)');
    expect(employeeDelete.message).toContain('LeaveRequest_tenant_employee_fkey');

    // Both rows are still there, which is what "refused" has to mean: a refusal is not a delete that
    // half happened.
    expect(await hrDb.leaveType.count({ where: { id: leaveTypeA.id } })).toBe(1);
    expect(await hrDb.employee.count({ where: { id: leaveDbEmployee.id } })).toBe(1);

    // THE COMPOSITE KEYS, ON INSERT. `employeeB` is a REAL employee — of tenant B — so nothing about
    // the row below is malformed except the one thing the key exists to forbid. A same-tenant FK
    // could not express this: it is the TENANT in the reference that makes the cross-tenant row
    // unrepresentable rather than merely refused.
    const crossEmployeeInsert = await refusalFrom(() =>
      hrDb.leaveRequest.create({
        data: {
          tenantId: tenantAId,
          employeeId: employeeB.id,
          leaveTypeId: leaveTypeA.id,
          startDate: new Date(Date.UTC(2026, 8, 8)),
          endDate: new Date(Date.UTC(2026, 8, 9)),
          reason: 'کارمند سازمان دیگر',
          status: 'PENDING',
        },
      })
    );
    expect(crossEmployeeInsert.accepted).toBe(false);
    expect(crossEmployeeInsert.code).toBe('P2003');
    expect(crossEmployeeInsert.constraint).toBe('LeaveRequest_tenant_employee_fkey (index)');

    // …and the type half of the same guarantee: tenant A's request cannot cite tenant B's leave kind,
    // even though that kind carries the SAME code as tenant A's own (§12.1).
    const crossTypeInsert = await refusalFrom(() =>
      hrDb.leaveRequest.create({
        data: {
          tenantId: tenantAId,
          employeeId: leaveDbEmployee.id,
          leaveTypeId: leaveTypeB.id,
          startDate: new Date(Date.UTC(2026, 8, 8)),
          endDate: new Date(Date.UTC(2026, 8, 9)),
          reason: 'نوع سازمان دیگر',
          status: 'PENDING',
        },
      })
    );
    expect(crossTypeInsert.accepted).toBe(false);
    expect(crossTypeInsert.code).toBe('P2003');
    expect(crossTypeInsert.constraint).toBe('LeaveRequest_tenant_leave_type_fkey (index)');

    // …AND ON UPDATE: re-pointing an EXISTING row at another tenant's person, or another tenant's
    // type, is the shape a "fix this person's records" script takes — and it is refused too, so "the
    // subject of a request cannot move across the boundary" is not merely a DTO rule.
    const crossEmployeeUpdate = await refusalFrom(() =>
      hrDb.leaveRequest.update({
        where: { id: leaveDbRequest.id },
        data: { employeeId: employeeB.id },
      })
    );
    expect(crossEmployeeUpdate.accepted).toBe(false);
    expect(crossEmployeeUpdate.code).toBe('P2003');
    expect(crossEmployeeUpdate.constraint).toBe('LeaveRequest_tenant_employee_fkey (index)');

    const crossTypeUpdate = await refusalFrom(() =>
      hrDb.leaveRequest.update({
        where: { id: leaveDbRequest.id },
        data: { leaveTypeId: leaveTypeB.id },
      })
    );
    expect(crossTypeUpdate.accepted).toBe(false);
    expect(crossTypeUpdate.code).toBe('P2003');
    expect(crossTypeUpdate.constraint).toBe('LeaveRequest_tenant_leave_type_fkey (index)');

    // Four refusals, four unchanged columns: the row still names its own tenant's person and type.
    const storedDbRequest = (await hrDb.leaveRequest.findFirst({
      where: { id: leaveDbRequest.id },
    }))!;
    expect(storedDbRequest.employeeId).toBe(leaveDbEmployee.id);
    expect(storedDbRequest.leaveTypeId).toBe(leaveTypeA.id);

    // THE THREE CHECKs THE REGISTER STATES ITSELF, each attempted as a writer that never passes the
    // service would attempt it. `LeaveRequest_cancelled_state_check` is tried in BOTH directions,
    // because "no CANCELLED row without an instant" and "no instant on a row that is still pending"
    // are two different guarantees sharing one predicate.
    const attempts: {
      constraint: string;
      data: {
        startDate: Date;
        endDate: Date;
        reason: string;
        status?: 'PENDING' | 'CANCELLED';
        cancelledAt?: Date | null;
      };
    }[] = [
      {
        // An inverted range is not a request. `end_date = start_date` IS one, and §12.2 made it.
        constraint: 'LeaveRequest_period_check',
        data: {
          startDate: new Date(Date.UTC(2026, 8, 10)),
          endDate: new Date(Date.UTC(2026, 8, 9)),
          reason: 'بازه وارونه',
        },
      },
      {
        // A request states WHY, and `btrim` makes spaces stop being a statement — the same rule
        // `Attendance_manual_reason_check` applies to a correction.
        constraint: 'LeaveRequest_reason_check',
        data: {
          startDate: new Date(Date.UTC(2026, 8, 10)),
          endDate: new Date(Date.UTC(2026, 8, 11)),
          reason: '   ',
        },
      },
      {
        constraint: 'LeaveRequest_cancelled_state_check',
        data: {
          startDate: new Date(Date.UTC(2026, 8, 10)),
          endDate: new Date(Date.UTC(2026, 8, 11)),
          reason: 'بدون زمان انصراف',
          status: 'CANCELLED',
          cancelledAt: null,
        },
      },
      {
        constraint: 'LeaveRequest_cancelled_state_check',
        data: {
          startDate: new Date(Date.UTC(2026, 8, 10)),
          endDate: new Date(Date.UTC(2026, 8, 11)),
          reason: 'زمان روی درخواست باز',
          status: 'PENDING',
          cancelledAt: new Date(),
        },
      },
    ];

    for (const attempt of attempts) {
      const refused = await refusalFrom(() =>
        hrDb.leaveRequest.create({
          data: {
            tenantId: tenantAId,
            employeeId: leaveDbEmployee.id,
            leaveTypeId: leaveTypeA.id,
            ...attempt.data,
          },
        })
      );
      expect(refused.accepted).toBe(false);
      // A CHECK has NO Prisma code at all, and it names itself only inside the driver's message — so
      // "no code" is not "no refusal", and the assertion points at 23514 AND at the exact constraint.
      expect(refused.code).toBeUndefined();
      expect(refused.message).toContain('23514');
      expect(refused.message).toContain(attempt.constraint);
    }

    // THE CATALOGUE'S OWN TWO, from the same kind of writer: a code spelled the way no normaliser
    // would spell it, and a name that renders as nothing.
    const badCode = await refusalFrom(() =>
      hrDb.leaveType.create({
        data: { tenantId: tenantAId, code: `AN NUAL-${now}`, name: 'نامعتبر' },
      })
    );
    expect(badCode.accepted).toBe(false);
    expect(badCode.code).toBeUndefined();
    expect(badCode.message).toContain('23514');
    expect(badCode.message).toContain('LeaveType_code_check');

    const blankName = await refusalFrom(() =>
      hrDb.leaveType.create({ data: { tenantId: tenantAId, code: `BLANK-${now}`, name: '   ' } })
    );
    expect(blankName.accepted).toBe(false);
    expect(blankName.code).toBeUndefined();
    expect(blankName.message).toContain('23514');
    expect(blankName.message).toContain('LeaveType_name_check');

    // …AND THE UNIQUE INDEX, which is the ARBITER of the catalogue's other rule: a code is unique PER
    // TENANT. The pre-check the service runs makes the ordinary duplicate a 409; the index is what
    // makes two concurrent creates safe, and it is per tenant on the NORMALISED value, so a global
    // index — which would make two tenants collide — is refused by construction rather than by
    // convention.
    const duplicate = await refusalFrom(() =>
      hrDb.leaveType.create({
        data: { tenantId: tenantAId, code: leaveTypeA.code, name: 'مرخصی تکراری' },
      })
    );
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.code).toBe('P2002');
    expect(
      await hrDb.leaveType.count({ where: { tenantId: tenantAId, code: leaveTypeA.code } })
    ).toBe(1);
    // …while the SAME code in the OTHER tenant is the ordinary case rather than a duplicate: the index
    // is unique PER TENANT, which is what lets two organizations each own `ANNUAL`. The code is chosen
    // for THIS assertion rather than borrowed from §12.1, because §12.1 already gave tenant B an entry
    // under tenant A's own code — re-using it here would measure the duplicate rule a second time
    // instead of the per-tenant rule. Both rows are removed again.
    const perTenantCode = `PER-TENANT-${now}`;
    const sameCodeInA = await hrDb.leaveType.create({
      data: { tenantId: tenantAId, code: perTenantCode, name: 'First tenant' },
    });
    const sameCodeInB = await hrDb.leaveType.create({
      data: { tenantId: tenantBId, code: perTenantCode, name: 'Second tenant' },
    });
    expect(sameCodeInA.tenantId).toBe(tenantAId);
    expect(sameCodeInB.tenantId).toBe(tenantBId);
    expect(sameCodeInB.code).toBe(perTenantCode);
    await hrDb.leaveType.delete({ where: { id: sameCodeInB.id } });
    await hrDb.leaveType.delete({ where: { id: sameCodeInA.id } });

    // WHAT POSTGRESQL DOES NOT REFUSE IS AS INFORMATIVE AS WHAT IT DOES. `terminatedEmployee` is
    // TERMINATED, and §12.2 measured the 409 the ROUTE answers — yet the ordinary client writes a
    // request for the same person, because the composite key forbids a CROSS-TENANT subject and says
    // nothing at all about employment status. The termination rule is one this module OWNS rather
    // than one it inherits from the schema, which is worth pinning: the first script that inserted
    // such a row directly would otherwise look like a broken constraint.
    expect((await hrDb.employee.findFirst({ where: { id: terminatedEmployee.id } }))!.status).toBe(
      'TERMINATED'
    );
    const forTerminatedByDb = await hrDb.leaveRequest.create({
      data: {
        tenantId: tenantAId,
        employeeId: terminatedEmployee.id,
        leaveTypeId: leaveTypeA.id,
        startDate: new Date(Date.UTC(2026, 11, 1)),
        endDate: new Date(Date.UTC(2026, 11, 2)),
        reason: 'ثبت مستقیم برای فرد خاتمه‌یافته',
        status: 'PENDING',
      },
    });
    expect(forTerminatedByDb.status).toBe('PENDING');
    // …and it is removed again, because the point was that it COULD be written rather than that it
    // should stay: this suite's register must hold what its own sentences describe.
    await hrDb.leaveRequest.delete({ where: { id: forTerminatedByDb.id } });

    // A REFUSED WRITE IS NEVER A PARTIAL ONE: after two RESTRICT refusals, four composite-key
    // refusals, seven CHECK/index refusals and one deleted deliberate row, the register and the
    // catalogue hold EXACTLY what they held before.
    expect(await hrDb.leaveRequest.count({ where: { tenantId: tenantAId } })).toBe(rowsBefore);
    expect(await hrDb.leaveType.count({ where: { tenantId: tenantAId } })).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 12.7 — the trail records ACTS, not writes — and there is no approval act to record
  // ---------------------------------------------------------------------------

  it('records ACTS rather than database writes, and offers no approval act to record', async () => {
    // §12.6 WROTE A PERSON AND A REQUEST THROUGH THE ORDINARY CLIENT — the same client, the same
    // database and the same tables a script or a migration would use. Those rows were REAL data (the
    // RESTRICT refusals are the proof) and they are ABSENT from the trail, because no route performed
    // them. This is what allows `AuditLog` to be evidence: a writer that bypasses the service cannot
    // pad it, and it cannot certify a change no route made.
    expect(await prisma.auditLog.count({ where: { resourceId: leaveDbEmployee.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { resourceId: leaveDbRequest.id } })).toBe(0);

    // …AND THE CONTRAST THAT MAKES THOSE ZEROS MEAN SOMETHING: rows written into the SAME two tables
    // through the routes are on file, with the actor and the tenant that wrote them.
    const viaApi = await prisma.auditLog.findMany({
      where: { resourceType: 'hr.leave', resourceId: leaveRequestRetiredType.id },
    });
    expect(viaApi.length).toBeGreaterThan(0);
    expect(viaApi.every((row) => row.userId === adminAId && row.tenantId === tenantAId)).toBe(true);

    // THE TRAIL'S VOCABULARY IS THE REGISTER'S OWN ACTS. Four request resources and the acts on them:
    // one create each, the restatements, and the two withdrawals — nothing invented, nothing missing.
    const leaveActs = await prisma.auditLog.findMany({
      where: {
        resourceType: 'hr.leave',
        resourceId: {
          in: [
            leaveRequestA.id,
            leaveRequestSingle.id,
            leaveRequestRetiredType.id,
            leaveRequestB.id,
          ],
        },
      },
    });
    expect([...new Set(leaveActs.map((row) => row.action))].sort()).toEqual([
      'cancel',
      'create',
      'update',
    ]);
    const perRequest: [string, string[]][] = [
      // §12.2 created it and §12.3 restated four things about it: the end, the start, the reason and
      // the type. Nothing else that touched it was an act.
      [leaveRequestA.id, ['create', 'update', 'update', 'update', 'update']],
      // Created, and withdrawn once: the second attempt and the restatement attempt are 409s, and a
      // 409 is not an act.
      [leaveRequestSingle.id, ['cancel', 'create']],
      // Created by §12.2, and re-worded in §12.4 while the type it names had already been retired.
      [leaveRequestRetiredType.id, ['create', 'update']],
      // Tenant B's own two acts, by tenant B's own administrator.
      [leaveRequestB.id, ['cancel', 'create']],
    ];
    for (const [resourceId, actions] of perRequest) {
      expect(
        leaveActs
          .filter((row) => row.resourceId === resourceId)
          .map((row) => row.action)
          .sort()
      ).toEqual([...actions].sort());
    }

    // THERE IS NO APPROVAL ACT TO RECORD, AND THE ABSENCE IS MECHANICAL RATHER THAN A CLAIM. Four
    // declarations would have to move TOGETHER for `APPROVED` to exist; three of them are read here,
    // and the fourth (a permission) is read with them.
    const statusMembers = await hrDb.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'LeaveRequestStatus'
      ORDER BY e.enumsortorder
    `;
    expect(statusMembers.map((row) => row.label)).toEqual(['PENDING', 'CANCELLED']);

    // A DECISION STATE NOBODY CAN LEGITIMATELY WRITE IS NOT A PLACEHOLDER — it is a lie with a column
    // name — so the columns a decision would need are absent as well as the member. This is the
    // half of the claim that a future migration would have to break visibly.
    const columns = await hrDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'LeaveRequest'
    `;
    const columnNames = columns.map((row) => row.column_name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'tenant_id',
        'employee_id',
        'leave_type_id',
        'start_date',
        'end_date',
        'reason',
        'status',
        'cancelled_at',
        'created_at',
        'updated_at',
      ])
    );
    for (const forbidden of [
      'approved_at',
      'approver_id',
      'decided_at',
      'decided_by',
      'rejected_at',
      'rejection_reason',
    ]) {
      expect(columnNames).not.toContain(forbidden);
    }

    // …AND NO ROUTE EXISTS EITHER: an approval endpoint is a 404, and the permission it would have to
    // be gated by is not seeded in Core. `hr.leave.approve` is named in the schema's maintenance
    // contract and in `domain/leave-status.ts` as the member that arrives TOGETHER with its
    // authority — the point of asserting its absence here is that the day it lands, this test is the
    // one that says so.
    expect(
      (await post(`/hr/leave-requests/${leaveRequestA.id}/approve`, adminAId).send({})).status
    ).toBe(404);
    expect(
      (await post(`/hr/leave-requests/${leaveRequestA.id}/reject`, adminAId).send({ reason: 'x' }))
        .status
    ).toBe(404);
    expect(await prisma.permission.findFirst({ where: { name: 'hr.leave.approve' } })).toBeNull();
    // The surface stands on exactly TWO permissions — one pair, read and manage — which is why the
    // whole register is reachable by one administrator and by nobody else in this tenant.
    expect(await prisma.permission.count({ where: { name: { startsWith: 'hr.leave.' } } })).toBe(2);

    // THE STATE THE SECTION LEAVES BEHIND: five requests in tenant A — the four the ROUTES produced
    // (three pending and one withdrawn) plus the one §12.6 wrote through the ordinary client, which is
    // still pending and still absent from the trail — and one withdrawn request in tenant B, each
    // visible only in its own register.
    expect((await get('/hr/leave-requests', adminAId)).body.total).toBe(5);
    expect((await get('/hr/leave-requests?status=PENDING', adminAId)).body.total).toBe(4);
    expect((await get('/hr/leave-requests?status=CANCELLED', adminAId)).body.total).toBe(1);
    expect((await get('/hr/leave-requests', adminBId)).body.total).toBe(1);
    // …and the catalogue is the one §12.4 described: the retired entry still listed, still holding
    // the history recorded under it, and no longer offered.
    expect((await get('/hr/leave-types?status=ACTIVE', adminAId)).body.total).toBe(1);
    expect((await get('/hr/leave-types?status=INACTIVE', adminAId)).body.total).toBe(1);
  });

  // §12-END-ANCHOR
});
