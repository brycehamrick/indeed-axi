import { parseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";
function buildOptions(commandPath, flags) {
    const options = {};
    for (const [name, def] of Object.entries(flags)) {
        if (def.short && name.length === 1) {
            throw new Error(`internal: long flag ${name} must not be single-char`);
        }
        if (def.short) {
            if (flags[def.short]) {
                throw new Error(`internal: short flag -${def.short} collides with --${def.short}`);
            }
            const short = { type: def.type };
            if (def.multiple)
                short.multiple = true;
            options[def.short] = short;
        }
        const option = { type: def.type };
        if (def.multiple)
            option.multiple = true;
        options[name] = option;
    }
    return options;
}
export function parseFlags(argv, commandPath, flags) {
    try {
        const parsed = parseArgs({
            args: argv,
            options: buildOptions(commandPath, flags),
            strict: true,
            allowPositionals: true,
        });
        const values = {};
        for (const [key, value] of Object.entries(parsed.values)) {
            values[key] = value;
        }
        return { values, positionals: parsed.positionals };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unknown option") ||
            codeOf(error) === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ||
            codeOf(error) === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
            const valid = Object.entries(flags)
                .map(([name, def]) => (def.type === "boolean" ? `--${name}` : `--${name} <${name}>`))
                .sort()
                .join(", ");
            throw new AxiError(`${commandPath}: ${message}`, "VALIDATION_ERROR", [`Valid flags for ${commandPath}: ${valid || "(none)"}`]);
        }
        throw new AxiError(`${commandPath}: ${message}`, "VALIDATION_ERROR");
    }
}
function codeOf(error) {
    if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}
export function requireString(values, name, commandPath) {
    const value = values[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new AxiError(`--${name} requires a non-empty value`, "VALIDATION_ERROR", [
            `Run \`${commandPath} --help\` for usage`,
        ]);
    }
    return value.trim();
}
/** Like requireString, but the flag must be present. */
export function requiredString(values, name, commandPath) {
    const value = requireString(values, name, commandPath);
    if (value === undefined) {
        throw new AxiError(`--${name} is required`, "VALIDATION_ERROR", [
            `Run \`${commandPath} --help\` for usage`,
        ]);
    }
    return value;
}
export function optionalInt(values, name, opts) {
    const value = values[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
        throw new AxiError(`--${name} requires an integer, got: ${value}`, "VALIDATION_ERROR");
    }
    const n = Number(value.trim());
    if (n < opts.min || n > opts.max) {
        throw new AxiError(`--${name} must be between ${opts.min} and ${opts.max}, got: ${n}`, "VALIDATION_ERROR");
    }
    return n;
}
export function oneOf(values, name, allowed) {
    const value = values[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new AxiError(`--${name} must be one of: ${allowed.join(", ")} (got: ${value})`, "VALIDATION_ERROR");
    }
    return value;
}
export function splitCsv(value) {
    if (value === undefined)
        return [];
    const parts = Array.isArray(value) ? value : [value];
    return parts
        .flatMap((part) => part.split(","))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
export function requireHttpUrl(raw, label) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new AxiError(`${label} must be a valid http(s) URL, got: ${raw}`, "VALIDATION_ERROR");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new AxiError(`${label} must use http or https, got protocol ${parsed.protocol}`, "VALIDATION_ERROR");
    }
    return parsed.toString();
}
export function requirePositional(positionals, index, label, commandPath) {
    const value = positionals[index];
    if (value === undefined || value.trim().length === 0) {
        throw new AxiError(`${commandPath}: missing <${label}>`, "VALIDATION_ERROR", [
            `Run \`${commandPath} --help\` for usage`,
        ]);
    }
    return value.trim();
}
export function forbidExtraPositionals(positionals, expected, commandPath) {
    if (positionals.length > expected) {
        throw new AxiError(`${commandPath}: unexpected argument${positionals.length - expected > 1 ? "s" : ""}: ${positionals.slice(expected).join(" ")}`, "VALIDATION_ERROR", [`Run \`${commandPath} --help\` for usage`]);
    }
}
/** Gate mutations behind an explicit --confirm (single invocation, no memory). */
export function requireConfirm(values, commandPath, preview) {
    if (values["confirm"] !== true) {
        throw new AxiError(`${commandPath} requires --confirm to proceed`, "VALIDATION_ERROR", [`Would ${preview}`, `Rerun with --confirm to apply`]);
    }
}
export function parseJsonFlag(values, name) {
    const value = values[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string") {
        throw new AxiError(`--${name} requires a JSON string`, "VALIDATION_ERROR");
    }
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not an object");
        }
        return parsed;
    }
    catch {
        throw new AxiError(`--${name} must be a valid JSON object, got: ${value.slice(0, 120)}`, "VALIDATION_ERROR");
    }
}
