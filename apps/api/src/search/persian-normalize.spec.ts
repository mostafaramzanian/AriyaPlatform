import {
  buildSearchText,
  normalizedTokens,
  normalizeForIndex,
  normalizeForQuery,
  normalizeSearchText,
  ZWNJ,
} from './persian-normalize';

/**
 * Phase 49J: normalization-boundary tests.
 *
 * The assertions are written as EQUIVALENCES between spellings a real user would
 * type, not as snapshots of the implementation's output. That is the property the
 * search actually depends on: two spellings of one word must produce one lexeme, and
 * the index path and the query path must produce the same string for the same input.
 *
 * No Postgres is involved here — this is the pure function that runs BEFORE
 * `to_tsvector('simple', …)` on both paths.
 */
describe('persian-normalize', () => {
  describe('the index/query invariant', () => {
    it('exposes one implementation under both names', () => {
      // Structural, not behavioural: if these ever become separate functions the
      // index could silently stop matching the query.
      expect(normalizeForIndex).toBe(normalizeSearchText);
      expect(normalizeForQuery).toBe(normalizeSearchText);
    });

    it('agrees on every sample used in this suite', () => {
      const samples = [
        'مرخصي',
        `می${ZWNJ}توانم`,
        'گزارش ها',
        'پشتیبانی/فنی',
        'TK-0123',
        '  ',
        'مُرَخَّصی',
      ];

      for (const sample of samples) {
        expect(normalizeForQuery(sample)).toBe(normalizeForIndex(sample));
      }
    });
  });

  describe('letter folding', () => {
    it('folds Arabic yeh to Persian yeh (مرخصي ≡ مرخصی)', () => {
      expect(normalizeSearchText('مرخصي')).toBe(normalizeSearchText('مرخصی'));
      expect(normalizeSearchText('مرخصي')).toBe('مرخصی');
    });

    it('folds Arabic kaf to keheh (كاركنان ≡ کارکنان)', () => {
      expect(normalizeSearchText('كاركنان')).toBe(normalizeSearchText('کارکنان'));
      expect(normalizeSearchText('كاركنان')).toBe('کارکنان');
    });

    it('folds hamza carriers and teh marbuta', () => {
      expect(normalizeSearchText('مسأله')).toBe(normalizeSearchText('مساله'));
      expect(normalizeSearchText('مسئول')).toBe('مسیول');
      expect(normalizeSearchText('نتيجة')).toBe(normalizeSearchText('نتیجه'));
    });

    it('folds the hamza-on-heh composite (نامۀ ≡ نامه)', () => {
      // Both the precomposed U+06C0 and the decomposed heh + U+0654 spelling.
      expect(normalizeSearchText('نامۀ')).toBe(normalizeSearchText('نامه'));
      expect(normalizeSearchText('نامه\u0654')).toBe(normalizeSearchText('نامه'));
    });

    it('does NOT fold آ to ا — they are different words', () => {
      expect(normalizeSearchText('آمد')).not.toBe(normalizeSearchText('امد'));
    });
  });

  describe('digit folding', () => {
    it('folds Extended Arabic-Indic digits to ASCII', () => {
      expect(normalizeSearchText('۱۴۰۵')).toBe('1405');
    });

    it('folds Arabic-Indic digits to ASCII', () => {
      expect(normalizeSearchText('١٢٣')).toBe('123');
    });

    it('makes a tracking number findable with Persian digits', () => {
      expect(normalizeSearchText('TK-۰۱۲۳')).toBe(normalizeSearchText('tk 0123'));
    });
  });

  describe('diacritics and invisible characters', () => {
    it('strips harakat (مُرَخَّصی ≡ مرخصی)', () => {
      expect(normalizeSearchText('مُرَخَّصی')).toBe('مرخصی');
    });

    it('strips the kashida', () => {
      expect(normalizeSearchText('مرخـــصی')).toBe('مرخصی');
    });

    it('strips bidi controls and the BOM', () => {
      expect(normalizeSearchText('\uFEFF\u202Bمرخصی\u202C')).toBe('مرخصی');
    });
  });

  describe('the ZWNJ rule', () => {
    it('converges all three spellings of می‌توانم', () => {
      const withZwnj = normalizeSearchText(`می${ZWNJ}توانم`);
      const joined = normalizeSearchText('میتوانم');
      const spaced = normalizeSearchText('می توانم');

      expect(withZwnj).toBe('میتوانم');
      expect(joined).toBe('میتوانم');
      expect(spaced).toBe('میتوانم');
      expect(new Set([withZwnj, joined, spaced]).size).toBe(1);
    });

    it('converges نمی‌دانم the same way', () => {
      expect(normalizeSearchText(`نمی${ZWNJ}دانم`)).toBe('نمیدانم');
      expect(normalizeSearchText('نمی دانم')).toBe('نمیدانم');
      expect(normalizeSearchText('نمیدانم')).toBe('نمیدانم');
    });

    it('deletes ZWNJ rather than replacing it with a space', () => {
      // The distinguishing assertion: a space would yield two tokens.
      expect(normalizeSearchText(`کتاب${ZWNJ}ها`).split(' ')).toHaveLength(1);
    });

    it('converges plural spellings (گزارش‌ها / گزارشها / گزارش ها)', () => {
      expect(normalizeSearchText(`گزارش${ZWNJ}ها`)).toBe('گزارشها');
      expect(normalizeSearchText('گزارشها')).toBe('گزارشها');
      expect(normalizeSearchText('گزارش ها')).toBe('گزارشها');
    });

    it('converges comparatives (بزرگ‌تر / بزرگتر / بزرگ تر)', () => {
      expect(normalizeSearchText(`بزرگ${ZWNJ}تر`)).toBe('بزرگتر');
      expect(normalizeSearchText('بزرگ تر')).toBe('بزرگتر');
    });

    it('does not join a Persian proclitic to a Latin token', () => {
      expect(normalizeSearchText('می test')).toBe('می test');
    });

    it('leaves a lone enclitic-looking token alone', () => {
      expect(normalizeSearchText('ها')).toBe('ها');
    });
  });

  describe('punctuation and whitespace', () => {
    it('splits on punctuation instead of merging tokens', () => {
      expect(normalizeSearchText('پشتیبانی/فنی')).toBe('پشتیبانی فنی');
      expect(normalizeSearchText('مرخصی، استحقاقی')).toBe('مرخصی استحقاقی');
      expect(normalizeSearchText('«نقل‌قول»')).toBe('نقلقول');
    });

    it('splits on the underscore so ticket_subject is findable by subject', () => {
      expect(normalizeSearchText('ticket_subject')).toBe('ticket subject');
    });

    it('collapses every flavour of whitespace to one space', () => {
      expect(normalizeSearchText('  مرخصی \u00A0\t\n استحقاقی  ')).toBe('مرخصی استحقاقی');
    });

    it('lowercases Latin content', () => {
      expect(normalizeSearchText('Ticket SUBJECT')).toBe('ticket subject');
    });
  });

  describe('empty and degenerate input', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace only', '   \t\n '],
      ['punctuation only', '!!!///'],
      ['ZWNJ only', ZWNJ],
    ])('returns an empty string for %s', (_label, input) => {
      expect(normalizeSearchText(input as string | null | undefined)).toBe('');
    });
  });

  describe('buildSearchText', () => {
    it('joins parts, dropping nulls and blanks', () => {
      expect(buildSearchText(['مرخصي', null, '  ', 'كاركنان', undefined])).toBe('مرخصی کارکنان');
    });

    it('keeps a title and a body from merging into one token', () => {
      expect(buildSearchText(['عنوان', 'متن'])).toBe('عنوان متن');
    });

    it('returns an empty string when every part is empty', () => {
      expect(buildSearchText([null, undefined, '', '   '])).toBe('');
    });
  });

  describe('normalizedTokens', () => {
    it('returns distinct tokens, longest first', () => {
      expect(normalizedTokens('مرخصی استحقاقی مرخصی')).toEqual(['استحقاقی', 'مرخصی']);
    });

    it('returns an empty array for empty input', () => {
      expect(normalizedTokens('   ')).toEqual([]);
    });

    it('reports the normalized form, not the raw one', () => {
      expect(normalizedTokens('مرخصي')).toEqual(['مرخصی']);
    });
  });
});
