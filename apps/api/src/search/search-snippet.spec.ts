import { buildBestSnippet, buildSnippet } from './search-snippet';
import { ZWNJ } from './persian-normalize';
import { SNIPPET_ELLIPSIS, SNIPPET_LEAD, SNIPPET_LENGTH } from './search.constants';

/**
 * Phase 49J: snippet and highlight-offset tests.
 *
 * The interesting assertions are the OFFSET ones. A match is located in NORMALIZED
 * space (ZWNJ deleted, yeh/kaf folded, diacritics stripped) but reported in ORIGINAL
 * space, and the two do not have the same length. Any test that only checked "the
 * snippet contains the word" would pass while the highlight painted the wrong
 * characters — so every highlight case below slices the emitted text with the returned
 * offsets and asserts on what comes out.
 */

/** Applies the returned offsets, which is the only honest way to check them. */
const highlighted = (text: string, ranges: Array<{ start: number; end: number }>): string[] =>
  ranges.map((range) => text.slice(range.start, range.end));

describe('search-snippet', () => {
  describe('buildSnippet', () => {
    it('returns nothing for empty or blank input', () => {
      expect(buildSnippet(null, 'x')).toEqual({ text: '', highlights: [] });
      expect(buildSnippet(undefined, 'x')).toEqual({ text: '', highlights: [] });
      expect(buildSnippet('   ', 'x')).toEqual({ text: '', highlights: [] });
    });

    it('highlights an exact match at the correct original offsets', () => {
      const source = 'درخواست مرخصی برای هفته آینده';
      const result = buildSnippet(source, 'مرخصی');

      expect(result.highlights).toHaveLength(1);
      expect(highlighted(result.text, result.highlights)).toEqual(['مرخصی']);
    });

    it('highlights across a folded letter (Arabic yeh query, Persian yeh text)', () => {
      // The defect this feature exists to fix: the two spellings must match, AND the
      // offsets must still land on the original characters.
      const source = 'درخواست مرخصی ثبت شد';
      const result = buildSnippet(source, 'مرخصي');

      expect(highlighted(result.text, result.highlights)).toEqual(['مرخصی']);
    });

    it('highlights a ZWNJ-joined word matched by its ZWNJ-free spelling', () => {
      // NORMALIZATION DELETES ZWNJ, so the normalized offset of the match is SHORTER
      // than the original span. The offset map is what keeps this correct; a
      // length-preserving assumption would highlight one character too few.
      const source = `من می${ZWNJ}توانم این کار را انجام دهم`;
      const result = buildSnippet(source, 'میتوانم');

      expect(highlighted(result.text, result.highlights)).toEqual([`می${ZWNJ}توانم`]);
    });

    it('highlights a diacritised word matched by its bare spelling', () => {
      // Diacritics are deleted too, so the original span is again longer.
      const source = 'مُرَخَّصی سالانه';
      const result = buildSnippet(source, 'مرخصی');

      expect(highlighted(result.text, result.highlights)).toEqual(['مُرَخَّصی']);
    });

    it('highlights every occurrence inside the window', () => {
      const source = 'گزارش ماهانه و گزارش سالانه';
      const result = buildSnippet(source, 'گزارش');

      expect(result.highlights).toHaveLength(2);
      expect(highlighted(result.text, result.highlights)).toEqual(['گزارش', 'گزارش']);
    });

    it('merges overlapping matches into one range', () => {
      // Two query tokens matching at the same place must not produce nested ranges.
      const source = 'کارکنان بخش فنی';
      const result = buildSnippet(source, 'کارکنان کارکنان');

      expect(result.highlights).toHaveLength(1);
      expect(highlighted(result.text, result.highlights)).toEqual(['کارکنان']);
    });

    it('returns the head of the field, unhighlighted, when nothing matched', () => {
      // Honest: something matched this ROW (possibly the semantic arm, possibly
      // another field), but not this field.
      const source = 'متن کاملا بی‌ربط';
      const result = buildSnippet(source, 'مرخصی');

      expect(result.highlights).toEqual([]);
      expect(result.text).toBe(source);
    });

    it('returns the head unhighlighted when the query normalizes to nothing', () => {
      const source = 'یک متن معمولی';
      const result = buildSnippet(source, '،؟!');

      expect(result.highlights).toEqual([]);
      expect(result.text).toBe(source);
    });
  });

  describe('windowing', () => {
    it('bounds the excerpt, so a snippet is never an export of the field', () => {
      const source = 'الف '.repeat(500);
      const result = buildSnippet(source, 'الف');

      // SNIPPET_LENGTH of body, plus at most the two ellipsis characters.
      expect(result.text.length).toBeLessThanOrEqual(SNIPPET_LENGTH + 2 * SNIPPET_ELLIPSIS.length);
    });

    it('ellipsises only the truncated end of a long field', () => {
      const source = `مرخصی ${'ب'.repeat(500)}`;
      const result = buildSnippet(source, 'مرخصی');

      // The match is at position 0, so nothing was cut from the front.
      expect(result.text.startsWith(SNIPPET_ELLIPSIS)).toBe(false);
      expect(result.text.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
    });

    it('ellipsises the front when the match is deep inside the field', () => {
      const source = `${'الف '.repeat(200)}مرخصی ${'ب '.repeat(200)}`;
      const result = buildSnippet(source, 'مرخصی');

      expect(result.text.startsWith(SNIPPET_ELLIPSIS)).toBe(true);
      // And the offsets still resolve to the match inside the shifted window.
      expect(highlighted(result.text, result.highlights)).toEqual(['مرخصی']);
    });

    it('never truncates a field shorter than the window', () => {
      const source = 'یک عبارت کوتاه';
      expect(buildSnippet(source, 'کوتاه').text).toBe(source);
    });

    it('keeps the match visible, not flush against the leading edge', () => {
      const source = `${'الف '.repeat(100)}مرخصی سالانه`;
      const result = buildSnippet(source, 'مرخصی');
      const [first] = result.highlights;

      // Some lead context exists before the match, bounded by SNIPPET_LEAD.
      expect(first.start).toBeGreaterThan(0);
      expect(first.start).toBeLessThanOrEqual(SNIPPET_LEAD + SNIPPET_ELLIPSIS.length);
    });

    it('starts the window on a word boundary rather than mid-token', () => {
      const source = `${'کارکنان '.repeat(40)}مرخصی`;
      const result = buildSnippet(source, 'مرخصی');
      const body = result.text.slice(SNIPPET_ELLIPSIS.length);

      // A mid-token cut would leave a partial word; the boundary rule prevents it.
      expect(source.includes(` ${body.split(' ')[0]}`)).toBe(true);
    });
  });

  describe('buildBestSnippet', () => {
    it('prefers the first field that actually contains a match', () => {
      // A body hit must produce a body snippet, not a subject snippet showing nothing
      // relevant.
      const result = buildBestSnippet(['موضوع تیکت', 'متن شامل مرخصی است'], 'مرخصی');

      expect(highlighted(result.text, result.highlights)).toEqual(['مرخصی']);
      expect(result.text).toContain('متن شامل');
    });

    it('falls back to the first non-empty field when nothing matches', () => {
      const result = buildBestSnippet([null, '', 'موضوع تیکت', 'متن'], 'مرخصی');

      expect(result.text).toBe('موضوع تیکت');
      expect(result.highlights).toEqual([]);
    });

    it('skips null, undefined and blank fields', () => {
      const result = buildBestSnippet([null, undefined, '   ', 'مرخصی'], 'مرخصی');

      expect(highlighted(result.text, result.highlights)).toEqual(['مرخصی']);
    });

    it('returns nothing when every field is empty', () => {
      expect(buildBestSnippet([null, undefined, '  '], 'x')).toEqual({ text: '', highlights: [] });
    });

    it('emits no markup, so a snippet can never inject into the DOM', () => {
      // The client renders text nodes and applies the offsets itself; this asserts the
      // contract rather than trusting it.
      const result = buildBestSnippet(['<script>alert(1)</script> مرخصی'], 'مرخصی');

      expect(result.text).not.toContain('<mark');
      expect(result.text).toContain('<script>');
      expect(highlighted(result.text, result.highlights)).toEqual(['مرخصی']);
    });
  });
});
