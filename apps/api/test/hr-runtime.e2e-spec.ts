import { INestApplication, WebSocketAdapter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import {
  DATASOURCE_PROBE_PROVIDERS,
  DatasourceProbeProvider,
} from '../src/health/datasource-probe.registry';
import { HR_PRISMA_CLIENT } from '../src/health/health-tokens';
import { HrPrismaService } from '../src/modules/hr/database/hr-prisma.service';
import { makeRequest, getTestApp } from './setup';

/**
 * Phase 51-HR-2A — the COMBINED RUNTIME owns HR: runtime, datasource and database.
 *
 * WHY THIS FILE EXISTS, AND WHY THE HR E2E SUITE IS NOT ENOUGH
 * -----------------------------------------------------------
 * `hr.e2e-spec.ts` proves the HR API against the real databases, but it builds a
 * FOCUSED module graph (`HrModule + PrismaModule + RbacModule`) to do it. That is the
 * right shape for testing the API, and the wrong shape for answering the deployment
 * question this phase has to answer:
 *
 *   "Does the process the platform actually ships — `AppModule`, the COMBINED
 *    composition root in `infrastructure/docker/Dockerfile.backend` — really boot with
 *    HR compiled in, open `hr_db` through HR's OWN client, and report that connection
 *    in its readiness contract?"
 *
 * Nothing else in the repository asserts that. The health suites
 * (`health.providers.spec.ts`, `datasource-health.probe.spec.ts`) prove the policy and
 * the engine against FAKE clients, and `architecture-boundaries.spec.ts` proves the
 * declared matrix matches the sources — so between them there was a gap: a real
 * process could fail to bind `HR_PRISMA_CLIENT`, and every one of those tests would
 * still pass while `/api/v1/ready` reported HR as a blocking failure (which is exactly
 * the fail-closed behaviour `health.providers.spec.ts` pins).
 *
 * THE APP UNDER TEST IS THE GLOBAL ONE
 * ------------------------------------
 * `test/setup.ts` — the repository's committed E2E harness, used by every other suite
 * in this folder — already boots the REAL `AppModule` through `NestFactory.create`
 * with the REAL production pipes, prefix and WebSocket adapter. This spec does not
 * build a second harness and does not stub anything: it asks THAT process what it is
 * holding.
 *
 * WHAT IS ASSERTED, AND WHY EACH ASSERTION IS NOT COSMETIC
 * --------------------------------------------------------
 *   §3  `HrPrismaService` resolves from the composition root, the health token
 *       `HR_PRISMA_CLIENT` resolves to that SAME instance (`useExisting`, not a second
 *       client), and it is NOT Core's client.
 *   §3  The probe registry of the live graph holds a provider for `HR_DATABASE_URL`, so
 *       `/api/v1/ready` measures HR through HR's own connection rather than reporting a
 *       datasource nobody probed.
 *   §3  `hrDatabase` is `required` in this runtime and reports `ok`, and is not in
 *       `blocking` — the readiness contract the orchestrator reads.
 *   §3  The HR routes are mounted on the SAME HTTP server as everything else, behind
 *       the real global `JwtAuthGuard` (401, not 404) — while a route that does not
 *       exist still answers 404, so the 401 is not an artefact of a catch-all.
 *   §3  FAIL CLOSED: with an unreachable `HR_DATABASE_URL` the combined runtime does not
 *       boot at all. `HrPrismaService` connects eagerly — `onModuleInit` awaits
 *       `$connect()`, exactly like `PrismaService`, `CmsPrismaService` and
 *       `CorrespondencePrismaService` — so an unreachable `hr_db` is a boot failure
 *       rather than a process that serves a surface where every request fails. The
 *       other half of the semantics is the readiness contract: a `required` datasource
 *       whose probe fails is blocking (503), never silently healthy
 *       (`health.providers.spec.ts`, pinned there against fake clients).
 *   §4  `HR_DATABASE_URL` is the real connection source: the process is connected to a
 *       database literally named `hr_db`, while Core's client is connected to
 *       `core_db` — two physical databases, and the HR one is reached through the HR
 *       client alone.
 *   §4  `hr_db` contains every HR table and NO Core identity table (no `User`, no
 *       `Tenant`, no `Role`, no `Permission`) — the boundary is a storage fact, not a
 *       naming convention.
 *   §4  Every foreign key stays INSIDE `hr_db` (`Employee`, `OrganizationUnit`,
 *       `Position`, `EmploymentRecord`, `Attendance`, `LeaveRequest`, `LeaveType`), none of
 *       them cascades a delete (`confdeltype = 'c'` is absent), and the tenancy, overlap and
 *       cycle rules are database objects (nine composite same-tenant FKs, an `EXCLUDE`
 *       constraint, a `BEFORE` trigger, twelve `CHECK`s) rather than service conventions.
 */
describe('HR runtime: the COMBINED process owns hr_db (51-HR-2A §3/§4)', () => {
  /** The REAL combined process booted by `test/setup.ts`. */
  const combinedApp = () => getTestApp();

  /** The HR tables `hr_db` must own, and the only FK targets allowed to exist there. */
  const HR_TABLES = [
    'Attendance',
    'Employee',
    'EmploymentRecord',
    'LeaveRequest',
    'LeaveType',
    'OrganizationUnit',
    'Position',
  ];

  let hrDb: HrPrismaService;
  let coreDb: PrismaService;

  beforeAll(() => {
    hrDb = combinedApp().get(HrPrismaService);
    coreDb = combinedApp().get(PrismaService);
  });

  // ---------------------------------------------------------------------------
  // §3. The datasource is INITIALIZED in the combined runtime — once, and as HR's.
  // ---------------------------------------------------------------------------

  it('resolves HRs own client from the composition root, bound to the health token', () => {
    expect(hrDb).toBeInstanceOf(HrPrismaService);
    // `HrPrismaModule` binds the token with `useExisting`, so the probe cannot hold a
    // second connection that nothing else in the graph shares.
    expect(combinedApp().get(HR_PRISMA_CLIENT)).toBe(hrDb);
    // HR does not hold Core's client: the two connections are different objects.
    expect(hrDb).not.toBe(coreDb);
    expect(coreDb).toBeInstanceOf(PrismaService);
  });

  it('registers an HR probe in the live graph, so readiness measures a real connection', () => {
    const providers = combinedApp().get<DatasourceProbeProvider[]>(DATASOURCE_PROBE_PROVIDERS);
    const datasources = providers.map((provider) => provider.datasource);

    expect(datasources).toContain('HR_DATABASE_URL');
    // The registry IS the policy's `instantiatedDatasources(combined)`: HR is in it for
    // the same reason Core and Correspondence are.
    expect(datasources).toContain('CORE_DATABASE_URL');
    expect(datasources).toContain('CORRESPONDENCE_DATABASE_URL');
  });

  it('reports hrDatabase as a REQUIRED, healthy check of the combined runtime', async () => {
    const res = await makeRequest().get('/api/v1/ready');

    // The status code is the answer (ARCH-1.3): a ready runtime answers 200.
    expect(res.status).toBe(200);
    expect(res.body.runtime).toBe('combined');
    expect(res.body.status).toBe('ready');

    expect(res.body.requirements.hrDatabase).toBe('required');
    expect(res.body.statuses.hrDatabase).toBe('ok');
    expect(res.body.blocking).not.toContain('hrDatabase');
  });

  it('serves the HR surface from the same process, behind the real global guard stack', async () => {
    // 401 — not 404 — means the route is mounted AND the global `JwtAuthGuard` ran.
    for (const path of [
      '/api/v1/hr/employees',
      '/api/v1/hr/organization',
      '/api/v1/hr/positions',
    ]) {
      expect((await makeRequest().get(path)).status).toBe(401);
    }

    // The control: an unmounted path is 404, so the 401s above are the guard, not a
    // catch-all that answers 401 to everything.
    expect((await makeRequest().get('/api/v1/hr/no-such-route')).status).toBe(404);
  });

  it('refuses to boot the combined runtime when HR_DATABASE_URL is unreachable', async () => {
    const valid = process.env.HR_DATABASE_URL;
    expect(valid).toBeTruthy();

    // Same host, credentials and database NAME; unreachable PORT — so environment
    // validation still passes and the failure is the connection, not the parsing.
    const unreachable = '59999';
    process.env.HR_DATABASE_URL = String(valid).replace(/@[^/]+\//, `@127.0.0.1:${unreachable}/`);
    expect(process.env.HR_DATABASE_URL).not.toBe(valid);

    /**
     * Booting the combined runtime, exactly as `test/setup.ts` and `main.ts` do.
     *
     * `NestFactory.create` alone is NOT a boot: it builds the graph without running
     * `onModuleInit`, so it resolves even against an unreachable database. The init hook
     * is run by `init()`/`listen()` — that is where `HrPrismaService.onModuleInit` awaits
     * `$connect()`, and where an unreachable `hr_db` becomes a boot failure. (This spec
     * learned that the hard way: a create-only assertion passed while proving nothing.)
     */
    const boot = async (): Promise<INestApplication> => {
      const app = await NestFactory.create(AppModule, { logger: false });
      try {
        // The adapter must be selected BEFORE `init()`: `registerWsModule` runs inside
        // it, `MessagingModule` registers a real gateway, and Nest's SocketModule then
        // loads `@nestjs/platform-socket.io` — a package this project deliberately does
        // not depend on (Phase 49F chose raw `ws`) — and calls `process.exit(1)` when it
        // is missing. This is the same trap `test/setup.ts` documents.
        app.useWebSocketAdapter(new WsAdapter(app) as unknown as WebSocketAdapter);
        await app.init();
      } catch (err) {
        await app.close().catch(() => undefined);
        throw err;
      }
      return app;
    };

    try {
      await expect(boot()).rejects.toThrow();
    } finally {
      process.env.HR_DATABASE_URL = valid;
    }

    // CAUSATION, not correlation: the rejected boot names the port this test injected,
    // so the failure is HR's connection and not some unrelated second-boot artefact.
    // The error is caught a second time (after the env is restored) purely to read it;
    // the FIRST boot is the one the assertion above judges.
    let message = '';
    process.env.HR_DATABASE_URL = String(valid).replace(/@[^/]+\//, `@127.0.0.1:${unreachable}/`);
    try {
      await boot().then(
        (app) => app.close(),
        (err) => {
          message = String((err as Error).message);
        }
      );
    } finally {
      process.env.HR_DATABASE_URL = valid;
    }
    expect(message).toContain(unreachable);
  });

  // ---------------------------------------------------------------------------
  // §4. The database itself: one physical HR database, and no Core table in it.
  // ---------------------------------------------------------------------------

  it('connects HR_DATABASE_URL to hr_db while Core stays on core_db', async () => {
    const url = process.env.HR_DATABASE_URL ?? '';
    expect(url).toContain('/hr_db');

    const [hr] = await hrDb.$queryRawUnsafe<{ name: string }[]>(
      'SELECT current_database() AS name'
    );
    const [core] = await coreDb.$queryRawUnsafe<{ name: string }[]>(
      'SELECT current_database() AS name'
    );

    expect(hr.name).toBe('hr_db');
    expect(core.name).toBe('core_db');
    // Two databases in one cluster: HR's client cannot reach Core's tables by accident,
    // which is the physical half of "no cross-database foreign key".
    expect(hr.name).not.toBe(core.name);
  });

  it('owns every HR table and no Core identity table', async () => {
    const rows = await hrDb.$queryRawUnsafe<{ table_name: string }[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const tables = rows.map((row) => row.table_name);

    for (const expected of HR_TABLES) {
      expect(tables).toContain(expected);
    }
    for (const forbidden of [
      'User',
      'Tenant',
      'Role',
      'Permission',
      'RolePermission',
      'UserRole',
    ]) {
      expect(tables).not.toContain(forbidden);
    }
  });

  it('keeps tenancy, overlap and cycle enforcement in PostgreSQL, not only in the service', async () => {
    const fks = await hrDb.$queryRawUnsafe<
      { conname: string; confdeltype: string; target: string }[]
    >(
      `SELECT c.conname, c.confdeltype, t.relname AS target
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.confrelid
        WHERE c.connamespace = 'public'::regnamespace AND c.contype = 'f'
        ORDER BY c.conname`
    );

    // The SAME-TENANT composite keys: a unit, a position, an interval and an
    // attendance row can only name rows of their own tenant, because the tenant column
    // is part of the key.
    expect(fks.map((fk) => fk.conname)).toEqual([
      'Attendance_tenant_employee_fkey',
      'EmploymentRecord_tenant_employee_fkey',
      'EmploymentRecord_tenant_manager_fkey',
      'EmploymentRecord_tenant_position_fkey',
      'EmploymentRecord_tenant_unit_fkey',
      // The LEAVE pair (51-HR-3A): a request can only name an employee AND a leave type of
      // its OWN tenant, so one tenant's request cannot cite another tenant's type.
      'LeaveRequest_tenant_employee_fkey',
      'LeaveRequest_tenant_leave_type_fkey',
      'OrganizationUnit_tenant_parent_fkey',
      'Position_tenant_unit_fkey',
    ]);
    // No FK leaves `hr_db` (there is no table outside these seven to point at), and none
    // of them deletes anything: RESTRICT, never CASCADE, so deleting a Core identity
    // cannot erase HR history — it cannot even be expressed.
    expect(fks.every((fk) => HR_TABLES.includes(fk.target))).toBe(true);
    expect(fks.filter((fk) => fk.confdeltype === 'c')).toEqual([]);

    const checks = await hrDb.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND contype = 'c' ORDER BY conname`
    );
    expect(checks.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'Attendance_date_key_check',
        'Attendance_manual_reason_check',
        'Attendance_punch_order_check',
        'EmploymentRecord_interval_order_check',
        'EmploymentRecord_no_self_manager_check',
        'EmploymentRecord_start_date_floor_check',
        // The LEAVE five (51-HR-3A): a real period, a stated reason, a status that agrees with
        // its own instant, and a catalogue code/name that cannot be shaped by hand.
        'LeaveRequest_cancelled_state_check',
        'LeaveRequest_period_check',
        'LeaveRequest_reason_check',
        'LeaveType_code_check',
        'LeaveType_name_check',
        'OrganizationUnit_no_self_parent_check',
      ])
    );

    // The tenant-safe uniqueness the catalogue stands on, asserted as an INDEX rather than as a
    // service pre-check: `(tenant_id, code)` is unique on the NORMALISED value, so `annual` and
    // `ANNUAL` are one entry in one tenant while two tenants may each own their own.
    const indexes = await hrDb.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() ORDER BY indexname`
    );
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'LeaveRequest_tenantId_id_key',
        'LeaveType_tenantId_code_key',
        'LeaveType_tenantId_id_key',
      ])
    );

    // Overlapping employment intervals are refused by an EXCLUDE constraint, which is the
    // guarantee no service-level check can make against a concurrent writer.
    const exclusion = await hrDb.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND contype = 'x' ORDER BY conname`
    );
    expect(exclusion.map((row) => row.conname)).toContain(
      'EmploymentRecord_no_overlapping_intervals_excl'
    );

    // …and a cycle in the organization forest is refused by a recursive trigger, which
    // holds for EVERY writer, not only for `OrganizationService`.
    const triggers = await hrDb.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
        ORDER BY t.tgname`
    );
    expect(triggers.map((row) => row.tgname)).toContain('OrganizationUnit_no_cycle_guard');
  });
});
