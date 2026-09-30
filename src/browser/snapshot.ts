/**
 * Ref-based snapshots for agent-driven browsing (the playwright-axi loop,
 * bound to the authenticated Indeed session).
 *
 * SNAPSHOT_SOURCE runs inside the page: it strips previous ref attributes,
 * numbers every visible interactive element as [ref=eN] via a
 * data-ia-ref attribute, and returns a compact DOM outline. Click/fill
 * targets resolve to `[data-ia-ref="eN"]` locators - public Playwright API
 * only, no undocumented internals. Refs are valid until the next snapshot
 * or navigation; stale refs fail loudly as STALE_REF.
 *
 * Pure helpers (clipLines, filterLines, parseTarget) live here too so they
 * are unit-testable without a browser.
 */

export interface PageSnapshot {
  url: string;
  title: string;
  lines: string[];
  refs: number;
}

export const SNAPSHOT_MAX_LINES = 2000;
export const DEFAULT_LINE_LIMIT = 400;

/**
 * Executed via page.evaluate as an expression. Must be self-contained
 * (no closure over module scope) and idempotent.
 */
export const SNAPSHOT_SOURCE = `(() => {
  const MAX_LINE = 240;
  document.querySelectorAll('[data-ia-ref]').forEach((el) => el.removeAttribute('data-ia-ref'));
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const inViewport = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  };
  const INTERACTIVE =
    'a, button, input, select, textarea, summary, [contenteditable="true"], label, option, [onclick], [role]:not([role="presentation"]):not([role="none"])';
  const ownText = (el) => {
    let text = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
    }
    return text.replace(/\\s+/g, ' ').trim();
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim();
    }
    const own = ownText(el);
    if (own) return own;
    const labelFor = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
    if (labelFor) return ownText(labelFor) || '';
    return '';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const map = {
      a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
      summary: 'summary', option: 'option', img: 'image', label: 'label',
    };
    if (map[tag]) return map[tag];
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };
  const stateOf = (el) => {
    const parts = [];
    if (el.disabled) parts.push('disabled');
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'button' && type !== 'submit') parts.push(type);
      if (el.checked) parts.push('checked');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const value = el.value;
      if (typeof value === 'string' && value) parts.push('value="' + value.slice(0, 80) + '"');
    }
    if (el.getAttribute('aria-expanded')) parts.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    return parts.join(' ');
  };
  const depthOf = (el) => {
    let depth = 0;
    let parent = el.parentElement;
    while (parent && parent !== document.body) { depth++; parent = parent.parentElement; }
    return depth;
  };
  const lines = [];
  let refs = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    const el = node;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const interactive = el.matches(INTERACTIVE);
    const heading = /^h[1-6]$/.test(tag) || el.getAttribute('role') === 'heading';
    const image = tag === 'img';
    const textBlock = tag === 'p' || tag === 'li' || tag === 'td' || tag === 'th';
    if (!interactive && !heading && !image && !textBlock) continue;
    const name = nameOf(el);
    if (!name && !interactive) continue;
    let ref = null;
    let offscreen = false;
    if (interactive) {
      if (inViewport(el)) {
        refs++;
        ref = 'e' + refs;
        el.setAttribute('data-ia-ref', ref);
      } else {
        // Ghost element (off-canvas clone, hidden drawer, below-the-fold):
        // keep it in the outline for context, but never make it clickable.
        offscreen = true;
      }
    }
    const indent = '  '.repeat(Math.min(depthOf(el), 12));
    const bits = [indent + '-', roleOf(el)];
    if (name) bits.push(JSON.stringify(name.slice(0, 120)));
    const state = stateOf(el);
    if (state) bits.push('(' + state + ')');
    if (offscreen) bits.push('(offscreen)');
    if (ref) bits.push('[ref=' + ref + ']');
    const line = bits.join(' ').slice(0, MAX_LINE);
    lines.push(line);
    if (lines.length >= ${SNAPSHOT_MAX_LINES}) break;
  }
  return { url: location.href, title: document.title, lines, refs };
})()`;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

export interface ClippedLines {
  shown: string[];
  truncated: boolean;
  total: number;
}

/** Clip outline lines to a budget with an aggregate hint (AXI principle 3). */
export function clipLines(lines: string[], limit: number): ClippedLines {
  if (lines.length <= limit) {
    return { shown: lines, truncated: false, total: lines.length };
  }
  return { shown: lines.slice(0, limit), truncated: true, total: lines.length };
}

/**
 * Filter outline lines: a line matches when every whitespace-separated
 * term appears (case-insensitive). Matching lines keep `context` lines of
 * surrounding outline for orientation.
 */
export function filterLines(
  lines: string[],
  terms: string[],
  context = 2,
): { lines: string[]; matches: number } {
  const tokens = terms
    .flatMap((term) => term.split(/\s+/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return { lines, matches: lines.length };
  const lower = lines.map((line) => line.toLowerCase());
  const keep = new Set<number>();
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    const hit = tokens.every((token) => lower[i]?.includes(token));
    if (hit) {
      matches++;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
        keep.add(j);
      }
    }
  }
  const out = lines.filter((_, i) => keep.has(i));
  return { lines: out, matches };
}

export type SnapshotTarget = { kind: "ref" | "selector"; selector: string };

/**
 * Resolve a click/fill target: `eN` (from a snapshot) becomes a
 * data-ia-ref attribute selector; anything else is treated as a Playwright
 * selector escape hatch.
 */
export function parseTarget(raw: string): SnapshotTarget {
  const trimmed = raw.trim();
  if (/^e\d+$/.test(trimmed)) {
    return { kind: "ref", selector: `[data-ia-ref="${trimmed}"]` };
  }
  return { kind: "selector", selector: trimmed };
}

/** Best-effort key-name validation for `browser press`. */
export function isValidKey(key: string): boolean {
  return /^[A-Za-z0-9]$/i.test(key) || /^[a-zA-Z]+(\+[a-zA-Z0-9]+)*$/.test(key);
}
