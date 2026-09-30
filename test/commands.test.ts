import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { BrowserContext, Page } from "playwright-core";
import { homeCommand } from "../src/commands/home.js";
import { authCommand } from "../src/commands/auth.js";
import { browserCommand } from "../src/commands/browser.js";
import { discoverCommand } from "../src/commands/discover.js";
import { writeSessionRecord } from "../src/browser/session.js";
import type { CommandContext } from "../src/context.js";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "indeed-axi-commands-test-"));
}

interface PageScript {
  locatorCount?: number;
  url?: string;
  snapshotLines?: string[];
}

function makePage(script: PageScript = {}): Page {
  const url = script.url ?? "https://employers.indeed.com/c/dashboard";
  const lines = script.snapshotLines ?? [
    '- heading "Candidates"',
    '- link "Jane Doe" [ref=e1]',
    '- button "Message" [ref=e2]',
  ];
  const actions: string[] = [];
  return {
    url: () => url,
    evaluate: async (source: string) => {
      if (source.includes("__iaInstall")) return true;
      if (source.includes("__iaErrors")) return [] as string[];
      return { url, title: "Employer dashboard", lines, refs: 2 };
    },
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: () => ({
      count: async () => script.locatorCount ?? 1,
      click: async () => {
        actions.push("click");
      },
      fill: async (text: string) => {
        actions.push(`fill:${text}`);
      },
      selectOption: async () => {
        actions.push("select");
      },
    }),
    keyboard: {
      press: async (key: string) => {
        actions.push(`press:${key}`);
      },
    },
    screenshot: async () => undefined,
    on: () => undefined,
    actions,
  } as unknown as Page & { actions: string[] };
}

interface CtxOverrides {
  page?: Page;
  daemonRunning?: boolean;
  probeState?: string;
}

function makeCtx(overrides: CtxOverrides = {}): { ctx: CommandContext; page: Page } {
  const stateDir = tempStateDir();
  const page = overrides.page ?? makePage();
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addInitScript: async () => undefined,
    on: () => undefined,
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    close: async () => undefined,
  };
  const ctx: CommandContext = {
    config: { stateDir },
    stateDir,
    env: {},
    browser: {
      login: async () => ({ url: "https://employers.indeed.com/c/dashboard", started: true }),
      probe: async () => ({
        state: overrides.probeState ?? "logged-in",
        url: "https://employers.indeed.com/c/dashboard",
        started: false,
      }),
      discover: async () => ({
        runDir: join(stateDir, "runs", "discover-x"),
        runId: "discover-x",
        url: "https://employers.indeed.com/",
        exchanges: [{ index: 0, url: "https://employers.indeed.com/api/x", method: "GET", status: 200 }],
        documentCount: 1,
        consoleErrors: [],
        files: ["network.json", "index.json"],
      }),
    },
    daemon: {
      ensure: async () => ({
        port: 46000,
        pid: 4242,
        startedAt: "2026-09-28T00:00:00Z",
        started: true,
      }),
      withPage: async <T>(fn: (conn: { browser: typeof browser; context: BrowserContext; page: Page; disconnect(): Promise<void> }) => Promise<T>) =>
        fn({ browser, context, page, disconnect: async () => undefined }),
      probe: async () =>
        overrides.daemonRunning === false
          ? { running: false }
          : { running: true, port: 46000, pid: 4242, browserVersion: "Chrome/130.0.0.0" },
      stop: async () => "stopped" as const,
    },
  };
  return { ctx, page };
}

describe("home", () => {
  it("renders session + daemon state without launching anything", async () => {
    const { ctx } = makeCtx();
    writeSessionRecord(ctx.stateDir, {
      lastLogin: "2026-09-28T00:00:00Z",
      url: "https://employers.indeed.com/c/dashboard",
    });
    const result = (await homeCommand([], ctx)) as Record<string, unknown>;
    expect(result["auth"]).toBeDefined();
    expect(result["browser"]).toMatchObject({ running: true, port: 46000 });
    expect(Array.isArray(result["help"])).toBe(true);
  });
});

describe("auth", () => {
  it("status --browser reports the live session", async () => {
    const { ctx } = makeCtx({ probeState: "logged-in" });
    const result = (await authCommand(["status", "--browser"], ctx)) as {
      auth: { browser_session: { live: { state: string } } };
    };
    expect(result.auth.browser_session.live.state).toBe("logged-in");
  });

  it("login reports the url and leaves the browser running", async () => {
    const { ctx } = makeCtx();
    const result = (await authCommand(["login"], ctx)) as {
      auth: { browser_session: { logged_in: boolean; browser: string } };
    };
    expect(result.auth.browser_session.logged_in).toBe(true);
    expect(result.auth.browser_session.browser).toContain("running");
  });

  it("logout stops the daemon and deletes the record", async () => {
    const { ctx } = makeCtx();
    writeSessionRecord(ctx.stateDir, { lastLogin: "x", url: "y" });
    const result = (await authCommand(["logout"], ctx)) as {
      auth: { browser_session: { session_record: string }; browser: string };
    };
    expect(result.auth.browser_session.session_record).toBe("deleted");
    expect(result.browser).toBe("stopped");
  });
});

