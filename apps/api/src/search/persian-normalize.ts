/**
 * Phase 49J: the Persian text-normalization boundary for Global Search.
 *
 * This file is the ONLY place that decides what "the same word" means for search,
 * and it is deliberately explicit about why it has to exist at all.
 *
 * WHY APP-LEVEL NORMALIZATION IS MANDATORY
 * ----------------------------------------
 * PostgreSQL has no Persian text-search configuration. The two candidates both
 * fail, and were measured against this database (Postgres 16, `core_db`):
 *
 *  1. `arabic` — has a stemmer, and it OVER-STEMS Persian:
 *     `to_tsvector('arabic','کارکنان')` → `'کارکن'`. A survey titled «کارکنان»
 *     would stop matching a query for «کارکنان» in ways nobody can predict, and
 *     Persian plural/ezafe morphology is not Arabic morphology.
 *  2. `simple` — no stemmer, no stopwords, pure token folding. Chosen. It is the
 *     ONLY configuration used anywhere in this feature, on both the index and the
 *     query path.
 *
 * `simple` splits on Unicode word boundaries and lowercases, and it does NOTHING
 * else. In particular it treats ZWNJ (U+200C) as part of the word:
 *
 *     SELECT to_tsvector('simple','میتوانم') = to_tsvector('simple','می‌توانم');
 *     -- f       (measured, not assumed: 'می‌توانم':1 stays a single lexeme)
 *
 * So `می‌توانم` and `میتوانم` are two different lexemes to Postgres. Every Persian
 * corpus contains both spellings of the same word, typed by different people. That
 * difference has to be erased BEFORE the text reaches `to_tsvector`, which is what
 * this module does.
 *
 * THE ONE INVARIANT
 * -----------------
 * The index path and the query path MUST apply the identical transformation. If
 * they diverge by one character the index silently stops matching. That is enforced
 * structurally here: there is exactly one implementation, `normalizeSearchText`,
 * and `normalizeForIndex` / `normalizeForQuery` are aliases of it that exist only
 * to make the call sites read honestly. There is no "query-only" tweak and no
 * "index-only" tweak, and there must never be one.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is NOT a stemmer, NOT a lemmatizer and NOT a spell corrector. It performs
 * character folding and a bounded, closed-set affix attachment. It never touches
 * source-of-truth text: callers normalize into a separate projection column and
 * the original `Ticket.subject` / `Message.body` / … are never rewritten.
 *
 * No new dependency is introduced. Everything here is plain JavaScript string and
 * `RegExp` work on the pinned Node runtime; `hazm`, `parsivar` and similar are
 * Python, and no JS Persian NLP package is in this repository's dependency tree.
 */

/** Zero-width non-joiner — the character this whole module exists because of. */
export const ZWNJ = '\u200C';

/**
 * Arabic-script letters that must fold to their Persian counterparts.
 *
 * These are NOT stylistic variants, they are different code points that render
 * near-identically and that Persian keyboards emit inconsistently. `مرخصي` (Arabic
 * yeh, U+064A) and `مرخصی` (Persian yeh, U+06CC) are the same word to every reader
 * and two unrelated lexemes to Postgres.
 *
 * `آ` (U+0622) is deliberately NOT folded to `ا`: it is a distinct Persian letter
 * with its own phonemic value, and folding it would merge unrelated words
 * (`آمد` / `امد`). Hamza CARRIERS are folded, because there the hamza is an
 * orthographic decoration in Persian usage.
 *
 * Arabic-Indic (U+0660–U+0669) and Extended Arabic-Indic (U+06F0–U+06F9) digits
 * fold to ASCII so a ticket number typed as `۱۲۳` finds the row stored as `123`.
 */
