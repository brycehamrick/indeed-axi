import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SECRET_KEY = /cookie|token|authorization|secret|password|session|csrf|api[-_]?key|bearer/i;
const INLINE_BODY_LIMIT = 4096;
const INDEED_HOST = /(^|\.)indeed\.com$/i;
export function shouldCaptureUrl(raw) {
    try {
        const url = new URL(raw);
        return INDEED_HOST.test(url.hostname);
    }
    catch {
        return false;
    }
}
export function shouldCaptureExchange(method, resourceType, contentType) {
    if (method.toUpperCase() !== "GET")
        return true;
    if (contentType !== undefined && /json/i.test(contentType))
        return true;
    return resourceType === "xhr" || resourceType === "fetch";
}
/** Deep-redact credential-shaped keys from parsed JSON; passthrough non-JSON. */
export function redactJsonText(text) {
    try {
        const parsed = JSON.parse(text);
        const redacted = redactValue(parsed);
        return JSON.stringify(redacted, null, 2);
    }
    catch {
        return text;
    }
}
export function redactValue(value) {
    if (Array.isArray(value))
        return value.map(redactValue);
    if (typeof value === "object" && value !== null) {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            out[key] = SECRET_KEY.test(key)
                ? typeof child === "string"
                    ? "***redacted***"
                    : redactSentinel(child)
                : redactValue(child);
        }
        return out;
    }
    return value;
}
function redactSentinel(value) {
    if (value === null || value === undefined)
        return value;
    return "***redacted***";
}
export function slugifyUrl(raw) {
    try {
        const url = new URL(raw);
        const slug = `${url.hostname}${url.pathname}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80);
        return slug.length > 0 ? slug : "document";
    }
    catch {
        return "document";
    }
}
export function createRecorder(opts = {}) {
    const minBodyBytes = opts.minBodyBytes ?? 512;
    const redact = opts.redact ?? redactJsonText;
    const exchanges = [];
    const pending = new Set();
    const attached = new WeakSet();
    let nextIndex = 0;
    function record(response) {
        const promise = (async () => {
            let index = -1;
            try {
                const request = response.request();
                const url = response.url();
                if (!shouldCaptureUrl(url))
                    return;
                const method = request.method();
                const resourceType = request.resourceType();
                const responseContentType = response.headers()["content-type"];
                if (!shouldCaptureExchange(method, resourceType, responseContentType))
                    return;
                index = nextIndex++;
                const exchange = {
                    index,
                    url,
                    method,
                    status: response.status(),
                    resourceType,
                };
                exchanges.push(exchange);
                const requestContentType = request.headers()["content-type"];
                if (requestContentType)
                    exchange.requestContentType = requestContentType;
                if (responseContentType)
                    exchange.responseContentType = responseContentType;
                const post = request.postData();
                if (post !== null &&
                    post.length > 0 &&
                    requestContentType !== undefined &&
                    /json/i.test(requestContentType)) {
                    exchange.requestBody = redact(post);
                }
                if (responseContentType !== undefined && /json/i.test(responseContentType)) {
                    const body = await response.body();
                    exchange.responseBytes = body.byteLength;
                    if (body.byteLength >= minBodyBytes && opts.documentsDir) {
                        const name = `${String(index).padStart(3, "0")}-${slugifyUrl(url)}.json`;
                        mkdirSync(opts.documentsDir, { recursive: true });
                        writeFileSync(join(opts.documentsDir, name), `${redact(body.toString("utf8"))}\n`, "utf8");
                        exchange.savedTo = `documents/${name}`;
                    }
                    else if (body.byteLength <= INLINE_BODY_LIMIT) {
                        exchange.responseBody = redact(body.toString("utf8"));
                    }
                }
            }
            catch (error) {
                if (index >= 0) {
                    const exchange = exchanges.find((item) => item.index === index);
                    if (exchange)
                        exchange.error = error instanceof Error ? error.message : String(error);
                }
            }
        })();
        pending.add(promise);
        promise.finally(() => pending.delete(promise)).catch(() => undefined);
    }
    function onPage(page) {
        if (attached.has(page))
            return;
        attached.add(page);
        page.on("response", (response) => {
            record(response);
        });
    }
    return {
        exchanges,
        attach(page) {
            onPage(page);
        },
        attachContext(context) {
            for (const page of context.pages())
                onPage(page);
            context.on("page", (page) => onPage(page));
        },
        async finish() {
            while (pending.size > 0) {
                await Promise.all([...pending]);
            }
        },
    };
}
