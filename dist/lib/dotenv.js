import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Minimal .env loader: KEY=VALUE lines from a .env file in the working
 * directory. Real environment variables always win. Values are never
 * logged. Keeps the CLI free of a dotenv dependency.
 */
export function parseDotEnv(text) {
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#"))
            continue;
        const stripped = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
        const eq = stripped.indexOf("=");
        if (eq <= 0)
            continue;
        const key = stripped.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        let value = stripped.slice(eq + 1).trim();
        const quoted = (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
        if (quoted) {
            value = value.slice(1, -1);
        }
        else {
            const hash = value.indexOf(" #");
            if (hash !== -1)
                value = value.slice(0, hash).trim();
        }
        out[key] = value;
    }
    return out;
}
export function loadDotEnv(cwd = process.cwd()) {
    const path = join(cwd, ".env");
    try {
        if (!existsSync(path))
            return {};
        return parseDotEnv(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
/** Real env wins over .env; nothing is logged. */
export function mergeEnv(dotEnv, env) {
    const fromFile = {};
    for (const [key, value] of Object.entries(dotEnv)) {
        if (!(key in env))
            fromFile[key] = value;
    }
    return { ...fromFile, ...env };
}
