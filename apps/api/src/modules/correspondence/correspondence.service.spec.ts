import {
  buildRecipientPlan,
  displayUserName,
  letterDateToInstant,
  normalizePersianQuery,
  parseDateBound,
  projectLetter,
  unknownUserProfile,
} from './correspondence.service';
import type { LetterBaseRow } from './correspondence.service';
import { BadRequestException } from '@nestjs/common';

/**
 * Phase 50: pure domain decisions of CorrespondenceService. The TRANSACTIONAL and
 * authorization behaviour is covered by real-Postgres integration specs; this file
 * pins the rules a caller depends on before any I/O happens.
 */
describe('buildRecipientPlan', () => {
  it('collapses a user present in TO and CC to TO (stronger edge wins)', () => {
    const plan = buildRecipientPlan(['a', 'b'], ['a', 'c'], []);
    const row = plan.rows.find((r) => r.userId === 'a');
    expect(row?.kind).toBe('TO');
    expect(plan.rows.filter((r) => r.userId === 'a')).toHaveLength(1);
  });

  it('collapses a user present in CC and BCC to CC', () => {
    const plan = buildRecipientPlan([], ['a'], ['a']);
    expect(plan.rows).toEqual([{ userId: 'a', kind: 'CC' }]);
  });

  it('keeps BCC only for users in no stronger list', () => {
    const plan = buildRecipientPlan(['to'], ['cc'], ['bcc', 'to']);
    expect(plan.rows).toEqual([
      { userId: 'to', kind: 'TO' },
      { userId: 'cc', kind: 'CC' },
      { userId: 'bcc', kind: 'BCC' },
    ]);
  });

  it('deduplicates within a single array, first occurrence wins', () => {
    const plan = buildRecipientPlan(['a', 'a', 'b'], undefined, undefined);
    expect(plan.rows).toEqual([
      { userId: 'a', kind: 'TO' },
      { userId: 'b', kind: 'TO' },
    ]);
  });

  it('produces an empty plan for no recipients (drafts may be unaddressed)', () => {
    expect(buildRecipientPlan(undefined, undefined, undefined).rows).toEqual([]);
  });
});

describe('letterDateToInstant', () => {
  it('converts a Jalali date key to the canonical midnight-in-Tehran instant', () => {
    const instant = letterDateToInstant('1405/01/01');
    // Farvardin 1, 1405 = 2026-03-21; midnight Tehran = 2026-03-20T20:30:00Z.
    expect(instant?.toISOString()).toBe('2026-03-20T20:30:00.000Z');
  });

  it('returns null for an absent date (defaults to send instant later)', () => {
    expect(letterDateToInstant(null)).toBeNull();
    expect(letterDateToInstant(undefined)).toBeNull();
    expect(letterDateToInstant('')).toBeNull();
  });

  it('rejects a malformed key instead of silently mis-dating the letter', () => {
    expect(() => letterDateToInstant('1405/13/01')).toThrow(BadRequestException);
    expect(() => letterDateToInstant('2026/03/21')).toThrow(BadRequestException);
    expect(() => letterDateToInstant('not-a-date')).toThrow(BadRequestException);
  });
});

describe('normalizePersianQuery', () => {
  it('folds Arabic Yeh/Kaf onto Persian forms', () => {
    expect(normalizePersianQuery('يارت كرد')).toBe('یارت کرد');
  });

  it('collapses ZWNJ and repeated whitespace', () => {
    expect(normalizePersianQuery('نامه\u200Cاداری   دوم')).toBe('نامه اداری دوم');
  });
});

describe('parseDateBound', () => {
  it('accepts ISO bounds', () => {
    expect(parseDateBound('2026-01-01T00:00:00.000Z').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('rejects garbage bounds instead of widening the result set', () => {
    expect(() => parseDateBound('yesterday')).toThrow(BadRequestException);
  });
});

describe('displayUserName', () => {
  it('joins names and never leaks an email-like fallback', () => {
    expect(displayUserName({ id: 'x', firstName: 'علی', lastName: 'محمدی', avatarUrl: null, jobTitle: null, department: null })).toBe('علی محمدی');
    expect(displayUserName(null)).toBe('نامشخص');
    expect(
      displayUserName({ id: 'x', firstName: null, lastName: null, avatarUrl: null, jobTitle: null, department: null }),
    ).toBe('کاربر');
  });
});

/**
 * Phase 50-MOD-CORR: the projection is PURE and takes identity as a parameter.
 *
 * Before the extraction it read `letter.sender` through a Core relation. Now the
 * caller hydrates identity through the platform directory port and passes it in, and
 * these two cases pin the consequence that matters: a letter whose author no longer
 * exists is still a letter, and it still names the historical actor.
 */
describe('projectLetter + unknownUserProfile (identity is injected, not related)', () => {
  const row = {
    id: 'l1',
    letterNumber: 'AR-1405-00001',
    subject: 'موضوع نامه',
    category: null,
    urgency: 'NORMAL' as const,
    classification: 'NORMAL' as const,
    status: 'SENT' as const,
    letterDate: null,
    sentAt: null,
    readyAt: null,
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
    updatedAt: new Date('2026-09-15T00:00:00.000Z'),
    senderId: 'u1',
    signatureId: null,
  } as unknown as LetterBaseRow;

  it('projects the allowlisted shape and never the internal isolation metadata', () => {
    const dto = projectLetter(row, unknownUserProfile('u1'));

    expect(dto.sender.id).toBe('u1');
    expect(dto.letterNumber).toBe('AR-1405-00001');
    expect(dto).not.toHaveProperty('senderId');
    expect(dto).not.toHaveProperty('tenantId');
    expect(dto).not.toHaveProperty('signatureId');
  });

  it('renders an actor the directory no longer knows instead of dropping the letter (D2)', () => {
    // Reachable BY DESIGN: cutting the CASCADE from identity to business documents
    // means a letter survives its author's deletion, so this is a normal state.
    const dto = projectLetter(row, unknownUserProfile('deleted-user'));

    expect(dto.sender.id).toBe('deleted-user');
    expect(displayUserName(dto.sender)).toBe('کاربر');
  });

  it('fabricates no identity for an unknown actor', () => {
    expect(unknownUserProfile('u9')).toEqual({
      id: 'u9',
      firstName: null,
      lastName: null,
      avatarUrl: null,
      jobTitle: null,
      department: null,
    });
  });
});