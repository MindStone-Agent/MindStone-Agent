/**
 * Credentials that are easy to recognise, masked before chat text goes into
 * the recall index (#106 review): a key the owner pastes into one chat is not
 * recalled into the next. Textual heuristics, not a guarantee; a secret with
 * no recognisable shape (a passphrase) is not caught here.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export const REDACTED_SECRET = "[redacted secret]";

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED_SECRET), text);
}
