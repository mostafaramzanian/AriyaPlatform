import xss from 'xss';
import { slugify } from './slug.util';

const MULTI_SPACE = /\s+/g;

export function normalizeText(value: string): string {
  const normalized = value.normalize('NFKC');
  const cleaned = Array.from(normalized)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');

  return cleaned.replace(/\r\n?/g, '\n').trim();
}

export function sanitizeText(value: string): string {
  const normalized = normalizeText(value);
  const safe = xss(normalized, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script'],
  });
  return safe.replace(MULTI_SPACE, ' ').trim();
}

export function sanitizeMarkdown(value: string): string {
  const normalized = normalizeText(value);
  const safe = xss(normalized, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script'],
  });
  return safe.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

export function normalizeSlug(value: string): string {
  return slugify(sanitizeText(value).toLowerCase());
}
