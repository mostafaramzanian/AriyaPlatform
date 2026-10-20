import { Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { PLATFORM_AUDIT_CONTRACT, type AuditEventInput } from './audit.contract';

/**
 * Phase ARCH-3B (§3/§6/§14): the Core binding of the audit port, against a fake table.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `audit.contract.spec.ts` pins WHAT the contract means; this file pins the WRITER that has to make it
 * true against a database, and there are three claims that nothing else can establish:
 *
 *  1. NORMALISATION IS WHAT MAKES A REPLAY A `duplicate`. The digest is taken over the row the event
 *     will produce, not over the payload as sent, so an event that omitted `requestId` and one that
 *     sent `''` must end up with ONE digest. `canonicalAuditJson` deliberately does not do that for
 *     them — it drops an omitted key and keeps an empty string — so the equality lives here, in
 *     `requestId ?? ''` and `changedFields ?? []`. If somebody removes one of those, idempotency breaks
 *     silently: the contract spec would stay green, because it asserts the opposite property on
 *     purpose. Test C is therefore the load-bearing test of this file.
 *  2. THE COMPARISON IS SCOPE-CORRECT. It must look the row up by `auditId` ALONE, which is the ADR's
 *     answer to its own open question ("`auditId` alone, globally unique"), and it must never UPDATE:
 *     an audit row is append-only, so a second arrival of one identity with different content is an
 *     ALARM (`conflict`) rather than an upsert.
 *  3. IT IS TERMINAL AND IT NEVER THROWS. No publish, no retry-ledger hop, and a failed write is
 *     RETURNED rather than raised — a completed business mutation must not become a 500 because its
 *     audit row could not be written.
 *
 * THE FAKE TABLE EMULATES POSTGRES, NOT THE MOCK. Rows are held in a `Map` so that a row written by
 * one call can be read back by the next, which is the only way to test a replay: asserting against a
 * hand-written row would let the test agree with the writer about a shape the database never stores.
 * `undefined` is coalesced to `null` on the way in for the same reason — a real column cannot hold
 * `undefined`, and the difference is exactly what the digest comparison is sensitive to.
 */

/** The columns this writer reads back, as the service declares them. */
interface FakeRow {
  id: string;
  auditId: string;
  [column: string]: unknown;
}

interface FakeTable {
  auditLog: {
    findUnique: jest.Mock;
    create: jest.Mock;
  };
  auditDispatch: { create: jest.Mock };
  rows: Map<string, FakeRow>;
}

/** A fake `core_db` holding the one table this port writes, and the legacy ledger it must not touch. */
function fakeTable(): FakeTable {
  const rows = new Map<string, FakeRow>();

  return {
    auditLog: {
      findUnique: jest.fn(async ({ where }: { where: { auditId: string } }) => {
        return rows.get(where.auditId) ?? null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // What a real INSERT does with the values Prisma was handed: every key the caller passed
        // becomes a column, and `undefined` becomes NULL because a column has no other way to say
        // "absent". Coalescing here rather than in the assertions is what makes test C meaningful.
        const stored = Object.fromEntries(
          Object.entries(data).map(([column, value]) => [
            column,
            value === undefined ? null : value,
          ])
        );
        const row: FakeRow = { id: `log-${rows.size + 1}`, ...stored } as FakeRow;
        rows.set(row.auditId, row);
        return row;
      }),
    },
    auditDispatch: { create: jest.fn(async () => undefined) },
    rows,
  };
}

/** A valid `platform.audit@v1` event, as a producer supplies it. */
const event = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  auditId: '3f6b1a1e-5f2c-4d4b-8c3a-9d0e1f2a3b4c',
  tenantId: 'tenant-north',
  requestId: 'req-1',
  actorId: 'user-1',
  action: 'CREATE',
  resource: 'employee',
  resourceId: 'emp-1',
  ...overrides,
});
describe('PlatformAuditService', () => {
  let table: FakeTable;
  let service: PlatformAuditService;

  beforeEach(() => {
    table = fakeTable();
    service = new PlatformAuditService(table as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The row the writer was asked to insert, as the `data` object it passed to `create`.
   *
   * Read off the MOCK rather than off the stored row, because the stored row has already been
   * coalesced by the fake table and the question "did the writer map this column correctly?" is about
   * the argument, not about the column afterwards.
   */
  const createdData = (call = 0): Record<string, unknown> =>
    table.auditLog.create.mock.calls[call][0].data as Record<string, unknown>;

  describe('recording one event (§3/§6)', () => {
    it('writes ONE row and reports it as recorded', async () => {
      const result = await service.record(event());

      expect(result).toEqual({
        status: 'recorded',
        auditId: event().auditId,
        auditLogId: 'log-1',
      });
      expect(table.auditLog.create).toHaveBeenCalledTimes(1);
      expect(table.rows.size).toBe(1);
    });

    it('maps the wire field names onto the TABLE column names, in one place', async () => {
      await service.record(event({ success: false, reason: 'no capacity', durationMs: 12 }));

      // `resource`→`resourceType`, `actorId`→`userId`, `ip`→`ipAddress` are the three renames. A
      // writer that passed the wire names straight through would be silently dropping the actor and
      // the source address of every module event, which is exactly the kind of loss that is noticed
      // only during an incident.
      expect(createdData()).toMatchObject({
        tenantId: 'tenant-north',
        resourceType: 'employee',
        resourceId: 'emp-1',
        userId: 'user-1',
        action: 'CREATE',
        success: false,
        reason: 'no capacity',
        durationMs: 12,
      });
    });

    it('never writes a NULL tenant, because the contract has no shape for one', async () => {
      // §3 in the form the database sees: the historical rows with a NULL tenant are provably
      // historical because this path cannot produce another one.
      await service.record(event());

      expect(createdData().tenantId).toBe('tenant-north');
    });

    it('normalises the optional columns to what the row will actually hold', async () => {
      await service.record(
        event({
          requestId: undefined,
          changedFields: undefined,
          actorId: undefined,
          ip: undefined,
          reason: undefined,
        })
      );

      // `requestId` is the exception that is worth stating: the column is NOT NULL for historical
      // reasons, so \"absent\" is stored as the empty string — a value no legacy producer ever writes,
      // which is what keeps it distinguishable from a real request id.
      expect(createdData()).toMatchObject({
        requestId: '',
        changedFields: [],
      });
      expect(createdData().userId).toBeUndefined();
      expect(createdData().ipAddress).toBeUndefined();
      expect(table.rows.get(event().auditId)?.userId).toBeNull();
    });

    it('does not publish, and does not touch the retry ledger', async () => {
      // A `platform.audit@v1` row is the TERMINAL record. Republishing it would have the module's own
      // consumer ingest its output and double the trail, and an `AuditDispatch` row would make the
      // legacy retry machinery treat a terminal row as a pending hop (§5).
      await service.record(event());

      expect(table.auditDispatch.create).not.toHaveBeenCalled();
    });
  });

  describe('rejection: the validator decides, and nothing is written', () => {
    it('refuses a tenant-less event and writes nothing at all', async () => {
      const result = await service.record(event({ tenantId: '' }));

      expect(result).toEqual({
        status: 'rejected',
        auditId: event().auditId,
        auditLogId: null,
        code: 'AUDIT_TENANT_MISSING',
      });
      // The ORDER matters: refusing before the read means a malformed flood never reaches the
      // database, and it also means this is the same code path the queue consumer uses.
      expect(table.auditLog.findUnique).not.toHaveBeenCalled();
      expect(table.auditLog.create).not.toHaveBeenCalled();
      expect(table.rows.size).toBe(0);
    });

    it('logs the rejection WITH its code, which is the only place the reason exists', async () => {
      await service.record(event({ auditId: 'req-1' }));

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'AUDIT_ID_INVALID', stage: 'record.rejected' }),
        expect.any(String)
      );
    });

    it('names the identity it could not identify without pretending to have one', async () => {
      // A caller with no usable `auditId` still gets a result, and the result does not invent an id:
      // an error log that carried a generated one would be untraceable to the producer's own record.
      const result = await service.record({ tenantId: 'tenant-north' } as AuditEventInput);

      expect(result.status).toBe('rejected');
      expect(result.auditId).toBe('');
    });

    it('STAMPS the descriptor itself — a caller cannot smuggle another capability onto the trail', async () => {
      // THE ASYMMETRY BETWEEN THE TWO WRITERS, and it is deliberate. The queue consumer must REJECT an
      // event whose descriptor is missing or foreign (`AUDIT_CONTRACT_MISMATCH`), because anything at
      // all could have published on that binding. This port is the opposite: a module calling it is
      // producing platform events BY DEFINITION, so `record` stamps the descriptor through
      // `toAuditEnvelope` and the caller's own value is overwritten rather than trusted.
      // `AuditEventInput` deliberately has no `contract` field — a caller of the PORT cannot even name
      // the descriptor in types. The cast states that the value is arriving from an untyped edge (a
      // legacy in-process producer), which is exactly the case being defended against.
      const legacyShaped = { ...event(), contract: 'legacy.v0' } as AuditEventInput & {
        contract: string;
      };

      expect(legacyShaped.contract).not.toBe(PLATFORM_AUDIT_CONTRACT);

      const result = await service.record(legacyShaped);

      // Recorded, not rejected: the descriptor the validator saw was the port's, not the caller's.
      expect(result.status).toBe('recorded');
      expect(table.rows.get(event().auditId)?.action).toBe('CREATE');
    });
  });

  describe('idempotency: a replay is a SUCCESS, not a duplicate write (§14)', () => {
    it('recognises the identical event as a duplicate, and writes no second row', async () => {
      const first = await service.record(event());
      const second = await service.record(event());

      expect(first.status).toBe('recorded');
      expect(second).toEqual({
        status: 'duplicate',
        auditId: event().auditId,
        auditLogId: first.auditLogId,
      });
      expect(table.auditLog.create).toHaveBeenCalledTimes(1);
      expect(table.rows.size).toBe(1);
    });

    it('THE LOAD-BEARING TEST: an OMITTED optional field and an EMPTY one are the same event', async () => {
      // This is the claim the contract spec deliberately does NOT make: `canonicalAuditJson` renders
      // an omitted key and an empty string differently, so the equality asserted here is produced by
      // THIS writer's normalisation (`requestId ?? ''`, `changedFields ?? []`) before it digests.
      // Delete either `??` and this test fails while every test in `audit.contract.spec.ts` stays
      // green — which is why it lives here and why it names the two normalisations in its assertions.
      const stored = await service.record(
        event({ requestId: undefined, changedFields: undefined, correlationId: undefined })
      );

      const replayed = await service.record(event({ requestId: '', changedFields: [] }));

      expect(stored.status).toBe('recorded');
      expect(replayed.status).toBe('duplicate');
      expect(table.rows.size).toBe(1);
    });

    it('treats an omitted field as equal to an explicit null across the whole optional set', async () => {
      await service.record(
        event({
          actorId: undefined,
          ip: undefined,
          userAgent: undefined,
          sessionId: undefined,
          reason: undefined,
          durationMs: undefined,
        })
      );

      const replayed = await service.record(
        event({
          actorId: null,
          ip: null,
          userAgent: null,
          sessionId: null,
          reason: null,
          durationMs: null,
        } as Partial<AuditEventInput>)
      );

      expect(replayed.status).toBe('duplicate');
    });

    it('is not fooled by the row order of a jsonb snapshot', async () => {
      // `oldValue` is `jsonb`, so a replayed event whose keys happen to serialise in another order is
      // still the same event. A byte comparison would report a conflict here.
      await service.record(event({ newValue: { name: 'Ali', code: 'E-1' } }));

      const replayed = await service.record(event({ newValue: { code: 'E-1', name: 'Ali' } }));

      expect(replayed.status).toBe('duplicate');
    });

    it('compares the REDACTED snapshot, so masking cannot itself cause a conflict', async () => {
      // The digest is taken after redaction, and a stored row's values are already redacted. Were the
      // arriving side digested raw, every replay of an event carrying an email would look different
      // from its own stored row.
      const payload = { user: { email: 'jane@example.com', name: 'Jane' } };

      await service.record(event({ newValue: payload }));
      const replayed = await service.record(event({ newValue: payload }));

      expect(replayed.status).toBe('duplicate');
    });
  });

  describe('conflict: one identity, two different events — the alarm (§14)', () => {
    it('refuses to overwrite, and writes nothing', async () => {
      const first = await service.record(event());

      const conflicting = await service.record(event({ action: 'DELETE' }));

      expect(conflicting).toEqual({
        status: 'conflict',
        auditId: event().auditId,
        auditLogId: first.auditLogId,
      });
      expect(table.auditLog.create).toHaveBeenCalledTimes(1);
      expect(table.rows.size).toBe(1);
      // The trail still says what it said: history is append-only.
      expect(table.rows.get(event().auditId)?.action).toBe('CREATE');
    });

    it('alarms with BOTH sides named, because that is what an operator has to read', async () => {
      await service.record(event());

      await service.record(
        event({ action: 'DELETE', tenantId: 'tenant-south', resource: 'position' })
      );

      // A bare "conflict" line would say an auditId collided but not between which two acts, so the
      // log carries the stored and the arriving action and tenant. This is the one place a conflict is
      // distinguishable at all: the caller gets a status and no detail.
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'record.conflict',
          incomingTenant: 'tenant-south',
          storedTenant: 'tenant-north',
          incomingAction: 'position.DELETE',
          storedAction: 'employee.CREATE',
        }),
        expect.any(String)
      );
    });

    it('has no way to UPDATE a row, because it is never given one', async () => {
      // Structural, not aspirational: the fake table implements exactly the two calls the class is
      // allowed to make. If a future edit reaches for `update`/`updateMany`/`upsert`, this spec fails
      // with a TypeError at the call site instead of quietly rewriting an audit row in production.
      await service.record(event());
      await service.record(event({ action: 'DELETE' }));

      expect(Object.keys(table.auditLog).sort()).toEqual(['create', 'findUnique']);
    });

    it('looks the row up by auditId ALONE, which is the ADR own answer to its open question', async () => {
      await service.record(event());

      expect(table.auditLog.findUnique).toHaveBeenCalledWith({
        where: { auditId: event().auditId },
      });
    });
  });

  describe('the race, and a write that fails (§6)', () => {
    it('classifies a UNIQUE violation as the duplicate it is, rather than a failure', async () => {
      // Two at-least-once deliveries can interleave between the read and the write. The unique index
      // is the arbiter, and losing that race is a SUCCESS: the row exists exactly once, which is all
      // the trail ever promised.
      const first = await service.record(event());

      table.auditLog.findUnique.mockImplementationOnce(async () => null);
      table.auditLog.create.mockImplementationOnce(async () => {
        throw Object.assign(new Error('duplicate key value'), { code: 'P2002' });
      });

      const raced = await service.record(event());

      expect(raced).toEqual({
        status: 'duplicate',
        auditId: event().auditId,
        auditLogId: first.auditLogId,
      });
    });

    it('still reports a conflict when the row that won the race is a DIFFERENT event', async () => {
      await service.record(event({ action: 'CREATE' }));

      table.auditLog.findUnique.mockImplementationOnce(async () => null);
      table.auditLog.create.mockImplementationOnce(async () => {
        throw Object.assign(new Error('duplicate key value'), { code: 'P2002' });
      });

      const raced = await service.record(event({ action: 'DELETE' }));

      expect(raced.status).toBe('conflict');
    });

    it('returns a rejection — never a throw — when the database is unavailable', async () => {
      // THE PROMISE THAT MATTERS TO EVERY BUSINESS WRITE: a completed mutation must not become a 500
      // because its audit row could not be written. The caller gets a value it can log; the trail has
      // a hole, which §6 makes visible rather than fatal.
      table.auditLog.findUnique.mockImplementationOnce(async () => {
        throw new Error('connection refused');
      });

      const result = await service.record(event());

      expect(result).toEqual({
        status: 'rejected',
        auditId: event().auditId,
        auditLogId: null,
        code: 'AUDIT_WRITE_FAILED',
      });
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({ auditId: event().auditId, tenantId: 'tenant-north' }),
        expect.any(String)
      );
    });

    it('does not swallow a failed write quietly: it is logged as an error', async () => {
      table.auditLog.create.mockImplementationOnce(async () => {
        throw new Error('deadlock detected');
      });

      const result = await service.record(event());

      expect(result.status).toBe('rejected');
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe('the actor foreign key (P2003) — the contract, not a suppression (P1)', () => {
    /**
     * `AuditLog.userId` is a real FK to `core_db."User"` (`onDelete: SetNull`), and
     * `AuditEventInput.actorId` is declared as "The Core identity that acted; null for a
     * machine context". An actorId no User row backs — a synthetic test principal, or a
     * user deleted between auth and write — is therefore a CONTRACT VIOLATION by the
     * producer, and this writer's answer to it is a rejection the caller can observe,
     * not a row with the actor silently nulled (that would fabricate a machine context
     * for a human act) and never a throw (a completed mutation must not 500).
     */
    it('rejects an event whose actorId no User row backs — logged, returned, never thrown', async () => {
      table.auditLog.create.mockImplementationOnce(async () => {
        throw Object.assign(
          new Error(
            'Foreign key constraint violated on the constraint: `AuditLog_userId_fkey`'
          ),
          { code: 'P2003' }
        );
      });

      const result = await service.record(event({ actorId: 'user-that-does-not-exist' }));

      expect(result).toEqual({
        status: 'rejected',
        auditId: event().auditId,
        auditLogId: null,
        code: 'AUDIT_WRITE_FAILED',
      });
      // Observable: the log carries the failing event's identity AND the raw error,
      // which is where P2003 is visible to an operator.
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({ auditId: event().auditId, tenantId: 'tenant-north' }),
        'Failed to persist a platform audit event'
      );
      // Nothing half-written, and no retry with a nulled actor either.
      expect(table.auditLog.create).toHaveBeenCalledTimes(1);
      expect(table.rows.size).toBe(0);
    });

    it('records the SAME event verbatim once a legitimate actor exists — no null-actor rewrite', async () => {
      // The digest includes actorId, so a replay after the FK is repaired must classify
      // as the identical event: the writer stores `actorId` as `userId` or not at all,
      // never as a null that would fabricate a machine context and break replay dedup.
      let foreignKeyHealthy = false;
      table.auditLog.create.mockImplementation(async ({ data }) => {
        if (!foreignKeyHealthy && data.userId !== null) {
          throw Object.assign(new Error('fk violated'), { code: 'P2003' });
        }
        const stored = Object.fromEntries(
          Object.entries(data).map(([column, value]) => [
            column,
            value === undefined ? null : value,
          ])
        );
        const row: FakeRow = { id: `log-${table.rows.size + 1}`, ...stored } as FakeRow;
        table.rows.set(row.auditId, row);
        return row;
      });

      const failed = await service.record(event({ actorId: 'user-that-did-not-exist' }));
      foreignKeyHealthy = true;
      const replayed = await service.record(event({ actorId: 'user-that-did-not-exist' }));

      expect(failed.status).toBe('rejected');
      expect(replayed.status).toBe('recorded');
      // The stored row carries the SAME actor — the repair is a producer fix, never a
      // rewrite of who acted.
      expect(table.rows.get(event().auditId)?.userId).toBe('user-that-did-not-exist');
    });
  });
});