const LETTER_FOLDING: ReadonlyArray<readonly [string, string]> = [
  ['\u064A', '\u06CC'], // ي  ARABIC YEH            → ی  FARSI YEH
  ['\u0649', '\u06CC'], // ى  ALEF MAKSURA          → ی
  ['\u06D2', '\u06CC'], // ے  YEH BARREE            → ی
  ['\u0643', '\u06A9'], // ك  ARABIC KAF            → ک  KEHEH
  ['\u06AA', '\u06A9'], // ڪ  SWASH KAF             → ک
  ['\u0623', '\u0627'], // أ  ALEF WITH HAMZA ABOVE → ا
  ['\u0625', '\u0627'], // إ  ALEF WITH HAMZA BELOW → ا
  ['\u0671', '\u0627'], // ٱ  ALEF WASLA            → ا
  ['\u0624', '\u0648'], // ؤ  WAW WITH HAMZA        → و
  ['\u0626', '\u06CC'], // ئ  YEH WITH HAMZA        → ی
  ['\u0629', '\u0647'], // ة  TEH MARBUTA           → ه
  ['\u06C0', '\u0647'], // ۀ  HEH WITH YEH ABOVE    → ه  (the `هٔ` composite)
  ['\u06C1', '\u0647'], // ہ  HEH GOAL              → ه
  ['\u06C2', '\u0647'], // ۂ  HEH GOAL + HAMZA      → ه
  ['\u06CD', '\u06CC'], // ۍ  YEH WITH TAIL         → ی
  ['\u0660', '0'],
  ['\u0661', '1'],
  ['\u0662', '2'],
  ['\u0663', '3'],
  ['\u0664', '4'],
  ['\u0665', '5'],
  ['\u0666', '6'],
  ['\u0667', '7'],
  ['\u0668', '8'],
  ['\u0669', '9'],
  ['\u06F0', '0'],
  ['\u06F1', '1'],
  ['\u06F2', '2'],
  ['\u06F3', '3'],
  ['\u06F4', '4'],
  ['\u06F5', '5'],
  ['\u06F6', '6'],
  ['\u06F7', '7'],
  ['\u06F8', '8'],
  ['\u06F9', '9'],
];

/** Pre-built single-pass folding map. */
const FOLD_MAP = new Map<string, string>(LETTER_FOLDING);

/**
 * Ligatures that expand to their constituent letters, so `ﻻ` tokenizes as `لا`.
 * Written as explicit pairs rather than relying on NFKC, which would also destroy
 * digit and space distinctions handled deliberately elsewhere in this file.
 */
const LIGATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\uFEFB\uFEF5\uFEF7\uFEF9]/g, '\u0644\u0627'], // ﻻ ﻵ ﻷ ﻹ → لا
  [/\uFDF2/g, '\u0627\u0644\u0644\u0647'], // ﷲ → الله
];

/**
 * Combining marks and decorations that carry no lexical weight in Persian search:
 * harakat (fathatan…sukun, which includes the hamza-above/below marks used to build
 * `هٔ`), the superscript alef, the kashida, and the standalone hamza.
 *
 * Removed rather than folded: `مُرَخَّصی` and `مرخصی` must be one lexeme, and nobody
 * types the diacritics when searching.
 *
 * ORDERING IS DELIBERATE: the combining ranges come FIRST and the two non-combining
 * characters (`\u0640` kashida, `\u0621` hamza) come LAST. A base character written
 * immediately before a combining mark inside a class forms a grapheme cluster in the
 * SOURCE TEXT, which `no-misleading-character-class` correctly flags — the class would
 * then read as one combined character rather than two independent members.
 *
 * `\u0653-\u0655` is NOT listed: those three code points already fall inside
 * `\u064B-\u065F`, so naming them again added nothing but the adjacency above.
 */
const DIACRITICS = /[\u064B-\u065F\u0670\u0640\u0621]/g;

