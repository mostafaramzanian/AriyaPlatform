import { sanitizeLetterBody, letterBodyToText, letterWordCount } from './correspondence-sanitize.util';

/**
 * Phase 50: the rich-text boundary is the XSS boundary for the whole module. Every
 * test here pins an allowlist decision the service depends on; there is no code path
 * that stores a letter body without passing through `sanitizeLetterBody`.
 */
describe('sanitizeLetterBody', () => {
  it('keeps the allowlisted editorial structure the editor produces', () => {
    const input =
      '<h2 style="text-align: right;">موضوع</h2><p style="text-align: justify;">متن نامه</p><ul><li><strong>مهم</strong></li><li><em>فوری</em></li></ul><p><a href="https://example.ir" target="_blank" rel="noopener">پیوند</a></p>';
    const output = sanitizeLetterBody(input);

    expect(output).toContain('<h2');
    expect(output).toContain('<p');
    expect(output).toContain('<ul>');
    expect(output).toContain('<strong>');
    expect(output).toContain('href="https://example.ir"');
    expect(output).toContain('text-align');
  });

  it('strips script tags AND their bodies', () => {
    const output = sanitizeLetterBody('<p>سلام</p><script>alert(1)</script>');
    expect(output).not.toContain('script');
    expect(output).not.toContain('alert');
    expect(output).toContain('سلام');
  });

  it('strips event handlers everywhere', () => {
    const output = sanitizeLetterBody('<p onmouseover="steal()">متن</p><img src="https://x.ir/i.png" onerror="x()">');
    expect(output).not.toContain('onmouseover');
    expect(output).not.toContain('onerror');
  });

  it('refuses javascript: URLs on links and images', () => {
    const output = sanitizeLetterBody('<a href="javascript:alert(1)">کلیک</a><img src="javascript:alert(2)">');
    expect(output).not.toContain('javascript:');
  });

  it('strips iframe / object / embed and their bodies', () => {
    const output = sanitizeLetterBody('<iframe src="https://evil.example"></iframe><p>متن</p>');
    expect(output).not.toContain('iframe');
    expect(output).toContain('متن');
  });

  it('keeps ONLY safe text-align declarations in style attributes', () => {
    const kept = sanitizeLetterBody('<p style="text-align: right;">راست</p>');
    expect(kept).toContain('text-align');

    const dropped = sanitizeLetterBody('<p style="position:fixed;top:0;left:0;width:100%">تزریق</p>');
    expect(dropped).not.toContain('position');
    expect(dropped).not.toContain('fixed');
  });

  it('drops style on non-alignable tags entirely', () => {
    const output = sanitizeLetterBody('<strong style="text-align:right">مهم</strong>');
    expect(output).not.toContain('style');
  });

  it('strips unknown tags while keeping their text content', () => {
    const output = sanitizeLetterBody('<section><p>داخل</p></section>');
    expect(output).not.toContain('section');
    expect(output).toContain('داخل');
  });

  it('normalizes NFKC (﷼ ligature folds to ریال) and trims', () => {
    const output = sanitizeLetterBody('  ﷼  متن  ');
    expect(output.startsWith('ریال')).toBe(true);
    expect(output.endsWith('متن')).toBe(true);
  });

  it('handles empty and null-ish input safely', () => {
    expect(sanitizeLetterBody('')).toBe('');
    expect(sanitizeLetterBody('   ')).toBe('');
  });

  it('survives deeply nested attack payloads without throwing', () => {
    const payload = '<div>'.repeat(50) + '<script>x</script>' + '</div>'.repeat(50);
    expect(() => sanitizeLetterBody(payload)).not.toThrow();
    expect(sanitizeLetterBody(payload)).not.toContain('script');
  });
});

describe('letterBodyToText / letterWordCount', () => {
  it('projects plaintext without any markup', () => {
    const text = letterBodyToText('<h2>عنوان</h2><p>متن نامه</p>');
    expect(text).not.toContain('<');
    expect(text).toContain('عنوان');
    expect(text).toContain('متن');
  });

  it('counts words over the plaintext projection', () => {
    expect(letterWordCount('<p>یک دو سه</p>')).toBe(3);
    expect(letterWordCount('')).toBe(0);
    expect(letterWordCount('<p></p>')).toBe(0);
  });
});