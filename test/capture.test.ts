import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import {
  createRecorder,
  redactJsonText,
  shouldCaptureExchange,
  shouldCaptureUrl,
  slugifyUrl,
} from "../src/browser/capture.js";

describe("capture filters", () => {
  it("captures only indeed.com hosts", () => {
    expect(shouldCaptureUrl("https://employers.indeed.com/api/candidates")).toBe(true);
    expect(shouldCaptureUrl("https://secure.indeed.com/api/x")).toBe(true);
    expect(shouldCaptureUrl("https://cdn.segment.com/analytics.js")).toBe(false);
    expect(shouldCaptureUrl("https://evilindeed.com/api")).toBe(false);
  });

  it("captures mutations, JSON, and XHR - skips static GETs", () => {
    expect(shouldCaptureExchange("POST", "xhr", "application/json")).toBe(true);
    expect(shouldCaptureExchange("PUT", undefined, undefined)).toBe(true);
    expect(shouldCaptureExchange("GET", "xhr", undefined)).toBe(true);
    expect(shouldCaptureExchange("GET", "fetch", undefined)).toBe(true);
    expect(shouldCaptureExchange("GET", undefined, "application/json")).toBe(true);
    expect(shouldCaptureExchange("GET", "document", "text/html")).toBe(false);
    expect(shouldCaptureExchange("GET", "script", "application/javascript")).toBe(false);
  });

  it("slugifies urls into document names", () => {
    expect(slugifyUrl("https://employers.indeed.com/api/candidates?job=1")).toContain(
      "employers-indeed-com-api-candidates",
    );
    expect(slugifyUrl("https://employers.indeed.com/")).toContain("employers-indeed-com");
    expect(slugifyUrl("not a url")).toBe("document");
  });
});

describe("redaction", () => {
  it("redacts credential-shaped keys deeply", () => {
    const redacted = redactJsonText(
      JSON.stringify({
        candidate: { name: "Jane Doe", session_token: "abc", phone: "555-0100" },
        csrf: "x",
        messages: [{ id: 1, body: "hello", authorization: "Bearer 123" }],
      }),
    );
    expect(redacted).toContain("Jane Doe");
    expect(redacted).toContain("***redacted***");
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("Bearer 123");
  });

  it("passes non-JSON through untouched", () => {
    expect(redactJsonText("<html>plain</html>")).toBe("<html>plain</html>");
  });
});

describe("recorder", () => {
  it("records indeed exchanges and skips foreign hosts", async () => {
    const page = new FakePage();
    const recorder = createRecorder({});
    recorder.attach(page.asPage());
    page.emitResponse(
      fakeExchange("https://employers.indeed.com/api/jobs", "GET", {
        "content-type": "application/json",
      }),
    );
    page.emitResponse(
      fakeExchange("https://analytics.example.com/collect", "POST", {
        "content-type": "application/json",
      }),
    );
    await recorder.finish();
    expect(recorder.exchanges.length).toBe(1);
    expect(recorder.exchanges[0]?.url).toBe("https://employers.indeed.com/api/jobs");
  });

  it("inlines small JSON bodies", async () => {
    const page = new FakePage();
    const recorder = createRecorder({});
    recorder.attach(page.asPage());
    page.emitResponse(
      fakeExchange(
        "https://employers.indeed.com/api/whoami",
        "GET",
        { "content-type": "application/json" },
        JSON.stringify({ ok: true }),
      ),
    );
    await recorder.finish();
    expect(recorder.exchanges[0]?.responseBody).toContain('"ok"');
  });
});

interface FakeExchange {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  postData?: string | null;
  resourceType?: string;
}

function fakeExchange(
  url: string,
  method: string,
  headers: Record<string, string>,
  body = "",
): FakeExchange {
  return { url, method, headers, body, postData: null, resourceType: "xhr" };
}

class FakePage {
  private responseHandler?: (response: unknown) => void;

  asPage(): Page {
    return this as unknown as Page;
  }

  on(event: string, handler: (response: unknown) => void): void {
    if (event === "response") this.responseHandler = handler;
  }

  emitResponse(exchange: FakeExchange): void {
    this.responseHandler?.({
      url: () => exchange.url,
      status: () => 200,
      headers: () => exchange.headers ?? {},
      body: async () => Buffer.from(exchange.body ?? "", "utf8"),
      request: () => ({
        method: () => exchange.method,
        headers: () => ({}) as Record<string, string>,
        postData: () => exchange.postData ?? null,
        resourceType: () => exchange.resourceType ?? "xhr",
      }),
    });
  }
}
