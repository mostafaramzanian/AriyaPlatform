import 'reflect-metadata';
import { HR_ATTENDANCE_SOURCES, type HrAttendanceSource } from '../dto/hr-query.dto';
import {
  HR_PERSONNEL_TRAFFIC_SOURCES,
  asHrPersonnelTrafficSource,
  hrPersonnelTrafficSourceEqualsDto,
} from './hr-attendance-source';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the pure source vocabulary's own guard.
 *
 * `hr-attendance-source.ts` exists because Reporting may not import an owner's DTO
 * internals — but a re-declaration is only safe while the two spellings stay equal.
 * This spec is the executable half of that sentence: the register's
 * `HR_ATTENDANCE_SOURCES` (the authority, beside its validation) and the reporting
 * module's `HR_PERSONNEL_TRAFFIC_SOURCES` must name the SAME two members in the SAME
 * order, so a third source added to one side fails here rather than letting the report
 * count a vocabulary the register does not have.
 */
describe('hr-attendance-source — one vocabulary, two files', () => {
  it('names the same two members as the register’s own closed set, in order', () => {
    expect(HR_PERSONNEL_TRAFFIC_SOURCES).toEqual(['DEVICE', 'MANUAL']);
    expect(hrPersonnelTrafficSourceEqualsDto(HR_ATTENDANCE_SOURCES)).toBe(true);
  });

  it('narrows only a real member — everything else is undefined, never a guess', () => {
    expect(asHrPersonnelTrafficSource('DEVICE')).toBe('DEVICE');
    expect(asHrPersonnelTrafficSource('MANUAL')).toBe('MANUAL');
    expect(asHrPersonnelTrafficSource('STATUS')).toBeUndefined();
    expect(asHrPersonnelTrafficSource('device')).toBeUndefined();
    expect(asHrPersonnelTrafficSource(undefined)).toBeUndefined();
  });

  /** Keeps the narrowing helper honest against the DTO type it mirrors. */
  const _typeCheck: readonly HrAttendanceSource[] = HR_PERSONNEL_TRAFFIC_SOURCES;
  it('is assignable to the register’s own source type', () => {
    expect(_typeCheck).toHaveLength(2);
  });
});
