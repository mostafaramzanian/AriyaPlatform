import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AUDIT_PORT } from './audit.contract';
import { AuditIngestConsumer } from './audit-ingest.consumer';
import { PlatformAuditService } from './platform-audit.service';

/**
 * Phase ARCH-3B (§6/§17): the platform's AUDIT seam, and the module that owns the binding.
 *
 * WHY THIS IS A PLATFORM MODULE AND NOT PART OF `RbacModule`
 * ---------------------------------------------------------
 * Before this phase a business module that wanted its mutations audited had to import
 * `RbacModule`, because `AuditService` was provided there. That is the coupling §17 removes: a
 * module was made to depend on Core's authorization module — and therefore on its permission
 * tables, its role services and its controllers — in order to write ONE row to the audit
 * trail. `HrModule` still imports `RbacModule`, but for the reason RBAC exists: its controllers
 * are gated on `hr.*` permissions. Its audit dependency now comes from here.
 *
 * WHAT IT DOES AND DOES NOT EXPORT. Only the PORT TOKEN. `PlatformAuditService` stays
 * module-private, so no consumer can reach the concrete class, and — because this module
 * imports `PrismaModule` and nothing else — no consumer that imports it acquires Core's
 * database handle by proxy.
 *
 * WHY IT DOES NOT IMPORT `NotificationModule`: a `platform.audit@v1` row is the TERMINAL record
 * of an event. `AuditService` publishes the row it just wrote, and if this writer did the same
 * the consumer below would receive its own output on the `audit.#` binding and write a second
 * row for every event — an audit trail that doubles itself. The legacy publish path is
 * untouched and still serves its own producers.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    PlatformAuditService,
    // `useExisting` rather than `useClass`, so one instance serves the port and any internal
    // consumer of the class, and the port cannot be satisfied by a second, divergent writer.
    { provide: AUDIT_PORT, useExisting: PlatformAuditService },
    // The `platform.audit@v1` ingest consumer lives HERE rather than in a module of its own: it
    // is the other half of the same contract, it needs the same binding, and a separate module
    // would exist only to import this one. It starts (or declines to start) on module init.
    AuditIngestConsumer,
  ],
  exports: [AUDIT_PORT],
})
export class PlatformAuditModule {}
