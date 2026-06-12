/**
 * Production-safe error message sanitiser.
 * Converts raw Error objects into short, user-friendly strings.
 * Strips technical noise (HTML, stack traces, cryptic JS errors).
 */

const TECHNICAL_PATTERNS = [
  /<!DOCTYPE/i,
  /Unexpected token/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /\bat position \d+/i,
  /JSON\.parse/i,
  /Cannot read prop/i,
  /is not a function/i,
  /undefined is not/i,
  /null is not/i,
  /fetch is not/i,
  /API route not found/i,
  /non-JSON/i,
  /status \d{3}$/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  // SQL / database errors — must never be shown to users
  /foreign key constraint/i,
  /insert or update on table/i,
  /violates.*constraint/i,
  /duplicate key value/i,
  /relation .* does not exist/i,
  /column .* does not exist/i,
  /syntax error at or near/i,
  /ERROR:\s+\w/i,
];

export function safeErrorMsg(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (typeof err === 'string') {
    const t = err.trim();
    if (!t || t.length > 160 || TECHNICAL_PATTERNS.some((p) => p.test(t))) return fallback;
    return t;
  }
  if (err instanceof Error) {
    const msg = err.message.trim();
    if (!msg || msg.length > 160 || TECHNICAL_PATTERNS.some((p) => p.test(msg))) return fallback;
    return msg;
  }
  return fallback;
}