/**
 * Invisible characters. ZWNJ is the important one (see the file header); the rest
 * are bidi controls, zero-width joiners/spaces and the BOM, which arrive from
 * copy-pasted Word/Outlook content and would otherwise split or corrupt lexemes.
 *
 * ZWNJ POLICY — THE EXPLICIT RULE, applied identically on index and query:
 *   ZWNJ IS DELETED, NOT REPLACED BY A SPACE.
 * Deleting joins the halves into one lexeme (`می‌توانم` → `میتوانم`); replacing it
 * with a space would produce two lexemes, making the ZWNJ spelling match the spaced
 * spelling but no longer the joined one. Deletion plus the closed-set affix
 * attachment below is what makes all three spellings converge on `میتوانم`.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u00AD\u061C]/g;

/**
 * Everything that is punctuation for search purposes becomes a SPACE, not the empty
 * string: `پشتیبانی/فنی` must be two tokens, and deleting the slash would invent the
 * single token `پشتیبانیفنی`.
 *
 * Underscore is included even though `simple` treats it as a word character, so
 * `ticket_subject` is findable by `subject`. The `-` inside the class is escaped by
 * position (first character of the ASCII range block) rather than by a backslash.
 *
 * `!-\/` is written as `!-/` — the backslash before `/` is unnecessary inside a
 * character class and only obscured the range's endpoints.
 */
