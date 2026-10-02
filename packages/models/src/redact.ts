const MASK = '***';

// Credential shapes that may appear even when we don't hold the value (echoed by a proxy, etc.).
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  [/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&#\s"']+/gi, `$1${MASK}`],
  [/("?(?:x-api-key|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi, `$1${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
];

/**
 * Removes known secret values and credential-looking substrings. Applied to every message, URL and
 * header that may reach a log or a user-visible error.
 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    // Very short values would mangle unrelated text; real keys are never this short.
    if (secret.length >= 6) out = out.split(secret).join(MASK);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Header names whose values are never logged. */
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'proxy-authorization']);

export function redactHeaders(
  headers: Record<string, string>,
  secrets: Iterable<string> = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? MASK : redact(value, secrets);
  }
  return out;
}
