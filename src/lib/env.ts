/**
 * Environment config. The Indeed transport is browser-only: there is no API
 * key to hold, so config is just the state-dir resolution plus redaction
 * helpers shared by every error path.
 */

export interface IndeedConfig {
  /** Browser-transport state directory (profile, daemon state, runs). */
  stateDir: string;
}

/** Redact anything that looks like a bearer credential from error text. */
export function redact(text: string, secret?: string): string {
  let out = text.replace(/\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/g, "Bearer ***");
  out = out.replace(/\bAuthorization:[^\s]*/gi, "Authorization: ***");
  if (secret && secret.length >= 4) {
    out = out.split(secret).join("***");
  }
  return out;
}

export function resolveConfig(stateDir: string): IndeedConfig {
  return { stateDir };
}
