import { calculateReadingTime } from './reading-time.util';

describe('calculateReadingTime', () => {
  it('calculates reading time for short text', () => {
    const text = 'This is a short text with ten words only.';
    const minutes = calculateReadingTime(text, 200);
    expect(minutes).toBeGreaterThanOrEqual(1);
  });

  it('scales with word count', () => {
    const words = new Array(1000).fill('word').join(' ');
    const minutes = calculateReadingTime(words, 200);
    expect(minutes).toBe(5);
  });
});
