export function calculateReadingTime(content: string, wpm = 200): number {
  const words = (content || '').trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / wpm));
}
