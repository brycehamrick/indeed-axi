import { AxiError } from "axi-sdk-js";
import { redact } from "./env.js";

/** Redacted error message for inline status reporting (home view, auth status). */
export function errorMessage(error: unknown, secret?: string): string {
  const message =
    error instanceof AxiError
      ? `${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  const code = error instanceof AxiError ? ` [${error.code}]` : "";
  return redact(`${message}${code}`.replace(/\s+/g, " "), secret);
}
