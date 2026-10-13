import { validateMissionDateTime } from './mission-date-time';

describe('HR domain — mission date/time', () => {
  describe('DAILY', () => {
    it('accepts a valid DAILY range', () => {
      expect(
        validateMissionDateTime({ mode: 'DAILY', startDate: '2026-09-20', endDate: '2026-09-22' })
      ).toEqual({ ok: true });
    });

    it('accepts a single-day DAILY range', () => {
      expect(
        validateMissionDateTime({ mode: 'DAILY', startDate: '2026-09-20', endDate: '2026-09-20' })
      ).toEqual({ ok: true });
    });

    it('rejects a DAILY range with start after end', () => {
      expect(
        validateMissionDateTime({ mode: 'DAILY', startDate: '2026-09-22', endDate: '2026-09-20' })
      ).toEqual({ ok: false, reason: 'daily-start-after-end' });
    });

    it('rejects an invalid start date', () => {
      expect(
        validateMissionDateTime({ mode: 'DAILY', startDate: 'not-a-date', endDate: '2026-09-20' })
      ).toEqual({ ok: false, reason: 'invalid-start-date' });
    });
  });

  describe('HOURLY', () => {
    it('accepts a valid HOURLY same-day span', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-20',
          startTime: '09:00',
          endTime: '17:00',
        })
      ).toEqual({ ok: true });
    });

    it('rejects HOURLY with different start and end dates', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-21',
          startTime: '09:00',
          endTime: '17:00',
        })
      ).toEqual({ ok: false, reason: 'hourly-start-end-same-day' });
    });

    it('rejects HOURLY cross-midnight', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-20',
          startTime: '23:00',
          endTime: '01:00',
        })
      ).toEqual({ ok: false, reason: 'hourly-end-time-not-after-start' });
    });

    it('rejects equal start and end times', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-20',
          startTime: '09:00',
          endTime: '09:00',
        })
      ).toEqual({ ok: false, reason: 'hourly-end-time-not-after-start' });
    });

    it('rejects missing startTime', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-20',
          endTime: '17:00',
        })
      ).toEqual({ ok: false, reason: 'hourly-time-required' });
    });

    it('rejects missing endTime', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-20',
          startTime: '09:00',
        })
      ).toEqual({ ok: false, reason: 'hourly-time-required' });
    });

    it('rejects an invalid time format', () => {
      expect(
        validateMissionDateTime({
          mode: 'HOURLY',
          startDate: '2026-09-20',
          endDate: '2026-09-20',
          startTime: '9:00',
          endTime: '17:00',
        })
      ).toEqual({ ok: false, reason: 'invalid-start-time' });
    });
  });
});
