/**
 * Phase 51-HR-ARCH-1B: the EMPLOYMENT INTERVAL rules, as pure TypeScript.
 *
 * WHY THIS FILE HAS EXACTLY ZERO IMPORTS
 * --------------------------------------
 * This is the domain layer, and "domain" is a claim that has to be falsifiable. The rule
 * the module enforces is therefore the strictest available: a domain file imports
 * NOTHING — no NestJS, no Express, no Prisma, no repository, no `AuditService`, no
 * `USER_DIRECTORY`, no `RequestContextService`. `hr-application-boundaries.spec.ts`
 * asserts `importSpecifiers(source) === []` for every non-spec file here, so a future
 * `import { ConflictException }` — the tempting one, because the service throws it two
 * lines later — fails the build instead of quietly re-coupling the domain to a framework.
 *
 * WHY THE RULES ARE HERE AND NOT IN THE SERVICE
 * --------------------------------------------
 * `employment.service.ts` owns orchestration: it reads the current interval, asks the
 * database, decides what to audit and which HTTP status to use. The three rules below are
 * the part that needs NO database, NO request and NO tenant to give the same answer every
 * time, which is exactly the part that can be tested without a fake Prisma driver:
 *
 *   * how a `YYYY-MM-DD` string becomes the day Postgres will store;
 *   * how a stored `@db.Date` becomes a `YYYY-MM-DD` string again;
 *   * whether a successor interval starts strictly AFTER the interval it follows.
 *
 * WHAT DELIBERATELY DID NOT MOVE, AND WHY
 * ---------------------------------------
 *   * The OVERLAP probe. Its answer depends on rows the service has to fetch, and the real
 *     guarantee is `EmploymentRecord_no_overlapping_intervals_excl` in `hr_db` — an
 *     `EXCLUDE USING gist` over `daterange(start_date, end_date, '[]')`. Re-coding that
 *     predicate in TypeScript would create a second, weaker copy of a constraint the
 *     database already enforces; the service's bounded pre-check exists to turn a
 *     constraint violation into a readable 409, and it stays where the read happens.
 *   * The ERRORS. A refusal is reported by `ConflictException` with a message the API
 *     contract already ships. Throwing from here would force a NestJS import into the
 *     domain, so these functions RETURN A DECISION and the service maps it to the same
 *     exception and the same text it threw before this phase (no message changed).
 *
 * DATE-ONLY ARITHMETIC. Every conversion pins the day at UTC midnight and reads it back
 * with `toISOString().slice(0, 10)`. Using `new Date('2026-03-01')` in one place and
 * `getDate()` in another is how an interval shifts by a day for a caller in a
 * positive-offset timezone, so neither is permitted anywhere in the module.
 */

/**
 * The outcome of reading a `YYYY-MM-DD` string.
 *
 * A RESULT, NOT AN EXCEPTION, and not a `null`: the two refusals are different pieces of
 * text on the wire (`… is not a valid YYYY-MM-DD date` and `Dates before …-01-01 are not
 * accepted`), so they must stay distinguishable after the parsing rule stops throwing.
 */
export type IsoDateParseResult =
  | { readonly ok: true; readonly date: Date }
  | { readonly ok: false; readonly reason: 'invalid-format' }
  | { readonly ok: false; readonly reason: 'before-min-year' };

/**
 * `'2026-03-01'` → a `Date` at UTC midnight, which is the day Postgres will store.
 *
 * `minYear` is a PARAMETER rather than an import of `HR_MIN_EMPLOYMENT_YEAR`: the bound is
 * policy, supplied by the caller that owns the policy, and keeping it out means this file
 * needs no module of its own to be testable. The check order matches the pre-phase code —
 * format first, then the year — because swapping them would change which message an
 * unparseable pre-1970 string produced.
 */
export function parseIsoDateValue(iso: string, minYear: number): IsoDateParseResult {
  const parsed = new Date(`${iso}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: 'invalid-format' };
  }

  if (parsed.getUTCFullYear() < minYear) {
    return { ok: false, reason: 'before-min-year' };
  }

  return { ok: true, date: parsed };
}

/** A stored `@db.Date` → `'2026-03-01'`. Never a timestamp, never a timezone shift. */
export function formatIsoDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * The successor rule: a new interval must start STRICTLY after the latest one began.
 *
 * Strictly, not "on or after": a second interval that started the same day would make the
 * history a zero-length pair, and the transfer endpoint's whole meaning is that the person
 * moved at a point in time. `getTime()` comparison rather than `<` on the `Date` objects
 * keeps this a plain-number rule that needs no date library and no timezone.
 */
export function startsAfterPreviousStart(start: Date, previousStart: Date): boolean {
  return start.getTime() > previousStart.getTime();
}