const PUNCTUATION =
  /[!-/:-@[-`{-~\u00AB\u00BB\u060C\u061B\u061F\u066A-\u066D\u06D4\u2010-\u2027\u2030-\u205E\u2039\u203A\u00D7\u00F7]/g;

/** Any run of whitespace, including the Persian/Arabic and non-breaking spaces. */
const WHITESPACE = /[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

/**
 * Verbal PROCLITICS: written attached, with a ZWNJ, or with a space, by different
 * people, for the same word. Once ZWNJ is deleted the first two spellings agree;
 * attaching these to the following token makes the spaced spelling agree too.
 *
 * Closed set on purpose. `می` and `نمی` are the only two productive verbal prefixes
 * in Persian written detached — this is not a general "join short words" heuristic
 * and it must not grow into one.
 *
 * Cost, stated honestly: a sentence containing the noun «می» (wine) followed by
 * another Persian word will have them joined. That is a rare false merge, it is
 * applied identically on both paths so it cannot cause a silent index/query
 * mismatch, and it buys convergence for the most common verb form in the language.
 */
const PROCLITICS: ReadonlySet<string> = new Set(['\u0645\u06CC', '\u0646\u0645\u06CC']); // می، نمی

/**
 * ENCLITICS: plural, comparative and possessive suffixes, again written attached /
 * with ZWNJ / with a space interchangeably. Attached to the PRECEDING token.
 *
 * Closed set. `ها`/`های`/`هایی` are the plural markers that let a search for
 * «گزارش‌ها» reach «گزارش ها» without a stemmer; `تر`/`ترین` the comparatives;
 * `ام`…`شان` the possessives. Exact token match, never prefix match, so ordering
 * within the set is irrelevant.
 */
const ENCLITICS: ReadonlySet<string> = new Set([
  '\u0647\u0627', // ها
  '\u0647\u0627\u06CC', // های
  '\u0647\u0627\u06CC\u06CC', // هایی
  '\u062A\u0631', // تر
  '\u062A\u0631\u06CC\u0646', // ترین
  '\u0627\u0645', // ام
  '\u0627\u062A', // ات
  '\u0627\u0634', // اش
  '\u0645\u0627\u0646', // مان
  '\u062A\u0627\u0646', // تان
  '\u0634\u0627\u0646', // شان
]);

/** True for a token made only of Persian/Arabic-script letters. */
const PERSIAN_TOKEN = /^[\u0600-\u06FF]+$/;

/**
 * Folds one string to its search form.
 *
 * Order is not arbitrary:
 *   1. ligatures expand first, so their constituent letters can then be folded;
 *   2. letters and digits fold;
 *   3. diacritics and invisibles are deleted — ZWNJ deletion happens HERE, before
 *      tokenization, which is what joins `می‌توانم` into a single token;
 *   4. punctuation becomes space, so it splits tokens instead of merging them;
 *   5. whitespace collapses, the string is tokenized and the closed-set affixes are
 *      attached;
 *   6. lowercasing handles the Latin content that shares these fields.
 *
 * Returns a single-space-joined, trimmed string. Empty/blank input yields `''`.
 */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return '';

  let text = input;

  for (const [pattern, replacement] of LIGATURES) {
    text = text.replace(pattern, replacement);
  }

  // Single pass over code points for the folding map: clearer and cheaper than a
  // chain of ~35 `replace` calls, and it cannot be defeated by overlapping patterns.
  let folded = '';
  for (const char of text) {
    folded += FOLD_MAP.get(char) ?? char;
  }

  folded = folded
    .replace(DIACRITICS, '')
    .replace(INVISIBLE, '')
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE, ' ')
    .trim()
    .toLowerCase();

  if (!folded) return '';

  return attachAffixes(folded.split(' '));
}

/**
 * Applies the closed-set proclitic/enclitic attachment to an already-folded token
 * list. Separated from `normalizeSearchText` so the rule is unit-testable on its own
 * and so the ordering guarantee above stays visible in one place.
 *
 * A proclitic attaches forward, an enclitic attaches backward, and both only ever
 * attach to a Persian-script token — `می test` stays two tokens, because joining a
 * Persian verbal prefix to a Latin word is never the intent.
 */
function attachAffixes(tokens: readonly string[]): string {
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    // Enclitic: fold into whatever was already emitted.
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      ENCLITICS.has(token) &&
      PERSIAN_TOKEN.test(previous) &&
      // `می ها` must not become the bare proclitic joined to a suffix.
      !PROCLITICS.has(previous)
    ) {
      out[out.length - 1] = previous + token;
      continue;
    }

    // Proclitic: consume the next token, if there is a Persian one to consume.
    const next = tokens[i + 1];
    if (PROCLITICS.has(token) && next !== undefined && PERSIAN_TOKEN.test(next)) {
      out.push(token + next);
      i += 1;
      continue;
    }

    out.push(token);
  }

  return out.join(' ');
}

/**
 * Normalization for the STORED projection. Identical to `normalizeForQuery` by
 * construction — both names refer to this one function, so the two paths cannot
 * drift apart.
 */
export const normalizeForIndex = normalizeSearchText;

/**
 * Normalization for an incoming query string. Identical to `normalizeForIndex` by
 * construction — both names refer to this one function.
 */
export const normalizeForQuery = normalizeSearchText;

/**
 * Joins the searchable fields of one source row into the text that will be
 * normalized and indexed.
 *
 * Nulls and blanks are dropped rather than becoming `'null'` or empty tokens, and
 * the parts are space-separated so a title's last word and a body's first word never
 * merge into a token present in neither.
 *
 * Callers pass ONLY allowlisted, non-secret fields. This helper cannot enforce that;
 * the indexer's per-source projections are where that decision is made and
 * documented.
 */
export function buildSearchText(parts: ReadonlyArray<string | null | undefined>): string {
  return normalizeSearchText(parts.filter((part) => Boolean(part && part.trim())).join(' '));
}

/**
 * The distinct normalized tokens of a string, longest-first.
 *
 * Used by the snippet builder to locate matches without a second round-trip to
 * Postgres. `ts_headline` is deliberately not used: it would re-tokenize the
 * ORIGINAL text, which is not what is indexed, so its offsets can disagree with the
 * match that actually happened.
 */
export function normalizedTokens(input: string | null | undefined): string[] {
  const normalized = normalizeSearchText(input);
  if (!normalized) return [];
  return [...new Set(normalized.split(' '))].filter(Boolean).sort((a, b) => b.length - a.length);
}
