import type { HrAttendanceSource } from '../dto/hr-query.dto';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the attendance-source vocabulary for the
 * fourth Reporting capability — «گزارش تردد پرسنل».
 *
 * WHY A PURE MODULE AND NOT AN IMPORT FROM `dto/hr-query.dto.ts`
 * --------------------------------------------------------------
 * The closed two-member set (`DEVICE`, `MANUAL`) is already declared in
 * `dto/hr-query.dto.ts` as `HR_ATTENDANCE_SOURCES`, next to the register's own
 * validation. But `reporting-isolation.spec.ts` group C forbids Reporting from
 * importing any owner's `*.dto.ts` internals — a DTO import is how a context's
 * request/response shapes leak across a boundary, and the guard fails the build
 * on it. So this file re-states the SAME two members as a pure vocabulary, the
 * exact trick `bom-status.ts` / `purchase-status.ts` / `check-request-status.ts`
 * play for their reports: one file owns the closed set, the contract imports it
 * by TYPE, the reader by VALUE, and the Reporting DTO validates against it.
 *
 * THE MEMBERS ARE NOT REDEFINED HERE. `HR_ATTENDANCE_SOURCES` in
 * `dto/hr-query.dto.ts` remains the register's own authority, and
 * `hr-attendance-source.spec.ts` asserts the two spellings name the same
 * members in the same order — so a third member added to one side fails here
 * rather than drifting silently.
 */
export const HR_PERSONNEL_TRAFFIC_SOURCES = ['DEVICE', 'MANUAL'] as const;

export type HrPersonnelTrafficSource = (typeof HR_PERSONNEL_TRAFFIC_SOURCES)[number];

/** Narrows an unknown value to the closed two-member set, or `undefined`. */
export function asHrPersonnelTrafficSource(value: unknown): HrPersonnelTrafficSource | undefined {
  return (HR_PERSONNEL_TRAFFIC_SOURCES as readonly unknown[]).includes(value)
    ? (value as HrPersonnelTrafficSource)
    : undefined;
}

/** Keeps the pure vocabulary aligned with the register's own closed set. */
export function hrPersonnelTrafficSourceEqualsDto(
  dtoSources: readonly HrAttendanceSource[]
): boolean {
  return (
    dtoSources.length === HR_PERSONNEL_TRAFFIC_SOURCES.length &&
    HR_PERSONNEL_TRAFFIC_SOURCES.every((member, index) => dtoSources[index] === member)
  );
}
