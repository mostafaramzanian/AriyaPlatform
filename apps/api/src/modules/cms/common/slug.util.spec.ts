import { slugify } from './slug.util';

describe('slugify', () => {
  it('converts title to slug', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('removes special chars and collapses spaces', () => {
    expect(slugify('  ACME:  Best -- Practices ')).toBe('acme-best-practices');
  });

  it('handles non-ascii characters', () => {
    expect(slugify('Café à la mode')).toBe('cafe-a-la-mode');
  });
});
