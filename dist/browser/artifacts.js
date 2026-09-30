import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function createRunDir(stateDir, kind, now = () => new Date()) {
    const date = now();
    const stamp = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("");
    const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join("");
    const rand = Math.random().toString(16).slice(2, 6);
    const id = `${kind}-${stamp}-${time}-${rand}`;
    const dir = join(stateDir, "runs", id);
    mkdirSync(dir, { recursive: true });
    return { dir, id };
}
export function writeText(path, text) {
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const SCRIPT_OPEN = /<script\b[^>]*\/?>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/**
 * Sanitize a DOM snapshot: drop script contents and HTML comments so no
 * inline credentials or bundle noise ends up in artifacts.
 */
export function sanitizeHtml(html) {
    return html.replace(SCRIPT_BLOCK, "").replace(HTML_COMMENT, "").replace(SCRIPT_OPEN, "");
}