describe("browser", () => {
  it("open ensures the daemon and returns the outline", async () => {
    const { ctx } = makeCtx();
    const result = (await browserCommand(["open"], ctx)) as Record<string, unknown>;
    expect(result["browser"]).toMatchObject({ started: true, port: 46000 });
    const outline = result["outline"] as string[];
    expect(outline.some((line) => line.includes("Jane Doe"))).toBe(true);
  });

  it("open rejects off-indeed urls", async () => {
    const { ctx } = makeCtx();
    await expect(
      browserCommand(["open", "--url", "https://example.com/"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("goto rejects off-indeed urls", async () => {
    const { ctx } = makeCtx();
    await expect(browserCommand(["goto", "https://google.com/"], ctx)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("click acts on a ref and returns a fresh snapshot", async () => {
    const page = makePage();
    const { ctx } = makeCtx({ page });
    const result = (await browserCommand(["click", "e1"], ctx)) as Record<string, unknown>;
    const outline = result["outline"] as string[];
    expect(outline.some((line) => line.includes("[ref=e1]"))).toBe(true);
    expect((page as unknown as { actions: string[] }).actions).toContain("click");
  });

  it("click fails loudly on stale refs", async () => {
    const { ctx } = makeCtx({ page: makePage({ locatorCount: 0 }) });
    await expect(browserCommand(["click", "e9"], ctx)).rejects.toMatchObject({
      code: "STALE_REF",
    });
  });

  it("fill fills and --submit presses Enter", async () => {
    const page = makePage();
    const { ctx } = makeCtx({ page });
    await browserCommand(["fill", "e2", "hello there", "--submit"], ctx);
    const actions = (page as unknown as { actions: string[] }).actions;
    expect(actions).toContain("fill:hello there");
    expect(actions).toContain("press:Enter");
  });

  it("find narrows the outline and reports matches", async () => {
    const { ctx } = makeCtx({
      page: makePage({
        snapshotLines: [
          '- heading "Candidates"',
          '- link "Jane Doe" [ref=e1]',
          '  - text "Applied yesterday"',
          '  - text "Screening sent"',
          '- link "John Smith" [ref=e4]',
        ],
      }),
    });
    const result = (await browserCommand(["find", "jane"], ctx)) as Record<string, unknown>;
    expect(result["snapshot"]).toMatchObject({ matches: 1 });
    const outline = result["outline"] as string[];
    expect(outline.some((line) => line.includes("Jane Doe"))).toBe(true);
    expect(outline.some((line) => line.includes("John Smith"))).toBe(false);
  });

  it("find reports a definitive zero state", async () => {
    const { ctx } = makeCtx();
    const result = (await browserCommand(["find", "nothing-matches-this"], ctx)) as Record<
      string,
      unknown
    >;
    expect(result["snapshot"]).toMatchObject({ matches: 0 });
    expect(result["note"]).toContain("0 matches");
  });

  it("eval returns a json result", async () => {
    const page = makePage();
    (page as unknown as { evaluate: (s: string) => Promise<unknown> }).evaluate = async () => 42;
    const { ctx } = makeCtx({ page });
    const result = (await browserCommand(["eval", "6*7"], ctx)) as Record<string, unknown>;
    expect(result["eval"]).toMatchObject({ result: "42" });
  });

  it("unknown subcommand fails as validation error", async () => {
    const { ctx } = makeCtx();
    await expect(browserCommand(["teleport"], ctx)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("unknown flag fails loud", async () => {
    const { ctx } = makeCtx();
    await expect(browserCommand(["snapshot", "--fuzzy"], ctx)).rejects.toBeInstanceOf(AxiError);
  });
});

describe("discover", () => {
  it("returns the artifact summary", async () => {
    const { ctx } = makeCtx();
    const result = (await discoverCommand([], ctx)) as Record<string, unknown>;
    expect(result["discover"]).toMatchObject({
      url: "https://employers.indeed.com/",
    });
    const network = (result["discover"] as { network: Record<string, unknown> }).network;
    expect(network).toMatchObject({ exchanges: 1, documents: 1 });
  });

  it("rejects off-indeed urls", async () => {
    const { ctx } = makeCtx();
    await expect(
      discoverCommand(["--url", "https://example.com/"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
