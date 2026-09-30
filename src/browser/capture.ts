import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page, Response } from "playwright-core";

/**
 * Network capture for discovery: record the Indeed XHR/JSON exchanges the
 * employer dashboard itself performs - including candidate/message document
 * bodies - while redacting credential-shaped keys.
 *
 * Never recorded: request/response headers, cookies, or non-Indeed hosts.
 */

export interface CapturedExchange {
  index: number;
  url: string;
  method: string;
  status: number;
  resourceType?: string;
  requestContentType?: string;
  /** Redacted JSON request body (POSTs only). */
  requestBody?: string;
  responseContentType?: string;
  responseBytes?: number;
  /** Inline when small; otherwise written to documents/ and referenced. */
  responseBody?: string;
  savedTo?: string;
  error?: string;
}

const SECRET_KEY = /cookie|token|authorization|secret|password|session|csrf|api[-_]?key|bearer/i;
const INLINE_BODY_LIMIT = 4096;
const INDEED_HOST = /(^|\.)indeed\.com$/i;

export function shouldCaptureUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return INDEED_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function shouldCaptureExchange(
  method: string,
  resourceType: string | undefined,
  contentType: string | undefined,
): boolean {
  if (method.toUpperCase() !== "GET") return true;
  if (contentType !== undefined && /json/i.test(contentType)) return true;
  return resourceType === "xhr" || resourceType === "fetch";
}

/** Deep-redact credential-shaped keys from parsed JSON; passthrough non-JSON. */
export function redactJsonText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const redacted = redactValue(parsed);
    return JSON.stringify(redacted, null, 2);
  } catch {
    return text;
  }
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
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

function redactSentinel(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return "***redacted***";
}

export function slugifyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const slug = `${url.hostname}${url.pathname}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug.length > 0 ? slug : "document";
  } catch {
    return "document";
  }
}

export interface RecorderOptions {
  /** Minimum response bytes before a body is written to documents/. */
  minBodyBytes?: number;
  /** Directory for document bodies. */
  documentsDir?: string;
  /** Redaction hook for tests. */
  redact?: (text: string) => string;
}

export interface ExchangeRecorder {
  readonly exchanges: CapturedExchange[];
  attach(page: Page): void;
  /** Attach to every existing and future page of a context (daemon mode). */
  attachContext(context: BrowserContext): void;
  /** Await pending body reads and flush document files. */
  finish(): Promise<void>;
}

interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  request(): {
    method(): string;
    headers(): Record<string, string>;
    postData(): string | null;
    resourceType(): string;
  };
}

export function createRecorder(opts: RecorderOptions = {}): ExchangeRecorder {
  const minBodyBytes = opts.minBodyBytes ?? 512;
  const redact = opts.redact ?? redactJsonText;
  const exchanges: CapturedExchange[] = [];
  const pending = new Set<Promise<void>>();
  const attached = new WeakSet<object>();
  let nextIndex = 0;

  function record(response: ResponseLike): void {
    const promise = (async () => {
      let index = -1;
      try {
        const request = response.request();
        const url = response.url();
        if (!shouldCaptureUrl(url)) return;
        const method = request.method();
        const resourceType = request.resourceType();
        const responseContentType = response.headers()["content-type"];
        if (!shouldCaptureExchange(method, resourceType, responseContentType)) return;

        index = nextIndex++;
        const exchange: CapturedExchange = {
          index,
          url,
          method,
          status: response.status(),
          resourceType,
        };
        exchanges.push(exchange);

        const requestContentType = request.headers()["content-type"];
        if (requestContentType) exchange.requestContentType = requestContentType;
        if (responseContentType) exchange.responseContentType = responseContentType;

        const post = request.postData();
        if (
          post !== null &&
          post.length > 0 &&
          requestContentType !== undefined &&
          /json/i.test(requestContentType)
        ) {
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
          } else if (body.byteLength <= INLINE_BODY_LIMIT) {
            exchange.responseBody = redact(body.toString("utf8"));
          }
        }
      } catch (error) {
        if (index >= 0) {
          const exchange = exchanges.find((item) => item.index === index);
          if (exchange) exchange.error = error instanceof Error ? error.message : String(error);
        }
      }
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => undefined);
  }

  function onPage(page: Page): void {
    if (attached.has(page)) return;
    attached.add(page);
    page.on("response", (response: Response) => {
      record(response as unknown as ResponseLike);
    });
  }

  return {
    exchanges,
    attach(page: Page): void {
      onPage(page);
    },
    attachContext(context: BrowserContext): void {
      for (const page of context.pages()) onPage(page);
      context.on("page", (page) => onPage(page));
    },
    async finish(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
