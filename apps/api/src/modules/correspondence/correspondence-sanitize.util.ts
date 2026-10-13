/**
 * Phase 50: the correspondence rich-text boundary.
 *
 * The letter body is RICH TEXT — headings, alignment, lists, links — produced by the
 * client's editor. It is therefore untrusted input, and the ONLY thing ever stored in
 * `Letter.bodyHtml` is the output of this module: an allowlist sanitizer built on the
 * `xss` package the repository already depends on (the CMS sanitizer uses it with an
 * EMPTY allowlist — it strips every tag, which would destroy a letter body).
 *
 * The contract, pinned by the unit spec:
 *  - allowlist, never denylist: any tag outside the set is dropped, and
 *    script/style BODIES are removed outright (never escaped into visible text);
 *  - event handlers never survive;
 *  - href/src accept only http/https (the `xss` safeAttrValue default), so
 *    `javascript:` URIs cannot enter a letter;
 *  - `style` survives ONLY as a `text-align: left|right|center|justify` on the
 *    alignment-bearing tags, because that is the one declaration the editor's
 *    alignment buttons legitimately produce;
 *  - list structure is preserved (`ul`/`ol`/`li`) so the letter renders as written.
 */

import xss from 'xss';

/** Tags a letter body may contain. Everything else is dropped. */
const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'br',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'img',
]);

/**
 * Tags whose `style` attribute may survive. The editor only ever emits
 * `text-align: …` on these.
 */
const ALIGNABLE_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'li']);

/** The one declaration that survives, and only with those four values. */
const SAFE_TEXT_ALIGN = /^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i;

/** `xss` whiteList shape: tag -> allowed attribute names. */
function buildWhitelist(): Record<string, string[]> {
  const whitelist: Record<string, string[]> = {};
  for (const tag of ALLOWED_TAGS) {
    const attrs: string[] = [];
    if (tag === 'a') attrs.push('href', 'target', 'rel');
    if (tag === 'img') attrs.push('src', 'alt');
    if (ALIGNABLE_TAGS.has(tag)) attrs.push('style');
    whitelist[tag] = attrs;
  }
  return whitelist;
}

/**
 * Sanitizes a client-provided letter body into storage-safe rich text. Runs on
 * EVERY create/update — there is no code path that stores raw HTML.
 */
export function sanitizeLetterBody(input: string): string {
  const normalized = (input ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .trim();

  return xss(normalized, {
    whiteList: buildWhitelist(),
    stripIgnoreTag: true,
    // Script/style BODIES are removed outright, never escaped into visible text.
    stripIgnoreTagBody: ['script', 'style'],
    onTagAttr: (tag, name, value, isWhiteAttr) => {
      if (name === 'style') {
        if (ALIGNABLE_TAGS.has(tag) && SAFE_TEXT_ALIGN.test(value)) {
          // Re-emit the validated declaration; the value is character-restricted by
          // the regex above (only the words left/right/center/justify can match).
          return `style="text-align: ${value.toLowerCase().replace(/[^a-z]/g, '').replace('textalign', '')};"`;
        }
        // Any other style on any tag is dropped outright.
        return '';
      }
      // Let xss's own safe handling apply to allowlisted attributes (href/src).
      return isWhiteAttr ? undefined as unknown as string : '';
    },
  }).trim();
}

/**
 * Plaintext projection for search and word counting: every tag removed, entities
 * collapsed. Never used for rendering.
 */
export function letterBodyToText(bodyHtml: string): string {
  return xss(bodyHtml ?? '', {
    whiteList: {},
    stripIgnoreTag: true,
    // Array form: drop every non-allowlisted tag AND remove its body (the boolean
    // form is not part of the xss contract).
    stripIgnoreTagBody: ['script', 'style'],
  })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word count over the plaintext projection (the editor's live indicator). */
export function letterWordCount(bodyHtml: string): number {
  const text = letterBodyToText(bodyHtml);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}