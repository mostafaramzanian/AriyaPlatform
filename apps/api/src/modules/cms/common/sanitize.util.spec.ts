import { normalizeSlug, sanitizeMarkdown, sanitizeText } from './sanitize.util';

describe('sanitize utilities', () => {
  it('strips script tags and collapses whitespace', () => {
    const value = '  Hello <script>alert(1)</script> world  ';
    expect(sanitizeText(value)).toBe('Hello world');
  });

  it('normalizes markdown content safely', () => {
    const value = '## Title\n\n- item';
    expect(sanitizeMarkdown(value)).toContain('Title');
  });

  it('creates a normalized slug', () => {
    expect(normalizeSlug('Hello   World!')).toBe('hello-world');
  });
});
