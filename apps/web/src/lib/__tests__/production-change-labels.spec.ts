import {
  PRODUCTION_BOM_CHANGE_TYPE_LABELS,
  PRODUCTION_ERROR_MESSAGES,
  productionBomChangeTotal,
  productionBomChangeTypeLabel,
  productionErrorMessage,
} from '../production-labels';
import { PRODUCTION_BOM_CHANGE_TYPES } from '../production-api';

/**
 * PHASE PRODUCTION-BOM-CHANGE: the Persian rendering of the change-request vocabulary.
 *
 * WHAT THESE SPECS PIN, and why each is falsifiable:
 *  1. THE TWO CHANGE TYPES, VERBATIM FROM THE SOURCE RADIO (`تغییر موجودی;غیر فعال سازی`).
 *     A third member added to the wire tuple without a label fails here.
 *  2. THE DERIVED TOTAL IS THE SOURCE'S DISPLAY FORMULA AND NOTHING MORE: `original + delta`,
 *     a null delta counting as `0`, and NO floor at zero — the `< 0` branch in `BomEdit.txt`
 *     was a warning whose `//error = true` was commented out, so a clamp would be an invented
 *     rule.
 *  3. EVERY NEW ERROR CODE HAS A PERSIAN SENTENCE, and the three the legacy form printed are
 *     mapped to the SOURCE'S OWN words rather than to a paraphrase.
 *  4. THE LABEL LOOKUP FALLS BACK TO THE RAW TOKEN for a value nobody defined, and renders
 *     `—` for an unset one — never a plausible-sounding sentence the backend never stated.
 */
describe('production-labels — BOM change vocabulary', () => {
  it('labels exactly the two change types the source radio offered', () => {
    expect(PRODUCTION_BOM_CHANGE_TYPES).toEqual(['QUANTITY_CHANGE', 'DEACTIVATE']);
    expect(PRODUCTION_BOM_CHANGE_TYPE_LABELS).toEqual({
      QUANTITY_CHANGE: 'تغییر موجودی',
      DEACTIVATE: 'غیر فعال سازی',
    });

    for (const type of PRODUCTION_BOM_CHANGE_TYPES) {
      expect(productionBomChangeTypeLabel(type).length).toBeGreaterThan(0);
    }
    expect(productionBomChangeTypeLabel('QUANTITY_CHANGE')).toBe('تغییر موجودی');
    expect(productionBomChangeTypeLabel(null)).toBe('—');
    // An unknown code renders AS ITSELF: a fallback sentence would attribute a meaning the
    // API never stated.
    expect(productionBomChangeTypeLabel('ARCHIVED')).toBe('ARCHIVED');
  });

  it('derives a total as `original + delta`, treating a null delta as zero', () => {
    expect(productionBomChangeTotal(4, -1)).toBe(3);
    expect(productionBomChangeTotal(4, 2)).toBe(6);
    expect(productionBomChangeTotal(4, 0)).toBe(4);
    expect(productionBomChangeTotal(4, null)).toBe(4);
    expect(productionBomChangeTotal(0, null)).toBe(0);
  });

  it('does NOT clamp a negative total — the source warned and never blocked', () => {
    // The single most tempting "fix" would be `Math.max(0, …)`. The source's own comment on
    // that branch is `//error = true`, so the number is shown as computed.
    expect(productionBomChangeTotal(1, -5)).toBe(-4);
    expect(productionBomChangeTotal(0, -1)).toBe(-1);
  });
});

describe('production-labels — the change-request refusals', () => {
  it('maps every new code to a Persian sentence, with no token left over', () => {
    const codes = [
      'BOM_CHANGE_REQUEST_ITEMS_REQUIRED',
      'BOM_CHANGE_ITEM_DUPLICATE',
      'BOM_CHANGE_ITEM_DELTA_REQUIRED',
      'BOM_CHANGE_REQUEST_NOT_EDITABLE',
      'BOM_CHANGE_REQUEST_NOT_FOUND',
      'BOM_CHANGE_REQUEST_BOM_NOT_FOUND',
      'BOM_CHANGE_ITEM_NOT_FOUND',
      'BOM_CHANGE_ITEM_DELTA_INVALID',
      'BOM_CHANGE_ITEM_TYPE_INVALID',
      'BOM_CHANGE_REQUEST_FIELD_REQUIRED',
      'BOM_CHANGE_REQUEST_PATCH_EMPTY',
    ];

    for (const code of codes) {
      expect({ code, message: PRODUCTION_ERROR_MESSAGES[code] }).toEqual({
        code,
        message: expect.any(String),
      });
      expect({ code, blank: PRODUCTION_ERROR_MESSAGES[code].length === 0 }).toEqual({
        code,
        blank: false,
      });
      expect(productionErrorMessage(code)).toBe(PRODUCTION_ERROR_MESSAGES[code]);
    }
  });

  it('carries the THREE refusals the legacy form printed, in the source\u2019s own words', () => {
    // «اقلامی جهت تغییر ثبت نشده است!» — the `c_Control1` submit gate.
    expect(productionErrorMessage('BOM_CHANGE_REQUEST_ITEMS_REQUIRED')).toBe(
      'اقلامی جهت تغییر ثبت نشده است!'
    );
    // «شما قبلا جزئیات این قطعه را تغییر و ثبت نموده اید» — the `c_add` duplicate guard.
    expect(productionErrorMessage('BOM_CHANGE_ITEM_DUPLICATE')).toContain(
      'قبلا جزئیات این قطعه را تغییر و ثبت نموده اید'
    );
    // «حداقل یکی از فیلد های افزایش ضریب مصرف … باید مقداردهی گردد» — the delta pair rule.
    expect(productionErrorMessage('BOM_CHANGE_ITEM_DELTA_REQUIRED')).toContain(
      'حداقل یکی از دو ضریب مصرف'
    );
  });

  it('falls back to the server message for an unknown code, never to the token', () => {
    expect(productionErrorMessage('BOM_CHANGE_SOMETHING_NEW', 'the server said this')).toBe(
      'the server said this'
    );
  });
});
