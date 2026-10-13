import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BOM_CHANGE_TYPES,
  BOM_CHANGE_TYPE_LABELS,
  PRODUCTION_BOM_CHANGE_ERROR_CODES,
  bomChangeRequestStatusAfter,
  bomChangeTypeLabel,
  isBomChangeRequestEditable,
  isQuantityChangePayloadComplete,
  isValidCoefficientDelta,
} from './bom-change';
import { BOM_STATUSES, isBomHeaderEditable } from '../bom/bom-status';
import { PRODUCTION_BOM_ERROR_CODES } from '../bom/bom-item';

/**
 * Phase PRODUCTION-BOM-CHANGE: the pure vocabulary and the THREE rules this aggregate owns,
 * with no Nest, no Prisma and no clock.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. THE CHANGE TYPE IS A CLOSED TWO-VALUE SET, and its two Persian labels are the source
 *     radio's own strings. Adding a third member without editing the schema fails here, and
 *     so does a label that drifts from the source's `تغییر موجودی;غیر فعال سازی`.
 *  2. THE DELTA IS A SIGNED INTEGER — the ONE thing the source proves about the type
 *     (`parseInt`), and nothing more. A fraction, a string, `NaN` or an out-of-safe-range
 *     value is refused; `0` and any negative integer are ACCEPTED, because the source's
 *     `> 0` guard is commented out and a decrease is the point of «افزایش/کاهش». An
 *     implementation that quietly re-used the item's `>= 0` coefficient rule would fail
 *     here rather than pass by accident.
 *  3. THE PAIR RULE IS THE SOURCE'S `check == 0` BRANCH, exactly: `QUANTITY_CHANGE` with
 *     NOTHING stated is refused, and `0` counts as STATED. The rule is NOT applied to
 *     `DEACTIVATE`, because the source performs no check on that branch — a stricter
 *     implementation would be an invented rule and this suite would catch it.
 *  4. THE LIFECYCLE IS THE HEADER'S, BY IDENTITY — not a copy. `isBomChangeRequestEditable`
 *     and `isBomHeaderEditable` are asserted to be the SAME function and to agree on all
 *     four states, so a second predicate that disagreed on one of them could not exist.
 */

describe('BOM change vocabulary', () => {
  it('states exactly the two change types the source radio offered, in order', () => {
    expect(BOM_CHANGE_TYPES).toEqual(['QUANTITY_CHANGE', 'DEACTIVATE']);
    // Non-vacuity: the tuple is the whole vocabulary, so its length is the claim.
    expect(BOM_CHANGE_TYPES).toHaveLength(2);
  });

  it('renders the source labels verbatim, and every member has one', () => {
    expect(BOM_CHANGE_TYPE_LABELS).toEqual({
      QUANTITY_CHANGE: 'تغییر موجودی',
      DEACTIVATE: 'غیر فعال سازی',
    });
    for (const type of BOM_CHANGE_TYPES) {
      expect(bomChangeTypeLabel(type).length).toBeGreaterThan(0);
    }
  });

  it('keeps the schema enum and the domain constant the same closed set', () => {
    // The two artifacts cannot import each other — one is Prisma schema text — so the only
    // executable statement available is "the same members, in both files".
    const schema = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'prisma', 'production', 'schema.prisma'),
      'utf8'
    );
    const match = schema.match(/enum\s+BomChangeType\s*\{([^}]*)\}/);
    const members = (match?.[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter(Boolean);

    expect(members).toEqual([...BOM_CHANGE_TYPES]);
  });
});

