import { Injectable } from '@nestjs/common';
import { CorrespondencePrismaService } from './database/correspondence-prisma.service';
// The Jalali boundary stays the calendar module's SINGLE implementation. It is pure
// date arithmetic: no database, no Prisma, no Core client — so reusing it is not a
// re-coupling, and a second Jalali implementation inside this module (which would be
// the alternative) is precisely the kind of drift the calendar module exists to
// prevent. The scheduler's own clock reads this same utility when it due-checks.
import { instantToJalaliDate } from '../../calendar/jalali.util';

/**
 * Phase 50: server-side, deterministic, concurrency-safe correspondence numbering.
 *
 * SEMANTICS (documented before implementation, per the phase contract):
 *
 *  - Format: `AR-{JalaliYear}-{5-digit sequence}`, e.g. `AR-1405-00042`. The AR-
 *    prefix reproduces the reference's visual language; the Jalali year is computed
 *    SERVER-side from the send instant via the calendar module's jalali.util — the
 *    ONLY Jalali boundary in Core — and never from a client value.
 *  - Uniqueness: UNIQUE per (tenantId, letterNumber) on Letter, backed by
 *    LetterNumberCounter's UNIQUE (tenantId, year) row.
 *  - Concurrency: the counter is allocated by a single atomic statement —
 *      INSERT … ON CONFLICT ("tenantId","year") DO UPDATE SET counter = counter + 1
 *      RETURNING counter
 *    — so two concurrent sends of DIFFERENT drafts in the same tenant/year each get
 *    a distinct sequence, resolved entirely by the database. Two concurrent sends of
 *    the SAME draft cannot both pass the service's conditional status update in the
 *    first place, so the numbering race never even arises for one letter.
 *  - Independence: nothing here reads a client-provided number. The reference's
 *    `AR-` + random-number behaviour is treated as a UX sketch of this contract.
 *  - Future compatibility: numbering POLICIES (org/unit prefixes, per-dabireh
 *    sequences) can be layered by adding a `policy` discriminator to the counter key
 *    and a formatter here, without touching any caller — the allocation statement is
 *    the single seam.
 *  - Auditability: the counter row is the mint record; the sent letter carries the
 *    number, its send tracking event and the AuditLog row (written by the service).
 */

/** The only prefix this phase mints. Deterministic, not random. */
export const LETTER_NUMBER_PREFIX = 'AR';

/** Fixed-width sequence window: `00042`. */
const SEQUENCE_WIDTH = 5;

@Injectable()
export class LetterNumberService {
  constructor(private readonly prisma: CorrespondencePrismaService) {}

  /**
   * Allocates the next number for `(tenantId, Jalali year of `now`)`.
   *
   * MUST run inside the same transaction that flips the letter to SENT, so a send
   * that rolls back never burns a number. `$queryRaw` is deliberate: Prisma's typed
   * API cannot express `INSERT … ON CONFLICT DO UPDATE … RETURNING` atomically.
   */
  async allocateNext(
    tenantId: string,
    now: Date,
  ): Promise<{ letterNumber: string; year: number; counter: number }> {
    const { jy } = instantToJalaliDate(now);

    const rows = await this.prisma.$queryRaw<Array<{ counter: number }>>`
      INSERT INTO "LetterNumberCounter" ("id", "tenantId", "year", "counter")
      VALUES (gen_random_uuid()::text, ${tenantId}, ${jy}, 1)
      ON CONFLICT ("tenantId", "year")
      DO UPDATE SET "counter" = "LetterNumberCounter"."counter" + 1
      RETURNING "counter"
    `;

    const counter = rows[0]?.counter;
    if (!Number.isInteger(counter) || counter < 1) {
      throw new Error('Letter number allocation failed');
    }

    return {
      letterNumber: formatLetterNumber(LETTER_NUMBER_PREFIX, jy, counter),
      year: jy,
      counter,
    };
  }
}

/** Pure formatter so the spec can pin the visual contract exactly. */
export function formatLetterNumber(prefix: string, year: number, counter: number): string {
  const sequence = String(counter).padStart(SEQUENCE_WIDTH, '0');
  return `${prefix}-${year}-${sequence}`;
}