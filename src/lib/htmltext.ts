/**
 * Minimal HTML-to-text for Indeed application previews: drop styles,
 * scripts, tags, and entities; collapse whitespace. The output is the
 * scoring substrate (plain text in the packet, no HTML parsing at score
 * time).
 */

const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const ANY_TAG = /<[^>]+>/g;

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
  [/&apos;/gi, "'"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&middot;/gi, "·"],
];

export function htmlToText(html: string): string {
  let text = html.replace(STYLE_BLOCK, " ").replace(SCRIPT_BLOCK, " ").replace(ANY_TAG, " ");
  for (const [pattern, replacement] of ENTITIES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim();
}
