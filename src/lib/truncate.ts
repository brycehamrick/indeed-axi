/**
 * AXI principle 3: truncate large text with a size hint and a --full escape
 * hatch. Singleton outputs carry the hint inline; list outputs set
 * `truncated: true` so callers can emit one aggregate hint line instead of
 * per-row noise.
 */

export interface TruncatedText {
  value: string;
  truncated: boolean;
  totalChars: number;
}

export function truncateText(text: string, limit: number): TruncatedText {
  if (text.length <= limit) {
    return { value: text, truncated: false, totalChars: text.length };
  }
  const cut = Array.from(text).slice(0, limit).join("");
  return {
    value: `${cut}\u2026(truncated, ${text.length} chars total \u2014 use --full)`,
    truncated: true,
    totalChars: text.length,
  };
}

/** Compact single-line snippet for list rows: ellipsis only, no inline hint. */
export function snippet(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${Array.from(flat).slice(0, limit).join("")}\u2026`;
}

export function truncationHint(fieldsTruncated: number, commandPath: string): string[] {
  if (fieldsTruncated === 0) return [];
  return [
    `${fieldsTruncated} field${fieldsTruncated > 1 ? "s" : ""} truncated \u2014 rerun with --full for complete text`,
  ];
}
