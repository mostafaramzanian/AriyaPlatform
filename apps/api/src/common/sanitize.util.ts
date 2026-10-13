/**
 * HTML sanitization utility
 * Escapes potentially harmful HTML characters
 */
export function escapeHtml(text: string): string {
  if (!text) return text;
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Sanitize user input for database storage.
 * Escapes HTML entities but preserves alphanumeric and common characters.
 *
 * `unknown` in, `unknown` out — the shape is discovered at runtime, and
 * callers narrow the result themselves.
 */
export function sanitizeInput(input: unknown): unknown {
  if (typeof input === 'string') {
    return escapeHtml(input);
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  }
  if (input !== null && typeof input === 'object') {
    // The walk only holds records here (non-array object), the same single
    // structural assertion the audit redactor makes for its containers.
    const record = input as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const key in record) {
      sanitized[key] = sanitizeInput(record[key]);
    }
    return sanitized;
  }
  return input;
}