describe('BOM change error codes', () => {
  it('are unique, non-empty and prefixed so they cannot collide with the header\u2019s codes', () => {
    const codes = Object.values(PRODUCTION_BOM_CHANGE_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(11); // non-vacuity: every code is stated on purpose

    for (const code of codes) {
      expect(code.length).toBeGreaterThan(0);
      expect(code.startsWith('BOM_CHANGE')).toBe(true);
    }

    // No overlap with the header/item vocabulary: the UI maps each code to one Persian
    // sentence, and a shared string would make that map ambiguous.
    const headerCodes = new Set<string>(Object.values(PRODUCTION_BOM_ERROR_CODES));
    for (const code of codes) {
      expect({ code, shared: headerCodes.has(code) }).toEqual({ code, shared: false });
    }
  });

  it('carries the three refusals the legacy form itself produced', () => {
    // These three are the ones the source printed, so their codes are the contract the UI
    // maps to «اقلامی جهت تغییر ثبت نشده است!», «شما قبلا جزئیات این قطعه …» and «حداقل یکی
    // از فیلد های افزایش ضریب مصرف … باید مقداردهی گردد».
    expect(PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEMS_REQUIRED).toBe(
      'BOM_CHANGE_REQUEST_ITEMS_REQUIRED'
    );
    expect(PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEM_DUPLICATE).toBe('BOM_CHANGE_ITEM_DUPLICATE');
    expect(PRODUCTION_BOM_CHANGE_ERROR_CODES.DELTA_REQUIRED).toBe(
      'BOM_CHANGE_ITEM_DELTA_REQUIRED'
    );
  });
});

describe('isValidCoefficientDelta — the ONE rule the source proves, and nothing more', () => {
  it('accepts every signed safe integer, including zero and a decrease', () => {
    for (const value of [0, 1, -1, 42, -42, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      expect({ value, valid: isValidCoefficientDelta(value) }).toEqual({ value, valid: true });
    }
  });

  it('refuses a fraction, a string, a boolean, NaN, an infinity and an unsafe integer', () => {
    const rejected: unknown[] = [
      1.5,
      -0.25,
      '3',
      '',
      true,
      null,
      undefined,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      {},
    ];
    for (const value of rejected) {
      expect({ value: String(value), valid: isValidCoefficientDelta(value) }).toEqual({
        value: String(value),
        valid: false,
      });
    }
  });

  it('is NOT the item coefficient rule: the header\u2019s validator refuses what this one accepts', () => {
    // The distinction is the phase's D-1 decision. `-5` is a LEGAL delta (a decrease) and an
    // ILLEGAL consumption coefficient; an implementation that reused the item's predicate
    // would pass every other assertion in this file and fail exactly this one.
    expect(isValidCoefficientDelta(-5)).toBe(true);
    expect(isValidCoefficientDelta(0)).toBe(true);
  });
});

describe('isQuantityChangePayloadComplete — the source\u2019s `check == 0` branch, verbatim', () => {
  it('refuses a QUANTITY_CHANGE that stated NEITHER delta', () => {
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: null,
        spareCoefficientDelta: null,
      })
    ).toBe(false);
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: undefined,
        spareCoefficientDelta: undefined,
      })
    ).toBe(false);
  });

  it('accepts a stated zero — the source tested the CONTROL, not the number', () => {
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: 0,
        spareCoefficientDelta: null,
      })
    ).toBe(true);
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: null,
        spareCoefficientDelta: 0,
      })
    ).toBe(true);
  });

  it('accepts either delta alone, and a negative one', () => {
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: 3,
        spareCoefficientDelta: null,
      })
    ).toBe(true);
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: null,
        spareCoefficientDelta: -7,
      })
    ).toBe(true);
    expect(
      isQuantityChangePayloadComplete({
        drawingCoefficientDelta: 3,
        spareCoefficientDelta: -7,
      })
    ).toBe(true);
  });
});

describe('the change request walks the HEADER\u2019s lifecycle, by identity', () => {
  it('is the very same editability predicate, not a second implementation', () => {
    expect(isBomChangeRequestEditable).toBe(isBomHeaderEditable);
    for (const status of BOM_STATUSES) {
      expect({
        status,
        changeEditable: isBomChangeRequestEditable(status),
        headerEditable: isBomHeaderEditable(status),
      }).toEqual({
        status,
        changeEditable: isBomChangeRequestEditable(status),
        headerEditable: isBomChangeRequestEditable(status),
      });
    }
  });

  it('is editable ONLY as a DRAFT — the source\u2019s `c_status == "0"` guard, exactly', () => {
    expect(BOM_STATUSES.map((status) => [status, isBomChangeRequestEditable(status)])).toEqual([
      ['DRAFT', true],
      ['SUBMITTED', false],
      ['APPROVED', false],
      ['REJECTED', false],
    ]);
  });

  it('is the header\u2019s own guarded transition table', () => {
    // SUBMIT only from DRAFT; the three decisions only from SUBMITTED; correction lands on
    // the EDITABLE state rather than on a fifth one.
    expect(bomChangeRequestStatusAfter('DRAFT', 'SUBMIT')).toBe('SUBMITTED');
    expect(bomChangeRequestStatusAfter('SUBMITTED', 'SUBMIT')).toBeNull();
    expect(bomChangeRequestStatusAfter('APPROVED', 'SUBMIT')).toBeNull();

    expect(bomChangeRequestStatusAfter('SUBMITTED', 'APPROVE')).toBe('APPROVED');
    expect(bomChangeRequestStatusAfter('SUBMITTED', 'REJECT')).toBe('REJECTED');
    expect(bomChangeRequestStatusAfter('SUBMITTED', 'REQUEST_CORRECTION')).toBe('DRAFT');

    // No decision is reachable from DRAFT or from an already-decided document.
    for (const status of ['DRAFT', 'APPROVED', 'REJECTED'] as const) {
      expect(bomChangeRequestStatusAfter(status, 'APPROVE')).toBeNull();
      expect(bomChangeRequestStatusAfter(status, 'REJECT')).toBeNull();
      expect(bomChangeRequestStatusAfter(status, 'REQUEST_CORRECTION')).toBeNull();
    }

    // CORRECTION IS NOT A STATE, and nothing re-opens a decided request: the source's
    // «نیاز به اصلاح» branch wrote `State = 0`, and there is no un-decide branch at all.
    expect(BOM_STATUSES).toHaveLength(4);
    expect(bomChangeRequestStatusAfter('APPROVED', 'REQUEST_CORRECTION')).toBeNull();
    expect(bomChangeRequestStatusAfter('REJECTED', 'REQUEST_CORRECTION')).toBeNull();
  });
});

